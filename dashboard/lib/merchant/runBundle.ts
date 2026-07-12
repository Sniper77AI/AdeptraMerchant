import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunBundleData, RunBundleSignal, RunBundleArtifact } from "../../../merchant/ucp/export/reportModel.ts";
import type { PillarScoreRow } from "../../../merchant/ucp/scorer.ts";
import type { ArtifactChangelog } from "../../../merchant/ucp/artifacts/types.ts";

/**
 * Assembles a RunBundleData-shaped object from the user's own RLS-scoped
 * reads — the dashboard-side mirror of merchant/ucp/supabaseSink.ts's
 * fetchRunBundleData, re-implemented against the anon-key + user-session
 * client instead of the service-role REST helper (that function is
 * Node-only and reads with service-role, neither of which belongs in a
 * browser-reachable app). Every table read here is confirmed RLS-readable
 * by the owning user: analysis_runs/pillar_scores/signals/artifacts are all
 * scoped via user_site_ids(); signal_evidence's SELECT policy is `true` for
 * any authenticated user (it's global reference data, not tenant-scoped).
 *
 * Passing the result into reportModel.ts's buildModel() — the SAME function
 * the downloadable report uses — is the whole point of this file: same
 * shape in, same model out, so the dashboard and the export can never
 * render different groupings/sorts/framing for the same run.
 *
 * Returns null if the run doesn't exist OR isn't visible under RLS (a run
 * belonging to another user's site) — both cases collapse to the same
 * "not found" the caller renders; this file never distinguishes them.
 */
export async function fetchRunBundleDataRLS(supabase: SupabaseClient, runId: string): Promise<RunBundleData | null> {
  const { data: run } = await supabase
    .from("analysis_runs")
    .select("id, site_id, status, created_at, sites(domain)")
    .eq("id", runId)
    .maybeSingle<{ id: string; site_id: string; status: string; created_at: string; sites: { domain: string | null } | null }>();

  if (!run) return null;

  const [{ data: pillarRows }, { data: signalRows }, { data: artifactRows }, { data: evidenceRows }] = await Promise.all([
    supabase.from("pillar_scores").select("pillar, score, signals_passed, signals_total").eq("run_id", runId).returns<PillarScoreRow[]>(),
    supabase
      .from("signals")
      .select("signal_key, pillar, category, status, weight, priority_score, fix_summary")
      .eq("run_id", runId)
      .returns<Array<Omit<RunBundleSignal, "basis" | "merchant_note">>>(),
    supabase
      .from("artifacts")
      .select("artifact_type, target_url, content, changelog_json, resolves_signal_ids")
      .eq("run_id", runId)
      .returns<Array<{ artifact_type: string; target_url: string | null; content: string | null; changelog_json: ArtifactChangelog | null; resolves_signal_ids: string[] | null }>>(),
    // Unscoped — global reference data, same as fetchSignalEvidence's own
    // unfiltered read. signal_evidence's RLS policy (qual: true) already
    // permits this for any authenticated user.
    supabase.from("signal_evidence").select("signal_key, basis, merchant_note").returns<Array<{ signal_key: string; basis: string | null; merchant_note: string | null }>>(),
  ]);

  const evidenceByKey = new Map((evidenceRows ?? []).map((e) => [e.signal_key, e]));

  return {
    runId: run.id,
    siteId: run.site_id,
    domain: run.sites?.domain ?? "unknown-domain",
    status: run.status,
    createdAt: run.created_at,
    pillars: pillarRows ?? [],
    signals: (signalRows ?? []).map((s) => ({
      ...s,
      basis: evidenceByKey.get(s.signal_key)?.basis ?? null,
      merchant_note: evidenceByKey.get(s.signal_key)?.merchant_note ?? null,
    })),
    artifacts: (artifactRows ?? []).map((a) => ({
      artifact_type: a.artifact_type,
      target_url: a.target_url,
      content: a.content,
      changelog: a.changelog_json,
      resolves_signal_ids: a.resolves_signal_ids,
    })) satisfies RunBundleArtifact[],
  };
}
