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
import type { RunBundleData } from "./export/reportBuilder.ts";

export interface SupabaseConfig {
  url: string; // e.g. https://qognnvjehcflbqlzxcru.supabase.co
  serviceRoleKey: string;
  // Optional — defaults to the real global fetch. Injectable so tests can
  // mock PostgREST/Storage responses without monkey-patching globalThis.fetch,
  // the same portability contract the signal-check modules use for HTTP.
  fetcher?: typeof fetch;
}

export interface RunHandle {
  runId: string;
  siteId: string;
}

// ---------------------------------------------------------------------------
// Auth headers — shared by supabaseSink.ts (PostgREST) and export/storageSink.ts
// (Storage REST API), since both talk to the same project via plain fetch.
//
// New-format keys (sb_publishable_.../sb_secret_...) are opaque tokens, not
// JWTs. Supabase's API gateway parses anything in `Authorization: Bearer` as
// a JWT, so sending a new-format key there fails with "Invalid JWT" — the
// migration guide's fix for backend code is to send it on `apikey` only.
// Legacy JWT-based service_role keys still need both headers (PostgREST reads
// the `role` claim out of the JWT in `Authorization` to bypass RLS), so this
// branches on key format rather than dropping `Authorization` unconditionally.
// ---------------------------------------------------------------------------

export function authHeaders(cfg: SupabaseConfig): Record<string, string> {
  if (cfg.serviceRoleKey.startsWith("sb_")) {
    return { apikey: cfg.serviceRoleKey };
  }
  return { apikey: cfg.serviceRoleKey, authorization: `Bearer ${cfg.serviceRoleKey}` };
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
  const doFetch = cfg.fetcher ?? fetch;
  const res = await doFetch(`${cfg.url}${path}`, {
    method,
    headers: {
      ...authHeaders(cfg),
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
 *  explicitly (draft / exportable); changelog_json stores the human-readable
 *  added/corrected/must_complete/flagged summary. created_at/updated_at are
 *  DB-managed and deliberately not sent, same discipline as signals.priority_score. */
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
    changelog_json: d.changelog,
  }));
  return await rest<InsertedArtifact[]>(cfg, "POST", "/rest/v1/artifacts", rows);
}

// ---------------------------------------------------------------------------
// Export read helper (Track C) — everything reportBuilder.ts needs for one
// run, fetched in one place rather than scattering queries through exportRun.ts.
// ---------------------------------------------------------------------------

/** Lightweight run→domain lookup — the report/bundle proxy routes need only
 *  this (to derive the Storage folder path via storageSink.ts's
 *  reportPathFor/bundlePathFor), not the full fetchRunBundleData fan-out
 *  (pillars/signals/artifacts) that export report-building needs. Returns
 *  null when the run doesn't exist. */
export async function getRunDomain(cfg: SupabaseConfig, runId: string): Promise<string | null> {
  const rows = await rest<Array<{ sites: { domain: string | null } | null }>>(
    cfg,
    "GET",
    `/rest/v1/analysis_runs?id=eq.${runId}&select=sites(domain)&limit=1`,
  );
  return rows[0]?.sites?.domain ?? null;
}

