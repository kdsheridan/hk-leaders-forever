// Prints the achievement statistics whose name or category matches a word, so you can see
// exactly how Blizzard names things for a character. Handy if a column comes up empty.
//
//   npm run probe                          killing blow / kill counters for Dtach Dtach
//   npm run probe -- death                 any other word (a regular expression, case-insensitive)
//   npm run probe -- "kill|blow" Ren Wix   a different character: pattern, first name, surname
const { fetchAchievementStatistics } = require("../lib/blizzard");

async function main() {
  const [pattern = "kill|blow", name = "Dtach", surname = "Dtach"] = process.argv.slice(2);
  const re = new RegExp(pattern, "i");

  const { httpStatus, body } = await fetchAchievementStatistics(name, surname);
  if (httpStatus !== 200) throw new Error(`Blizzard answered HTTP ${httpStatus} for ${name} ${surname}`);

  let shown = 0;
  const walk = (categories, path) => {
    for (const category of categories || []) {
      const here = [...path, category.name];
      for (const stat of category.statistics || []) {
        if (re.test(`${here.join(" ")} ${stat.name}`)) {
          console.log(`${here.join(" > ")} | ${stat.name} = ${stat.quantity}   (id ${stat.id})`);
          shown++;
        }
      }
      walk(category.sub_categories, here);
    }
  };
  walk(body.categories, []);
  if (!shown) console.log(`Nothing matched "${pattern}" for ${name} ${surname}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
