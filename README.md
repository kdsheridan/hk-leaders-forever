# HK Leaders · WoW Forever

Honorable kills leaderboard for a list of WoW Forever characters, hosted on Vercel.

- `characters.json` – the characters to track (`name` + `surname`, no realm)
- `lib/blizzard.js` – Blizzard API calls (`pvp-summary`, namespace `profile-forever-us`)
- `api/leaderboard.js` – Vercel function that returns the ranked list (and logs changes)
- `api/characters.js` – add / remove characters from the website (passcode protected)
- `api/changelog.js` – the history shown on the Changelog tab
- `lib/store.js`, `lib/changelog.js` – Upstash Redis access, the character list, snapshots and events
- `public/index.html` – the page: Leaderboard and Changelog tabs, add form

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

## Killing blows and guilds

- **Killing blows** come from each character's achievement statistics (`/achievements/statistics`). I haven't confirmed the exact ids or names Forever uses, so they're found by name: any counter called "...killing blow(s)...", or anything inside a category with that name. The column shows the total. The picker above the table switches it to any single counter (battleground, arena and so on) and sorts by it, and clicking the number lists every counter. A character with no killing blow data shows a dash.
- If the column stays empty, run `npm run probe` to print what Blizzard returns for killing blows. `npm run probe -- death Ren Wix` searches any word for any character.
- **Guilds tab** is worked out in the browser from the leaderboard rows, so it only covers characters on the board. Per guild it shows members, total and average HK, PvP deaths, HK per death (total HK divided by total PvP deaths), killing blows, PvE deaths, and average level and item level. Click a member count to see who is in the guild. Characters without a guild are grouped under "No guild", which always stays at the bottom.

## Rate limiting and caching

- **Edge cache:** `/api/leaderboard` is sent with `s-maxage` (at most 60 seconds), so Vercel serves repeat visitors without running the function and added characters show up quickly.
- **Memory cache:** each warm function instance keeps the finished leaderboard for `CACHE_TTL_SECONDS` (default 300), ignores query strings, and lets simultaneous visitors share one refresh.
- **Concurrency cap:** at most 5 characters (15 requests) are fetched at once.
- **Retries:** 429/502/503/504 are retried with backoff (honouring `Retry-After`), and an expired token is refreshed once.
- **Outages:** if Blizzard fails, the last good data is served (the page says so) and Blizzard isn't retried for 30 seconds. A single character that fails keeps its last good row.
- A normal refresh is about 3 requests per character, so 20 characters is ~60 calls every 5 minutes at most per instance.

## Adding characters from the site, and the changelog

Both features need a small Upstash Redis database. Without one the site still works: the form and the Changelog tab simply don't appear, and the list comes from `characters.json`.

1. In your Vercel project, open **Storage** (or the **Marketplace**), create an **Upstash Redis** database and connect it to the project. Vercel adds the connection variables for you (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`; the code accepts either).
2. Add `ADMIN_PASSCODE` under Project Settings → Environment Variables. Pick something long and share it with your friends.
3. Redeploy so the new variables take effect.

To try it locally, copy those variables into `.env.local` and run `npm run dev`.

**Adding:** the form checks the character exists in Blizzard before saving, so typos are rejected (and so are characters below level 10 or that haven't logged out yet). Saved characters use Blizzard's capitalisation. Characters in `characters.json` are permanent; the ones added on the site are stored in Redis. `MAX_CHARACTERS` (default 50) caps the list, and each visitor gets 10 attempts per 10 minutes.

**Removing** a character that was added on the site: send `DELETE /api/characters` with `{ "name", "surname", "passcode" }`, or delete its entry from the `hk:characters` hash in the Upstash console. There is no remove button on the page.

**Changelog:** every time the leaderboard refreshes, each character is compared with its saved snapshot and the differences are logged, newest first (the last `CHANGELOG_MAX_EVENTS`, default 500, are kept).

| Filter | What is logged |
| :- | :- |
| Character | level, item level, guild (joined / left / moved) |
| PvP | honorable kills, PvP deaths, killing blows |
| PvE | PvE deaths, and each counter in the death breakdown |

Good to know: a character's first sighting only saves a baseline, so nothing is logged for it. History only builds up while the site is being visited, and times are when the site noticed a change, so changes made while nobody was looking show up together. A failed Blizzard call never creates a fake change.
