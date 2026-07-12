import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { fetchRunBundleDataRLS } from "@/lib/merchant/runBundle";
import { checkEntitlementRLS } from "@/lib/merchant/entitlement";
import { PillarCard } from "@/components/pillar-card";
import { ArtifactList } from "@/components/artifact-list";
import { Badge } from "@/components/ui/badge";
import { buildModel, pillarDisplayName, canonicalPillarOrder } from "../../../../merchant/ucp/export/reportModel.ts";

interface SiteRow {
  id: string;
  client_id: string;
  domain: string | null;
  root_url: string;
  platform: string | null;
}

interface RunRow {
  id: string;
  status: "queued" | "running" | "complete" | "failed" | "no_manifest";
  started_at: string;
  completed_at: string | null;
  error_detail: string | null;
}

interface RunHistoryRow {
  id: string;
  status: RunRow["status"];
  started_at: string;
}

interface PillarScoreRow {
  pillar: string;
  score: number;
  signals_passed: number;
  signals_total: number;
}

/** Uncached dynamic data (auth + the site/run reads) inside Suspense — same
 *  Cache-Components requirement as /dashboard and /onboarding. */
async function StoreStatus({ params }: { params: Promise<{ siteId: string }> }) {
  // Route params are also dynamic per-request data — read inside the
  // Suspense boundary alongside the auth/DB reads below, not at the outer
  // page's top level, or the whole page loses its static shell the same way
  // a top-level cookies()/headers() read would (see /dashboard's comment).
  const { siteId } = await params;
  const supabase = await createClient();

  const { data, error: authError } = await supabase.auth.getClaims();
  if (authError || !data?.claims) {
    redirect("/auth/login");
  }

  // Both reads go through the user's own RLS-scoped client (anon key + their
  // session) — never service-role. sites_select / runs_select are both
  // scoped via user_client_ids()/user_site_ids(), so a site or run this user
  // doesn't own simply won't come back, same as a genuine 404 — RLS itself
  // does the not-found-vs-error collapsing, not UI-side hiding.
  const { data: site } = await supabase.from("sites").select("id, client_id, domain, root_url, platform").eq("id", siteId).maybeSingle<SiteRow>();

  if (!site) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-lg">Store not found — either it doesn&apos;t exist, or it&apos;s not yours.</p>
        <Link href="/onboarding" className="underline underline-offset-4">
          Add a store
        </Link>
      </div>
    );
  }

  const [{ data: run }, { data: historyRuns }] = await Promise.all([
    supabase.from("analysis_runs").select("id, status, started_at, completed_at, error_detail").eq("site_id", siteId).order("started_at", { ascending: false }).limit(1).maybeSingle<RunRow>(),
    supabase.from("analysis_runs").select("id, status, started_at").eq("site_id", siteId).order("started_at", { ascending: false }).returns<RunHistoryRow[]>(),
  ]);

  // Run history: pillar_scores for every run of this site, batched in one
  // query rather than one round trip per run, then grouped client-side.
  const runIds = (historyRuns ?? []).map((r) => r.id);
  const { data: historyPillars } =
    runIds.length > 0
      ? await supabase.from("pillar_scores").select("run_id, pillar, score, signals_passed, signals_total").in("run_id", runIds).returns<Array<PillarScoreRow & { run_id: string }>>()
      : { data: [] as Array<PillarScoreRow & { run_id: string }> };
  const pillarsByRun = new Map<string, PillarScoreRow[]>();
  for (const p of historyPillars ?? []) {
    const arr = pillarsByRun.get(p.run_id) ?? [];
    arr.push(p);
    pillarsByRun.set(p.run_id, arr);
  }

  const showFullReport = run && (run.status === "complete" || run.status === "no_manifest");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{site.domain ?? site.root_url}</h1>
        <p className="text-sm text-muted-foreground">{site.root_url}</p>
      </div>

      {/* Explicit states only — never inferred from absence. A missing run
       *  row (shouldn't happen via /onboarding, which creates it
       *  synchronously before redirecting here, but is reachable by
       *  navigating here directly) gets its own honest, labeled case. */}
      {!run ? (
        <p className="text-sm">No analysis has been started for this store yet.</p>
      ) : run.status === "running" || run.status === "queued" ? (
        <div className="rounded-md border p-4">
          <p className="font-medium">Analysis in progress…</p>
          <p className="text-sm text-muted-foreground">Started {new Date(run.started_at).toLocaleString()}. This page doesn&apos;t auto-refresh yet — reload to check.</p>
        </div>
      ) : run.status === "failed" ? (
        <div className="rounded-md border border-red-300 p-4">
          <p className="font-medium text-red-600">Analysis failed</p>
          {run.error_detail && <p className="text-sm text-muted-foreground mt-1">{run.error_detail}</p>}
          <Link href="/onboarding" className="underline underline-offset-4 text-sm mt-2 inline-block">
            Retry
          </Link>
        </div>
      ) : null}

      {showFullReport && run && <FullReport runId={run.id} siteId={site.id} clientId={site.client_id} />}

      <div>
        <h2 className="text-lg font-semibold mb-2">Run history</h2>
        {(historyRuns ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(historyRuns ?? []).map((r) => {
              const pillars = pillarsByRun.get(r.id) ?? [];
              return (
                <li key={r.id} className="flex items-center gap-3 text-sm border-b pb-2">
                  <span className="text-muted-foreground w-40 shrink-0">{new Date(r.started_at).toLocaleString()}</span>
                  <Badge variant={r.status === "failed" ? "destructive" : r.status === "running" || r.status === "queued" ? "secondary" : "default"}>{r.status}</Badge>
                  <span className="text-muted-foreground">
                    {pillars.length === 0
                      ? "—"
                      : canonicalPillarOrder(pillars.map((p) => p.pillar))
                          .map((key) => pillars.find((p) => p.pillar === key)!)
                          .map((p) => `${pillarDisplayName(p.pillar)} ${p.score}%`)
                          .join(" · ")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The full ReportModel — pillar cards, what's-working/to-fix, generated
 *  fixes, fix-bundle gate. Built from the SAME buildModel() the downloadable
 *  report uses, over data assembled from the user's own RLS reads. */
async function FullReport({ runId, siteId, clientId }: { runId: string; siteId: string; clientId: string }) {
  const supabase = await createClient();
  const bundleData = await fetchRunBundleDataRLS(supabase, runId);
  if (!bundleData) return null; // shouldn't happen — this run was just read above

  const model = buildModel(bundleData);
  const entitled = await checkEntitlementRLS(supabase, clientId, siteId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        {model.pillars.map((p) => {
          const section = model.sections.find((s) => s.pillar === p.pillar);
          return section ? <PillarCard key={p.pillar} pillar={p} section={section} hasManifest={model.hasManifest} /> : null;
        })}
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-2">Your generated fixes</h2>
        <ArtifactList artifacts={model.artifacts} />
      </div>

      <div className="rounded-lg border p-4">
        {entitled ? (
          // Points at the merchant backend's own proxy route (never a raw
          // signed Storage URL) — see merchant/api/bundle/[runId].ts. That
          // route re-checks isEntitled() itself server-side; this link is
          // never the thing enforcing access.
          <a href={`/api/bundle/${runId}`} className="font-medium underline underline-offset-4">
            ⬇ Download fix package
          </a>
        ) : (
          <div>
            <p className="font-medium">🔒 Unlock fix package</p>
            <p className="text-sm text-muted-foreground">The report above is free. Downloading the generated fix files is a paid feature — billing isn&apos;t live yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StorePage({ params }: { params: Promise<{ siteId: string }> }) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 py-8">
      <Suspense fallback={<p>Loading…</p>}>
        <StoreStatus params={params} />
      </Suspense>
    </div>
  );
}
