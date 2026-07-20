// Loads seed-urls.txt into crawl_queue as high-priority pending URLs.
// Run once (or any time you want to add a fresh batch of starting points):
//   npm run seed

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const urls = fs
  .readFileSync(path.join(__dirname, "seed-urls.txt"), "utf-8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

if (urls.length === 0) {
  console.log("No seed URLs found in seed-urls.txt.");
  process.exit(0);
}

const rows = urls.map((url) => ({ url, status: "pending", priority: 10 }));

const { error } = await supabase
  .from("crawl_queue")
  .upsert(rows, { onConflict: "url", ignoreDuplicates: true });

if (error) {
  console.error("Seeding failed:", error);
  process.exit(1);
}

console.log(`Seeded ${rows.length} URL(s) into crawl_queue.`);
