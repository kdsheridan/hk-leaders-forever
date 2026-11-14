// Talks to Blizzard's WoW Forever profile API.
// Docs reference: https://github.com/Pinta365/blizzard_api (docs/content/02-forever)

const REGION = process.env.BLIZZARD_REGION || "us";
const LOCALE = "en_US";

// --- Rate limiting and caching knobs ------------------------------------------
// How long a finished leaderboard is reused. This one number drives both the
// in-memory cache below and the Cache-Control header Vercel's edge honours.
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
// How long Vercel's edge keeps the response. Shorter than the memory cache so list
// changes appear within a minute; the memory cache is what protects Blizzard.
const EDGE_TTL_SECONDS = Math.min(CACHE_TTL_SECONDS, 60);
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

// Counters under "Deaths", minus the grand total and anything PvP. Two fixes over a plain list:
//  - "Total deaths in 5-player dungeons" (918) is a subset of "Total raid and dungeon deaths" (321),
//    so it's dropped when 321 is there instead of counting the same deaths twice.
//  - The itemised counters never add up to the PvE total (Forever only itemises dungeons, drowning,
//    falling, ...), so the gap is shown as a derived "Other / not itemised" line.
const STAT_RAID_DUNGEON_DEATHS = 321;
const STAT_DUNGEON_5MAN_DEATHS = 918;
const OTHER_DEATHS_LABEL = "Other / not itemised";

function deathBreakdown(categories, pveDeaths) {
  const deaths = findCategory(categories, DEATHS_CATEGORY_ID);
  if (!deaths) return [];
  const stats = collectStats(deaths).filter(
    (s) =>
      s.id !== STAT_TOTAL_DEATHS &&
      s.quantity > 0 &&
      !/other players|opposing/i.test(s.name)
  );
  const hasParent = stats.some((s) => s.id === STAT_RAID_DUNGEON_DEATHS);
  const kept = stats.filter((s) => !(hasParent && s.id === STAT_DUNGEON_5MAN_DEATHS));
  const out = kept.map((s) => ({ name: s.name, quantity: s.quantity }));
  if (pveDeaths != null) {
    const itemised = out.reduce((sum, d) => sum + d.quantity, 0);
    if (pveDeaths > itemised) {
      out.push({ name: OTHER_DEATHS_LABEL, quantity: pveDeaths - itemised, derived: true });
    }
  }
  return out.sort((a, b) => b.quantity - a.quantity);
}

