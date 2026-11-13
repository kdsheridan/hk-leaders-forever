const { getChangelog } = require("../lib/changelog");
const { hasHistory } = require("../lib/store");

// GET /api/changelog -> { enabled, events } with the newest event first.
// Events only change when the leaderboard refreshes, so a minute of edge caching is plenty.
module.exports = async (req, res) => {
  if (!hasHistory()) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ enabled: false, events: [] });
  }
  try {
    const events = await getChangelog();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ enabled: true, events });
  } catch (err) {
    console.error("api/changelog failed:", err);
    res.setHeader("Cache-Control", "public, s-maxage=10");
    return res.status(502).json({ error: "Couldn't load the changelog right now." });
  }
};
