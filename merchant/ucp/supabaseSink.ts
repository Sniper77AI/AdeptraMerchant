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

/** Stamp run_id onto portable SignalRows and insert.
 *  NOTE: priority_score is deliberately ABSENT — in the schema it is a
 *  GENERATED ALWAYS AS (impact * weight / GREATEST(effort,1)) STORED column,
 *  so Postgres computes it and rejects inserts that supply it. The identical
 *  formula in scorer.ts (`priorityScore`) exists only for display in mocks/n8n. */
export async function insertSignals(
  cfg: SupabaseConfig,
  runId: string,
  signals: SignalRow[],
): Promise<number> {
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
  const inserted = await rest<unknown[]>(cfg, "POST", "/rest/v1/signals", rows);
  return inserted.length;
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
// Site config (onboarding-level flags that shape scoring, e.g. capability
// opt-outs a merchant declares once rather than something derived per-run)
// ---------------------------------------------------------------------------

export interface SiteConfig {
  id: string;
  domain: string | null;
  rootUrl: string | null;
  identityLinkingOptOut: boolean;
  feedUrl: string | null;
}

export async function getSite(cfg: SupabaseConfig, siteId: string): Promise<SiteConfig> {
  const rows = await rest<
    Array<{ id: string; domain: string | null; root_url: string | null; identity_linking_opt_out: boolean; feed_url: string | null }>
  >(cfg, "GET", `/rest/v1/sites?id=eq.${siteId}&select=id,domain,root_url,identity_linking_opt_out,feed_url&limit=1`);
  if (!rows[0]) throw new Error(`site not found: ${siteId}`);
  return {
    id: rows[0].id,
    domain: rows[0].domain,
    rootUrl: rows[0].root_url,
    identityLinkingOptOut: rows[0].identity_linking_opt_out,
    feedUrl: rows[0].feed_url,
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
