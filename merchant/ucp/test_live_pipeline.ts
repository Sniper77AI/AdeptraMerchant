/**
 * Tests for the live-pipeline pieces that can run without network or DB:
 *  1. scorer.ts   — pillar rollup math, N/A exclusion, priority formula
 *  2. httpFetcher — redirect chain recording, auth detection, timeout, by
 *                   stubbing globalThis.fetch (no real network)
 *
 * Run: node --experimental-strip-types test_live_pipeline.ts
 */

import { runManifestChecks, isManifestMissing, type Fetcher, type ManifestState } from "./manifestChecks.ts";
import {
  runCapabilityChecks,
  checkEndpointReachability,
  sig_capability_catalog_declared,
  sig_capability_identity_linking_declared,
} from "./capabilityChecks.ts";
import {
  runFeedChecks,
  fetchFeed,
  parseShopifyFeed,
  parseGoogleMerchantFeed,
  extractFeedVariants,
  sig_feed_available,
  sig_native_commerce_attribute,
  type FeedState,
  type FeedVariant,
} from "./feedChecks.ts";
import {
  runPageConsistencyChecks,
  fetchProductPage,
  extractVariants,
  sampleAndCompare,
  sig_product_id_consistency,
  sig_price_consistency,
  sig_availability_consistency,
} from "./pageChecks.ts";
import {
  runLlmChecks,
  sig_title_description_consistency,
  sig_discovery_attributes_enrichment,
  type LlmClient,
  type TitleDescSample,
  type EnrichmentSample,
} from "./llmChecks.ts";
import {
  runPolicyChecks,
  probeCandidatePaths,
  sig_return_policy_present,
  sig_shipping_info_present,
  sig_support_contact_present,
  type PagePresenceProbe,
  type HomepageState,
} from "./policyChecks.ts";
import {
  runPaymentChecks,
  sig_ap2_compatibility_declared,
  sig_credential_security_posture,
  sig_merchant_of_record_declared,
} from "./paymentChecks.ts";
import {
  runReadinessChecks,
  sig_merchant_center_account_ready,
  sig_ucp_early_access_status,
  type MerchantCenterAttestation,
} from "./readinessChecks.ts";
import { scorePillars, priorityScore } from "./scorer.ts";
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
// 3. Known-shortcut fixes: no_manifest detection + identity_linking opt-out
// ---------------------------------------------------------------------------

{
  const missing404: ManifestState = { ...FULL_CAPS_STATE, reachable: true, httpStatus: 404, parsed: null, isValidJson: false };
  const missingUnreachable: ManifestState = { ...FULL_CAPS_STATE, reachable: false, httpStatus: null, parsed: null, isValidJson: false };
  const presentButInvalid: ManifestState = { ...FULL_CAPS_STATE, reachable: true, httpStatus: 200, parsed: null, isValidJson: false };
  const presentAndGood: ManifestState = FULL_CAPS_STATE;

  check("isManifestMissing: true on 404", isManifestMissing(missing404) === true);
  check("isManifestMissing: true when unreachable (fetch failed)", isManifestMissing(missingUnreachable) === true);
  check(
    "isManifestMissing: false when manifest present but invalid JSON (200) — a real fail, not a missing manifest",
    isManifestMissing(presentButInvalid) === false,
  );
  check("isManifestMissing: false when manifest present and valid", isManifestMissing(presentAndGood) === false);
}

{
  const optedOut = sig_capability_identity_linking_declared(EMPTY_CAPS_STATE, { identityLinkingOptOut: true });
  check("identity_linking: not_applicable when opted out, even though not declared", optedOut.status === "not_applicable", optedOut);

  const notOptedOut = sig_capability_identity_linking_declared(EMPTY_CAPS_STATE, { identityLinkingOptOut: false });
  check("identity_linking: still fail when not opted out and not declared (no regression)", notOptedOut.status === "fail", notOptedOut);

  const noOptsArg = sig_capability_identity_linking_declared(EMPTY_CAPS_STATE);
  check("identity_linking: defaults to fail when opts omitted entirely (backward compatible)", noOptsArg.status === "fail", noOptsArg);

  const pillars = scorePillars([optedOut]);
  check("identity_linking: opted-out signal drops out of the pillar denominator", pillars[0].signals_total === 0, pillars[0]);
}

// ---------------------------------------------------------------------------
// 4. feedChecks (Category 2: feed_available + native_commerce_attribute)
// ---------------------------------------------------------------------------

const SHOPIFY_FEED_BODY = JSON.stringify({
  products: [
    {
      id: 1,
      handle: "widget",
      title: "Widget",
      variants: [{ sku: "W-1", price: "19.99", available: true }],
      native_commerce: true,
    },
    {
      id: 2,
      handle: "gadget",
      title: "Gadget",
      variants: [{ sku: "G-1", price: "29.99", available: false }],
    },
  ],
});

