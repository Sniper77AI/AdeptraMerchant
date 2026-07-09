/**
 * Adeptra Merchant — Local dev server for the intake + delivery endpoints (no
 * deployment here; this is purely so merchant/api/*.ts is runnable on your
 * own machine before there's ever a Vercel project). Zero dependencies —
 * just node:http, hand-rolling the path-param routing Vercel's [runId].ts
 * file convention gets for free once actually deployed.
 *
 * Usage: node --experimental-strip-types serve.ts
 * Then open the printed URL in a browser.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import analyzeHandler from "./analyze.ts";
import reportHandler from "./report/[runId].ts";
import bundleHandler from "./bundle/[runId].ts";

const PORT = Number(process.env.PORT) || 3000;
const FORM_PATH = `${(import.meta as any).dirname}/public/index.html`;

const server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
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
  if (req.method === "POST" && path === "/api/analyze") {
    await analyzeHandler(req, res);
    return;
  }
  if (req.method === "GET" && path.startsWith("/api/report/")) {
    await reportHandler(req, res);
    return;
  }
  if (req.method === "GET" && path.startsWith("/api/bundle/")) {
    await bundleHandler(req, res);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Adeptra Merchant intake running at http://localhost:${PORT}`);
});
