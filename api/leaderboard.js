const { getCachedLeaderboard, EDGE_TTL_SECONDS } = require("../lib/blizzard");
const { getAllCharacters, canAdd, hasHistory } = require("../lib/store");
const { recordChanges } = require("../lib/changelog");

// Caching happens in two layers:
//   1. Vercel's edge, via the Cache-Control header below (shared by all visitors).
//      Kept short (see EDGE_TTL_SECONDS) so added characters appear within a minute.
//   2. A per-instance memory cache inside getCachedLeaderboard (see lib/blizzard.js).
//      This is the layer that protects Blizzard's API.
// The query string is ignored on purpose: ?x=123 can't force a fresh round of Blizzard calls.

let lastRecorded = 0; // fetchedAt of the refresh we last logged changes for

module.exports = async (req, res) => {
  try {
    // characters.json plus anyone added through the website.
    const characters = await getAllCharacters();
    const { rows, fetchedAt, stale } = await getCachedLeaderboard(characters);

    // Log what changed since the last refresh. The changelog must never break the leaderboard.
    if (!stale && fetchedAt !== lastRecorded) {
      lastRecorded = fetchedAt;
      try {
        await recordChanges(rows);
      } catch (err) {
        console.error("Could not record changes:", err.message);
      }
    }

    res.setHeader(
      "Cache-Control",
      stale
        ? "public, s-maxage=30" // old data: check back soon
        : `public, s-maxage=${EDGE_TTL_SECONDS}, stale-while-revalidate=${EDGE_TTL_SECONDS * 2}`
    );
    res.status(200).json({
      updatedAt: new Date(fetchedAt).toISOString(),
      stale,
      canAdd: canAdd(),
      hasHistory: hasHistory(),
      rows,
    });
  } catch (err) {
    // Short edge cache so a Blizzard outage can't turn every page view into API calls.
    res.setHeader("Cache-Control", "public, s-maxage=10");
    res.status(502).json({ error: err.message });
  }
};
