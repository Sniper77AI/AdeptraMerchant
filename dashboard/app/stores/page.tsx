import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

interface SiteRow {
  id: string;
  domain: string | null;
  root_url: string;
  platform: string | null;
}

interface RunRow {
  id: string;
  site_id: string;
  status: "queued" | "running" | "complete" | "failed" | "no_manifest";
  started_at: string;
}

interface PillarScoreRow {
  run_id: string;
  pillar: string;
  score: number;
}

// Compact "at a glance" labels, distinct from the full report's formal
// PILLAR_DISPLAY_NAMES ("Agent Readability" / "UCP Protocol Compliance") —
// matches the report's own prose shorthand ("searchable" / "buyable"), kept
// local to this list view since the full store view uses the shared model's
// formal names + claim sentences instead.
const COMPACT_PILLAR_LABEL: Record<string, string> = {
  agent_readability: "Searchable",
  ucp: "Buyable",
};
const COMPACT_PILLAR_ORDER = ["agent_readability", "ucp"];

/** Uncached dynamic data inside Suspense — same Cache-Components requirement
 *  as every other protected route in this app. */
async function StoresList() {
  const supabase = await createClient();

  const { data, error: authError } = await supabase.auth.getClaims();
  if (authError || !data?.claims) {
    redirect("/auth/login");
  }

  const { data: sites } = await supabase.from("sites").select("id, domain, root_url, platform").returns<SiteRow[]>();

  if (!sites || sites.length === 0) {
    return (
      <div className="flex flex-col gap-4 items-start">
        <p className="text-lg">You haven&apos;t added a store yet.</p>
        <Link href="/onboarding" className="underline underline-offset-4 font-medium">
          Add a store
        </Link>
      </div>
    );
  }

  const siteIds = sites.map((s) => s.id);
  const { data: allRuns } = await supabase.from("analysis_runs").select("id, site_id, status, started_at").in("site_id", siteIds).order("started_at", { ascending: false }).returns<RunRow[]>();

  // Latest run per site — first row per site_id, since allRuns is already
  // ordered started_at desc.
  const latestRunBySite = new Map<string, RunRow>();
  for (const r of allRuns ?? []) {
    if (!latestRunBySite.has(r.site_id)) latestRunBySite.set(r.site_id, r);
  }

  const latestRunIds = [...latestRunBySite.values()].map((r) => r.id);
  const { data: pillarRows } =
    latestRunIds.length > 0
      ? await supabase.from("pillar_scores").select("run_id, pillar, score").in("run_id", latestRunIds).returns<PillarScoreRow[]>()
      : { data: [] as PillarScoreRow[] };
  const pillarsByRun = new Map<string, PillarScoreRow[]>();
  for (const p of pillarRows ?? []) {
    const arr = pillarsByRun.get(p.run_id) ?? [];
    arr.push(p);
    pillarsByRun.set(p.run_id, arr);
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My Stores</h1>
        <Link href="/onboarding" className="underline underline-offset-4 font-medium text-sm">
          + Add a store
        </Link>
      </div>

      <ul className="flex flex-col gap-2">
        {sites.map((site) => {
          const run = latestRunBySite.get(site.id);
          const pillars = run ? pillarsByRun.get(run.id) ?? [] : [];

          return (
            <li key={site.id}>
              <Link href={`/stores/${site.id}`} className="block rounded-lg border p-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-semibold">{site.domain ?? site.root_url}</div>
                    <div className="text-xs text-muted-foreground">{site.platform ?? "platform not set"}</div>
                  </div>
                  <div className="text-sm">
                    {!run ? (
                      <span className="text-muted-foreground italic">No analysis yet</span>
                    ) : run.status === "running" || run.status === "queued" ? (
                      <Badge variant="secondary">Analysis in progress</Badge>
                    ) : run.status === "failed" ? (
                      <Badge variant="destructive">Analysis failed</Badge>
                    ) : (
                      <span className="flex gap-3">
                        {COMPACT_PILLAR_ORDER.filter((key) => pillars.some((p) => p.pillar === key)).map((key) => {
                          const p = pillars.find((p) => p.pillar === key)!;
                          const suppressed = key === "ucp" && run.status === "no_manifest";
                          return (
                            <span key={key}>
                              {COMPACT_PILLAR_LABEL[key]} {suppressed ? "—" : `${p.score}%`}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function StoresListPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 py-8">
      <Suspense fallback={<p>Loading…</p>}>
        <StoresList />
      </Suspense>
    </div>
  );
}