const GOOGLE_FEED_BODY = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
<item>
  <g:id>101</g:id>
  <title>Widget</title>
  <link>https://shop.example.com/products/widget</link>
  <g:price>19.99 USD</g:price>
  <g:availability>in stock</g:availability>
</item>
<item>
  <g:id>102</g:id>
  <title><![CDATA[Gadget & Co]]></title>
  <link>https://shop.example.com/products/gadget</link>
  <g:price>29.99 USD</g:price>
  <g:availability>out of stock</g:availability>
</item>
</channel></rss>`;

{
  const items = parseShopifyFeed(JSON.parse(SHOPIFY_FEED_BODY).products, "https://shop.example.com");
  check("parseShopifyFeed: item count", items.length === 2, items);
  check("parseShopifyFeed: price parsed from first variant", items[0].price === 19.99, items[0]);
  check("parseShopifyFeed: available true when any variant available", items[0].available === true, items[0]);
  check("parseShopifyFeed: available false when no variant available", items[1].available === false, items[1]);
  check("parseShopifyFeed: link built from handle + rootUrl", items[0].link === "https://shop.example.com/products/widget", items[0]);
  check("parseShopifyFeed: native_commerce carried through in raw", items[0].raw?.native_commerce === true, items[0]);
}

{
  const items = parseGoogleMerchantFeed(GOOGLE_FEED_BODY);
  check("parseGoogleMerchantFeed: item count", items.length === 2, items);
  check("parseGoogleMerchantFeed: id from g:id", items[0].id === "101", items[0]);
  check("parseGoogleMerchantFeed: price split from 'N.NN CUR'", items[0].price === 19.99 && items[0].currency === "USD", items[0]);
  check("parseGoogleMerchantFeed: availability true on 'in stock'", items[0].available === true, items[0]);
  check("parseGoogleMerchantFeed: availability false on 'out of stock'", items[1].available === false, items[1]);
  check("parseGoogleMerchantFeed: CDATA title unwrapped", items[1].title === "Gadget & Co", items[1]);
}

{
  const mockShopifyFeed: Fetcher = async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: SHOPIFY_FEED_BODY,
    redirectChain: [],
    requiresAuth: false,
  });
  const feed = await fetchFeed("https://shop.example.com/products.json", mockShopifyFeed, "https://shop.example.com");
  check("fetchFeed: detects shopify_json format", feed.format === "shopify_json", feed);
  check("fetchFeed: parses both items", feed.items.length === 2, feed);

  const available = sig_feed_available(feed);
  check("feed_available: pass on reachable, recognized, non-empty feed", available.status === "pass", available);

  const nativeCommerce = sig_native_commerce_attribute(feed);
  check("native_commerce_attribute: partial when present on some but not all", nativeCommerce.status === "partial", nativeCommerce);
}

{
  const mock404: Fetcher = async () => ({ status: 404, headers: {}, body: "", redirectChain: [], requiresAuth: false });
  const feed = await fetchFeed("https://shop.example.com/missing.json", mock404);
  check("feed_available: fail when feed unreachable (404)", sig_feed_available(feed).status === "fail", feed);
}

{
  const mockUnrecognized: Fetcher = async () => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "not a feed",
    redirectChain: [],
    requiresAuth: false,
  });
  const feed = await fetchFeed("https://shop.example.com/weird", mockUnrecognized);
  check("feed_available: partial when reachable but unrecognized format", sig_feed_available(feed).status === "partial", feed);
}

{
  const noFeed: FeedState | null = null;
  check("feed_available: not_applicable when no feed_url configured", sig_feed_available(noFeed).status === "not_applicable");
  check("native_commerce_attribute: not_applicable when no feed_url configured", sig_native_commerce_attribute(noFeed).status === "not_applicable");
}

{
  // No feedUrl at all — runFeedChecks should short-circuit without calling the fetcher.
  let called = false;
  const shouldNotBeCalled: Fetcher = async () => {
    called = true;
    return { status: 200, headers: {}, body: "{}", redirectChain: [], requiresAuth: false };
  };
  const { feed, signals } = await runFeedChecks(null, shouldNotBeCalled);
  check("runFeedChecks: fetcher not called when feedUrl is null", called === false);
  check("runFeedChecks: feed is null when feedUrl is null", feed === null);
  check("runFeedChecks: both signals not_applicable", signals.every((s) => s.status === "not_applicable"), signals);
}

// ---------------------------------------------------------------------------
// 5. pageChecks (Category 2 cross-surface consistency: id/price/availability)
// ---------------------------------------------------------------------------

// Grounded against a real Skims product page's JSON-LD (ProductGroup -> hasVariant,
// each variant's `mpn` matching the feed's variant `sku`).
const PRODUCT_GROUP_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "ProductGroup",
  productGroupID: "WID-1",
  hasVariant: [
    {
      "@type": "Product",
      name: "Widget Small",
      mpn: "W-1",
      offers: { "@type": "Offer", price: 19.99, priceCurrency: "USD", availability: "https://schema.org/InStock" },
    },
    {
      "@type": "Product",
      name: "Widget Large",
      mpn: "W-2",
      offers: { "@type": "Offer", price: 24.99, priceCurrency: "USD", availability: "https://schema.org/OutOfStock" },
    },
  ],
});

function htmlWithJsonLd(json: string): string {
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

const FEED_VARIANTS: FeedVariant[] = [
  { sku: "W-1", productTitle: "Widget", price: 19.99, currency: null, available: true, link: "https://shop.example.com/products/widget" },
  { sku: "W-2", productTitle: "Widget", price: 24.99, currency: null, available: false, link: "https://shop.example.com/products/widget" },
];

{
  const blocks = [JSON.parse(PRODUCT_GROUP_JSONLD)];
  const variants = extractVariants(blocks);
  check("extractVariants: ProductGroup -> hasVariant flattened", variants.length === 2, variants);
  check("extractVariants: sku read from mpn", variants[0].sku === "W-1", variants[0]);
  check("extractVariants: price/currency from offers", variants[0].price === 19.99 && variants[0].currency === "USD", variants[0]);
  check("extractVariants: InStock -> available true", variants[0].available === true, variants[0]);
  check("extractVariants: OutOfStock -> available false", variants[1].available === false, variants[1]);
}

{
  const bareProduct = { "@type": "Product", mpn: "SOLO-1", offers: { price: 9.99, priceCurrency: "USD", availability: "https://schema.org/InStock" } };
  const variants = extractVariants([bareProduct]);
  check("extractVariants: bare Product (no group) treated as one variant", variants.length === 1 && variants[0].sku === "SOLO-1", variants);
}

{
  const graphWrapped = { "@graph": [{ "@type": "BreadcrumbList" }, JSON.parse(PRODUCT_GROUP_JSONLD)] };
  const variants = extractVariants([graphWrapped]);
  check("extractVariants: @graph wrapping unwrapped, non-product nodes ignored", variants.length === 2, variants);
}

{
  const mockPage: Fetcher = async () => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: htmlWithJsonLd(PRODUCT_GROUP_JSONLD),
    redirectChain: [],
    requiresAuth: false,
  });
  const page = await fetchProductPage("https://shop.example.com/products/widget", mockPage);
  check("fetchProductPage: extracts variants from a real page shape", page.variants.length === 2, page);

  let fetchCount = 0;
  const countingFetcher: Fetcher = async () => {
    fetchCount++;
    return { status: 200, headers: {}, body: htmlWithJsonLd(PRODUCT_GROUP_JSONLD), redirectChain: [], requiresAuth: false };
  };
  const { comparisons, pageStates } = await sampleAndCompare(FEED_VARIANTS, countingFetcher);
  check("sampleAndCompare: both variants matched by sku", comparisons.every((c) => c.pageFound), comparisons);
  check("sampleAndCompare: shared product link fetched once, not twice (de-duped)", fetchCount === 1, { fetchCount });
  check("sampleAndCompare: pageStates has one deduped entry for the shared link", pageStates.length === 1, pageStates);
  check("sampleAndCompare: pageStates carries rawHtml (in-memory only)", pageStates[0].rawHtml === htmlWithJsonLd(PRODUCT_GROUP_JSONLD), pageStates[0]);

  const idSignal = sig_product_id_consistency(comparisons);
  const priceSignal = sig_price_consistency(comparisons);
  const availSignal = sig_availability_consistency(comparisons);
  check("product_id_consistency: pass when every sku matches", idSignal.status === "pass", idSignal);
  check("price_consistency: pass when feed and page prices match", priceSignal.status === "pass", priceSignal);
  check("availability_consistency: pass when feed and page agree (incl. the out-of-stock one)", availSignal.status === "pass", availSignal);
}

{
  // Page price disagrees with the feed for one of two variants -> mismatch_rate 0.5 -> fail (>= 20%).
  const mismatchedPageJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    hasVariant: [
      { "@type": "Product", mpn: "W-1", offers: { price: 999, priceCurrency: "USD", availability: "https://schema.org/InStock" } },
      { "@type": "Product", mpn: "W-2", offers: { price: 24.99, priceCurrency: "USD", availability: "https://schema.org/OutOfStock" } },
    ],
  });
  const mockMismatched: Fetcher = async () => ({
    status: 200,
    headers: {},
    body: htmlWithJsonLd(mismatchedPageJsonLd),
    redirectChain: [],
    requiresAuth: false,
  });
  const { comparisons } = await sampleAndCompare(FEED_VARIANTS, mockMismatched);
  const priceSignal = sig_price_consistency(comparisons);
  check("price_consistency: fail when mismatch_rate >= 20%", priceSignal.status === "fail", priceSignal);
}

{
  // sku not present on the page at all.
  const noMatchFetcher: Fetcher = async () => ({
    status: 200,
    headers: {},
    body: htmlWithJsonLd(JSON.stringify({ "@type": "Product", mpn: "SOMETHING-ELSE", offers: { price: 1, availability: "https://schema.org/InStock" } })),
    redirectChain: [],
    requiresAuth: false,
  });
  const { comparisons } = await sampleAndCompare(FEED_VARIANTS, noMatchFetcher);
  check("sampleAndCompare: pageFound false when no sku matches", comparisons.every((c) => !c.pageFound), comparisons);
  const idSignal = sig_product_id_consistency(comparisons);
  check("product_id_consistency: fail when no sampled sku is found on its page", idSignal.status === "fail", idSignal);
  // price/availability can't be judged for unmatched skus -> not_applicable, not a false fail.
  check("price_consistency: not_applicable when nothing could be matched", sig_price_consistency(comparisons).status === "not_applicable");
  check("availability_consistency: not_applicable when nothing could be matched", sig_availability_consistency(comparisons).status === "not_applicable");
}

{
  const mockUnreachable: Fetcher = async () => {
    throw new Error("ECONNREFUSED");
  };
  const { comparisons } = await sampleAndCompare(FEED_VARIANTS, mockUnreachable);
  check("sampleAndCompare: fetchError recorded when the page is unreachable", comparisons.every((c) => !!c.fetchError), comparisons);
  check("product_id_consistency: not_applicable when every sampled page failed to fetch", sig_product_id_consistency(comparisons).status === "not_applicable", comparisons);
}

{
  check("product_id_consistency: not_applicable with no comparisons at all", sig_product_id_consistency(null).status === "not_applicable");
  check("price_consistency: not_applicable with no comparisons at all", sig_price_consistency(null).status === "not_applicable");
  check("availability_consistency: not_applicable with no comparisons at all", sig_availability_consistency(null).status === "not_applicable");
}

{
  // End-to-end orchestrator, and extractFeedVariants over a real FeedState shape.
  const shopifyProducts = [
    { id: 1, handle: "widget", title: "Widget", variants: [{ sku: "W-1", price: "19.99", available: true }, { sku: "W-2", price: "24.99", available: false }] },
  ];
  const feed: FeedState = {
    url: "https://shop.example.com/products.json",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    format: "shopify_json",
    items: parseShopifyFeed(shopifyProducts, "https://shop.example.com"),
  };
  const variants = extractFeedVariants(feed);
  check("extractFeedVariants: one row per Shopify variant, not per product", variants.length === 2, variants);

  const goodPageFetcher: Fetcher = async () => ({
    status: 200,
    headers: {},
    body: htmlWithJsonLd(PRODUCT_GROUP_JSONLD),
    redirectChain: [],
    requiresAuth: false,
  });
  const { signals, pageStates } = await runPageConsistencyChecks(variants, goodPageFetcher);
  check("runPageConsistencyChecks: returns all three signals", signals.length === 3, signals);
  check("runPageConsistencyChecks: all pass end-to-end", signals.every((s) => s.status === "pass"), signals);
  check("runPageConsistencyChecks: exposes the fetched page states", pageStates.length === 1, pageStates);

  const { signals: noVariantsSignals, pageStates: noVariantsPageStates } = await runPageConsistencyChecks([], goodPageFetcher);
  check("runPageConsistencyChecks: not_applicable across the board with no feed variants", noVariantsSignals.every((s) => s.status === "not_applicable"), noVariantsSignals);
  check("runPageConsistencyChecks: pageStates empty when there are no feed variants to sample", noVariantsPageStates.length === 0, noVariantsPageStates);
}

// ---------------------------------------------------------------------------
// 6. llmChecks (Category 2: title_description_consistency + discovery_attributes_enrichment)
// ---------------------------------------------------------------------------

function mockLlm(responses: string[]): { client: LlmClient; calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const client: LlmClient = async (prompt: string) => {
    calls.push(prompt);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { client, calls };
}

{
  const identicalSample: TitleDescSample = {
    sku: "W-1",
    feedTitle: "Widget",
    feedDescription: "A great widget.",
    pageTitle: "Widget",
    pageDescription: "A great widget.",
  };
  const { client, calls } = mockLlm([]); // should never be called
  const signal = await sig_title_description_consistency([identicalSample], client);
  check("title_description_consistency: pass without calling the LLM when identical", signal.status === "pass" && calls.length === 0, { signal, calls });
}

{
  const cosmeticSample: TitleDescSample = {
    sku: "W-1",
    feedTitle: "Widget",
    feedDescription: "A great widget.",
    pageTitle: "The Widget",
    pageDescription: "A truly great widget!",
  };
  const { client, calls } = mockLlm([JSON.stringify({ contradiction: false, note: "cosmetic wording only" })]);
  const signal = await sig_title_description_consistency([cosmeticSample], client);
  check("title_description_consistency: partial when LLM finds no contradiction on a wording diff", signal.status === "partial" && calls.length === 1, signal);
}

{
  const contradictorySample: TitleDescSample = {
    sku: "W-1",
    feedTitle: "Waterproof Jacket",
    feedDescription: "Fully waterproof.",
    pageTitle: "Water-Resistant Jacket",
    pageDescription: "Water-resistant, not waterproof.",
  };
  const { client } = mockLlm([JSON.stringify({ contradiction: true, note: "waterproof vs water-resistant" })]);
  const signal = await sig_title_description_consistency([contradictorySample], client);
  check("title_description_consistency: fail when LLM finds a contradiction", signal.status === "fail", signal);
}

{
  const sample: TitleDescSample = { sku: "W-1", feedTitle: "A", feedDescription: null, pageTitle: "B", pageDescription: null };
  const brokenClient: LlmClient = async () => "not json";
  const signal = await sig_title_description_consistency([sample], brokenClient);
  check("title_description_consistency: malformed LLM response recorded as llm_error, not a crash", (signal.evidence_json as any).sampled[0].note.startsWith("llm_error"), signal);
}

{
  const signal = await sig_title_description_consistency([], async () => "{}");
  check("title_description_consistency: not_applicable with no samples", signal.status === "not_applicable", signal);
}

{
  const richSample: EnrichmentSample = { sku: "W-1", productType: "Jacket", attributeKeys: ["material", "care", "fit", "reviews"] };
  const { client } = mockLlm([JSON.stringify({ coverage: "rich", missing: [] })]);
  const signal = await sig_discovery_attributes_enrichment([richSample], client);
  check("discovery_attributes_enrichment: pass when every sample is rich", signal.status === "pass", signal);
}

{
  const sparseSample: EnrichmentSample = { sku: "W-1", productType: "Jacket", attributeKeys: [] };
  const { client } = mockLlm([JSON.stringify({ coverage: "sparse", missing: ["material", "care", "fit"] })]);
  const signal = await sig_discovery_attributes_enrichment([sparseSample], client);
  check("discovery_attributes_enrichment: fail when every sample is sparse", signal.status === "fail", signal);
  check(
    "discovery_attributes_enrichment: missing_attribute_types collected in evidence",
    (signal.evidence_json as any).missing_attribute_types.includes("material"),
    signal,
  );
}

{
  const samples: EnrichmentSample[] = [
    { sku: "W-1", productType: "Jacket", attributeKeys: ["material"] },
    { sku: "W-2", productType: "Jacket", attributeKeys: [] },
  ];
  const { client } = mockLlm([JSON.stringify({ coverage: "rich", missing: [] }), JSON.stringify({ coverage: "sparse", missing: ["care"] })]);
  const signal = await sig_discovery_attributes_enrichment(samples, client);
  check("discovery_attributes_enrichment: partial on a mixed rich/sparse sample", signal.status === "partial", signal);
}

{
  const signal = await sig_discovery_attributes_enrichment([], async () => "{}");
  check("discovery_attributes_enrichment: not_applicable with no samples", signal.status === "not_applicable", signal);
}

{
  // runLlmChecks orchestrator: no llm configured -> both not_applicable, fetcher/llm never called.
  let fetcherCalled = false;
  const shouldNotBeCalledFetcher: Fetcher = async () => {
    fetcherCalled = true;
    return { status: 200, headers: {}, body: "", redirectChain: [], requiresAuth: false };
  };
  const feed: FeedState = {
    url: "https://shop.example.com/products.json",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    format: "shopify_json",
    items: [{ id: "1", title: "Widget", description: "d", price: 1, currency: null, available: true, link: "https://shop.example.com/products/widget", raw: {} }],
  };
  const signals = await runLlmChecks(feed, shouldNotBeCalledFetcher, null);
  check("runLlmChecks: not_applicable for both signals when llm is null", signals.every((s) => s.status === "not_applicable"), signals);
  check("runLlmChecks: page fetcher never called when llm is null", fetcherCalled === false);
  check(
    "runLlmChecks: llm_not_configured recorded in evidence",
    signals.every((s) => (s.evidence_json as any).reason === "llm_not_configured"),
    signals,
  );
}

{
  // End-to-end with a real page fetch + mock LLM.
  const feed: FeedState = {
    url: "https://shop.example.com/products.json",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    format: "shopify_json",
    items: [
      {
        id: "1",
        title: "Widget",
        description: "A great widget.",
        price: 19.99,
        currency: null,
        available: true,
        link: "https://shop.example.com/products/widget",
        raw: { product_type: "Widgets" },
      },
    ],
  };
  const pageWithJsonLd = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "Widget",
    description: "A great widget.",
    material: "plastic",
    offers: { price: 19.99, priceCurrency: "USD", availability: "https://schema.org/InStock" },
  })}</script></head></html>`;
  const pageFetcher: Fetcher = async () => ({ status: 200, headers: {}, body: pageWithJsonLd, redirectChain: [], requiresAuth: false });
  const { client } = mockLlm([JSON.stringify({ coverage: "basic", missing: ["care", "fit"] })]);

  const signals = await runLlmChecks(feed, pageFetcher, client);
  check("runLlmChecks: returns both signals end-to-end", signals.length === 2, signals);
  const titleDesc = signals.find((s) => s.signal_key === "title_description_consistency")!;
  const enrichment = signals.find((s) => s.signal_key === "discovery_attributes_enrichment")!;
  check("runLlmChecks: title_description_consistency passes without an LLM call (identical text)", titleDesc.status === "pass", titleDesc);
  check("runLlmChecks: discovery_attributes_enrichment reflects the LLM's basic/partial verdict", enrichment.status === "partial", enrichment);
}

