// Looks through every public character endpoint for anything that looks like money, so we can
// tell whether Blizzard exposes a gold figure for Forever characters at all.
//
//   npm run hunt                      Dtach Dtach
//   npm run hunt -- Ren Wix           another character (first name, surname)
//
// Prints, per endpoint, the HTTP status and any key or value that mentions gold, money, coin,
// copper, silver, wealth, funds, cash, purse or balance. Item sell prices on equipment are
// ignored because they're a vendor value, not what the player holds.
const { apiGet } = require("../lib/blizzard");

const ENDPOINTS = [
  "", "/statistics", "/achievements", "/achievements/statistics", "/equipment", "/professions",
  "/quests", "/quests/completed", "/reputations", "/collections", "/encounters", "/pvp-summary",
  "/specializations", "/titles", "/appearance", "/character-media", "/status",
];
const MONEY = /gold|money|coin|copper|silver|wealth|fund|cash|purse|balance|currenc/i;

function scan(value, path, out, inEquipment) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (inEquipment && /sell_price/.test(`${path}.${k}`)) continue;
      scan(v, path ? `${path}.${k}` : k, out, inEquipment);
    }
    return;
  }
  if (MONEY.test(path) || (typeof value === "string" && MONEY.test(value))) {
    out.push(`${path} = ${JSON.stringify(value)}`);
  }
}

async function main() {
  const [name = "Dtach", surname = "Dtach"] = process.argv.slice(2);
  let any = false;
  for (const suffix of ENDPOINTS) {
    let result;
    try {
      result = await apiGet(name, surname, suffix);
    } catch (err) {
      console.log(`${suffix || "/"}  ->  failed: ${err.message}`);
      continue;
    }
    const hits = [];
    if (result.httpStatus === 200) scan(result.body, "", hits, suffix === "/equipment");
    console.log(`${suffix || "/"}  ->  HTTP ${result.httpStatus}` + (hits.length ? `, ${hits.length} money-like` : ""));
    for (const h of hits.slice(0, 15)) console.log("    " + h);
    if (hits.length) any = true;
  }
  console.log(any ? "\nSend me the indented lines above." : "\nNothing money-like in any public endpoint for this character.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
