/**
 * Tests for the live-pipeline pieces that can run without network or DB:
 *  1. scorer.ts   — pillar rollup math, N/A exclusion, priority formula
 *  2. httpFetcher — redirect chain recording, auth detection, timeout, by
 *                   stubbing globalThis.fetch (no real network)
 *
 * Run: node --experimental-strip-types test_live_pipeline.ts
 */

import { runManifestChecks, type Fetcher, type ManifestState } from "./manifestChecks.ts";
import { runCapabilityChecks, checkEndpointReachability, sig_capability_catalog_declared } from "./capabilityChecks.ts";
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
// 2. capabilityChecks (Category 3)
// ---------------------------------------------------------------------------

const FULL_CAPS_STATE: ManifestState = {
  url: "https://shop.example.com/.well-known/ucp",
  reachable: true,
  httpStatus: 200,
  contentType: "application/json",
  requiresAuth: false,
  redirectChain: [],
  isValidJson: true,
  parsed: {
    ucp: {
      version: "2026-04-08",
      services: {
        "dev.ucp.shopping": [
          {
            version: "2026-04-08",
            transport: "rest",
            endpoint: "https://shop.example.com/ucp/v1",
            schema: "https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json",
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: "2026-04-08", schema: "https://ucp.dev/2026-04-08/schemas/shopping/checkout.json" }],
        "dev.ucp.shopping.cart": [{ version: "2026-04-08" }],
        "dev.ucp.shopping.catalog": [{ version: "2026-04-08" }],
        "dev.ucp.shopping.fulfillment": [{ version: "2026-04-08", schema: "https://ucp.dev/2026-04-08/schemas/shopping/fulfillment.json" }],
        "dev.ucp.common.identity_linking": [{ scopes: ["dev.ucp.shopping.order:read"] }],
      },
    },
  },
};

const EMPTY_CAPS_STATE: ManifestState = {
  url: "https://shop.example.com/.well-known/ucp",
  reachable: true,
  httpStatus: 200,
  contentType: "application/json",
  requiresAuth: false,
  redirectChain: [],
  isValidJson: true,
  parsed: { ucp: { version: "2026-04-08", services: {} } },
};

const mockEndpointOk: Fetcher = async () => ({ status: 200, headers: {}, body: "{}", redirectChain: [], requiresAuth: false });
const mockEndpointError: Fetcher = async () => ({ status: 500, headers: {}, body: "", redirectChain: [], requiresAuth: false });
const mockEndpointThrow: Fetcher = async () => {
  throw new Error("ECONNREFUSED");
};

{
  const signals = await runCapabilityChecks(FULL_CAPS_STATE, mockEndpointOk);
  const byKey = Object.fromEntries(signals.map((s) => [s.signal_key, s]));
  check("capabilities: checkout pass when version+schema present", byKey.capability_checkout_declared.status === "pass", byKey.capability_checkout_declared);
  check("capabilities: cart pass when version present", byKey.capability_cart_declared.status === "pass", byKey.capability_cart_declared);
  check("capabilities: catalog pass when declared", byKey.capability_catalog_declared.status === "pass", byKey.capability_catalog_declared);
  check("capabilities: fulfillment pass when version+schema present", byKey.capability_fulfillment_declared.status === "pass", byKey.capability_fulfillment_declared);
  check("capabilities: identity_linking pass when scopes present", byKey.capability_identity_linking_declared.status === "pass", byKey.capability_identity_linking_declared);
  check("capabilities: endpoint_reachability pass on 200", byKey.endpoint_reachability.status === "pass", byKey.endpoint_reachability);
}

{
  const signals = await runCapabilityChecks(EMPTY_CAPS_STATE, mockEndpointOk);
  check("capabilities: all six fail when nothing declared (incl. no-endpoint probe)", signals.every((s) => s.status === "fail"), signals);
}

{
  const errSignal = await checkEndpointReachability(FULL_CAPS_STATE, mockEndpointError);
  check("endpoint_reachability: partial on non-2xx/3xx (500)", errSignal.status === "partial", errSignal);
}

{
  // Real-world shape (Skims/Shopify): no flat "dev.ucp.shopping.catalog" key —
  // catalog is split into .search / .lookup sub-capabilities instead.
  const SPLIT_CATALOG_STATE: ManifestState = {
    ...EMPTY_CAPS_STATE,
    parsed: {
      ucp: {
        version: "2026-04-08",
        capabilities: {
          "dev.ucp.shopping.catalog.search": [{ version: "2026-04-08" }],
          "dev.ucp.shopping.catalog.lookup": [{ version: "2026-04-08" }],
        },
      },
    },
  };
  const signal = sig_capability_catalog_declared(SPLIT_CATALOG_STATE);
  check("capability_catalog_declared: pass on split .search/.lookup sub-capabilities (no flat key)", signal.status === "pass", signal);
}

{
  const throwSignal = await checkEndpointReachability(FULL_CAPS_STATE, mockEndpointThrow);
  check("endpoint_reachability: fail when fetch throws", throwSignal.status === "fail", throwSignal);
}

{
  // Manifest signals (Category 1) + capability signals (Category 3) roll into ONE ucp pillar.
  const { signals: manifestSignals } = await runManifestChecks("shop.example.com", mockOk);
  const capabilitySignals = await runCapabilityChecks(FULL_CAPS_STATE, mockEndpointOk);
  const pillars = scorePillars([...manifestSignals, ...capabilitySignals]);
  check("combined: manifest + capability signals roll into a single ucp pillar", pillars.length === 1 && pillars[0].pillar === "ucp", pillars);
  check("combined: signals_total counts both categories (4 + 6 = 10)", pillars[0].signals_total === 10, pillars[0]);
  check("combined: all-pass manifest+capabilities = 100%", pillars[0].score === 100, pillars[0]);
}

// ---------------------------------------------------------------------------
// 3. httpFetcher (stubbed globalThis.fetch)
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
