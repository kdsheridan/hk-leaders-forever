const characters = require("../characters.json");
const { getCachedLeaderboard, CACHE_TTL_SECONDS } = require("../lib/blizzard");

// Caching happens in two layers:
//   1. Vercel's edge, via the Cache-Control header below (shared by all visitors).
//   2. A per-instance memory cache inside getCachedLeaderboard (see lib/blizzard.js).
// Blizzard data is a snapshot from each character's last logout, so a few minutes
// of caching costs nothing. The query string is ignored on purpose: ?x=123 can't
// force a fresh round of Blizzard calls.
module.exports = async (req, res) => {
  try {
    const { rows, fetchedAt, stale } = await getCachedLeaderboard(characters);
    res.setHeader(
      "Cache-Control",
      stale
        ? "public, s-maxage=30" // old data: check back soon
        : `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS * 2}`
    );
    res.status(200).json({
      updatedAt: new Date(fetchedAt).toISOString(),
      stale,
      rows,
    });
  } catch (err) {
    // Short edge cache so a Blizzard outage can't turn every page view into API calls.
    res.setHeader("Cache-Control", "public, s-maxage=10");
    res.status(502).json({ error: err.message });
  }
};
