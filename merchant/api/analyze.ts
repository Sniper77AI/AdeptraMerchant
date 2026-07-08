/**
 * Adeptra Merchant — Intake endpoint (Vercel-shaped, runs locally today).
 *
 * A plain Node http-compatible handler: `(req: IncomingMessage, res:
 * ServerResponse) => Promise<void>`, using only node:http types — no
 * `@vercel/node` package. Vercel's Node.js runtime is documented-compatible
 * with plain Node http handlers directly, so deploying this later (with the
 * Vercel project root set to merchant/, so this file maps to /api/analyze)
 * is a config flip, not a rewrite. The request body is read manually from
 * the raw stream + JSON.parse'd — portable to both local and Vercel, and
 * avoids depending on Vercel's req.body convenience sugar that a plain local
 * http server doesn't have.
 *
 * Flow: validate input → ensureSiteFromIntake → runAnalysis → runExport →
 * respond JSON. A store that's already fully compliant can legitimately
 * produce zero artifacts (every generator correctly returns null) — that's
 * good news, not a request failure, so NoArtifactsError from runExport still
 * yields a 200 with reportUrl/bundleUrl: null and a note, not an error.
 *
 * createHandler(deps) exists for testability: tests inject fake pipeline
 * functions without needing a module-mocking framework (this project has
 * none) — the default export used by serve.ts / Vercel is createHandler()
 * with the real pipeline.ts functions.
 *
 * This file (with runLive.ts and exportRun.ts) reads env vars — same names
 * as .env today (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureSiteFromIntake, runAnalysis, runExport, NoArtifactsError } from "../ucp/pipeline.ts";
import type { SupabaseConfig } from "../ucp/supabaseSink.ts";

// Resolved relative to this file (not cwd), same pattern as runLive.ts/
// exportRun.ts. Missing .env is not an error — falls back to whatever's
// already in the process environment (e.g. Vercel's injected env vars).
try {
  process.loadEnvFile(`${(import.meta as any).dirname}/../../.env`);
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(text);
}

export interface PipelineDeps {
  ensureSiteFromIntake: typeof ensureSiteFromIntake;
  runAnalysis: typeof runAnalysis;
  runExport: typeof runExport;
}

const defaultDeps: PipelineDeps = { ensureSiteFromIntake, runAnalysis, runExport };

export function createHandler(deps: PipelineDeps = defaultDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed — POST only" });
      return;
    }

    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!rawUrl) {
      sendJson(res, 400, { error: "url is required" });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    } catch {
      sendJson(res, 400, { error: "url is not a valid URL" });
      return;
    }
    const domain = parsed.host;
    const rootUrl = parsed.origin;

    const platform = typeof body.platform === "string" ? body.platform.trim() : "";
    if (!platform) {
      sendJson(res, 400, { error: "platform is required" });
      return;
    }

    const cfgUrl = process.env.SUPABASE_URL ?? "";
    const cfgKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!cfgUrl || !cfgKey) {
      sendJson(res, 500, { error: "server misconfigured — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set" });
      return;
    }
    const cfg: SupabaseConfig = { url: cfgUrl, serviceRoleKey: cfgKey };
    const openAiKey = process.env.OPENAI_API_KEY;

    try {
      const { siteId } = await deps.ensureSiteFromIntake({
        config: cfg,
        clientName: typeof body.clientName === "string" && body.clientName.trim() ? body.clientName.trim() : undefined,
        domain,
        rootUrl,
        platform,
        feedUrl: typeof body.feedUrl === "string" && body.feedUrl.trim() ? body.feedUrl.trim() : undefined,
        identityLinkingOptOut: typeof body.identityLinkingOptOut === "boolean" ? body.identityLinkingOptOut : undefined,
        merchantCenter: body.merchantCenter && typeof body.merchantCenter === "object" ? body.merchantCenter : undefined,
      });

      const analysis = await deps.runAnalysis({ domain, siteId, config: cfg, openAiKey });

      if (analysis.status === "failed") {
        sendJson(res, 500, { error: analysis.error ?? "analysis failed", runId: analysis.runId });
        return;
      }

      let reportUrl: string | null = null;
      let bundleUrl: string | null = null;
      let note: string | undefined;
      try {
        const exported = await deps.runExport({ runId: analysis.runId, config: cfg });
        reportUrl = exported.reportUrl;
        bundleUrl = exported.bundleUrl;
      } catch (e) {
        if (e instanceof NoArtifactsError) {
          note = "Analysis complete — no fixes needed, nothing to export.";
        } else {
          throw e;
        }
      }

      sendJson(res, 200, {
        runId: analysis.runId,
        status: analysis.status,
        overallScore: analysis.overallScore,
        artifactTypes: analysis.artifactTypes,
        reportUrl,
        bundleUrl,
        ...(note ? { note } : {}),
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? String(e) });
    }
  };
}

export default createHandler();
