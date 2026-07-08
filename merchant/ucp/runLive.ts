/**
 * Adeptra Merchant — Live end-to-end run (thin CLI wrapper around pipeline.ts).
 *
 * domain in → real /.well-known/ucp fetch (Category 1 + 3 + 4) + product feed
 * fetch + page cross-check + LLM checks (Category 2, if configured) + policy/
 * contact page probes (Category 5) + Merchant Center readiness checklist
 * (Category 6, self-attested — not scored into the % score) → scorer →
 * artifact generation (ucp_manifest + feed_fix + content_rewrite + mcp_scaffold,
 * from the shared ArtifactContext) → rows in analysis_runs / signals /
 * pillar_scores / artifacts.
 *
 * This file only does argv/env/console concerns; the actual pipeline
 * (runAnalysis) is a plain function in pipeline.ts, callable the same way by
 * the HTTP intake endpoint (merchant/api/analyze.ts) or a future agent caller.
 *
 * Usage (reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY from
 * the repo-root .env file automatically — see loadEnvFile() below):
 *   node --experimental-strip-types runLive.ts <domain> [site_id]
 *
 * OPENAI_API_KEY is optional — enables the 2 LLM-scored signals; unset, they
 * degrade to not_applicable.
 *
 * If site_id is omitted, a dev client ("Adeptra Dev") + site row for the domain
 * are created/reused so the FK chain is satisfied without dashboard clicking.
 *
 * This file is one of the places that reads env vars (with exportRun.ts and
 * merchant/api/analyze.ts). Everything it calls takes explicit config — in
 * n8n, a code node builds the same calls from credentials.
 */

import { ensureDevSite, type SupabaseConfig } from "./supabaseSink.ts";
import { runAnalysis } from "./pipeline.ts";

// Resolved relative to this file (not cwd) so `.env` loads correctly whether
// this is run from the repo root or from merchant/ucp/. Missing .env is not
// an error — falls back to whatever's already in the shell environment.
try {
  process.loadEnvFile(`${(import.meta as any).dirname}/../../.env`);
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

const [domain, siteIdArg] = process.argv.slice(2);
if (!domain) {
  console.error("usage: runLive.ts <domain> [site_id]");
  process.exit(1);
}

const cfg: SupabaseConfig = {
  url: process.env.SUPABASE_URL ?? "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
};
if (!cfg.url || !cfg.serviceRoleKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const openAiKey = process.env.OPENAI_API_KEY;

const siteId = siteIdArg ?? (await ensureDevSite(cfg, { clientName: "Adeptra Dev", domain }));
console.log(`site:  ${siteId}`);

const result = await runAnalysis({ domain, siteId, config: cfg, openAiKey, onLog: console.log });

if (result.status === "failed") {
  console.error(`run:   ${result.runId} (failed) — ${result.error}`);
  process.exit(1);
}

if (result.artifactCount > 0) {
  console.log(`\nTo export this run: node exportRun.ts ${result.runId}`);
}
