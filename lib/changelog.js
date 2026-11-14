// Changelog: every time the leaderboard refreshes, compare each character with the
// snapshot saved last time and log what changed. Snapshots and events live in Redis.
//
//   category   what is tracked
//   character  level, item level, guild
//   pvp        honorable kills, PvP deaths, killing blows
//   pve        PvE deaths, and each counter in the "Deaths" breakdown
const { redis, hasHistory, slugOf } = require("./store");

const SNAPSHOT_KEY = "hk:snapshots";
const EVENTS_KEY = "hk:events";
const LOCK_KEY = "hk:changelog:lock";
const MAX_EVENTS = Number(process.env.CHANGELOG_MAX_EVENTS || 500);

// What we remember about a character. A value that failed to load this time (null)
// never overwrites the last good one, so a Blizzard hiccup can't invent a change.
function snapshotOf(row, previous = {}) {
  const snap = { ...previous };
  if (row.level != null) {
    // The profile loaded: level, item level and guild are all trustworthy.
    snap.level = row.level;
    if (row.itemLevel != null) snap.itemLevel = row.itemLevel;
    snap.guild = row.guild ?? null;
  }
  if (row.honorableKills != null) snap.honorableKills = row.honorableKills;
  if (row.pvpDeaths != null) snap.pvpDeaths = row.pvpDeaths;
  if (row.killingBlows != null) snap.killingBlows = row.killingBlows;
  if (row.killingBlowsPvp != null) snap.killingBlowsPvp = row.killingBlowsPvp;
  if (row.killingBlowsPve != null) snap.killingBlowsPve = row.killingBlowsPve;
  if (row.pveDeaths != null) {
    // The achievement statistics loaded, so the death counters are trustworthy.
    snap.pveDeaths = row.pveDeaths;
    snap.breakdown = Object.fromEntries((row.deathBreakdown || []).filter((d) => !d.derived).map((d) => [d.name, d.quantity]));
  }
  return snap;
}

// Events for one character. No previous snapshot means a first sighting: nothing to compare.
function diffRow(previous, row, at) {
  if (!previous) return [];
  const events = [];
  const base = { t: at, name: row.name, surname: row.surname };
  const changed = (category, kind, label, before, after) => {
    if (before != null && after != null && before !== after) {
      events.push({ ...base, category, kind, label, from: before, to: after });
    }
  };

  if (row.level != null) {
    changed("character", "level", "Level", previous.level, row.level);
    changed("character", "itemLevel", "Item level", previous.itemLevel, row.itemLevel);
    if (previous.guild !== undefined && (previous.guild ?? null) !== (row.guild ?? null)) {
      events.push({
        ...base,
        category: "character",
        kind: "guild",
        label: "Guild",
        from: previous.guild ?? null,
        to: row.guild ?? null,
      });
    }
  }

  changed("pvp", "honorableKills", "Honorable kills", previous.honorableKills, row.honorableKills);
  changed("pvp", "pvpDeaths", "PvP deaths", previous.pvpDeaths, row.pvpDeaths);
  // With the PvP/PvE split known on both sides, log the two halves; the total would only repeat them.
  if (previous.killingBlowsPvp != null && row.killingBlowsPvp != null) {
    changed("pvp", "killingBlowsPvp", "PvP killing blows", previous.killingBlowsPvp, row.killingBlowsPvp);
    changed("pve", "killingBlowsPve", "PvE killing blows", previous.killingBlowsPve, row.killingBlowsPve);
  } else {
    changed("pvp", "killingBlows", "Killing blows", previous.killingBlows, row.killingBlows);
  }

  if (row.pveDeaths != null) {
    changed("pve", "pveDeaths", "PvE deaths", previous.pveDeaths, row.pveDeaths);
    if (previous.breakdown) {
      for (const d of (row.deathBreakdown || []).filter((x) => !x.derived)) {
        const before = previous.breakdown[d.name] ?? 0; // a counter that just appeared started at 0
        if (before !== d.quantity) {
          events.push({ ...base, category: "pve", kind: "deathDetail", label: d.name, from: before, to: d.quantity });
        }
      }
    }
  }
  return events;
}

async function readSnapshots() {
  const result = await redis(["HGETALL", SNAPSHOT_KEY]);
  const map = new Map();
  if (Array.isArray(result)) {
    for (let i = 0; i + 1 < result.length; i += 2) {
      try {
        map.set(result[i], JSON.parse(result[i + 1]));
      } catch {
        // ignore a corrupt snapshot; it gets rewritten below
      }
    }
  }
  return map;
}

// Called after each fresh refresh. Safe to call from several instances at once: a short
// lock plus comparing against the saved snapshot means each change is logged only once.
async function recordChanges(rows) {
  if (!hasHistory()) return { recorded: 0 };
  const locked = await redis(["SET", LOCK_KEY, "1", "EX", "30", "NX"]);
  if (locked !== "OK") return { recorded: 0, skipped: true };

  try {
    const snapshots = await readSnapshots();
    const at = new Date().toISOString();
    const events = [];
    const writes = [];
    for (const row of rows) {
      if (row.status !== "ok") continue;
      const slug = slugOf(row);
      const previous = snapshots.get(slug);
      events.push(...diffRow(previous, row, at));
      writes.push(slug, JSON.stringify(snapshotOf(row, previous)));
    }
    // Events first: if the snapshot write then fails we may log a change twice,
    // which is better than silently losing one.
    if (events.length) {
      await redis(["LPUSH", EVENTS_KEY, ...events.map((e) => JSON.stringify(e))]);
      await redis(["LTRIM", EVENTS_KEY, "0", String(MAX_EVENTS - 1)]);
    }
    if (writes.length) await redis(["HSET", SNAPSHOT_KEY, ...writes]);
    return { recorded: events.length };
  } finally {
    await redis(["DEL", LOCK_KEY]).catch(() => {});
  }
}

async function getChangelog() {
  const raw = await redis(["LRANGE", EVENTS_KEY, "0", "-1"]);
  const events = [];
  for (const item of raw || []) {
    try {
      events.push(JSON.parse(item));
    } catch {
      // skip a corrupt entry
    }
  }
  return events; // newest first
}

module.exports = { snapshotOf, diffRow, recordChanges, getChangelog };
