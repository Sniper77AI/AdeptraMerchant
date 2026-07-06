/**
 * Tests for the live-pipeline pieces that can run without network or DB:
 *  1. scorer.ts   — pillar rollup math, N/A exclusion, priority formula
 *  2. httpFetcher — redirect chain recording, auth detection, timeout, by
 *                   stubbing globalThis.fetch (no real network)
 *
 * Run: node --experimental-strip-types test_live_pipeline.ts
 */

import { runManifestChecks, type Fetcher } from "./manifestChecks.ts";
import { scorePillars, overallScore, priorityScore } from "./scorer.ts";
import { httpFetcher } from "./httpFetcher.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 1. Scorer
// ---------------------------------------------------------------------------

const GOOD_MANIFEST = JSON.stringify({
  ucp: {
    version: "2026-04-08",
    services: {
      "dev.ucp.shopping": [
        {
          version: "2026-04-08",
          spec: "https://ucp.dev/specification/overview",
          transport: "rest",
          endpoint: "https://shop.example.com/ucp/v1",
          schema: "https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json",
        },
      ],
    },
  },
});

const mockOk: Fetcher = async () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: GOOD_MANIFEST,
  redirectChain: [],
  requiresAuth: false,
});

const mock404: Fetcher = async () => ({
  status: 404,
  headers: { "content-type": "text/html" },
  body: "nope",
  redirectChain: [],
  requiresAuth: false,
});

{
  const { signals } = await runManifestChecks("shop.example.com", mockOk);
  const pillars = scorePillars(signals);
  check("scorer: single ucp pillar", pillars.length === 1 && pillars[0].pillar === "ucp", pillars);
  check("scorer: compliant store = 100%", pillars[0].score === 100, pillars[0]);
  check(
    "scorer: passed/total counts pass & applicable only",
    pillars[0].signals_passed === pillars[0].signals_total,
    pillars[0],
  );
  check("scorer: overall equals single pillar", overallScore(pillars) === pillars[0].score);
}

{
  const { signals } = await runManifestChecks("shop.example.com", mock404);
  const pillars = scorePillars(signals);
  // 404: present=fail, version=fail, services=fail, namespace=N/A
  check("scorer: 404 store = 0%", pillars[0].score === 0, pillars[0]);
  check(
    "scorer: N/A excluded from signals_total (3, not 4)",
    pillars[0].signals_total === 3,
    pillars[0],
  );
  check("scorer: priority formula matches harness", priorityScore({ impact: 5, weight: 3, effort: 2 }) === 7.5);
}

// ---------------------------------------------------------------------------
// 2. httpFetcher (stubbed globalThis.fetch)
// ---------------------------------------------------------------------------

type StubResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  hang?: boolean; // never resolve (until aborted)
};

function stubFetch(script: StubResponse[]) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push(String(input));
    const step = script[Math.min(i++, script.length - 1)];
    if (step.hang) {
      return await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });
    }
    return new Response(step.body ?? "", {
      status: step.status,
      headers: step.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

{
  // Single redirect then 200 — chain recorded, final body returned.
  const calls = stubFetch([
    { status: 301, headers: { location: "https://cdn.example.com/ucp" }, body: "" },
    { status: 200, body: GOOD_MANIFEST },
  ]);
  const res = await httpFetcher("https://shop.example.com/.well-known/ucp", 5000);
  check("fetcher: follows redirect", res.status === 200 && calls.length === 2, { status: res.status, calls });
  check("fetcher: records redirect chain", res.redirectChain.length === 1 && res.redirectChain[0] === "https://cdn.example.com/ucp", res.redirectChain);
  check("fetcher: relative Location resolved", (stubFetch([{ status: 302, headers: { location: "/moved" } }, { status: 200, body: "{}" }]), (await httpFetcher("https://a.example.com/.well-known/ucp", 5000)).redirectChain[0] === "https://a.example.com/moved"));
}

{
  // 401 → requiresAuth
  stubFetch([{ status: 401, headers: { "www-authenticate": "Basic" }, body: "" }]);
  const res = await httpFetcher("https://x.example.com/.well-known/ucp", 5000);
  check("fetcher: 401 flags requiresAuth", res.requiresAuth === true && res.status === 401, res);
}

{
  // Redirect loop → throws (caught by fetchManifest in production as fetch_failed)
  stubFetch([{ status: 301, headers: { location: "https://loop.example.com/ucp" }, body: "" }]);
  let threw = false;
  try {
    await httpFetcher("https://loop.example.com/.well-known/ucp", 5000);
  } catch {
    threw = true;
  }
  check("fetcher: redirect loop throws", threw);
}

{
  // Timeout → rejects within budget
  stubFetch([{ status: 200, hang: true }]);
  const t0 = Date.now();
  let threw = false;
  try {
    await httpFetcher("https://slow.example.com/.well-known/ucp", 200);
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - t0;
  check("fetcher: timeout aborts", threw && elapsed < 2000, { threw, elapsed });
}

globalThis.fetch = realFetch;

console.log(failures === 0 ? "\nAll pipeline tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
