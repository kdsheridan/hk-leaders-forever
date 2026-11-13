// Where the character list comes from:
//   - characters.json: the permanent list, edited in git
//   - characters added through the website, kept in Upstash Redis
// Redis is reached through its REST API, so there is nothing to install.
const crypto = require("crypto");
const core = require("../characters.json");

const HASH_KEY = "hk:characters";
const MAX_CHARACTERS = Number(process.env.MAX_CHARACTERS || 50);

const slugOf = (c) => `${c.name}-${c.surname}`.toLowerCase();

// Connecting Upstash Redis to a Vercel project adds these variables for you
// (KV_REST_API_* or UPSTASH_REDIS_REST_*, depending on the integration).
function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

// The form only works when both the database and a passcode are set up.
const canAdd = () => Boolean(redisConfig() && process.env.ADMIN_PASSCODE);
// The changelog only needs the database.
const hasHistory = () => Boolean(redisConfig());

async function redis(command) {
  const config = redisConfig();
  if (!config) throw new Error("Redis is not configured");
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Redis error: ${data.error || "HTTP " + res.status}`);
  }
  return data.result;
}

async function listStored() {
  if (!redisConfig()) return [];
  const result = await redis(["HGETALL", HASH_KEY]);
  // REST returns a flat [field, value, field, value, ...] list.
  const values = Array.isArray(result)
    ? result.filter((_, i) => i % 2 === 1)
    : Object.values(result || {});
  const out = [];
  for (const value of values) {
    try {
      const c = JSON.parse(value);
      if (c.name && c.surname) out.push({ name: c.name, surname: c.surname });
    } catch {
      // skip a corrupt entry rather than breaking the whole leaderboard
    }
  }
  return out;
}

// If Redis blips, keep using the last list we saw so friends don't vanish for a while.
let lastStored = [];

async function getAllCharacters() {
  try {
    lastStored = await listStored();
  } catch (err) {
    console.error("Could not read stored characters, using the last known list:", err.message);
  }
  const seen = new Set();
  const all = [];
  for (const c of [...core, ...lastStored]) {
    const slug = slugOf(c);
    if (!seen.has(slug)) {
      seen.add(slug);
      all.push({ name: c.name, surname: c.surname });
    }
  }
  return all;
}

const isCore = (slug) => core.some((c) => slugOf(c) === slug);

async function addStored(character) {
  await redis([
    "HSET",
    HASH_KEY,
    slugOf(character),
    JSON.stringify({ name: character.name, surname: character.surname, addedAt: new Date().toISOString() }),
  ]);
}

async function removeStored(slug) {
  return (await redis(["HDEL", HASH_KEY, slug])) > 0;
}

// Counts attempts per visitor. The key always gets an expiry, so nobody is locked out forever.
async function allowAttempt(id, limit = 10, windowSeconds = 600) {
  const key = `hk:attempts:${id}`;
  await redis(["SET", key, "0", "EX", String(windowSeconds), "NX"]);
  const count = await redis(["INCR", key]);
  return count <= limit;
}

function passcodeMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const hash = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

module.exports = {
  MAX_CHARACTERS,
  slugOf,
  canAdd,
  hasHistory,
  redis,
  getAllCharacters,
  isCore,
  addStored,
  removeStored,
  allowAttempt,
  passcodeMatches,
};