// ---------------------------------------------------------------------------
// 7. policyChecks (Category 5: return policy / shipping info / support contact)
// ---------------------------------------------------------------------------

function mockPathFetcher(okPaths: string[], body = ""): Fetcher {
  return async (url: string) => {
    const found = okPaths.some((p) => url.endsWith(p));
    return { status: found ? 200 : 404, headers: {}, body: found ? body : "", redirectChain: [], requiresAuth: false };
  };
}

{
  const probe = await probeCandidatePaths("https://shop.example.com", ["/policies/refund-policy", "/pages/returns"], mockPathFetcher(["/pages/returns"]));
  check("probeCandidatePaths: skips 404s, finds the first candidate that 200s", probe.foundUrl === "https://shop.example.com/pages/returns", probe);
  check("probeCandidatePaths: records every URL it tried", probe.checkedUrls.length === 2, probe);
}

{
  const probe = await probeCandidatePaths("https://shop.example.com", ["/policies/refund-policy", "/pages/returns"], mockPathFetcher([]));
  check("probeCandidatePaths: foundUrl null when every candidate 404s", probe.foundUrl === null, probe);
}

{
  const notFound: PagePresenceProbe = { checkedUrls: ["https://shop.example.com/policies/refund-policy"], foundUrl: null, hasStructuredData: false };
  check("return_policy: fail when not found", sig_return_policy_present(notFound).status === "fail", sig_return_policy_present(notFound));
  check("return_policy: feed_match explicitly null (not checked)", (sig_return_policy_present(notFound).evidence_json as any).feed_match === null);
}