// Killing blows are in the achievement statistics too, but I haven't seen the exact ids or
// names Forever uses, so they're found by name rather than by id: any counter called
// "...killing blow(s)...", or any counter inside a category called that.
// Returns the grand total (null if there isn't one) and the other non-zero counters, biggest first.
function killingBlowStats(categories) {
  const found = new Map();
  const walk = (list, inside) => {
    for (const category of list || []) {
      const here = inside || /killing blows?/i.test(category.name || "");
      for (const s of category.statistics || []) {
        if (typeof s.quantity !== "number") continue;
        if (here || /killing blows?/i.test(s.name || "")) found.set(s.id ?? s.name, s);
      }
      walk(category.sub_categories, here);
    }
  };
  walk(categories, false);

  const stats = [...found.values()];
  const named = (re) => stats.filter((s) => re.test(s.name || ""));
  const total =
    named(/^total killing blows?$/i)[0] ||
    named(/^total\b/i).sort((a, b) => a.name.length - b.name.length)[0] ||
    named(/^killing blows?$/i)[0] ||
    null;
  // PvP vs PvE. Anything called battleground / arena / player / PvP counts as PvP; everything
  // else (creatures, world kills, ...) is PvE. The PvE number is the total minus the PvP part.
  const PVP_RE = /battleground|arena|warsong|arathi|alterac|eye of the storm|strand of|isle of conquest|wintergrasp|\bplayers?\b|\bpvp\b|honorable|opposing|duel/i;
  const kindOf = (s) => (PVP_RE.test(s.name || "") ? "pvp" : "pve");
  const pvpStats = stats.filter((s) => s !== total && kindOf(s) === "pvp");

  // Several counters can describe the same kills (a battleground total plus each battleground),
  // so use an aggregate when there is one and only sum the parts when there isn't.
  const family = (memberRe, aggRe) => {
    const members = pvpStats.filter((s) => memberRe.test(s.name || ""));
    const agg = members.find((s) => aggRe.test(s.name || ""));
    return agg ? agg.quantity : members.reduce((sum, s) => sum + s.quantity, 0);
  };
  const explicit = pvpStats.find((s) => /\b(players?|pvp)\b/i.test(s.name || "") && !/battleground|arena/i.test(s.name || ""));
  // With no PvP-named counter there is nothing to split on, and "0" would be a guess (world PvP
  // kills are inside the world total), so the split stays unknown.
  let pvp = null;
  if (total && pvpStats.length > 0) {
    pvp = explicit
      ? explicit.quantity
      : family(/battleground|warsong|arathi|alterac|eye of the storm|strand of|isle of conquest|wintergrasp/i, /^(total )?battlegrounds?( killing blows?)?$/i) +
        family(/arena/i, /^(total )?arenas?( killing blows?)?$/i);
    pvp = Math.min(pvp, total.quantity); // can't exceed the total
  }
  const breakdown = stats
    .filter((s) => s !== total && s.quantity > 0 && !/^(continent|zone) with the most/i.test(s.name || ""))
    .map((s) => ({ name: s.name, quantity: s.quantity, kind: kindOf(s) }))
    .sort((a, b) => b.quantity - a.quantity);
  return {
    total: total ? total.quantity : null,
    pvp,
    pve: pvp != null ? total.quantity - pvp : null,
    breakdown,
  };
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
  const kb = killingBlowStats(categories);
  const pveDeaths =
    totalDeaths != null && pvpDeaths != null ? Math.max(totalDeaths - pvpDeaths, 0) : null;
  return {
    // Prefer the capitalisation Blizzard stores over what we typed in characters.json.
    name: pvp.body.character?.name ?? name,
    surname: pvp.body.character?.surname ?? surname,
    status: "ok",
    honorableKills: pvp.body.honorable_kills ?? null,
    pvpRank: pvp.body.pvp_rank ?? null,
    killingBlows: kb.total,
    killingBlowsPvp: kb.pvp,
    killingBlowsPve: kb.pve,
    killingBlowBreakdown: kb.breakdown,
    pvpDeaths,
    totalDeaths,
    // Assumes "Total deaths" includes deaths from other players, so PvE = total - PvP.
    pveDeaths,
    deathBreakdown: deathBreakdown(categories, pveDeaths),
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
let board = { rows: null, fetchedAt: 0, signature: "" };
let refreshing = null;
let retryNotBefore = 0;

const slugOf = (row) => `${row.name}-${row.surname}`.toLowerCase();
// Identifies the character list the cached board was built from. If the list
// changes (someone added or removed a character) the cache is rebuilt at once.
const signatureOf = (characters) => characters.map(slugOf).sort().join("|");

async function refresh(characters, signature) {
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
  board = { rows: sortRows(rows), fetchedAt: Date.now(), signature };
}

async function getCachedLeaderboard(characters) {
  if (characters.length === 0) {
    return { rows: [], fetchedAt: Date.now(), stale: false }; // nothing to fetch
  }
  const signature = signatureOf(characters);
  const now = Date.now();
  if (board.rows && board.signature === signature && now - board.fetchedAt < CACHE_TTL_MS) {
    return { rows: board.rows, fetchedAt: board.fetchedAt, stale: false };
  }
  if (board.rows && now < retryNotBefore) {
    // Recently failed; don't hammer Blizzard, keep serving the last good data.
    return { rows: board.rows, fetchedAt: board.fetchedAt, stale: true };
  }

  // Concurrent requests share one refresh instead of each calling Blizzard.
  if (!refreshing) {
    refreshing = refresh(characters, signature).finally(() => {
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
  apiGet,
  CACHE_TTL_SECONDS,
  EDGE_TTL_SECONDS,
  fetchPvpSummary,
  fetchProfile,
  fetchAchievementStatistics,
  fetchCharacter,
  killingBlowStats,
  deathBreakdown,
  getLeaderboard,
  getCachedLeaderboard,
};
