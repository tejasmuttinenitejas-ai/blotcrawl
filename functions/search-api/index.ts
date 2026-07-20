// Blot Search API — a Google-Custom-Search-style endpoint:
//   GET /functions/v1/search-api?q=your+query&key=blot_33a85b8bfa6a06d80c7d6b3d2a0cb71ed16c
//
// Deploy this via the Supabase Dashboard (Edge Functions → Deploy a new
// function → Via Editor) — no CLI or terminal needed.
//
// Requires two function secrets set in Supabase Dashboard →
// Edge Functions → search-api → Secrets:
//   SUPABASE_URL           = https://qisogtmsflsbwfwkvmie.supabase.co
//   SUPABASE_SERVICE_KEY   = sb_secret_ZYxMGSIbRim4B_XxOYXQOg_5t8ZEnbK (same one the crawler uses)

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const apiKey = url.searchParams.get("key");
  const requestedLimit = Number(url.searchParams.get("limit") || 20);
  const limit = Math.min(Math.max(requestedLimit || 20, 1), 50); // clamp 1–50

  if (!q) {
    return json({ error: "Missing required parameter: q" }, 400);
  }
  if (!apiKey) {
    return json({ error: "Missing required parameter: key" }, 401);
  }

  // Look up and validate the API key
  const { data: keyRow, error: keyError } = await supabase
    .from("api_keys")
    .select("*")
    .eq("key", apiKey)
    .maybeSingle();

  if (keyError) {
    return json({ error: "Key lookup failed", details: keyError.message }, 500);
  }
  if (!keyRow) {
    return json({ error: "Invalid API key" }, 401);
  }
  if (!keyRow.is_active) {
    return json({ error: "This API key has been disabled" }, 403);
  }
  if (keyRow.requests_used >= keyRow.monthly_limit) {
    return json(
      { error: "Monthly request limit reached for this key", limit: keyRow.monthly_limit },
      429
    );
  }

  // Run the actual ranked search
  const started = Date.now();
  const { data: results, error: searchError } = await supabase.rpc("search_pages", {
    query: q,
    limit_count: limit,
  });

  if (searchError) {
    return json({ error: "Search failed", details: searchError.message }, 500);
  }

  // Log usage (fire and forget is fine here, but we await for correctness)
  await supabase
    .from("api_keys")
    .update({ requests_used: keyRow.requests_used + 1 })
    .eq("id", keyRow.id);

  return json({
    query: q,
    count: results?.length ?? 0,
    took_ms: Date.now() - started,
    requests_remaining: keyRow.monthly_limit - keyRow.requests_used - 1,
    results: results ?? [],
  });
});
