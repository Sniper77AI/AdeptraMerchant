/**
 * Adeptra Merchant — Bundle proxy route (Vercel-shaped, runs locally today).
 *
 * GET /api/bundle/<runId> — the paid deliverable. Checks isEntitled() BEFORE
 * fetching anything from Storage; returns 402 when not entitled. Today
 * isEntitled() (pipeline.ts) is a stub that always returns true — billing
 * hasn't landed, so this route is fully usable now, but the seam is here:
 * see pipeline.ts's isEntitled() for exactly what the real check should
 * query once it does. This route intentionally does the check itself
 * (rather than folding it into getBundleBytes) so entitlement is enforced
 * at the one place a client can actually reach the bytes.
 *
 * Fetches bundle.zip from the merchant-exports Storage bucket server-side
 * (service-role key, via pipeline.ts's getBundleBytes — never a signed
 * Storage URL handed to the client) and re-serves it.
 *
 * File name follows Vercel's [param].ts dynamic-route convention (see
 * report/[runId].ts for the full explanation).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getBundleBytes, isEntitled, RunNotFoundError, BundleNotFoundError } from "../../ucp/pipeline.ts";
import type { SupabaseConfig } from "../../ucp/supabaseSink.ts";

try {
  process.loadEnvFile(`${(import.meta as any).dirname}/../../../.env`);
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

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

export interface BundleDeps {
  getBundleBytes: typeof getBundleBytes;
  isEntitled: typeof isEntitled;
}

const defaultDeps: BundleDeps = { getBundleBytes, isEntitled };

export function createHandler(deps: BundleDeps = defaultDeps) {
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
      const entitled = await deps.isEntitled({ runId, config: cfg });
      if (!entitled) {
        sendJson(res, 402, { error: "payment required — this fix bundle is a paid deliverable" });
        return;
      }

      const { bytes, filename } = await deps.getBundleBytes({ runId, config: cfg });
      res.statusCode = 200;
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${filename}"`);
      res.end(bytes);
    } catch (e) {
      if (e instanceof RunNotFoundError || e instanceof BundleNotFoundError) {
        sendJson(res, 404, { error: e.message });
        return;
      }
      sendJson(res, 500, { error: (e as Error).message ?? String(e) });
    }
  };
}

export default createHandler();