{
  const foundNoStructure: PagePresenceProbe = { checkedUrls: ["https://shop.example.com/pages/returns"], foundUrl: "https://shop.example.com/pages/returns", hasStructuredData: false };
  check("return_policy: partial when found but no structured data", sig_return_policy_present(foundNoStructure).status === "partial");
}

{
  const foundStructured: PagePresenceProbe = { checkedUrls: ["https://shop.example.com/policies/refund-policy"], foundUrl: "https://shop.example.com/policies/refund-policy", hasStructuredData: true };
  check("return_policy: pass when found and structured", sig_return_policy_present(foundStructured).status === "pass");
  check("shipping_info: pass when found and structured", sig_shipping_info_present(foundStructured).status === "pass");
}

{
  const orgJsonLd = JSON.stringify({ "@type": "Organization", name: "Shop", contactPoint: { "@type": "ContactPoint", telephone: "+1-555-0100", contactType: "customer support" } });
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [JSON.parse(orgJsonLd)] };
  const signal = sig_support_contact_present(homepage);
  check("support_contact_present: pass on Organization.contactPoint with a telephone", signal.status === "pass", signal);
  check("support_contact_present: method recorded in evidence", (signal.evidence_json as any).method === "schema.org Organization.contactPoint", signal);
}

{
  const orgNoContact = JSON.stringify({ "@type": "Organization", name: "Shop" });
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [JSON.parse(orgNoContact)] };
  const signal = sig_support_contact_present(homepage);
  check("support_contact_present: partial when Organization present but no usable contactPoint", signal.status === "partial", signal);
}

