"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createRun, type SupabaseConfig } from "../../../merchant/ucp/supabaseSink.ts";
import { runAnalysis } from "../../../merchant/ucp/pipeline.ts";

export interface OnboardingState {
  error: string | null;
}

/**
 * Server-only Supabase config for the analysis pipeline. Deliberately reads
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix) — Next.js
 * only inlines NEXT_PUBLIC_* vars into the client bundle, so this key never
 * reaches the browser as long as this function is only called from this
 * "use server" file. signals/pillar_scores/artifacts have no INSERT policy
 * for `authenticated`, and analysis_runs has no UPDATE policy at all — the
 * whole pipeline write path requires service-role regardless of who's asking.
 */
function serviceConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("server misconfigured — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return { url, serviceRoleKey };
}

/**
 * onboard_add_site's return shape via PostgREST RPC: the bare uuid, or (per
 * Supabase's JS client for a scalar-returning function) the value directly
 * under `data`.
 */
export async function onboardAndAnalyze(_prevState: OnboardingState, formData: FormData): Promise<OnboardingState> {
  const rawUrl = String(formData.get("rootUrl") ?? "").trim();
  const platform = String(formData.get("platform") ?? "").trim();
  const feedUrl = String(formData.get("feedUrl") ?? "").trim();
  const identityLinkingOptOut = formData.get("identityLinkingOptOut") === "on";
  const checkoutHandoffOptIn = formData.get("checkoutHandoffOptIn") === "on";
  const aiTrainingOptOut = formData.get("aiTrainingOptOut") === "on";

  // Server-side validation — never trust the client-side checks alone.
  if (!rawUrl) {
    return { error: "Store URL is required." };
  }
  let normalizedRootUrl: string;
  try {
    const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    normalizedRootUrl = parsed.origin; // canonical scheme+host, no path/trailing slash — matches (client_id, root_url)'s uniqueness expectation
  } catch {
    return { error: "Store URL is not a valid URL." };
  }
  if (!platform) {
    return { error: "Platform is required." };
  }
  if (feedUrl) {
    try {
      new URL(feedUrl);
    } catch {
      return { error: "Feed URL is not a valid URL." };
    }
  }

  const supabase = await createClient();
  const { data: claimsData, error: authError } = await supabase.auth.getClaims();
  if (authError || !claimsData?.claims) {
    redirect("/auth/login");
  }

  const domain = new URL(normalizedRootUrl).host;

  // Step 1 — the atomic bootstrap, via the USER-scoped client (anon key +
  // this caller's real session cookie), so auth.uid() inside the SECURITY
  // DEFINER function resolves to the actual signed-in user. onboard_add_site
  // itself is granted to `authenticated` only (anon explicitly revoked) —
  // this must run as the real user, never service-role.
  const { data: siteId, error: rpcError } = await supabase.rpc("onboard_add_site", {
    p_root_url: normalizedRootUrl,
    p_platform: platform,
    p_feed_url: feedUrl || null,
    p_identity_linking_opt_out: identityLinkingOptOut,
    p_checkout_handoff_opt_in: checkoutHandoffOptIn,
    p_ai_training_opt_out: aiTrainingOptOut,
    p_client_name: domain,
  });

  if (rpcError || typeof siteId !== "string") {
    return { error: rpcError?.message ?? "Could not save your store — please try again." };
  }

  // Step 2 — create the run row SYNCHRONOUSLY, before responding. The store
  // view this redirects to must find a real 'running' row the instant it
  // loads; deferring row-creation itself into after() would race the
  // redirect (after() fires once the redirect response is sent, but the
  // browser's next request for /stores/<siteId> can plausibly beat it).
  const cfg = serviceConfig();
  const run = await createRun(cfg, siteId);

  // Step 3 — the actual pipeline (manifest/feed/page fetches, scoring,
  // artifact generation) is deferred into after(). PART-3 FINDING: a bare
  // fire-and-forget promise here has no completion guarantee on Vercel
  // serverless — confirmed via Next.js's own docs, which describe
  // waitUntil() as existing specifically to "extend the lifetime of a
  // serverless invocation" that otherwise ends once the response is sent.
  // after() (stable since Next.js 15.1.0, explicitly supported inside
  // Server Functions) is the documented, Vercel-first-party-wired mechanism
  // for exactly this. runAnalysis() already self-heals to a 'failed' row on
  // any thrown error via its own internal try/catch (see pipeline.ts); the
  // .catch() below is just a backstop against a throw before that point
  // (e.g. this closure itself misconfigured).
  const openAiKey = process.env.OPENAI_API_KEY;
  after(async () => {
    await runAnalysis({
      domain,
      siteId,
      config: cfg,
      existingRunId: run.runId,
      openAiKey,
    }).catch(() => undefined);
  });

  redirect(`/stores/${siteId}`);
}
