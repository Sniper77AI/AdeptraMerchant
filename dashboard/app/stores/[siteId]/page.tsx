import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

interface SiteRow {
  id: string;
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
  // doesn't own simply won't come back, same as a genuine 404.
  const { data: site } = await supabase.from("sites").select("id, domain, root_url, platform").eq("id", siteId).maybeSingle<SiteRow>();

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

  const { data: run } = await supabase
    .from("analysis_runs")
    .select("id, status, started_at, completed_at, error_detail")
    .eq("site_id", siteId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle<RunRow>();

  return (
    <div className="flex flex-col gap-4">
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
      ) : (
        <div className="rounded-md border p-4">
          <p className="font-medium">Analysis complete{run.status === "no_manifest" ? " — no UCP manifest found" : ""}.</p>
          <p className="text-sm text-muted-foreground">
            Completed {run.completed_at ? new Date(run.completed_at).toLocaleString() : "—"}. The full results view is coming in a later stage.
          </p>
        </div>
      )}
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