{
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [] };
  const signal = sig_support_contact_present(homepage);
  check("support_contact_present: fail when no Organization node at all", signal.status === "fail", signal);
}

{
  // End-to-end orchestrator: real-shaped fetcher serving different candidates per signal.
  const fetcher: Fetcher = async (url: string) => {
    if (url.endsWith("/pages/returns")) return { status: 200, headers: {}, body: "", redirectChain: [], requiresAuth: false };
    if (url.endsWith("/policies/shipping-policy")) {
      return {
        status: 200,
        headers: {},
        body: `<script type="application/ld+json">${JSON.stringify({ "@type": "WebPage" })}</script>`,
        redirectChain: [],
        requiresAuth: false,
      };
    }
    if (url === "https://shop.example.com") {
      const org = { "@type": "Organization", contactPoint: { email: "support@shop.example.com" } };
      return { status: 200, headers: {}, body: `<script type="application/ld+json">${JSON.stringify(org)}</script>`, redirectChain: [], requiresAuth: false };
    }
    return { status: 404, headers: {}, body: "", redirectChain: [], requiresAuth: false };
  };
  const signals = await runPolicyChecks("https://shop.example.com", fetcher);
  check("runPolicyChecks: returns all three signals", signals.length === 3, signals);
  const returnPolicy = signals.find((s) => s.signal_key === "return_policy_present_consistent")!;
  const shippingInfo = signals.find((s) => s.signal_key === "shipping_info_present_consistent")!;
  const supportContact = signals.find((s) => s.signal_key === "support_contact_present")!;
  check("runPolicyChecks: return policy found but unstructured -> partial", returnPolicy.status === "partial", returnPolicy);
  check("runPolicyChecks: shipping info found and structured -> pass", shippingInfo.status === "pass", shippingInfo);
  check("runPolicyChecks: support contact found via homepage Organization -> pass", supportContact.status === "pass", supportContact);
}

