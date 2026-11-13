// Tiny local server for testing without Vercel: serves public/ and runs the same
// api/ handlers. Start it with:  npm run dev
// then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "..", "public");
const ROUTES = {
  "/api/leaderboard": require("../api/leaderboard"),
  "/api/characters": require("../api/characters"),
  "/api/changelog": require("../api/changelog"),
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(raw); // handler reports invalid JSON
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    const handler = ROUTES[pathname];
    if (handler) {
      // Vercel adds these helpers to req/res; mimic them here.
      req.body = await readJsonBody(req);
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (data) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      };
      return handler(req, res);
    }

    const file = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream"
    );
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`Leaderboard running at http://localhost:${PORT}`));
