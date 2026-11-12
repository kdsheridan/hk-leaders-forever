// Talks to Blizzard's WoW Forever profile API.
// Docs reference: https://github.com/Pinta365/blizzard_api (docs/content/02-forever)

const REGION = process.env.BLIZZARD_REGION || "us";
const LOCALE = "en_US";

// --- Rate limiting and caching knobs ------------------------------------------
// How long a finished leaderboard is reused. This one number drives both the
// in-memory cache below and the Cache-Control header Vercel's edge honours.
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
// Characters fetched at once. Each character makes 3 Blizzard requests, so at
// most CONCURRENCY * 3 requests are in flight at any moment.
const CONCURRENCY = 5;
// Attempts per request when Blizzard answers 429/5xx (or a 401 from an expired token).
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([429, 502, 503, 504]);
// After a failed refresh, serve the last good data for this long before trying again.
const FAILURE_BACKOFF_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Auth ----------------------------------------------------------------------
let cachedToken = { value: null, expiresAt: 0 };
let tokenInflight = null;

async function requestToken() {
  const id = process.env.BLIZZARD_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET");
  }
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Blizzard token request failed (HTTP ${res.status}). Check the client ID and secret.`);
  }
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

// Reuses the cached token, and makes concurrent callers share one token request.
async function getToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  if (!tokenInflight) {
    tokenInflight = requestToken().finally(() => {
      tokenInflight = null;
    });
  }
  return tokenInflight;
}

// --- Requests ------------------------------------------------------------------
// Forever is realmless: characters are looked up as {name}-{surname}, lowercase.
async function apiGet(name, surname, suffix = "") {
  const slug = encodeURIComponent(`${name}-${surname}`.toLowerCase());
  const url =
    `https://${REGION}.api.blizzard.com/profile/wow/character/${slug}${suffix}` +
    `?namespace=profile-forever-${REGION}&locale=${LOCALE}`;

  let res;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;

    if (res.status === 401 && !isLastAttempt) {
      cachedToken = { value: null, expiresAt: 0 }; // expired early; fetch a new one
      continue;
    }
    if (RETRYABLE.has(res.status) && !isLastAttempt) {
      // Honour Retry-After when Blizzard sends it, otherwise back off 0.5s, 1s, ...
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 500 * 2 ** attempt;
      await sleep(Math.min(waitMs, 3000));
      continue;
    }
    break;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body; leave null
  }
  return { httpStatus: res.status, body };
}

const fetchPvpSummary = (name, surname) => apiGet(name, surname, "/pvp-summary");
const fetchProfile = (name, surname) => apiGet(name, surname, "");
const fetchAchievementStatistics = (name, surname) =>
  apiGet(name, surname, "/achievements/statistics");

// --- Reading the responses -----------------------------------------------------
// Counters inside achievements/statistics (found by probing a live character).
const STAT_TOTAL_DEATHS = 60;
const STAT_DEATHS_FROM_PLAYERS = 1501;
const DEATHS_CATEGORY_ID = 122; // the "Deaths" category and its sub-categories

// Achievement statistics are nested: categories -> sub_categories -> statistics.
function findStat(categories, id) {
  for (const category of categories || []) {
    const hit = (category.statistics || []).find((s) => s.id === id);
    if (hit) return hit.quantity;
    const nested = findStat(category.sub_categories, id);
    if (nested != null) return nested;
  }
  return null;
}

function findCategory(categories, id) {
  for (const category of categories || []) {
    if (category.id === id) return category;
    const nested = findCategory(category.sub_categories, id);
    if (nested) return nested;
  }
  return null;
}

function collectStats(category, out = []) {
  out.push(...(category.statistics || []));
  for (const sub of category.sub_categories || []) collectStats(sub, out);
  return out;
}

// Every non-zero counter under "Deaths" except the grand total and anything PvP,
// biggest first. Some counters can overlap (e.g. dungeon deaths vs. wider totals).
function deathBreakdown(categories) {
  const deaths = findCategory(categories, DEATHS_CATEGORY_ID);
  if (!deaths) return [];
  return collectStats(deaths)
    .filter(
      (s) =>
        s.id !== STAT_TOTAL_DEATHS &&
        s.quantity > 0 &&
        !/other players|opposing/i.test(s.name)
    )
    .map((s) => ({ name: s.name, quantity: s.quantity }))
    .sort((a, b) => b.quantity - a.quantity);
}

