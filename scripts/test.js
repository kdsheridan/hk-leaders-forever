// Quick local check, no Vercel needed:
//   node --env-file=.env.local scripts/test.js         -> leaderboard table
//   node --env-file=.env.local scripts/test.js raw     -> raw pvp-summary JSON per character
const { fetchPvpSummary, getLeaderboard } = require("../lib/blizzard");
const { getAllCharacters } = require("../lib/store");

async function main() {
  // characters.json plus anyone added through the website (when Redis is configured).
  const characters = await getAllCharacters();
  if (process.argv[2] === "raw") {
    for (const c of characters) {
      const { httpStatus, body } = await fetchPvpSummary(c.name, c.surname);
      console.log(`\n${c.name} ${c.surname} -> HTTP ${httpStatus}`);
      console.log(JSON.stringify(body, null, 2));
    }
    return;
  }
  console.table(await getLeaderboard(characters));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
