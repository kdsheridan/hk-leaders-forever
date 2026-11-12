# HK Leaders · WoW Forever

Honorable kills leaderboard for a list of WoW Forever characters, hosted on Vercel.

- `characters.json` – the characters to track (`name` + `surname`, no realm)
- `lib/blizzard.js` – Blizzard API calls (`pvp-summary`, namespace `profile-forever-us`)
- `api/leaderboard.js` – Vercel function that returns the ranked list
- `public/index.html` – the leaderboard page

## Setup

1. Copy `.env.example` to `.env.local` and fill in your Blizzard client ID **and** secret.
2. Check the API from your terminal (Node 20.6+ works locally; Vercel is set to Node 26.x in `package.json`):

   ```
   npm run test:raw   # raw pvp-summary response, to confirm honorable_kills
   npm run test:api   # the ranked table
   ```

3. Run the site locally with `npm run dev` and open http://localhost:3000 (no Vercel login needed),
   or deploy by importing the repo in Vercel.
   Add `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` and `BLIZZARD_REGION` under
   Project Settings → Environment Variables.

## Notes

- A character only shows up from level 10, and only after logging out once at that level.
- Values are a snapshot from the character's last logout.

## Rate limiting and caching

- **Edge cache:** `/api/leaderboard` is sent with `s-maxage`, so Vercel serves repeat visitors without running the function.
- **Memory cache:** each warm function instance keeps the finished leaderboard for `CACHE_TTL_SECONDS` (default 300), ignores query strings, and lets simultaneous visitors share one refresh.
- **Concurrency cap:** at most 5 characters (15 requests) are fetched at once.
- **Retries:** 429/502/503/504 are retried with backoff (honouring `Retry-After`), and an expired token is refreshed once.
- **Outages:** if Blizzard fails, the last good data is served (the page says so) and Blizzard isn't retried for 30 seconds. A single character that fails keeps its last good row.
- A normal refresh is about 3 requests per character, so 20 characters is ~60 calls every 5 minutes at most per instance.
