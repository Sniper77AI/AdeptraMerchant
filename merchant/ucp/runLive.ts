/**
 * Adeptra Merchant — Live end-to-end run.
 *
 * domain in → real /.well-known/ucp fetch (Category 1 + 3) + product feed
 * fetch (Category 2, if configured) → scorer → rows in analysis_runs /
 * signals / pillar_scores.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node --experimental-strip-types runLive.ts <domain> [site_id]
 *
 * If site_id is omitted, a dev client ("Adeptra Dev") + site row for the domain
 * are created/reused so the FK chain is satisfied without dashboard clicking.
 *
 * This file is the ONLY place that reads env vars. Everything it calls takes
 * explicit config — in n8n, a code node builds the same calls from credentials.
 */

import { runManifestChecks, isManifestMissing } from "./manifestChecks.ts";
import { runCapabilityChecks } from "./capabilityChecks.ts";
import { runFeedChecks, extractFeedVariants } from "./feedChecks.ts";
import { runPageConsistencyChecks } from "./pageChecks.ts";
import { httpFetcher } from "./httpFetcher.ts";
import { scorePillars, overallScore } from "./scorer.ts";
import {
  createRun,
  completeRun,
  failRun,
  markNoManifest,
  insertSignals,
  insertPillarScores,
  ensureDevSite,
  getSite,
  type SupabaseConfig,
} from "./supabaseSink.ts";

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

const siteId = siteIdArg ?? (await ensureDevSite(cfg, { clientName: "Adeptra Dev", domain }));
console.log(`site:  ${siteId}`);

const site = await getSite(cfg, siteId);

const run = await createRun(cfg, siteId);
console.log(`run:   ${run.runId} (running)`);

try {
  const { manifest, signals: manifestSignals } = await runManifestChecks(domain, httpFetcher);
  console.log(`fetch: ${manifest.url} → ${manifest.httpStatus ?? "unreachable"}${manifest.errorNote ? ` (${manifest.errorNote})` : ""}`);

  const capabilitySignals = await runCapabilityChecks(manifest, httpFetcher, {
    identityLinkingOptOut: site.identityLinkingOptOut,
  });
  const { feed, signals: feedSignals } = await runFeedChecks(site.feedUrl, httpFetcher, site.rootUrl ?? undefined);
  if (feed) {
    console.log(`feed:  ${feed.url} → ${feed.httpStatus ?? "unreachable"} (${feed.format}, ${feed.items.length} items)${feed.errorNote ? ` (${feed.errorNote})` : ""}`);
  }
  const feedVariants = feed ? extractFeedVariants(feed) : [];
  const pageSignals = await runPageConsistencyChecks(feedVariants, httpFetcher);
  if (feedVariants.length > 0) {
    console.log(`pages: sampled up to 15 of ${feedVariants.length} feed variants for id/price/availability cross-check`);
  }
  const signals = [...manifestSignals, ...capabilitySignals, ...feedSignals, ...pageSignals];

  const nSignals = await insertSignals(cfg, run.runId, signals);
  const pillars = scorePillars(signals);
  const nPillars = await insertPillarScores(cfg, run.runId, pillars);
  const overall = overallScore(pillars);

  const noManifest = isManifestMissing(manifest);
  if (noManifest) {
    await markNoManifest(cfg, run.runId);
  } else {
    await completeRun(cfg, run.runId, overall);
  }

  console.log(`wrote: ${nSignals} signals, ${nPillars} pillar score(s)`);
  for (const p of pillars) {
    console.log(`score: ${p.pillar} = ${p.score}% (${p.signals_passed}/${p.signals_total} passed)`);
  }
  console.log(`run:   ${run.runId} (${noManifest ? "no_manifest" : `complete, overall ${overall}`})`);
} catch (e) {
  const msg = (e as Error).message ?? String(e);
  await failRun(cfg, run.runId, msg).catch(() => undefined);
  console.error(`run:   ${run.runId} (failed) — ${msg}`);
  process.exit(1);
}
