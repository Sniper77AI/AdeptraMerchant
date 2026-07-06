/**
 * Adeptra Merchant — Live end-to-end run.
 *
 * domain in → real /.well-known/ucp fetch (Category 1 + 3 + 4) + product feed
 * fetch + page cross-check + LLM checks (Category 2, if configured) + policy/
 * contact page probes (Category 5) + Merchant Center readiness checklist
 * (Category 6, self-attested — not scored into the % score) → scorer → rows
 * in analysis_runs / signals / pillar_scores.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   OPENAI_API_KEY=...  (optional — enables the 2 LLM-scored signals) \
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
import { runLlmChecks, openAiClient, type LlmClient } from "./llmChecks.ts";
import { runPolicyChecks } from "./policyChecks.ts";
import { runPaymentChecks } from "./paymentChecks.ts";
import { runReadinessChecks } from "./readinessChecks.ts";
import { runArtifacts } from "./artifacts/index.ts";
import { httpFetcher } from "./httpFetcher.ts";
import { scorePillars, overallScore } from "./scorer.ts";
import {
  createRun,
  completeRun,
  failRun,
  markNoManifest,
  insertSignals,
  insertPillarScores,
  insertArtifacts,
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

// Optional: title_description_consistency / discovery_attributes_enrichment
// degrade to not_applicable (not fail) when this isn't set.
const openAiKey = process.env.OPENAI_API_KEY;
const llm: LlmClient | null = openAiKey ? openAiClient(openAiKey) : null;

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
  const llmSignals = await runLlmChecks(feed, httpFetcher, llm);
  if (!llm) {
    console.log("llm:   OPENAI_API_KEY not set — title_description_consistency / discovery_attributes_enrichment skipped (not_applicable)");
  } else if (feed && feed.items.length > 0) {
    console.log(`llm:   sampled up to 5 of ${feed.items.length} feed products for title/description + attribute-richness checks`);
  }
  const policySignals = await runPolicyChecks(site.rootUrl ?? `https://${domain}`, httpFetcher);
  const paymentSignals = runPaymentChecks(manifest);
  const readinessSignals = runReadinessChecks({
    accountReady: site.merchantCenterAccountReady,
    feedsConfigured: site.merchantCenterFeedsConfigured,
    earlyAccessStatus: site.ucpEarlyAccessStatus,
  });
  const signals = [
    ...manifestSignals,
    ...capabilitySignals,
    ...feedSignals,
    ...pageSignals,
    ...llmSignals,
    ...policySignals,
    ...paymentSignals,
    ...readinessSignals,
  ];

  const insertedSignals = await insertSignals(cfg, run.runId, signals);
  const signalKeyToId = new Map(insertedSignals.map((s) => [s.signal_key, s.id]));
  const pillars = scorePillars(signals);
  const nPillars = await insertPillarScores(cfg, run.runId, pillars);
  const overall = overallScore(pillars);

  const drafts = runArtifacts(manifest, signals);
  const insertedArtifacts = await insertArtifacts(cfg, run.runId, siteId, drafts, signalKeyToId);

  const noManifest = isManifestMissing(manifest);
  if (noManifest) {
    await markNoManifest(cfg, run.runId);
  } else {
    await completeRun(cfg, run.runId, overall);
  }

  console.log(`wrote: ${insertedSignals.length} signals, ${nPillars} pillar score(s)`);
  for (const p of pillars) {
    console.log(`score: ${p.pillar} = ${p.score}% (${p.signals_passed}/${p.signals_total} passed)`);
  }
  console.log(`artifacts: ${insertedArtifacts.length} generated`);
  for (const draft of drafts) {
    const c = draft.changelog;
    console.log(`  ${draft.artifact_type}: +${c.added.length} added, ~${c.corrected.length} corrected, ${c.must_complete.length} must-complete, ${c.flagged.length} flagged`);
    if (c.must_complete.length > 0) {
      console.log(`  must complete:`);
      for (const item of c.must_complete) console.log(`    - ${item}`);
    }
    // TODO: artifacts table has no changelog column yet — printing only here.
    // Add one (e.g. a changelog JSONB column) when the dashboard needs it.
    console.log(`  changelog (not yet persisted): ${JSON.stringify(c)}`);
  }
  console.log(`run:   ${run.runId} (${noManifest ? "no_manifest" : `complete, overall ${overall}`})`);
} catch (e) {
  const msg = (e as Error).message ?? String(e);
  await failRun(cfg, run.runId, msg).catch(() => undefined);
  console.error(`run:   ${run.runId} (failed) — ${msg}`);
  process.exit(1);
}
