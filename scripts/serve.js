// Tiny local server for testing without Vercel: serves public/ and runs the
// same api/leaderboard.js handler. Start it with:  npm run dev
// then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");
const handler = require("../api/leaderboard");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "..", "public");

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/api/leaderboard") {
      // Vercel adds these helpers to the response; mimic them here.
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