async function fetchCharacter(name, surname) {
  let pvp, profile, ach;
  try {
    [pvp, profile, ach] = await Promise.all([
      fetchPvpSummary(name, surname),
      fetchProfile(name, surname),
      fetchAchievementStatistics(name, surname),
    ]);
  } catch {
    return { name, surname, status: "error" }; // network failure for this character
  }

  if (pvp.httpStatus === 404) {
    // Characters only appear from level 10, and only after logging out once.
    return { name, surname, status: "not_found" };
  }
  if (pvp.httpStatus !== 200 || !pvp.body) {
    return { name, surname, status: "error", httpStatus: pvp.httpStatus };
  }

  // The profile only adds detail; if it fails we still show the HK count.
  const p = profile.httpStatus === 200 && profile.body ? profile.body : {};
  const categories = ach.httpStatus === 200 && ach.body ? ach.body.categories : [];
  const totalDeaths = findStat(categories, STAT_TOTAL_DEATHS);
  const pvpDeaths = findStat(categories, STAT_DEATHS_FROM_PLAYERS);
  return {
    // Prefer the capitalisation Blizzard stores over what we typed in characters.json.
    name: pvp.body.character?.name ?? name,
    surname: pvp.body.character?.surname ?? surname,
    status: "ok",
    honorableKills: pvp.body.honorable_kills ?? null,
    pvpRank: pvp.body.pvp_rank ?? null,
    pvpDeaths,
    totalDeaths,
    // Assumes "Total deaths" includes deaths from other players.
    pveDeaths:
      totalDeaths != null && pvpDeaths != null
        ? Math.max(totalDeaths - pvpDeaths, 0)
        : null,
    deathBreakdown: deathBreakdown(categories),
    level: p.level ?? null,
    itemLevel: p.equipped_item_level ?? p.average_item_level ?? null,
    className: p.character_class?.name ?? null,
    race: p.race?.name ?? null,
    faction: p.faction?.type ?? null, // "ALLIANCE" | "HORDE"
    guild: p.guild?.name ?? null,
    lastLogin: p.last_login_timestamp
      ? new Date(p.last_login_timestamp).toISOString()
      : null,
  };
}

// --- Leaderboard ---------------------------------------------------------------
// Runs fn over items with at most `limit` running at once, keeping result order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchAll(characters) {
  await getToken(); // fail fast, with a clear message, if the credentials are wrong
  return mapLimit(characters, CONCURRENCY, (c) => fetchCharacter(c.name, c.surname));
}

// Ranked characters first (most HK on top), everything else after.
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const aOk = a.status === "ok" && a.honorableKills != null;
    const bOk = b.status === "ok" && b.honorableKills != null;
    if (aOk && bOk) return b.honorableKills - a.honorableKills;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}

// Uncached; used by scripts/test.js.
async function getLeaderboard(characters) {
  return sortRows(await fetchAll(characters));
}

// --- In-memory cache (per warm function instance) -------------------------------
// Vercel's edge cache is the first layer (Cache-Control in api/leaderboard.js).
// This is the second: it stops cache-busting URLs and cold edge regions from each
// triggering a full round of Blizzard calls, and it lets us serve old data if
// Blizzard is rate limiting or down.
let board = { rows: null, fetchedAt: 0 };
let refreshing = null;
let retryNotBefore = 0;

const slugOf = (row) => `${row.name}-${row.surname}`.toLowerCase();

async function refresh(characters) {
  const fresh = await fetchAll(characters);
  // Check the raw results first: if everything failed, this is an outage, not a refresh.
  if (fresh.every((r) => r.status === "error")) {
    throw new Error("Blizzard's API is unavailable or rate limiting right now");
  }
  const previous = new Map(
    (board.rows || []).filter((r) => r.status === "ok").map((r) => [slugOf(r), r])
  );
  // A character that failed this time (rate limit, hiccup) keeps its last good row.
  const rows = fresh.map((r) => (r.status === "error" && previous.get(slugOf(r))) || r);
  board = { rows: sortRows(rows), fetchedAt: Date.now() };
}

async function getCachedLeaderboard(characters) {
  const now = Date.now();
  if (board.rows && now - board.fetchedAt < CACHE_TTL_MS) {
    return { rows: board.rows, fetchedAt: board.fetchedAt, stale: false };
  }
  if (board.rows && now < retryNotBefore) {
    // Recently failed; don't hammer Blizzard, keep serving the last good data.
    return { rows: board.rows, fetchedAt: board.fetchedAt, stale: true };
  }

  // Concurrent requests share one refresh instead of each calling Blizzard.
  if (!refreshing) {
    refreshing = refresh(characters).finally(() => {
      refreshing = null;
    });
  }
  try {
    await refreshing;
    return { rows: board.rows, fetchedAt: board.fetchedAt, stale: false };
  } catch (err) {
    retryNotBefore = Date.now() + FAILURE_BACKOFF_MS;
    if (board.rows) return { rows: board.rows, fetchedAt: board.fetchedAt, stale: true };
    throw err;
  }
}

module.exports = {
  CACHE_TTL_SECONDS,
  fetchPvpSummary,
  fetchProfile,
  fetchAchievementStatistics,
  fetchCharacter,
  getLeaderboard,
  getCachedLeaderboard,
};