// ---------------------------------------------------------------------------
// 8. paymentChecks (Category 4: AP2 / payment readiness)
// ---------------------------------------------------------------------------

function manifestWithPaymentHandlers(paymentHandlers: any): ManifestState {
  return {
    url: "https://shop.example.com/.well-known/ucp",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    requiresAuth: false,
    redirectChain: [],
    isValidJson: true,
    parsed: { ucp: { version: "2026-04-08", payment_handlers: paymentHandlers } },
  };
}

const NO_MANIFEST: ManifestState = {
  url: "https://shop.example.com/.well-known/ucp",
  reachable: false,
  httpStatus: null,
  contentType: null,
  requiresAuth: false,
  redirectChain: [],
  isValidJson: false,
  parsed: null,
};

{
  // Grounded against a real production manifest (skims.com): com.google.pay's
  // config carries tokenization_specification under allowed_payment_methods.
  const manifest = manifestWithPaymentHandlers({
    "com.google.pay": [
      {
        config: {
          allowed_payment_methods: [{ type: "CARD", tokenization_specification: { type: "PAYMENT_GATEWAY", parameters: { gateway: "shopify" } } }],
        },
      },
    ],
  });
  const ap2 = sig_ap2_compatibility_declared(manifest);
  const cred = sig_credential_security_posture(manifest);
  check("ap2_compatibility_declared: partial when handler declared but AP2 not explicitly mentioned", ap2.status === "partial", ap2);
  check("credential_security_posture: pass when tokenization_specification is present", cred.status === "pass", cred);
}

