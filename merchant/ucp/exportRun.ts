/**
 * Adeptra Merchant — Export a completed run into a merchant-ready bundle.
 *
 * Given a run_id: fetches everything reportBuilder.ts needs, builds the
 * report + zip file list (pure), zips it, uploads the zip + a standalone
 * report.html to Supabase Storage, signs both, and records an `exports` row.
 * Prints the two signed URLs.
 *
 * Usage (reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the repo-root
 * .env file automatically — see loadEnvFile() below):
 *   node --experimental-strip-types exportRun.ts <run_id>
 *
 * This file (and runLive.ts) are the ONLY places that read env vars.
 * Deliberately a separate command from runLive.ts — exporting isn't part of
 * every analysis run, it's a distinct "deliver this one" action.
 */

import { fetchRunBundleData, type SupabaseConfig } from "./supabaseSink.ts";
import { buildBundlePlan } from "./export/reportBuilder.ts";
import { uploadAndRecordExport } from "./export/storageSink.ts";

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

const data = await fetchRunBundleData(cfg, runId);
if (!data) {
  console.error(`run not found: ${runId}`);
  process.exit(1);
}
if (data.artifacts.length === 0) {
  console.error(`run ${runId} has no artifacts to export — nothing to deliver.`);
  process.exit(1);
}

console.log(`run:      ${data.runId} (${data.status}) — ${data.domain}`);
console.log(`artifacts: ${data.artifacts.length}`);

const plan = buildBundlePlan(data);
const result = await uploadAndRecordExport(cfg, data.siteId, data.domain, data.runId, plan, data.artifacts.length);

console.log(`export:   ${result.exportId}`);
console.log(`report page:  ${result.reportUrl}`);
console.log(`download zip: ${result.bundleUrl}`);
