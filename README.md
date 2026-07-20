# blot — a real (small) search engine

Crawler → index → ranking → search page, built to actually run on Supabase's
free tier. Not a Google clone — a genuine, working search engine scoped to
what a free Postgres database and free automation can actually hold.

## How it works

| Piece | What it does | Where |
|---|---|---|
| **Crawler** | Fetches queued URLs, respects `robots.txt`, extracts text/title/links | `crawler/crawler.js` |
| **Queue** | Tracks which URLs are pending / done / failed | `crawl_queue` table |
| **Index** | Postgres full-text search (`tsvector` + GIN index) — this *is* the inverted index | `pages` table |
| **Ranking** | Text relevance (`ts_rank_cd`) × a popularity boost from inbound link counts (simplified PageRank) | `search_pages()` SQL function |
| **Scheduler** | Runs the crawler every few hours, for free | `.github/workflows/crawl.yml` |
| **Search page** | Calls the ranking function, shows results | `frontend/index.html` |

## Setup

### 1. Database
In your Supabase project dashboard → **SQL Editor** → paste and run `sql/schema.sql`.

### 2. Get your keys
Project Settings → API:
- **Project URL** and **service_role key** → used by the crawler (server-side only — never put this in the frontend)
- **Project URL** and **anon / public key** → used by the search page (safe for the browser)

### 3. Seed and crawl locally (test run)
```bash
cd crawler
npm install
export SUPABASE_URL="https://YOUR-PROJECT-REF.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-role-key"
npm run seed    # loads seed-urls.txt into the queue
npm run crawl   # crawls one batch (25 URLs by default)
```
Edit `crawler/seed-urls.txt` first to point at whatever your engine should
focus on — the crawler follows links outward from your seeds, so seed pages
that link to the kind of content you want indexed.

### 4. Automate it (GitHub Actions, free)
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Secrets and variables → Actions** → add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. The workflow in `.github/workflows/crawl.yml` runs every 6 hours automatically (edit the cron line to change that), and you can trigger it manually from the Actions tab any time.
4. Bonus: this also stops your Supabase project from auto-pausing after 7 idle days, since it hits the database on a schedule.

### 5. Deploy the search page
Edit `frontend/index.html` and fill in `SUPABASE_URL` / `SUPABASE_ANON_KEY` near the top of the `<script>` block. Then host the single file — easiest free options:
- **GitHub Pages**: enable Pages on the same repo, point it at `frontend/`, then add a `CNAME` file with your domain (e.g. `glenai.in`) and update your domain's DNS to point at GitHub Pages.
- Netlify / Vercel free tier also work if you'd rather use those.

## Honest scope and scaling notes

- **Storage budget**: 500MB free Postgres, ~8KB per indexed page (title + trimmed content + search index overhead) → roughly **tens of thousands of pages**, not the whole web. That's still a real, searchable index — just scoped.
- **Growing past that**: prune low-value pages, upgrade to Supabase Pro (8GB+ storage, $25/mo), or self-host Postgres later. This schema doesn't need to change for that.
- **Bandwidth**: free tier gives ~5GB egress/month — plenty for search traffic at small scale; watch it if you get real visitors.
- **Politeness**: the crawler already respects `robots.txt` and rate-limits itself (1 request/sec by default). Don't remove that — it's both good etiquette and how you avoid getting blocked.
- **Platforms with anti-scraping ToS** (YouTube, and most "AI" product sites): don't point the crawler at these directly. Use their official APIs instead where you want that content — it's the sanctioned path and won't get your crawler's IP banned.
- **Growing the index**: increase `CRAWL_BATCH_SIZE` / run the Action more often as your comfort with the bandwidth budget grows. Re-seed periodically with fresh starting points for topics you want more coverage on.

## Public search API (Google-style, with keys)

A dedicated endpoint with your own API keys and request limits — like a mini
version of Google's Custom Search API.

**1. Run the extra SQL.** In Supabase SQL Editor → New query, paste and run
`sql/api_keys.sql` (after `schema.sql`). This creates an `api_keys` table and
issues you a first key — check the `api_keys` table afterward and copy the
`key` value.

**2. Deploy the function — no terminal needed.**
1. Supabase Dashboard → **Edge Functions** (left sidebar).
2. **Deploy a new function → Via Editor**.
3. Name it `search-api`.
4. If there's a toggle for "Enforce JWT Verification" / "Verify JWT", **turn it off** — this API uses its own `key` parameter for access control instead.
5. Delete the placeholder code and paste in the contents of `functions/search-api/index.ts`.
6. Before deploying, add two **secrets** for this function (there's a Secrets tab/section): `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` — same values you've used for the crawler.
7. Click **Deploy**.

**3. Use it.** Anyone with a key can now call:
```
GET https://YOUR-PROJECT-REF.supabase.co/functions/v1/search-api?q=wikipedia&key=blot_xxxxxxxx
```
Try it straight in a browser address bar, or with curl:
```bash
curl "https://YOUR-PROJECT-REF.supabase.co/functions/v1/search-api?q=wikipedia&key=blot_xxxxxxxx"
```
Response:
```json
{
  "query": "wikipedia",
  "count": 3,
  "took_ms": 42,
  "requests_remaining": 998,
  "results": [
    { "url": "...", "title": "...", "description": "...", "domain": "...", "rank": 0.8, "inbound_links": 5 }
  ]
}
```

**Issue more keys** (e.g. for other people/apps using your API) any time by
running in SQL Editor:
```sql
insert into api_keys (key, label, monthly_limit) values (generate_api_key(), 'their label', 1000);
```

**Disable a key** if it's being abused:
```sql
update api_keys set is_active = false where key = 'blot_xxxxxxxx';
```

## Next ideas once this is running
- Swap the ranking function's popularity term for a proper iterative PageRank pass (a scheduled SQL job) once you have enough link data.
- Add a `favicon`/thumbnail column and show it in results.
- Add query logging (a `searches` table) to see what people actually look for.
