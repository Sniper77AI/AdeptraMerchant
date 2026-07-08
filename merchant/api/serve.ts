/**
 * Adeptra Merchant — Local dev server for the intake endpoint (no deployment
 * here; this is purely so merchant/api/analyze.ts is runnable on your own
 * machine before there's ever a Vercel project). Zero dependencies — just
 * node:http, routing GET / (and /index.html) to the static intake form and
 * POST /api/analyze to the real handler.
 *
 * Usage: node --experimental-strip-types serve.ts
 * Then open the printed URL in a browser.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import handler from "./analyze.ts";

const PORT = Number(process.env.PORT) || 3000;
const FORM_PATH = `${(import.meta as any).dirname}/public/index.html`;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = await readFile(FORM_PATH, "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    } catch {
      res.statusCode = 500;
      res.end("could not read the intake form");
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/analyze") {
    await handler(req, res);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Adeptra Merchant intake running at http://localhost:${PORT}`);
});
