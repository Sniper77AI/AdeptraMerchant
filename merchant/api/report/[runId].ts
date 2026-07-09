/**
 * Adeptra Merchant — Report proxy route (Vercel-shaped, runs locally today).
 *
 * GET /api/report/<runId> — fetches report.html from the merchant-exports
 * Storage bucket server-side (service-role key, via pipeline.ts's
 * getReportHtml — never a signed Storage URL handed to the client) and
 * re-serves it with the correct Content-Type.
 *
 * THIS ROUTE IS THE ACTUAL FIX for a real bug: Supabase Storage deliberately
 * forces `Content-Type: text/plain` plus a sandboxed CSP on any HTML object
 * it serves directly (an anti-phishing platform policy — confirmed via
 * Supabase's own GitHub discussions; there's no bypass via upload headers).
 * Uploading report.html with the "right" Content-Type never worked because
 * of this — proxying it through our own server is the only way to actually
 * render it in a browser.
 *
 * The report is free and instant — no entitlement check here. Compare
 * bundle/[runId].ts, which gates on isEntitled() because the fix bundle is
 * the paid deliverable and this route is where that will eventually live.
 *
 * File name follows Vercel's [param].ts dynamic-route convention so this
 * maps to /api/report/:runId with zero code changes once deployed (Vercel
 * project root set to merchant/). Locally, serve.ts does the equivalent
 * routing by hand (this project has no Vercel dev server dependency).
 *
 * createHandler(deps) exists for testability (dependency injection, no
 * mocking framework needed) — the default export used by serve.ts/Vercel is
 * createHandler() with the real pipeline.ts functions.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getReportHtml, RunNotFoundError, ReportNotFoundError } from "../../ucp/pipeline.ts";
import type { SupabaseConfig } from "../../ucp/supabaseSink.ts";

// Resolved relative to this file (not cwd), same pattern as the other
// entrypoints. Missing .env is not an error — falls back to whatever's
// already in the process environment (e.g. Vercel's injected env vars).
try {
  process.loadEnvFile(`${(import.meta as any).dirname}/../../../.env`);
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

/** Extracts the last path segment as the run id — works whether this handler
 *  is invoked via our own hand-rolled local router (serve.ts, passing the
 *  raw req.url) or via Vercel's routing (also a real req.url); avoids
 *  depending on Vercel's req.query convenience sugar a local server doesn't have. */
function runIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] || null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export interface ReportDeps {
  getReportHtml: typeof getReportHtml;
}

const defaultDeps: ReportDeps = { getReportHtml };

export function createHandler(deps: ReportDeps = defaultDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed — GET only" });
      return;
    }

    const runId = runIdFromUrl(req.url);
    if (!runId) {
      sendJson(res, 400, { error: "run id is required" });
      return;
    }

    const cfgUrl = process.env.SUPABASE_URL ?? "";
    const cfgKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!cfgUrl || !cfgKey) {
      sendJson(res, 500, { error: "server misconfigured — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set" });
      return;
    }
    const cfg: SupabaseConfig = { url: cfgUrl, serviceRoleKey: cfgKey };

    try {
      const html = await deps.getReportHtml({ runId, config: cfg });
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-disposition", "inline");
      res.end(html);
    } catch (e) {
      if (e instanceof RunNotFoundError || e instanceof ReportNotFoundError) {
        sendJson(res, 404, { error: e.message });
        return;
      }
      sendJson(res, 500, { error: (e as Error).message ?? String(e) });
    }
  };
}

export default createHandler();
