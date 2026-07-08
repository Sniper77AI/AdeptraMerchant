/**
 * Adeptra Merchant — Callable pipeline (no process.argv / process.exit /
 * console.log in here). The same engine driven by three callers today:
 * a human via runLive.ts/exportRun.ts (thin CLI wrappers around this file),
 * an HTTP form via merchant/api/analyze.ts, and later an agent (n8n/agentic
 * org) calling these same functions directly.
 *
 * Three operations:
 *   ensureSiteFromIntake — real client+site rows for a fresh intake submission
 *     (NOT the "Adeptra Dev" shortcut in supabaseSink.ts's ensureDevSite).
 *   runAnalysis — the exact body of what runLive.ts used to do inline: checks
 *     → signals → score → artifacts → persist → complete/no_manifest. Returns
 *     a result value; never process.exit — on error it marks the run failed
 *     and RETURNS {status:"failed", error}, so callers (CLI, HTTP endpoint,
 *     future agent) each decide how to surface that.
 *   runExport — the exact body of what exportRun.ts used to do inline: fetch
 *     → build bundle plan → upload/sign → record. Throws typed errors
 *     (RunNotFoundError, NoArtifactsError) for the caller to handle.
 */

import { runManifestChecks, isManifestMissing } from "./manifestChecks.ts";
import { runCapabilityChecks } from "./capabilityChecks.ts";
import { runFeedChecks, extractFeedVariants } from "./feedChecks.ts";
import { runPageConsistencyChecks } from "./pageChecks.ts";
import { runLlmChecks, openAiClient, type LlmClient } from "./llmChecks.ts";
import { runPolicyChecks } from "./policyChecks.ts";
import { runPaymentChecks } from "./paymentChecks.ts";
import { runReadinessChecks } from "./readinessChecks.ts";
import { runArtifacts, type ArtifactContext } from "./artifacts/index.ts";
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
  getSite,
  fetchRunBundleData,
  ensureClient,
  upsertIntakeSite,
  type SupabaseConfig,
} from "./supabaseSink.ts";
import { buildBundlePlan } from "./export/reportBuilder.ts";
import { uploadAndRecordExport } from "./export/storageSink.ts";

// ---------------------------------------------------------------------------
// Intake — real client + site rows (not the ensureDevSite dev shortcut)
// ---------------------------------------------------------------------------

export interface IntakeInput {
  config: SupabaseConfig;
  clientName?: string;
  domain: string;
  rootUrl?: string;
  platform?: string;
  feedUrl?: string;
  identityLinkingOptOut?: boolean;
  merchantCenter?: {
    accountReady?: boolean;
    feedsConfigured?: boolean;
    earlyAccessStatus?: "not_applied" | "pending" | "approved";
  };
}