/** Returns null when run_id doesn't exist. Read-only — never mutates. */
export async function fetchRunBundleData(cfg: SupabaseConfig, runId: string): Promise<RunBundleData | null> {
  const runRows = await rest<
    Array<{
      id: string;
      site_id: string;
      status: string;
      overall_score: number | null;
      created_at: string;
      sites: { domain: string | null } | null;
    }>
  >(cfg, "GET", `/rest/v1/analysis_runs?id=eq.${runId}&select=id,site_id,status,overall_score,created_at,sites(domain)&limit=1`);
  const run = runRows[0];
  if (!run) return null;

  const [pillarRows, signalRows, artifactRows] = await Promise.all([
    rest<Array<{ pillar: string; score: number; signals_passed: number; signals_total: number }>>(
      cfg,
      "GET",
      `/rest/v1/pillar_scores?run_id=eq.${runId}&select=pillar,score,signals_passed,signals_total`,
    ),
    rest<Array<{ signal_key: string; category: string; status: SignalRow["status"]; weight: number; priority_score: number; fix_summary: string | null }>>(
      cfg,
      "GET",
      `/rest/v1/signals?run_id=eq.${runId}&select=signal_key,category,status,weight,priority_score,fix_summary`,
    ),
    rest<
      Array<{
        artifact_type: string;
        target_url: string | null;
        content: string | null;
        changelog_json: RunBundleData["artifacts"][number]["changelog"];
        resolves_signal_ids: string[] | null;
      }>
    >(cfg, "GET", `/rest/v1/artifacts?run_id=eq.${runId}&select=artifact_type,target_url,content,changelog_json,resolves_signal_ids`),
  ]);

  return {
    runId: run.id,
    siteId: run.site_id,
    domain: run.sites?.domain ?? "unknown-domain",
    status: run.status,
    overallScore: run.overall_score,
    createdAt: run.created_at,
    pillars: pillarRows,
    signals: signalRows,
    artifacts: artifactRows.map((a) => ({
      artifact_type: a.artifact_type,
      target_url: a.target_url,
      content: a.content,
      changelog: a.changelog_json,
      resolves_signal_ids: a.resolves_signal_ids,
    })),
  };
}

export interface InsertedExport {
  id: string;
}

/** Records an export. bundle_storage_path is the zip's path — the exports
 *  table has no separate column for the report page's path; storageSink.ts
 *  derives it by convention (same folder, "report.html" instead of
 *  "bundle.zip") rather than needing a schema change. */
export async function insertExport(
  cfg: SupabaseConfig,
  siteId: string,
  bundleStoragePath: string,
  artifactCount: number,
  reason: "client_request" | "cancellation" | "periodic" = "client_request",
): Promise<InsertedExport> {
  const rows = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/exports", [
    { site_id: siteId, bundle_storage_path: bundleStoragePath, reason, artifact_count: artifactCount },
  ]);
  return { id: rows[0].id };
}

// ---------------------------------------------------------------------------
// Site config (onboarding-level flags that shape scoring, e.g. capability
// opt-outs a merchant declares once rather than something derived per-run)
// ---------------------------------------------------------------------------

export interface SiteConfig {
  id: string;
  domain: string | null;
  rootUrl: string | null;
  platform: string | null;
  identityLinkingOptOut: boolean;
  checkoutHandoffOptIn: boolean;
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
      platform: string | null;
      identity_linking_opt_out: boolean;
      checkout_handoff_opt_in: boolean;
      feed_url: string | null;
      merchant_center_account_ready: boolean | null;
      merchant_center_feeds_configured: boolean;
      ucp_early_access_status: "not_applied" | "pending" | "approved" | null;
    }>
  >(
    cfg,
    "GET",
    `/rest/v1/sites?id=eq.${siteId}&select=id,domain,root_url,platform,identity_linking_opt_out,checkout_handoff_opt_in,feed_url,merchant_center_account_ready,merchant_center_feeds_configured,ucp_early_access_status&limit=1`,
  );
  if (!rows[0]) throw new Error(`site not found: ${siteId}`);
  return {
    id: rows[0].id,
    domain: rows[0].domain,
    rootUrl: rows[0].root_url,
    platform: rows[0].platform,
    identityLinkingOptOut: rows[0].identity_linking_opt_out,
    checkoutHandoffOptIn: rows[0].checkout_handoff_opt_in,
    feedUrl: rows[0].feed_url,
    merchantCenterAccountReady: rows[0].merchant_center_account_ready,
    merchantCenterFeedsConfigured: rows[0].merchant_center_feeds_configured,
    ucpEarlyAccessStatus: rows[0].ucp_early_access_status,
  };
}

// ---------------------------------------------------------------------------
// Client resolution — shared by ensureDevSite (below) and the real intake
// path (pipeline.ts's ensureSiteFromIntake). Reuse-or-create by name.
// ---------------------------------------------------------------------------

export async function ensureClient(cfg: SupabaseConfig, name: string): Promise<string> {
  const existing = await rest<Array<{ id: string }>>(cfg, "GET", `/rest/v1/clients?name=eq.${encodeURIComponent(name)}&select=id&limit=1`);
  if (existing[0]?.id) return existing[0].id;
  const created = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/clients", [{ name }]);
  return created[0].id;
}