{
  const manifest = manifestWithPaymentHandlers({ "dev.shopify.card": [{ config: { payment_methods: [{ type: "card" }] } }] });
  const cred = sig_credential_security_posture(manifest);
  check("credential_security_posture: partial when no tokenization_specification found", cred.status === "partial", cred);
}

{
  const manifest = manifestWithPaymentHandlers({
    "dev.ucp.common.ap2": [{ spec: "https://ucp.dev/specification/ap2" }],
  });
  const ap2 = sig_ap2_compatibility_declared(manifest);
  check("ap2_compatibility_declared: pass when an AP2-hinting handler key/spec is present", ap2.status === "pass", ap2);
}

{
  const noHandlers = manifestWithPaymentHandlers({});
  const ap2 = sig_ap2_compatibility_declared(noHandlers);
  const cred = sig_credential_security_posture(noHandlers);
  check("ap2_compatibility_declared: fail when no payment handler declared", ap2.status === "fail", ap2);
  check("credential_security_posture: not_applicable when no payment handler declared (nothing observable)", cred.status === "not_applicable", cred);
}

{
  const ap2 = sig_ap2_compatibility_declared(NO_MANIFEST);
  const cred = sig_credential_security_posture(NO_MANIFEST);
  check("ap2_compatibility_declared: fail when there's no manifest at all", ap2.status === "fail", ap2);
  check("credential_security_posture: not_applicable when there's no manifest at all", cred.status === "not_applicable", cred);
}

