// POST   /api/characters  { name, surname, passcode }  -> add a character
// DELETE /api/characters  { name, surname, passcode }  -> remove one that was added here
// Both use the shared ADMIN_PASSCODE. Characters in characters.json can't be removed this way.
const { fetchCharacter } = require("../lib/blizzard");
const {
  MAX_CHARACTERS,
  slugOf,
  canAdd,
  getAllCharacters,
  isCore,
  addStored,
  removeStored,
  allowAttempt,
  passcodeMatches,
} = require("../lib/store");

// Forever names are letters (accents allowed) with the odd apostrophe or hyphen.
const NAME_RE = /^[\p{L}][\p{L}'’-]{1,23}$/u;

const clean = (v) => String(v ?? "").trim();

function readBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function visitorId(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return String(req.headers?.["x-real-ip"] || forwarded || "unknown");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Use POST to add a character." });
  }
  if (!canAdd()) {
    return res.status(501).json({ error: "Adding characters isn't set up on this site yet." });
  }

  const body = readBody(req);
  const name = clean(body.name);
  const surname = clean(body.surname);

  try {
    // Counts every attempt, so guessing the passcode (or spamming Blizzard lookups) is capped.
    if (!(await allowAttempt(visitorId(req)))) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    if (!passcodeMatches(body.passcode, process.env.ADMIN_PASSCODE)) {
      return res.status(401).json({ error: "Wrong passcode." });
    }

    const slug = slugOf({ name, surname });

    if (req.method === "DELETE") {
      if (isCore(slug)) {
        return res.status(400).json({ error: "That character is in characters.json. Remove it there." });
      }
      if (!(await removeStored(slug))) {
        return res.status(404).json({ error: "That character isn't in the added list." });
      }
      return res.status(200).json({ removed: true });
    }

    if (!NAME_RE.test(name) || !NAME_RE.test(surname)) {
      return res.status(400).json({ error: "Enter the character's first name and surname (letters only)." });
    }

    const all = await getAllCharacters();
    if (all.some((c) => slugOf(c) === slug)) {
      return res.status(409).json({ error: "That character is already on the leaderboard." });
    }
    if (all.length >= MAX_CHARACTERS) {
      return res.status(400).json({ error: `The leaderboard is full (${MAX_CHARACTERS} characters).` });
    }

    // Only save characters Blizzard actually knows, which catches typos.
    const row = await fetchCharacter(name, surname);
    if (row.status === "not_found") {
      return res.status(404).json({
        error:
          "Blizzard can't find that character. Check the spelling. Characters only appear from level 10, after logging out once.",
      });
    }
    if (row.status !== "ok") {
      return res.status(502).json({ error: "Couldn't reach Blizzard just now. Try again in a minute." });
    }

    // Save it the way Blizzard spells it, whatever capitalisation was typed.
    await addStored({ name: row.name, surname: row.surname });
    return res.status(201).json({ row });
  } catch (err) {
    console.error("api/characters failed:", err);
    return res.status(500).json({ error: "Something went wrong saving that. Try again." });
  }
};