// ---------------------------------------------------------------------------
// Dev convenience: resolve (or create) a client + site so an end-to-end smoke
// test doesn't require touching the dashboard. Idempotent by domain.
// ---------------------------------------------------------------------------

export async function ensureDevSite(
  cfg: SupabaseConfig,
  opts: { clientName: string; domain: string; rootUrl?: string; feedUrl?: string },
): Promise<string> {
  const clientId = await ensureClient(cfg, opts.clientName);

  // Site (by domain, within that client)
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
      is_test: true, // this IS the dev bootstrap path — anything it creates is by
      // definition not a real merchant site (see sites.is_test's own column
      // comment). Only set on the create path above, never when reusing an
      // existing site found by the domain lookup — ensureDevSite dedups by
      // domain, and re-running it against a site that's since become real
      // (e.g. re-pointed at by ensureSiteFromIntake) must not silently
      // re-flag it as test data.
      ...(opts.feedUrl ? { feed_url: opts.feedUrl } : {}),
    },
  ]);
  return createdSites[0].id;
}

// ---------------------------------------------------------------------------
// Real intake site upsert (pipeline.ts's ensureSiteFromIntake). Unlike
// ensureDevSite, this dedups on (client_id, root_url) — the ACTUAL `sites`
// UNIQUE constraint (ensureDevSite dedups by domain, which is a close but
// not identical match) — and writes the onboarding-declared fields a real
// intake form collects. On a repeat submission for the same client+root_url,
// PATCHes only the fields actually provided this time, rather than silently
// ignoring an updated answer — a resubmission is a real edit, not a no-op.
// NEVER writes sites.is_test — IntakeSiteFields has no such field, and
// neither the create nor the PATCH path below sets one. Real intake is, by
// definition, a real site; it relies entirely on the column's own
// DEFAULT false, the same way every other real-merchant write path does.
// ---------------------------------------------------------------------------

export interface IntakeSiteFields {
  domain: string;
  rootUrl: string;
  platform?: string;
  feedUrl?: string;
  identityLinkingOptOut?: boolean;
  checkoutHandoffOptIn?: boolean;
  merchantCenterAccountReady?: boolean;
  merchantCenterFeedsConfigured?: boolean;
  ucpEarlyAccessStatus?: "not_applied" | "pending" | "approved";
}

export async function upsertIntakeSite(cfg: SupabaseConfig, clientId: string, fields: IntakeSiteFields): Promise<string> {
  const patch: Record<string, unknown> = {};
  if (fields.platform !== undefined) patch.platform = fields.platform;
  if (fields.feedUrl !== undefined) patch.feed_url = fields.feedUrl;
  if (fields.identityLinkingOptOut !== undefined) patch.identity_linking_opt_out = fields.identityLinkingOptOut;
  if (fields.checkoutHandoffOptIn !== undefined) patch.checkout_handoff_opt_in = fields.checkoutHandoffOptIn;
  if (fields.merchantCenterAccountReady !== undefined) patch.merchant_center_account_ready = fields.merchantCenterAccountReady;
  if (fields.merchantCenterFeedsConfigured !== undefined) patch.merchant_center_feeds_configured = fields.merchantCenterFeedsConfigured;
  if (fields.ucpEarlyAccessStatus !== undefined) patch.ucp_early_access_status = fields.ucpEarlyAccessStatus;

  const existing = await rest<Array<{ id: string }>>(
    cfg,
    "GET",
    `/rest/v1/sites?client_id=eq.${clientId}&root_url=eq.${encodeURIComponent(fields.rootUrl)}&select=id&limit=1`,
  );
  if (existing[0]?.id) {
    if (Object.keys(patch).length > 0) {
      await rest(cfg, "PATCH", `/rest/v1/sites?id=eq.${existing[0].id}`, patch);
    }
    return existing[0].id;
  }

  const created = await rest<Array<{ id: string }>>(cfg, "POST", "/rest/v1/sites", [
    {
      client_id: clientId,
      domain: fields.domain,
      root_url: fields.rootUrl,
      is_ecommerce: true,
      ...patch,
    },
  ]);
  return created[0].id;
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
