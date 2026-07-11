/**
 * Adeptra Merchant — permanent guardrail: signal weight/impact/effort/
 * pillar/category drift is impossible-by-construction (signalDefinitions.ts's
 * whole reason for existing). Two halves:
 *
 *  1. STATIC — inspects SIGNAL_DEFINITIONS itself: no duplicate signal_key,
 *     every weight/impact/effort in range, and the zero-weight set is
 *     EXACTLY the two deliberate readiness signals (merchant_center_account_
 *     ready, ucp_early_access_status) — declared explicitly here so a scored
 *     signal accidentally zeroed, or a readiness signal accidentally given a
 *     nonzero weight, both fail loudly instead of passing a bare `>= 0` check.
 *
 *  2. DYNAMIC — runs the REAL orchestrators (runManifestChecks,
 *     runCapabilityChecks, runFeedChecks, runPageConsistencyChecks,
 *     runLlmChecks, runPolicyChecks, runPaymentChecks, runReadinessChecks for
 *     the ucp pillar; runReadabilityChecks for agent_readability) against
 *     representative mocks and asserts the emitted signal_key set matches the
 *     declared set EXACTLY, per pillar, in both directions — catches a signal
 *     added/removed/recategorized without updating its definition, not just a
 *     value mismatch. Also cross-checks every emitted row's pillar/category/
 *     weight/impact/effort against SIGNAL_DEFINITIONS directly (not by trusting
 *     the check functions' internals — an independent comparison).
 *
 * Run: node --experimental-strip-types test_signal_definitions.ts
 */

