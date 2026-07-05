import { runManifestChecks, type Fetcher, type FetchResult } from "./manifestChecks.ts";

// --- Three mock manifests ---------------------------------------------------

// A. Fully compliant store (should mostly PASS)
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
    capabilities: {
      "dev.ucp.shopping.checkout": [
        { version: "2026-04-08", spec: "https://ucp.dev/specification/checkout", schema: "https://ucp.dev/2026-04-08/schemas/shopping/checkout.json" },
      ],
    },
  },
});

// B. Present but flawed: stale version, missing schema, one bad-authority URL (should PARTIAL)
const PARTIAL_MANIFEST = JSON.stringify({
  ucp: {
    version: "2025-11-01", // unknown/older
    services: {
      "dev.ucp.shopping": [
        { version: "2025-11-01", spec: "https://evilcdn.example.net/spec", transport: "rest", endpoint: "https://shop2.example.com/ucp" }, // no schema, bad authority
      ],
    },
  },
});

// --- Mock fetchers ----------------------------------------------------------

const mockFetch =
  (result: Partial<FetchResult> & { body: string; status: number }): Fetcher =>
  async () => ({
    status: result.status,
    headers: result.headers ?? { "content-type": "application/json" },
    body: result.body,
    redirectChain: result.redirectChain ?? [],
    requiresAuth: result.requiresAuth ?? false,
  });

const scenarios: Record<string, Fetcher> = {
  "A. compliant store": mockFetch({ status: 200, body: GOOD_MANIFEST }),
  "B. present-but-flawed": mockFetch({ status: 200, body: PARTIAL_MANIFEST }),
  "C. missing manifest (404)": mockFetch({ status: 404, body: "<html>Not Found</html>", headers: { "content-type": "text/html" } }),
  "D. auth-walled manifest": mockFetch({ status: 200, body: GOOD_MANIFEST, requiresAuth: true }),
};

// --- Run --------------------------------------------------------------------

function bar(status: string): string {
  return { pass: "✅ PASS", partial: "🟡 PART", fail: "❌ FAIL", not_applicable: "⚪ N/A " }[status] ?? status;
}

for (const [name, fetcher] of Object.entries(scenarios)) {
  const { signals } = await runManifestChecks("shop.example.com", fetcher);
  const earned = signals.reduce((s, r) => s + r.score_contribution, 0);
  const achievable = signals
    .filter((r) => r.status !== "not_applicable")
    .reduce((s, r) => s + r.weight, 0);
  const pct = achievable > 0 ? ((earned / achievable) * 100).toFixed(0) : "n/a";

  console.log(`\n=== ${name} ===  (manifest sub-score: ${pct}%)`);
  for (const r of signals) {
    const prio = ((r.impact * r.weight) / Math.max(r.effort, 1)).toFixed(2);
    console.log(`  ${bar(r.status)}  ${r.signal_key.padEnd(32)} w=${r.weight} prio=${prio}  ${r.fix_summary ?? ""}`);
  }
}
console.log("");