{
  const mor = sig_merchant_of_record_declared();
  check("merchant_of_record_declared: always not_applicable — no UCP field exists to read it from", mor.status === "not_applicable", mor);
}

{
  const manifest = manifestWithPaymentHandlers({
    "com.google.pay": [{ config: { allowed_payment_methods: [{ tokenization_specification: {} }] } }],
  });
  const signals = runPaymentChecks(manifest);
  check("runPaymentChecks: returns all three signals", signals.length === 3, signals);
  check("runPaymentChecks: every signal is category payment_ap2_readiness", signals.every((s) => s.category === "payment_ap2_readiness"), signals);
}

// ---------------------------------------------------------------------------
// 9. readinessChecks (Category 6: Merchant Center eligibility — readiness
//    checklist, not scored into capability quality) + scorer.ts weight=0 exclusion
// ---------------------------------------------------------------------------

{
  const unattested: MerchantCenterAttestation = { accountReady: null, feedsConfigured: false, earlyAccessStatus: null };
  const account = sig_merchant_center_account_ready(unattested);
  const access = sig_ucp_early_access_status(unattested);
  check("merchant_center_account_ready: not_applicable when unattested", account.status === "not_applicable", account);
  check("ucp_early_access_status: not_applicable when unattested", access.status === "not_applicable", access);
  check("readiness signals carry weight 0", account.weight === 0 && access.weight === 0, { account, access });
}

{
  const notReady: MerchantCenterAttestation = { accountReady: false, feedsConfigured: false, earlyAccessStatus: "not_applied" };
  check("merchant_center_account_ready: fail when explicitly attested not ready", sig_merchant_center_account_ready(notReady).status === "fail");
  check("ucp_early_access_status: fail when not_applied", sig_ucp_early_access_status(notReady).status === "fail");
}

{
  const readyNoFeeds: MerchantCenterAttestation = { accountReady: true, feedsConfigured: false, earlyAccessStatus: "pending" };
  check("merchant_center_account_ready: partial when ready but feeds not configured", sig_merchant_center_account_ready(readyNoFeeds).status === "partial");
  check("ucp_early_access_status: partial when pending", sig_ucp_early_access_status(readyNoFeeds).status === "partial");
}

{
  const fullyReady: MerchantCenterAttestation = { accountReady: true, feedsConfigured: true, earlyAccessStatus: "approved" };
  const account = sig_merchant_center_account_ready(fullyReady);
  const access = sig_ucp_early_access_status(fullyReady);
  check("merchant_center_account_ready: pass when ready and feeds configured", account.status === "pass", account);
  check("ucp_early_access_status: pass when approved", access.status === "pass", access);
  check("readiness signals still earn score_contribution 0 despite pass (weight 0)", account.score_contribution === 0 && access.score_contribution === 0, { account, access });
}

{
  const signals = runReadinessChecks({ accountReady: true, feedsConfigured: true, earlyAccessStatus: "approved" });
  check("runReadinessChecks: returns both signals", signals.length === 2, signals);
  check("runReadinessChecks: every signal is category merchant_center_eligibility", signals.every((s) => s.category === "merchant_center_eligibility"), signals);
}

{
  // scorer.ts: weight=0 readiness signals must not affect the score OR the
  // signals_total/signals_passed counts, even when they pass.
  const { signals: manifestSignals } = await runManifestChecks("shop.example.com", mockOk);
  const readinessAllPass = runReadinessChecks({ accountReady: true, feedsConfigured: true, earlyAccessStatus: "approved" });
  const withoutReadiness = scorePillars(manifestSignals);
  const withReadiness = scorePillars([...manifestSignals, ...readinessAllPass]);
  check(
    "scorer: adding all-pass weight=0 readiness signals doesn't change the score",
    withReadiness[0].score === withoutReadiness[0].score,
    { withReadiness, withoutReadiness },
  );
  check(
    "scorer: adding weight=0 readiness signals doesn't change signals_total/signals_passed",
    withReadiness[0].signals_total === withoutReadiness[0].signals_total && withReadiness[0].signals_passed === withoutReadiness[0].signals_passed,
    { withReadiness, withoutReadiness },
  );
}

// ---------------------------------------------------------------------------
// 10. httpFetcher (stubbed globalThis.fetch)
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
