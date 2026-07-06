/**
 * Adeptra Merchant — Supabase sink.
 *
 * Writes runs, signals, and pillar scores to Postgres via PostgREST (Supabase's
 * REST layer) using plain `fetch`. Deliberately NOT @supabase/supabase-js:
 * zero npm deps means this file runs verbatim inside an n8n code node today and
 * in a standalone worker later — same contract as the signal modules.
 *
 * All functions take an explicit `SupabaseConfig` (no globals, no env reads here);
 * the entrypoint decides where credentials come from.
 *
 * Uses the service-role key from a trusted runner (n8n). RLS stays the guard for
 * user-facing reads; the pipeline is a backend writer, consistent with the
 * membership-based RLS design in the schema.
 */

import type { SignalRow, ManifestState } from "./manifestChecks.ts";
import type { PillarScoreRow } from "./scorer.ts";
import type { ArtifactDraft } from "./artifacts/index.ts";

export interface SupabaseConfig {
  url: string; // e.g. https://qognnvjehcflbqlzxcru.supabase.co
  serviceRoleKey: string;
}

export interface RunHandle {
  runId: string;
  siteId: string;
}

// ---------------------------------------------------------------------------
// Low-level PostgREST helper
// ---------------------------------------------------------------------------

async function rest<T>(
  cfg: SupabaseConfig,
  method: "GET" | "POST" | "PATCH",
  path: string, // e.g. "/rest/v1/signals" (may include query string)
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      apikey: cfg.serviceRoleKey,
      authorization: `Bearer ${cfg.serviceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PostgREST ${method} ${path} → ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ---------------------------------------------------------------------------
// Run lifecycle (analysis_runs are immutable facts; only status/score fields
// transition, matching the queued → running → complete/failed/no_manifest
// check constraint)
// ---------------------------------------------------------------------------

export async function createRun(cfg: SupabaseConfig, siteId: string): Promise<RunHandle> {
  const rows = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/analysis_runs", [
    { site_id: siteId, status: "running", started_at: new Date().toISOString() },
  ]);
  return { runId: rows[0].id, siteId };
}

export async function completeRun(
  cfg: SupabaseConfig,
  runId: string,
  overallScore: number | null,
): Promise<void> {
  await rest(cfg, "PATCH", `/rest/v1/analysis_runs?id=eq.${runId}`, {
    status: "complete",
    overall_score: overallScore,
    completed_at: new Date().toISOString(),
  });
}

export async function failRun(cfg: SupabaseConfig, runId: string, errorDetail: string): Promise<void> {
  await rest(cfg, "PATCH", `/rest/v1/analysis_runs?id=eq.${runId}`, {
    status: "failed",
    error_detail: errorDetail.slice(0, 2000),
    completed_at: new Date().toISOString(),
  });
}

/** No reachable manifest at all (unreachable or 404) — distinct from a manifest
 *  that's present but scores 0%. overall_score is left NULL: there's nothing to
 *  score, not a score of zero. See manifestChecks.ts `isManifestMissing`. */
export async function markNoManifest(cfg: SupabaseConfig, runId: string): Promise<void> {
  await rest(cfg, "PATCH", `/rest/v1/analysis_runs?id=eq.${runId}`, {
    status: "no_manifest",
    completed_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Signals + pillar scores
// ---------------------------------------------------------------------------

export interface InsertedSignal {
  id: string;
  signal_key: string;
}

/** Stamp run_id onto portable SignalRows and insert. Returns the inserted rows
 *  (id + signal_key) — not just a count — so the caller can build a
 *  signal_key → id map for artifacts.resolves_signal_ids (PostgREST already
 *  returns full rows via prefer: return=representation).
 *  NOTE: priority_score is deliberately ABSENT — in the schema it is a
 *  GENERATED ALWAYS AS (impact * weight / GREATEST(effort,1)) STORED column,
 *  so Postgres computes it and rejects inserts that supply it. The identical
 *  formula in scorer.ts (`priorityScore`) exists only for display in mocks/n8n. */
export async function insertSignals(
  cfg: SupabaseConfig,
  runId: string,
  signals: SignalRow[],
): Promise<InsertedSignal[]> {
  const rows = signals.map((s) => ({
    run_id: runId,
    pillar: s.pillar,
    category: s.category,
    signal_key: s.signal_key,
    status: s.status,
    weight: s.weight,
    score_contribution: s.score_contribution,
    impact: s.impact,
    effort: s.effort,
    evidence_json: s.evidence_json,
    fix_summary: s.fix_summary,
  }));
  const inserted = await rest<Array<{ id: string; signal_key: string }>>(cfg, "POST", "/rest/v1/signals", rows);
  return inserted.map((r) => ({ id: r.id, signal_key: r.signal_key }));
}

export async function insertPillarScores(
  cfg: SupabaseConfig,
  runId: string,
  pillars: PillarScoreRow[],
): Promise<number> {
  const rows = pillars.map((p) => ({ run_id: runId, ...p }));
  const inserted = await rest<unknown[]>(cfg, "POST", "/rest/v1/pillar_scores", rows);
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface InsertedArtifact {
  id: string;
  artifact_type: string;
}

/** Inserts generated artifact drafts. resolves_signal_ids is built by mapping
 *  each draft's signal_keys through signalKeyToId (unmatched keys are dropped
 *  rather than inserting a bad UUID). deploy_status/is_exportable are set
 *  explicitly (draft / exportable) — created_at/updated_at are DB-managed and
 *  deliberately not sent, same discipline as signals.priority_score.
 *  TODO: the artifacts table has no changelog column yet — the caller prints
 *  it (runLive.ts) rather than persisting it. Add one (e.g. a changelog JSONB
 *  column) when the dashboard needs to display it; not blocking this feature. */
export async function insertArtifacts(
  cfg: SupabaseConfig,
  runId: string,
  siteId: string,
  drafts: ArtifactDraft[],
  signalKeyToId: Map<string, string>,
): Promise<InsertedArtifact[]> {
  if (drafts.length === 0) return [];
  const rows = drafts.map((d) => ({
    run_id: runId,
    site_id: siteId,
    artifact_type: d.artifact_type,
    target_url: d.target_url,
    content: d.content,
    resolves_signal_ids: d.resolves_signal_keys.map((k) => signalKeyToId.get(k)).filter((id): id is string => !!id),
    deploy_status: "draft",
    is_exportable: true,
  }));
  return await rest<InsertedArtifact[]>(cfg, "POST", "/rest/v1/artifacts", rows);
}

// ---------------------------------------------------------------------------
// Site config (onboarding-level flags that shape scoring, e.g. capability
// opt-outs a merchant declares once rather than something derived per-run)
// ---------------------------------------------------------------------------

export interface SiteConfig {
  id: string;
  domain: string | null;
  rootUrl: string | null;
  identityLinkingOptOut: boolean;
  feedUrl: string | null;
  merchantCenterAccountReady: boolean | null;
  merchantCenterFeedsConfigured: boolean;
  ucpEarlyAccessStatus: "not_applied" | "pending" | "approved" | null;
}

export async function getSite(cfg: SupabaseConfig, siteId: string): Promise<SiteConfig> {
  const rows = await rest<
    Array<{
      id: string;
      domain: string | null;
      root_url: string | null;
      identity_linking_opt_out: boolean;
      feed_url: string | null;
      merchant_center_account_ready: boolean | null;
      merchant_center_feeds_configured: boolean;
      ucp_early_access_status: "not_applied" | "pending" | "approved" | null;
    }>
  >(
    cfg,
    "GET",
    `/rest/v1/sites?id=eq.${siteId}&select=id,domain,root_url,identity_linking_opt_out,feed_url,merchant_center_account_ready,merchant_center_feeds_configured,ucp_early_access_status&limit=1`,
  );
  if (!rows[0]) throw new Error(`site not found: ${siteId}`);
  return {
    id: rows[0].id,
    domain: rows[0].domain,
    rootUrl: rows[0].root_url,
    identityLinkingOptOut: rows[0].identity_linking_opt_out,
    feedUrl: rows[0].feed_url,
    merchantCenterAccountReady: rows[0].merchant_center_account_ready,
    merchantCenterFeedsConfigured: rows[0].merchant_center_feeds_configured,
    ucpEarlyAccessStatus: rows[0].ucp_early_access_status,
  };
}

// ---------------------------------------------------------------------------
// Dev convenience: resolve (or create) a client + site so an end-to-end smoke
// test doesn't require touching the dashboard. Idempotent by domain.
// ---------------------------------------------------------------------------

export async function ensureDevSite(
  cfg: SupabaseConfig,
  opts: { clientName: string; domain: string; rootUrl?: string; feedUrl?: string },
): Promise<string> {
  // 1. Client (by name)
  const existingClients = await rest<Array<{ id: string }>>(
    cfg,
    "GET",
    `/rest/v1/clients?name=eq.${encodeURIComponent(opts.clientName)}&select=id&limit=1`,
  );
  let clientId = existingClients[0]?.id;
  if (!clientId) {
    const created = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/clients", [
      { name: opts.clientName },
    ]);
    clientId = created[0].id;
  }

  // 2. Site (by domain, within that client)
  const existingSites = await rest<Array<{ id: string }>>(
    cfg,
    "GET",
    `/rest/v1/sites?client_id=eq.${clientId}&domain=eq.${encodeURIComponent(opts.domain)}&select=id&limit=1`,
  );
  if (existingSites[0]?.id) return existingSites[0].id;

  const createdSites = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/sites", [
    {
      client_id: clientId,
      domain: opts.domain,
      root_url: opts.rootUrl ?? `https://${opts.domain}`,
      is_ecommerce: true,
      ...(opts.feedUrl ? { feed_url: opts.feedUrl } : {}),
    },
  ]);
  return createdSites[0].id;
}

// ---------------------------------------------------------------------------
// Optional: persist the raw manifest fetch as evidence alongside the run.
// crawl_snapshots is the natural home; kept as a helper so the orchestrator
// stays one readable file.
// ---------------------------------------------------------------------------

export function manifestEvidence(m: ManifestState): Record<string, unknown> {
  return {
    url: m.url,
    http_status: m.httpStatus,
    content_type: m.contentType,
    requires_auth: m.requiresAuth,
    redirect_chain: m.redirectChain,
    is_valid_json: m.isValidJson,
    error_note: m.errorNote ?? null,
  };
}