import { SIGNAL_DEFINITIONS, type SignalDefinition } from "./signalDefinitions.ts";
import { runManifestChecks, type Fetcher, type SignalRow } from "./manifestChecks.ts";
import { runCapabilityChecks } from "./capabilityChecks.ts";
import { runFeedChecks, extractFeedVariants } from "./feedChecks.ts";
import { runPageConsistencyChecks } from "./pageChecks.ts";
import { runLlmChecks } from "./llmChecks.ts";
import { runPolicyChecks } from "./policyChecks.ts";
import { runPaymentChecks } from "./paymentChecks.ts";
import { runReadinessChecks } from "./readinessChecks.ts";
import { runReadabilityChecks } from "./readabilityChecks.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   - ${label}`);
  } else {
    failures++;
    console.error(`  FAIL - ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. STATIC assertions over SIGNAL_DEFINITIONS
// ---------------------------------------------------------------------------

function runStaticChecks() {
  console.log("Static checks over SIGNAL_DEFINITIONS:");
  const defs = Object.values(SIGNAL_DEFINITIONS);

  // Declared expectation, not inferred — a scored signal accidentally set to
  // 0 must fail this, and removing the deliberate 0 from a readiness signal
  // must also fail this.
  const EXPECTED_ZERO_WEIGHT_KEYS = new Set(["merchant_center_account_ready", "ucp_early_access_status"]);

  check("no duplicate signal_key", new Set(defs.map((d) => d.signal_key)).size === defs.length);

  for (const d of defs) {
    check(`${d.signal_key}: weight >= 0`, d.weight >= 0, `weight=${d.weight}`);
    check(`${d.signal_key}: impact in [1,5]`, d.impact >= 1 && d.impact <= 5, `impact=${d.impact}`);
    check(`${d.signal_key}: effort in [1,5]`, d.effort >= 1 && d.effort <= 5, `effort=${d.effort}`);

    const shouldBeZero = EXPECTED_ZERO_WEIGHT_KEYS.has(d.signal_key);
    if (shouldBeZero) {
      check(`${d.signal_key}: is a declared zero-weight readiness signal (weight === 0)`, d.weight === 0, `weight=${d.weight}`);
    } else {
      check(`${d.signal_key}: is NOT a declared zero-weight signal (weight > 0)`, d.weight > 0, `weight=${d.weight}`);
    }
  }

  const actualZeroWeightKeys = new Set(defs.filter((d) => d.weight === 0).map((d) => d.signal_key));
  check(
    "zero-weight set is EXACTLY {merchant_center_account_ready, ucp_early_access_status}",
    actualZeroWeightKeys.size === EXPECTED_ZERO_WEIGHT_KEYS.size && [...EXPECTED_ZERO_WEIGHT_KEYS].every((k) => actualZeroWeightKeys.has(k)),
    `actual={${[...actualZeroWeightKeys].join(", ")}}`,
  );
}

// ---------------------------------------------------------------------------
// 2. DYNAMIC assertions — run the real orchestrators against representative
//    mocks, compare emitted signal_key sets and full row values against
//    SIGNAL_DEFINITIONS.
// ---------------------------------------------------------------------------

const ROOT_URL = "https://shop.example.com";
const DOMAIN = "shop.example.com";
const PRODUCT_URL = `${ROOT_URL}/products/widget`;

const MANIFEST_BODY = JSON.stringify({
  ucp: {
    version: "2026-04-08",
    services: {
      "dev.ucp.shopping": [
        {
          version: "2026-04-08",
          transport: "rest",
          endpoint: `${ROOT_URL}/ucp/v1`,
          schema: "https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json",
          spec: "https://ucp.dev/specification/overview",
        },
      ],
    },
    capabilities: {
      "dev.ucp.shopping.checkout": [{ version: "2026-04-08", spec: "https://ucp.dev/specification/checkout", schema: "https://ucp.dev/2026-04-08/schemas/shopping/checkout.json" }],
      "dev.ucp.shopping.cart": [{ version: "2026-04-08", spec: "https://ucp.dev/specification/cart", schema: "https://ucp.dev/2026-04-08/schemas/shopping/cart.json" }],
      "dev.ucp.shopping.catalog": [{ version: "2026-04-08", spec: "https://ucp.dev/specification/catalog", schema: "https://ucp.dev/2026-04-08/schemas/shopping/catalog.json" }],
      "dev.ucp.shopping.fulfillment": [{ version: "2026-04-08", spec: "https://ucp.dev/specification/fulfillment", schema: "https://ucp.dev/2026-04-08/schemas/shopping/fulfillment.json" }],
      "dev.ucp.common.identity_linking": [{ version: "2026-04-08", scopes: ["dev.ucp.shopping.order:read"] }],
    },
    payment_handlers: {
      "com.google.pay": [{ config: { allowed_payment_methods: [{ tokenization_specification: {} }] } }],
    },
  },
});

const FEED_BODY = JSON.stringify({
  products: [{ id: 1, title: "Widget", body_html: "<p>A widget.</p>", handle: "widget", variants: [{ sku: "WIDGET-1", price: "9.99", available: true }] }],
});

const PRODUCT_PAGE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Widget",
  offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD", availability: "https://schema.org/InStock" },
})}</script></head><body><h1>Widget</h1><p>$9.99</p></body></html>`;

const HOMEPAGE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Shop Example",
  url: ROOT_URL,
  logo: `${ROOT_URL}/logo.png`,
  contactPoint: { "@type": "ContactPoint", telephone: "+1-555-555-5555", contactType: "customer service" },
})}</script></head><body>Shop</body></html>`;

const ROBOTS_BODY = `User-agent: *\nAllow: /\nSitemap: ${ROOT_URL}/sitemap.xml\n`;
const SITEMAP_BODY = `<?xml version="1.0"?><urlset><url><loc>${PRODUCT_URL}</loc></url></urlset>`;
const LLMS_TXT_BODY = "# Shop Example\n\nA great shop selling widgets online, direct to consumers.\n";

const routedFetcher: Fetcher = async (url: string) => {
  const ok = (body: string, contentType = "text/plain") => ({ status: 200, headers: { "content-type": contentType }, body, redirectChain: [], requiresAuth: false });
  const notFound = () => ({ status: 404, headers: {}, body: "", redirectChain: [], requiresAuth: false });

  if (url.includes("/.well-known/ucp")) return ok(MANIFEST_BODY, "application/json");
  if (url.includes("/products.json")) return ok(FEED_BODY, "application/json");
  if (url === PRODUCT_URL) return ok(PRODUCT_PAGE_HTML, "text/html");
  if (url.endsWith("/robots.txt")) return ok(ROBOTS_BODY);
  if (url.endsWith("/sitemap.xml")) return ok(SITEMAP_BODY, "application/xml");
  if (url.endsWith("/llms.txt")) return ok(LLMS_TXT_BODY);
  if (url === ROOT_URL || url === `${ROOT_URL}/`) return ok(HOMEPAGE_HTML, "text/html");
  return notFound(); // policy candidate paths, endpoint reachability, etc — fine, still emits real rows
};

async function collectUcpSignals(): Promise<SignalRow[]> {
  const { manifest, signals: manifestSignals } = await runManifestChecks(DOMAIN, routedFetcher);
  const capabilitySignals = await runCapabilityChecks(manifest, routedFetcher, { identityLinkingOptOut: false, checkoutHandoffOptIn: false });
  const { feed, signals: feedSignals } = await runFeedChecks(`${ROOT_URL}/products.json`, routedFetcher, ROOT_URL);
  const feedVariants = feed ? extractFeedVariants(feed) : [];
  const { signals: pageSignals } = await runPageConsistencyChecks(feedVariants, routedFetcher);
  const llmSignals = await runLlmChecks(feed, routedFetcher, null); // llm: null -> both LLM signals still emitted, as not_applicable
  const policySignals = await runPolicyChecks(ROOT_URL, routedFetcher);
  const paymentSignals = runPaymentChecks(manifest);
  const readinessSignals = runReadinessChecks({ accountReady: null, feedsConfigured: false, earlyAccessStatus: null });

  return [...manifestSignals, ...capabilitySignals, ...feedSignals, ...pageSignals, ...llmSignals, ...policySignals, ...paymentSignals, ...readinessSignals];
}

async function collectReadabilitySignals(): Promise<SignalRow[]> {
  const { signals } = await runReadabilityChecks({
    rootUrl: ROOT_URL,
    fetcher: routedFetcher,
    feedVariants: [],
    pageStates: [],
    opts: { aiTrainingOptOut: false },
  });
  return signals;
}

function declaredKeysForPillar(pillar: SignalDefinition["pillar"]): Set<string> {
  return new Set(Object.values(SIGNAL_DEFINITIONS).filter((d) => d.pillar === pillar).map((d) => d.signal_key));
}

function setDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x));
}

function checkPillarSignals(pillarLabel: string, pillar: SignalDefinition["pillar"], emitted: SignalRow[]) {
  const declared = declaredKeysForPillar(pillar);
  const emittedKeys = new Set(emitted.map((s) => s.signal_key));

  check(`${pillarLabel}: emitted count matches declared count (${declared.size})`, emittedKeys.size === declared.size, `emitted=${emittedKeys.size}`);

  const undeclaredEmitted = setDiff(emittedKeys, declared);
  check(`${pillarLabel}: no emitted signal_key is undeclared`, undeclaredEmitted.length === 0, undeclaredEmitted.join(", "));

  const declaredNotEmitted = setDiff(declared, emittedKeys);
  check(`${pillarLabel}: no declared signal_key went unemitted`, declaredNotEmitted.length === 0, declaredNotEmitted.join(", "));

  for (const row of emitted) {
    const def = SIGNAL_DEFINITIONS[row.signal_key];
    if (!def) continue; // already reported above
    check(`${row.signal_key}: emitted pillar matches declared`, row.pillar === def.pillar, `emitted=${row.pillar} declared=${def.pillar}`);
    check(`${row.signal_key}: emitted category matches declared`, row.category === def.category, `emitted=${row.category} declared=${def.category}`);
    check(`${row.signal_key}: emitted weight matches declared`, row.weight === def.weight, `emitted=${row.weight} declared=${def.weight}`);
    check(`${row.signal_key}: emitted impact matches declared`, row.impact === def.impact, `emitted=${row.impact} declared=${def.impact}`);
    check(`${row.signal_key}: emitted effort matches declared`, row.effort === def.effort, `emitted=${row.effort} declared=${def.effort}`);
  }
}

async function runDynamicChecks() {
  console.log("\nDynamic checks — real orchestrators against representative mocks:");

  const ucpSignals = await collectUcpSignals();
  checkPillarSignals("ucp", "ucp", ucpSignals);

  const readabilitySignals = await collectReadabilitySignals();
  checkPillarSignals("agent_readability", "agent_readability", readabilitySignals);

  const aeoGeoDeclared = declaredKeysForPillar("aeo_geo");
  check("aeo_geo: zero signals declared (intentionally empty pillar)", aeoGeoDeclared.size === 0, `declared=${aeoGeoDeclared.size}`);
}

async function main() {
  runStaticChecks();
  await runDynamicChecks();

  console.log("");
  if (failures === 0) {
    console.log("✅ signal-definitions guardrail: all checks passed.");
    process.exit(0);
  } else {
    console.error(`❌ signal-definitions guardrail: ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main();
