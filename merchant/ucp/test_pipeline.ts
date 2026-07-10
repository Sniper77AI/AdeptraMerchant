/**
 * Tests for the callable pipeline (mock-driven — no real network/DB).
 *
 * supabaseSink.ts's rest() and storageSink.ts's upload/sign calls now accept
 * an injectable SupabaseConfig.fetcher (defaults to real fetch when absent),
 * the same portability contract the signal-check modules already use for
 * HTTP — this is what lets these tests mock PostgREST/Storage responses
 * without monkey-patching globalThis.fetch. httpFetcher.ts (the manifest/
 * feed/policy prober used inside runAnalysis) has no such injection point,
 * so runAnalysis's tests temporarily replace globalThis.fetch instead,
 * restoring it in a finally block.
 *
 * 1. ensureSiteFromIntake: creates a new client+site with platform/feed_url/
 *    opt-out written to the right columns; defaults clientName to domain
 *    when omitted; upserts (PATCH, not a duplicate POST) on a repeat
 *    submission for the same client+root_url; NEVER writes is_test (real
 *    intake is always a real site).
 * 1b. ensureDevSite: sets is_test: true on a newly CREATED site (the dev
 *     bootstrap path is never a real merchant site) but never re-sets it
 *     when reusing an already-existing site found by domain.
 * 2. runAnalysis: returns the documented result shape (no_manifest path);
 *    returns {status:"failed", error} — never throws/exits — when a
 *    downstream call fails.
 * 3. runExport: throws RunNotFoundError / NoArtifactsError as documented;
 *    returns the documented result shape on success.
 * 4. Endpoint handler (createHandler with injected fake pipeline deps): a
 *    valid POST returns the expected 200 JSON; missing url/platform return
 *    400; a non-POST method returns 405; an analysis failure returns 500;
 *    NoArtifactsError from export still returns 200 with a note; the
 *    reportUrl/bundleUrl it returns are OUR routes (/api/report/.., /api/
 *    bundle/..), never a raw signed Storage URL.
 * 5. getReportHtml / getBundleBytes: RunNotFoundError when the run doesn't
 *    exist; ReportNotFoundError/BundleNotFoundError when it exists but was
 *    never exported; returns the object's bytes/text on success.
 * 6. isEntitled: stub always returns true.
 * 7. Report route handler: valid GET renders with text/html content-type +
 *    inline disposition; RunNotFoundError/ReportNotFoundError -> 404;
 *    non-GET -> 405.
 * 8. Bundle route handler: not-entitled -> 402 (bytes never fetched);
 *    entitled -> 200 with application/zip + attachment disposition;
 *    BundleNotFoundError -> 404.
 *
 * Run: node --experimental-strip-types test_pipeline.ts
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ensureSiteFromIntake,
  runAnalysis,
  runExport,
  getReportHtml,
  getBundleBytes,
  isEntitled,
  RunNotFoundError,
  NoArtifactsError,
  ReportNotFoundError,
  BundleNotFoundError,
} from "./pipeline.ts";
import type { SupabaseConfig } from "./supabaseSink.ts";
import { ensureDevSite } from "./supabaseSink.ts";
import { createHandler, type PipelineDeps } from "../api/analyze.ts";
import { createHandler as createReportHandler, type ReportDeps } from "../api/report/[runId].ts";
import { createHandler as createBundleHandler, type BundleDeps } from "../api/bundle/[runId].ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Mock fetch plumbing
// ---------------------------------------------------------------------------

interface MockCall {
  url: string;
  method: string;
  body?: string;
}

interface MockHandler {
  match: (url: string, method: string) => boolean;
  respond: (url: string, init: RequestInit) => Response;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function makeMockFetch(handlers: MockHandler[], calls: MockCall[]): typeof fetch {
  return (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
    for (const h of handlers) {
      if (h.match(url, method)) return h.respond(url, init);
    }
    // Catch-all: unmatched calls 404 — matches real behavior for the many
    // policy/homepage/endpoint-reachability probe candidate URLs.
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function has(calls: MockCall[], urlSubstr: string, method: string): boolean {
  return calls.some((c) => c.url.includes(urlSubstr) && c.method === method);
}

// ---------------------------------------------------------------------------
// 1. ensureSiteFromIntake
// ---------------------------------------------------------------------------

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "POST", respond: () => jsonResponse([{ id: "client-new" }]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "POST", respond: () => jsonResponse([{ id: "site-new" }]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const result = await ensureSiteFromIntake({
    config: cfg,
    domain: "new-store.test",
    platform: "woocommerce",
    feedUrl: "https://new-store.test/products.json",
    identityLinkingOptOut: true,
  });

  check("ensureSiteFromIntake: returns the created siteId", result.siteId === "site-new", result);
  check("ensureSiteFromIntake: defaults clientName to the domain when omitted", has(calls, "name=eq.new-store.test", "GET"), calls.map((c) => c.url));

  const sitesPost = calls.find((c) => c.url.includes("/rest/v1/sites") && c.method === "POST");
  const sentBody = sitesPost?.body ? JSON.parse(sitesPost.body) : null;
  check(
    "ensureSiteFromIntake: writes platform/feed_url/identity_linking_opt_out to the new site row",
    sentBody?.[0]?.platform === "woocommerce" && sentBody?.[0]?.feed_url === "https://new-store.test/products.json" && sentBody?.[0]?.identity_linking_opt_out === true,
    sentBody,
  );
  check("ensureSiteFromIntake: new site defaults is_ecommerce true", sentBody?.[0]?.is_ecommerce === true, sentBody);
  check(
    "ensureSiteFromIntake: NEVER writes is_test — real intake is, by definition, a real site (relies on the column's own DEFAULT false)",
    sentBody?.[0]?.is_test === undefined,
    sentBody,
  );
}

// ---------------------------------------------------------------------------
// 1b. ensureDevSite — the dev bootstrap path. Anything it CREATES is, by
//     definition, not a real merchant site, so it must set is_test: true on
//     creation — but never on a reuse of an already-existing site (which may
//     since have become real via ensureSiteFromIntake pointing at the same
//     domain).
// ---------------------------------------------------------------------------

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "POST", respond: () => jsonResponse([{ id: "client-dev" }]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "POST", respond: () => jsonResponse([{ id: "site-dev-new" }]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const siteId = await ensureDevSite(cfg, { clientName: "Adeptra Dev", domain: "dev-store.test" });
  check("ensureDevSite: returns the created siteId", siteId === "site-dev-new", siteId);

  const sitesPost = calls.find((c) => c.url.includes("/rest/v1/sites") && c.method === "POST");
  const sentBody = sitesPost?.body ? JSON.parse(sitesPost.body) : null;
  check("ensureDevSite: sets is_test: true on a newly created site (the dev bootstrap path is never a real merchant site)", sentBody?.[0]?.is_test === true, sentBody);
}

{
  // Reusing an already-existing site (found by domain) must NOT re-flag it —
  // no POST happens at all here, so there's no body to (mis)set is_test on.
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "GET", respond: () => jsonResponse([{ id: "client-dev" }]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "GET", respond: () => jsonResponse([{ id: "site-dev-existing" }]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const siteId = await ensureDevSite(cfg, { clientName: "Adeptra Dev", domain: "dev-store.test" });
  check("ensureDevSite (repeat): reuses the existing siteId", siteId === "site-dev-existing", siteId);
  check("ensureDevSite (repeat): does NOT create a duplicate site row (so is_test can't be re-set on reuse)", !has(calls, "/rest/v1/sites", "POST"), calls.map((c) => `${c.method} ${c.url}`));
}

{
  // Existing client + existing site (same client_id + root_url) -> PATCH, not a duplicate POST.
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/clients") && m === "GET", respond: () => jsonResponse([{ id: "client-existing" }]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "GET", respond: () => jsonResponse([{ id: "site-existing" }]) },
      { match: (u, m) => u.includes("/rest/v1/sites") && m === "PATCH", respond: () => jsonResponse([{ id: "site-existing" }]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const result = await ensureSiteFromIntake({
    config: cfg,
    clientName: "Returning Merchant",
    domain: "returning-store.test",
    platform: "shopify",
  });

  check("ensureSiteFromIntake (repeat): reuses the existing siteId", result.siteId === "site-existing", result);
  check("ensureSiteFromIntake (repeat): PATCHes the existing site (upsert)", has(calls, "/rest/v1/sites?id=eq.site-existing", "PATCH"), calls.map((c) => `${c.method} ${c.url}`));
  check("ensureSiteFromIntake (repeat): does NOT create a duplicate site row", !has(calls, "/rest/v1/sites", "POST"), calls.map((c) => `${c.method} ${c.url}`));

  const patchCall = calls.find((c) => c.url.includes("/rest/v1/sites") && c.method === "PATCH");
  const patchBody = patchCall?.body ? JSON.parse(patchCall.body) : null;
  check("ensureSiteFromIntake (repeat): PATCH body carries the newly-submitted platform", patchBody?.platform === "shopify", patchBody);
}

// ---------------------------------------------------------------------------
// 2. runAnalysis
// ---------------------------------------------------------------------------

const SITE_ROW = {
  id: "site-1",
  domain: "mock-store.test",
  root_url: "https://mock-store.test",
  platform: null,
  identity_linking_opt_out: false,
  feed_url: null,
  merchant_center_account_ready: null,
  merchant_center_feeds_configured: false,
  ucp_early_access_status: null,
};

function analysisHandlers(signalsStatus = 200): MockHandler[] {
  return [
    { match: (u, m) => u.includes("/rest/v1/sites") && m === "GET", respond: () => jsonResponse([SITE_ROW]) },
    { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "POST", respond: () => jsonResponse([{ id: "run-1" }]) },
    { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "PATCH", respond: () => new Response("", { status: 200 }) },
    {
      match: (u, m) => u.includes("/rest/v1/signals") && m === "POST",
      respond: (_u, init) => {
        if (signalsStatus !== 200) return new Response("forced failure", { status: signalsStatus });
        const rows = JSON.parse(init.body as string) as Array<{ signal_key: string }>;
        return jsonResponse(rows.map((r, i) => ({ id: `sig-${i}`, signal_key: r.signal_key })));
      },
    },
    {
      match: (u, m) => u.includes("/rest/v1/pillar_scores") && m === "POST",
      respond: (_u, init) => jsonResponse((JSON.parse(init.body as string) as unknown[]).map(() => ({}))),
    },
    {
      match: (u, m) => u.includes("/rest/v1/artifacts") && m === "POST",
      respond: (_u, init) => {
        const rows = JSON.parse(init.body as string) as Array<{ artifact_type: string }>;
        return jsonResponse(rows.map((r, i) => ({ id: `art-${i}`, artifact_type: r.artifact_type })));
      },
    },
  ];
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(analysisHandlers(), calls);
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  let result;
  try {
    result = await runAnalysis({ domain: "mock-store.test", siteId: "site-1", config: cfg });
  } finally {
    globalThis.fetch = originalFetch;
  }

  check("runAnalysis: returns the created runId", result.runId === "run-1", result);
  check("runAnalysis: status is no_manifest (manifest 404s via the mock catch-all)", result.status === "no_manifest", result);
  check("runAnalysis: overallScore is null for a no_manifest run", result.overallScore === null, result);
  check("runAnalysis: pillarCount/signalCount are numbers", typeof result.pillarCount === "number" && typeof result.signalCount === "number", result);
  check("runAnalysis: artifactTypes is an array", Array.isArray(result.artifactTypes), result);
  check("runAnalysis: marks the run no_manifest (PATCH sent)", has(calls, "/rest/v1/analysis_runs?id=eq.run-1", "PATCH"), calls.map((c) => `${c.method} ${c.url}`));
}

{
  // Forced failure: /rest/v1/signals POST returns 500 -> runAnalysis must
  // return {status:"failed"}, never throw, and still mark the run failed.
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(analysisHandlers(500), calls);
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  let result: Awaited<ReturnType<typeof runAnalysis>> | null = null;
  let threw: unknown = null;
  try {
    result = await runAnalysis({ domain: "mock-store.test", siteId: "site-1", config: cfg });
  } catch (e) {
    threw = e;
  } finally {
    globalThis.fetch = originalFetch;
  }

  check("runAnalysis (forced failure): does not throw", threw === null, threw);
  check("runAnalysis (forced failure): returns status 'failed'", result?.status === "failed", result);
  check("runAnalysis (forced failure): carries a non-empty error message", typeof result?.error === "string" && result.error.length > 0, result);
  check("runAnalysis (forced failure): still marks the run failed (PATCH sent)", has(calls, "/rest/v1/analysis_runs?id=eq.run-1", "PATCH"), calls.map((c) => `${c.method} ${c.url}`));
}

// ---------------------------------------------------------------------------
// 3. runExport
// ---------------------------------------------------------------------------

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch([{ match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([]) }], calls);
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await runExport({ runId: "missing-run", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("runExport: throws RunNotFoundError when the run doesn't exist", threw instanceof RunNotFoundError, threw);
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      {
        match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET",
        respond: () => jsonResponse([{ id: "run-2", site_id: "site-1", status: "complete", overall_score: 90, created_at: "2026-07-08T00:00:00.000Z", sites: { domain: "mock-store.test" } }]),
      },
      { match: (u, m) => u.includes("/rest/v1/pillar_scores") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/signal_evidence") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/signals") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/artifacts") && m === "GET", respond: () => jsonResponse([]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await runExport({ runId: "run-2", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("runExport: throws NoArtifactsError when the run has zero artifacts", threw instanceof NoArtifactsError, threw);
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      {
        match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET",
        respond: () => jsonResponse([{ id: "run-3", site_id: "site-1", status: "complete", overall_score: 77.5, created_at: "2026-07-08T00:00:00.000Z", sites: { domain: "mock-store.test" } }]),
      },
      { match: (u, m) => u.includes("/rest/v1/pillar_scores") && m === "GET", respond: () => jsonResponse([{ pillar: "ucp", score: 77.5, signals_passed: 10, signals_total: 13 }]) },
      { match: (u, m) => u.includes("/rest/v1/signal_evidence") && m === "GET", respond: () => jsonResponse([]) },
      { match: (u, m) => u.includes("/rest/v1/signals") && m === "GET", respond: () => jsonResponse([]) },
      {
        match: (u, m) => u.includes("/rest/v1/artifacts") && m === "GET",
        respond: () =>
          jsonResponse([
            {
              artifact_type: "ucp_manifest",
              target_url: "/.well-known/ucp",
              content: JSON.stringify({ ucp: { version: "2026-04-08" } }),
              changelog_json: { added: [], corrected: [], must_complete: [], flagged: [] },
              resolves_signal_ids: [],
            },
          ]),
      },
      { match: (u, m) => u.includes("/storage/v1/object/sign/"), respond: () => jsonResponse({ signedURL: "/object/sign/merchant-exports/mock-store.test/run-3/x" }) },
      { match: (u, m) => u.includes("/storage/v1/object/") && m === "POST", respond: () => new Response("", { status: 200 }) },
      { match: (u, m) => u.includes("/rest/v1/exports") && m === "POST", respond: () => jsonResponse([{ id: "export-1" }]) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const result = await runExport({ runId: "run-3", config: cfg });
  check("runExport: returns the exportId", result.exportId === "export-1", result);
  check("runExport: returns the runId (regression — exportRun.ts's CLI output depends on this)", result.runId === "run-3", result);
  check("runExport: returns the domain", result.domain === "mock-store.test", result);
  check("runExport: returns the run's status", result.status === "complete", result);
  check("runExport: returns artifactCount", result.artifactCount === 1, result);
  check("runExport: returns signed reportUrl/bundleUrl", typeof result.reportUrl === "string" && typeof result.bundleUrl === "string", result);
}

// ---------------------------------------------------------------------------
// 4. Endpoint handler (createHandler with injected fake pipeline deps)
// ---------------------------------------------------------------------------

function fakeReq(method: string, jsonBody?: unknown): IncomingMessage {
  const bodyStr = jsonBody !== undefined ? JSON.stringify(jsonBody) : "";
  const chunk = bodyStr ? Buffer.from(bodyStr, "utf8") : null;
  const req: any = {
    method,
    async *[Symbol.asyncIterator]() {
      if (chunk) yield chunk;
    },
  };
  return req as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; getStatus: () => number; getBody: () => any } {
  let statusCode = 200;
  let body = "";
  const res: any = {
    setHeader() {},
    end(text?: any) {
      if (text !== undefined) body = String(text);
    },
  };
  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (v) => {
      statusCode = v;
    },
  });
  return { res: res as ServerResponse, getStatus: () => statusCode, getBody: () => (body ? JSON.parse(body) : null) };
}

const happyDeps: PipelineDeps = {
  ensureSiteFromIntake: async () => ({ siteId: "site-h" }),
  runAnalysis: async () => ({
    runId: "run-h",
    status: "complete",
    overallScore: 88,
    pillarCount: 1,
    signalCount: 20,
    artifactCount: 2,
    artifactTypes: ["ucp_manifest", "feed_fix"],
  }),
  runExport: async () => ({
    exportId: "export-h",
    runId: "run-h",
    // Deliberately still a raw signed-looking Storage URL here, to prove the
    // endpoint DISCARDS this and substitutes its own routes rather than
    // passing it through — see the assertion below.
    reportUrl: "https://mock.supabase.co/storage/v1/object/sign/merchant-exports/mock-store.test/run-h/report.html?token=abc",
    bundleUrl: "https://mock.supabase.co/storage/v1/object/sign/merchant-exports/mock-store.test/run-h/bundle.zip?token=abc",
    domain: "mock-store.test",
    status: "complete",
    artifactCount: 2,
  }),
};

{
  const handler = createHandler(happyDeps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeReq("POST", { url: "https://mock-store.test", platform: "woocommerce" }), res);
  check("endpoint: valid POST returns 200", getStatus() === 200, getStatus());
  const body = getBody();
  check("endpoint: response carries the expected fields", body?.runId === "run-h" && body?.overallScore === 88, body);
  check(
    "endpoint: reportUrl/bundleUrl are OUR routes, not the raw signed Storage URL runExport returned",
    body?.reportUrl === "/api/report/run-h" && body?.bundleUrl === "/api/bundle/run-h",
    body,
  );
  check("endpoint: never leaks a raw Storage URL into the response", JSON.stringify(body).includes("supabase.co") === false, body);
}

{
  const handler = createHandler(happyDeps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeReq("POST", { platform: "woocommerce" }), res); // missing url
  check("endpoint: missing url -> 400", getStatus() === 400, { status: getStatus(), body: getBody() });
}

{
  const handler = createHandler(happyDeps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeReq("POST", { url: "https://mock-store.test" }), res); // missing platform
  check("endpoint: missing platform -> 400", getStatus() === 400, { status: getStatus(), body: getBody() });
}

{
  const handler = createHandler(happyDeps);
  const { res, getStatus } = fakeRes();
  await handler(fakeReq("GET"), res);
  check("endpoint: non-POST method -> 405", getStatus() === 405, getStatus());
}

{
  const failingDeps: PipelineDeps = {
    ...happyDeps,
    runAnalysis: async () => ({
      runId: "run-fail",
      status: "failed",
      overallScore: null,
      pillarCount: 0,
      signalCount: 0,
      artifactCount: 0,
      artifactTypes: [],
      error: "manifest fetch exploded",
    }),
  };
  const handler = createHandler(failingDeps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeReq("POST", { url: "https://mock-store.test", platform: "woocommerce" }), res);
  check("endpoint: analysis status 'failed' -> 500 with the error message", getStatus() === 500 && getBody()?.error === "manifest fetch exploded", { status: getStatus(), body: getBody() });
}

{
  const noArtifactsDeps: PipelineDeps = {
    ...happyDeps,
    runExport: async () => {
      throw new NoArtifactsError("run-clean");
    },
  };
  const handler = createHandler(noArtifactsDeps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeReq("POST", { url: "https://mock-store.test", platform: "woocommerce" }), res);
  const body = getBody();
  check("endpoint: NoArtifactsError from export still returns 200 (good news, not a failure)", getStatus() === 200, { status: getStatus(), body });
  check("endpoint: reportUrl/bundleUrl are null and a note is present", body?.reportUrl === null && body?.bundleUrl === null && typeof body?.note === "string", body);
}

// ---------------------------------------------------------------------------
// 5. getReportHtml / getBundleBytes
// ---------------------------------------------------------------------------

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch([{ match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([]) }], calls);
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await getReportHtml({ runId: "missing-run", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("getReportHtml: throws RunNotFoundError when the run doesn't exist", threw instanceof RunNotFoundError, threw);
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([{ sites: { domain: "mock-store.test" } }]) },
      { match: (u, m) => u.includes("/storage/v1/object/") && m === "GET", respond: () => new Response("not found", { status: 404 }) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await getReportHtml({ runId: "never-exported", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("getReportHtml: throws ReportNotFoundError when the run exists but was never exported", threw instanceof ReportNotFoundError, threw);
}

{
  const calls: MockCall[] = [];
  const html = "<html><body>Report with an em dash — right here</body></html>";
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([{ sites: { domain: "mock-store.test" } }]) },
      { match: (u, m) => u.includes("/storage/v1/object/") && m === "GET", respond: () => new Response(html, { status: 200 }) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const result = await getReportHtml({ runId: "run-ok", config: cfg });
  check("getReportHtml: returns the object's text content exactly", result === html, result);
  check(
    "getReportHtml: fetches from the expected domain/runId path",
    calls.some((c) => c.method === "GET" && c.url.includes("mock-store.test/run-ok/report.html")),
    calls.map((c) => `${c.method} ${c.url}`),
  );
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch([{ match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([]) }], calls);
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await getBundleBytes({ runId: "missing-run", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("getBundleBytes: throws RunNotFoundError when the run doesn't exist", threw instanceof RunNotFoundError, threw);
}

{
  const calls: MockCall[] = [];
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([{ sites: { domain: "mock-store.test" } }]) },
      { match: (u, m) => u.includes("/storage/v1/object/") && m === "GET", respond: () => new Response("not found", { status: 404 }) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  let threw: unknown = null;
  try {
    await getBundleBytes({ runId: "never-exported", config: cfg });
  } catch (e) {
    threw = e;
  }
  check("getBundleBytes: throws BundleNotFoundError when the run exists but was never exported", threw instanceof BundleNotFoundError, threw);
}

{
  const calls: MockCall[] = [];
  const zipBytes = "PK-fake-zip-bytes";
  const fetcher = makeMockFetch(
    [
      { match: (u, m) => u.includes("/rest/v1/analysis_runs") && m === "GET", respond: () => jsonResponse([{ sites: { domain: "mock-store.test" } }]) },
      { match: (u, m) => u.includes("/storage/v1/object/") && m === "GET", respond: () => new Response(zipBytes, { status: 200 }) },
    ],
    calls,
  );
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key", fetcher };

  const result = await getBundleBytes({ runId: "run-ok", config: cfg });
  check("getBundleBytes: returns the object's bytes", result.bytes.toString("utf8") === zipBytes, result.bytes.toString("utf8"));
  check("getBundleBytes: returns a sensible filename", typeof result.filename === "string" && result.filename.endsWith(".zip"), result.filename);
  check(
    "getBundleBytes: fetches from the expected domain/runId path",
    calls.some((c) => c.method === "GET" && c.url.includes("mock-store.test/run-ok/bundle.zip")),
    calls.map((c) => `${c.method} ${c.url}`),
  );
}

// ---------------------------------------------------------------------------
// 6. isEntitled (stub)
// ---------------------------------------------------------------------------

{
  const cfg: SupabaseConfig = { url: "https://mock.supabase.co", serviceRoleKey: "mock-key" };
  const result = await isEntitled({ runId: "any-run", config: cfg });
  check("isEntitled: stub always returns true (no billing yet)", result === true, result);
}

// ---------------------------------------------------------------------------
// 7. Report route handler
// ---------------------------------------------------------------------------

function fakeGetReq(path: string): IncomingMessage {
  const req: any = { method: "GET", url: path, async *[Symbol.asyncIterator]() {} };
  return req as IncomingMessage;
}

{
  const deps: ReportDeps = { getReportHtml: async () => "<html><body>hi — there</body></html>" };
  const handler = createReportHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeGetReq("/api/report/run-1"), res);
  check("report route: valid GET returns 200", getStatus() === 200, getStatus());
}

{
  const capturedHeaders: Record<string, string> = {};
  const deps: ReportDeps = { getReportHtml: async () => "<html></html>" };
  const handler = createReportHandler(deps);
  const { res } = fakeRes();
  (res as any).setHeader = (k: string, v: string) => {
    capturedHeaders[k.toLowerCase()] = v;
  };
  await handler(fakeGetReq("/api/report/run-1"), res);
  check("report route: serves with text/html; charset=utf-8", capturedHeaders["content-type"] === "text/html; charset=utf-8", capturedHeaders);
  check("report route: content-disposition is inline (renders, not downloads)", capturedHeaders["content-disposition"] === "inline", capturedHeaders);
}

{
  const deps: ReportDeps = {
    getReportHtml: async () => {
      throw new RunNotFoundError("missing-run");
    },
  };
  const handler = createReportHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeGetReq("/api/report/missing-run"), res);
  check("report route: RunNotFoundError -> 404", getStatus() === 404, getStatus());
}

{
  const deps: ReportDeps = {
    getReportHtml: async () => {
      throw new ReportNotFoundError("never-exported");
    },
  };
  const handler = createReportHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeGetReq("/api/report/never-exported"), res);
  check("report route: ReportNotFoundError -> 404", getStatus() === 404, getStatus());
}

{
  const deps: ReportDeps = { getReportHtml: async () => "<html></html>" };
  const handler = createReportHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeReq("POST"), res);
  check("report route: non-GET -> 405", getStatus() === 405, getStatus());
}

// ---------------------------------------------------------------------------
// 8. Bundle route handler
// ---------------------------------------------------------------------------

{
  let bundleFetchCalled = false;
  const deps: BundleDeps = {
    isEntitled: async () => false,
    getBundleBytes: async () => {
      bundleFetchCalled = true;
      return { bytes: Buffer.from("zip"), filename: "x.zip" };
    },
  };
  const handler = createBundleHandler(deps);
  const { res, getStatus, getBody } = fakeRes();
  await handler(fakeGetReq("/api/bundle/run-1"), res);
  check("bundle route: not entitled -> 402", getStatus() === 402, { status: getStatus(), body: getBody() });
  check("bundle route: not entitled -> bytes never fetched", bundleFetchCalled === false, bundleFetchCalled);
}

{
  const capturedHeaders: Record<string, string> = {};
  const deps: BundleDeps = {
    isEntitled: async () => true,
    getBundleBytes: async () => ({ bytes: Buffer.from("real-zip-bytes"), filename: "adeptra-merchant-fix-bundle.zip" }),
  };
  const handler = createBundleHandler(deps);
  const { res, getStatus } = fakeRes();
  (res as any).setHeader = (k: string, v: string) => {
    capturedHeaders[k.toLowerCase()] = v;
  };
  await handler(fakeGetReq("/api/bundle/run-1"), res);
  check("bundle route: entitled -> 200", getStatus() === 200, getStatus());
  check("bundle route: content-type is application/zip", capturedHeaders["content-type"] === "application/zip", capturedHeaders);
  check(
    "bundle route: content-disposition is attachment with a filename (downloads, doesn't render)",
    !!capturedHeaders["content-disposition"]?.includes("attachment") && !!capturedHeaders["content-disposition"]?.includes("adeptra-merchant-fix-bundle.zip"),
    capturedHeaders,
  );
}

{
  const deps: BundleDeps = {
    isEntitled: async () => true,
    getBundleBytes: async () => {
      throw new BundleNotFoundError("never-exported");
    },
  };
  const handler = createBundleHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeGetReq("/api/bundle/never-exported"), res);
  check("bundle route: BundleNotFoundError -> 404", getStatus() === 404, getStatus());
}

{
  const deps: BundleDeps = { isEntitled: async () => true, getBundleBytes: async () => ({ bytes: Buffer.from(""), filename: "x.zip" }) };
  const handler = createBundleHandler(deps);
  const { res, getStatus } = fakeRes();
  await handler(fakeReq("POST"), res);
  check("bundle route: non-GET -> 405", getStatus() === 405, getStatus());
}

console.log(failures === 0 ? "\nAll pipeline tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
