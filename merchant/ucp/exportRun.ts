/**
 * Adeptra Merchant — Export a completed run into a merchant-ready bundle
 * (thin CLI wrapper around pipeline.ts).
 *
 * Given a run_id: fetches everything reportBuilder.ts needs, builds the
 * report + zip file list (pure), zips it, uploads the zip + a standalone
 * report.html to Supabase Storage, signs both, and records an `exports` row.
 * Prints the two signed URLs.
 *
 * This file only does argv/env/console concerns; the actual pipeline
 * (runExport) is a plain function in pipeline.ts, callable the same way by
 * the HTTP intake endpoint (merchant/api/analyze.ts) or a future agent caller.
 *
 * Usage (reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the repo-root
 * .env file automatically — see loadEnvFile() below):
 *   node --experimental-strip-types exportRun.ts <run_id>
 *
 * This file (with runLive.ts and merchant/api/analyze.ts) reads env vars.
 * Deliberately a separate command from runLive.ts — exporting isn't part of
 * every analysis run, it's a distinct "deliver this one" action.
 */

import type { SupabaseConfig } from "./supabaseSink.ts";
import { runExport, RunNotFoundError, NoArtifactsError } from "./pipeline.ts";

// Resolved relative to this file (not cwd) so `.env` loads correctly whether
// this is run from the repo root or from merchant/ucp/. Missing .env is not
// an error — falls back to whatever's already in the shell environment.
try {
  process.loadEnvFile(`${(import.meta as any).dirname}/../../.env`);
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

const [runId] = process.argv.slice(2);
if (!runId) {
  console.error("usage: exportRun.ts <run_id>");
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

try {
  const result = await runExport({ runId, config: cfg });
  console.log(`run:      ${result.runId} (${result.status}) — ${result.domain}`);
  console.log(`artifacts: ${result.artifactCount}`);
  console.log(`export:   ${result.exportId}`);
  console.log(`report page:  ${result.reportUrl}`);
  console.log(`download zip: ${result.bundleUrl}`);
} catch (e) {
  if (e instanceof RunNotFoundError) {
    console.error(`run not found: ${runId}`);
  } else if (e instanceof NoArtifactsError) {
    console.error(`run ${runId} has no artifacts to export — nothing to deliver.`);
  } else {
    console.error((e as Error).message ?? String(e));
  }
  process.exit(1);
}