export async function ensureSiteFromIntake(input: IntakeInput): Promise<{ siteId: string }> {
  // Pre-auth behavior: there's no logged-in account yet for an intake
  // submission to attach to, so a "client" has to come from somewhere. A
  // shared placeholder name (e.g. "Adeptra Intake") would incorrectly bucket
  // every unrelated merchant's site under one client via ensureClient's
  // reuse-by-name lookup — defaulting to the submitted domain itself keeps
  // each anonymous submission isolated. This is a documented seam for the
  // dashboard/auth era, not a permanent design: once real accounts exist,
  // callers should pass the actual client's name (or an existing client_id)
  // instead of relying on this default.
  const clientName = input.clientName ?? input.domain;
  const rootUrl = input.rootUrl ?? `https://${input.domain}`;

  const clientId = await ensureClient(input.config, clientName);
  const siteId = await upsertIntakeSite(input.config, clientId, {
    domain: input.domain,
    rootUrl,
    platform: input.platform,
    feedUrl: input.feedUrl,
    identityLinkingOptOut: input.identityLinkingOptOut,
    merchantCenterAccountReady: input.merchantCenter?.accountReady,
    merchantCenterFeedsConfigured: input.merchantCenter?.feedsConfigured,
    ucpEarlyAccessStatus: input.merchantCenter?.earlyAccessStatus,
  });
  return { siteId };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AnalyzeInput {
  domain: string;
  siteId: string; // caller resolves/creates the site first (ensureSiteFromIntake or ensureDevSite)
  config: SupabaseConfig;
  openAiKey?: string; // optional, same LLM-degrades-to-not_applicable behavior as before
  onLog?: (msg: string) => void; // progress messages; defaults to no-op (callers decide whether/how to surface them)
}

export interface AnalyzeResult {
  runId: string;
  status: "complete" | "no_manifest" | "failed";
  overallScore: number | null;
  pillarCount: number;
  signalCount: number;
  artifactCount: number;
  artifactTypes: string[];
  error?: string;
}

export async function runAnalysis(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { domain, siteId, config: cfg, openAiKey } = input;
  const log = input.onLog ?? (() => {});
  const llm: LlmClient | null = openAiKey ? openAiClient(openAiKey) : null;

  const site = await getSite(cfg, siteId);
  const run = await createRun(cfg, siteId);
  log(`run:   ${run.runId} (running)`);

  try {
    const { manifest, signals: manifestSignals } = await runManifestChecks(domain, httpFetcher);
    log(`fetch: ${manifest.url} → ${manifest.httpStatus ?? "unreachable"}${manifest.errorNote ? ` (${manifest.errorNote})` : ""}`);

    const capabilitySignals = await runCapabilityChecks(manifest, httpFetcher, {
      identityLinkingOptOut: site.identityLinkingOptOut,
    });
    const { feed, signals: feedSignals } = await runFeedChecks(site.feedUrl, httpFetcher, site.rootUrl ?? undefined);
    if (feed) {
      log(`feed:  ${feed.url} → ${feed.httpStatus ?? "unreachable"} (${feed.format}, ${feed.items.length} items)${feed.errorNote ? ` (${feed.errorNote})` : ""}`);
    }
    const feedVariants = feed ? extractFeedVariants(feed) : [];
    const pageSignals = await runPageConsistencyChecks(feedVariants, httpFetcher);
    if (feedVariants.length > 0) {
      log(`pages: sampled up to 15 of ${feedVariants.length} feed variants for id/price/availability cross-check`);
    }
    const llmSignals = await runLlmChecks(feed, httpFetcher, llm);
    if (!llm) {
      log("llm:   OPENAI_API_KEY not set — title_description_consistency / discovery_attributes_enrichment skipped (not_applicable)");
    } else if (feed && feed.items.length > 0) {
      log(`llm:   sampled up to 5 of ${feed.items.length} feed products for title/description + attribute-richness checks`);
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

    const ctx: ArtifactContext = {
      manifest,
      feed,
      signals,
      fetcher: httpFetcher,
      llm,
      rootUrl: site.rootUrl ?? `https://${domain}`,
      platform: site.platform ?? undefined,
    };
    const drafts = await runArtifacts(ctx);
    const insertedArtifacts = await insertArtifacts(cfg, run.runId, siteId, drafts, signalKeyToId);

    const noManifest = isManifestMissing(manifest);
    if (noManifest) {
      await markNoManifest(cfg, run.runId);
    } else {
      await completeRun(cfg, run.runId, overall);
    }

    log(`wrote: ${insertedSignals.length} signals, ${nPillars} pillar score(s)`);
    for (const p of pillars) {
      log(`score: ${p.pillar} = ${p.score}% (${p.signals_passed}/${p.signals_total} passed)`);
    }
    log(`artifacts: ${insertedArtifacts.length} generated`);
    for (const draft of drafts) {
      const c = draft.changelog;
      log(`  ${draft.artifact_type}: +${c.added.length} added, ~${c.corrected.length} corrected, ${c.must_complete.length} must-complete, ${c.flagged.length} flagged`);
      if (c.must_complete.length > 0) {
        log(`  must complete:`);
        for (const item of c.must_complete) log(`    - ${item}`);
      }
    }
    log(`run:   ${run.runId} (${noManifest ? "no_manifest" : `complete, overall ${overall}`})`);

    return {
      runId: run.runId,
      status: noManifest ? "no_manifest" : "complete",
      overallScore: noManifest ? null : overall,
      pillarCount: nPillars,
      signalCount: insertedSignals.length,
      artifactCount: insertedArtifacts.length,
      artifactTypes: insertedArtifacts.map((a) => a.artifact_type),
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await failRun(cfg, run.runId, msg).catch(() => undefined);
    return {
      runId: run.runId,
      status: "failed",
      overallScore: null,
      pillarCount: 0,
      signalCount: 0,
      artifactCount: 0,
      artifactTypes: [],
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class NoArtifactsError extends Error {
  constructor(runId: string) {
    super(`run ${runId} has no artifacts to export — nothing to deliver.`);
    this.name = "NoArtifactsError";
  }
}

export interface ExportInput {
  runId: string;
  config: SupabaseConfig;
}

export interface ExportResult {
  exportId: string;
  runId: string;
  reportUrl: string;
  bundleUrl: string;
  domain: string;
  status: string; // the exported run's analysis_runs.status (complete/no_manifest/...)
  artifactCount: number;
}

export async function runExport(input: ExportInput): Promise<ExportResult> {
  const { runId, config: cfg } = input;
  const data = await fetchRunBundleData(cfg, runId);
  if (!data) throw new RunNotFoundError(runId);
  if (data.artifacts.length === 0) throw new NoArtifactsError(runId);

  const plan = buildBundlePlan(data);
  const result = await uploadAndRecordExport(cfg, data.siteId, data.domain, data.runId, plan, data.artifacts.length);

  return {
    exportId: result.exportId,
    runId: data.runId,
    reportUrl: result.reportUrl,
    bundleUrl: result.bundleUrl,
    domain: data.domain,
    status: data.status,
    artifactCount: data.artifacts.length,
  };
}
