 //Blot crawler — one run through a batch of the queue.
// Meant to be run repeatedly (cron / GitHub Actions), not as a
// long-lived process: each run claims a batch, crawls it politely,
// and exits. Keep running it and the index grows over time.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run crawl

import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Config -----------------------------------------------------
// Identify yourself honestly and give a way to contact you — this
// is expected crawler etiquette and some sites use it to decide
// whether to allow or block you.
const USER_AGENT = "BlotBot/0.1 (+https://glenai.in/about-blot)";
const BATCH_SIZE = Number(process.env.CRAWL_BATCH_SIZE || 25);
const REQUEST_DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 1000); // politeness delay between requests
const MAX_CONTENT_CHARS = 3000; // keep rows small — 500MB db budget, more pages > more text per page
const MAX_OUTLINKS_PER_PAGE = 40; // caps how fast the queue grows
// -----------------------------------------------------------------

const robotsCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const robotsUrl = `${origin}/robots.txt`;
  let robots;
  try {
    const { data } = await axios.get(robotsUrl, {
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT },
    });
    robots = robotsParser(robotsUrl, data);
  } catch {
    robots = robotsParser(robotsUrl, ""); // no robots.txt found = treat as allow-all
  }
  robotsCache.set(origin, robots);
  return robots;
}

function extract(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, svg").remove();

  const title = $("title").first().text().trim().slice(0, 200);
  const description = ($('meta[name="description"]').attr("content") || "").trim().slice(0, 300);
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_CHARS);

  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href);
  });

  return { title, description, text, links };
}

function resolveUrl(base, href) {
  try {
    const u = new URL(href, base);
    u.hash = "";
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function markQueue(id, status) {
  await supabase.from("crawl_queue").update({ status }).eq("id", id);
}

async function processItem(item) {
  const url = item.url;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return markQueue(item.id, "failed");
  }

  const robots = await getRobots(origin);
  if (robots?.isDisallowed?.(url, USER_AGENT)) {
    console.log(`Skipping (robots.txt disallows): ${url}`);
    return markQueue(item.id, "failed");
  }

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": USER_AGENT },
      maxContentLength: 3_000_000, // don't pull huge files
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const contentType = res.headers["content-type"] || "";
    if (!contentType.includes("text/html")) {
      return markQueue(item.id, "done");
    }

    const { title, description, text, links } = extract(res.data);
    const domain = new URL(url).hostname;

    const { error: upsertError } = await supabase.from("pages").upsert(
      {
        url,
        title,
        description,
        content: text,
        domain,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "url" }
    );
    if (upsertError) throw upsertError;

    const uniqueLinks = [...new Set(links.map((h) => resolveUrl(url, h)).filter(Boolean))].slice(
      0,
      MAX_OUTLINKS_PER_PAGE
    );

    if (uniqueLinks.length > 0) {
      // Bump popularity counters (and create stub rows) for linked-to pages
      const { error: bumpError } = await supabase.rpc("bump_inbound", { urls: uniqueLinks });
      if (bumpError) console.error("bump_inbound failed:", bumpError.message);

      // Queue newly discovered URLs for future crawls
      const { error: queueError } = await supabase
        .from("crawl_queue")
        .upsert(
          uniqueLinks.map((u) => ({ url: u, status: "pending" })),
          { onConflict: "url", ignoreDuplicates: true }
        );
      if (queueError) console.error("queue insert failed:", queueError.message);
    }

    await markQueue(item.id, "done");
    console.log(`Crawled: ${url} (${uniqueLinks.length} links found)`);
  } catch (err) {
    console.error(`Failed ${url}:`, err.message);
    await markQueue(item.id, "failed");
  }
}

async function run() {
  const { data: batch, error } = await supabase
    .from("crawl_queue")
    .select("id, url")
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("added_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("Failed to read queue:", error);
    process.exit(1);
  }

  if (!batch || batch.length === 0) {
    console.log("Queue is empty. Run `npm run seed` to add starting URLs.");
    return;
  }

  for (const item of batch) {
    await supabase.from("crawl_queue").update({ status: "crawling" }).eq("id", item.id);
    await processItem(item);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Done. Processed ${batch.length} URL(s) this run.`);
}

run();
