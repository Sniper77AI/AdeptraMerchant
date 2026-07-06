/**
 * Tests for the artifact generators (mock-driven, no network/DB).
 *
 * Manifest generator (artifact_type='ucp_manifest'):
 * 1. No-manifest case: complete starter scaffold.
 * 2. Partial-manifest (skims-like) case: preserve valid config, fix only
 *    what's broken, including a passing sub-capability catalog shape
 *    preserved byte-for-byte.
 * 3. Closed-loop validation: generated content re-scored with the REAL
 *    signal functions must show every AUTO-FIX signal passing, while
 *    identity_linking and endpoint_reachability are NOT claimed as fixed.
 * 4. Purity: no async/Promise, deterministic output, no input mutation.
 *
 * Feed generator (artifact_type='feed_fix'):
 * 5. native_commerce fail (0 of N have it) -> full supplemental feed.
 * 6. native_commerce partial (some have it) -> only the missing ones.
 * 7. native_commerce pass -> null (nothing to do).
 * 8. No feed configured but native_commerce fail (hand-built edge case,
 *    since the real signal function never produces this combo) -> flag-only,
 *    never fabricates a feed.
 * 9. Purity + determinism.
 * 10. A consistency-signal failure (e.g. price mismatch) -> flagged, not
 *     auto-fixed, resolves nothing.
 *
 * Run: node --experimental-strip-types test_artifacts.ts
 */

import {
  sig_manifest_present,
  sig_version_declared,
  sig_services_declared,
  sig_namespace_authority_valid,
  CURRENT_UCP_VERSION,
  type ManifestState,
  type SignalRow,
  type Fetcher,
} from "./manifestChecks.ts";
import {
  sig_capability_checkout_declared,
  sig_capability_cart_declared,
  sig_capability_catalog_declared,
  sig_capability_fulfillment_declared,
  sig_capability_identity_linking_declared,
  checkEndpointReachability,
} from "./capabilityChecks.ts";
import { sig_native_commerce_attribute, type FeedState, type FeedItem } from "./feedChecks.ts";
import { generateManifestArtifact } from "./artifacts/manifestArtifact.ts";
import { generateFeedArtifact } from "./artifacts/feedArtifact.ts";
import { runArtifacts, type ArtifactContext } from "./artifacts/index.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

function allSignalsFor(manifest: ManifestState): SignalRow[] {
  return [
    sig_manifest_present(manifest),
    sig_version_declared(manifest),
    sig_services_declared(manifest),
    sig_namespace_authority_valid(manifest),
    sig_capability_checkout_declared(manifest),
    sig_capability_cart_declared(manifest),
    sig_capability_catalog_declared(manifest),
    sig_capability_fulfillment_declared(manifest),
    sig_capability_identity_linking_declared(manifest),
  ];
}

/** Builds an ArtifactContext for tests that only care about manifest+signals. */
function mctx(manifest: ManifestState, signals: SignalRow[], feed: FeedState | null = null): ArtifactContext {
  return { manifest, feed, signals };
}

// ---------------------------------------------------------------------------
// 1. No-manifest case
// ---------------------------------------------------------------------------

const NO_MANIFEST: ManifestState = {
  url: "https://shop.example.com/.well-known/ucp",
  reachable: false,
  httpStatus: 404,
  contentType: null,
  requiresAuth: false,
  redirectChain: [],
  isValidJson: false,
  parsed: null,
};

const noManifestSignals = allSignalsFor(NO_MANIFEST);
const draft1 = generateManifestArtifact(mctx(NO_MANIFEST, noManifestSignals));

{
  check("no-manifest: generator returns a draft (not null)", draft1 !== null, draft1);
  const parsed = JSON.parse(draft1!.content);
  check("no-manifest: artifact_type is ucp_manifest", draft1!.artifact_type === "ucp_manifest");
  check("no-manifest: target_url is /.well-known/ucp", draft1!.target_url === "/.well-known/ucp");
  check("no-manifest: version set to current", parsed.ucp.version === CURRENT_UCP_VERSION, parsed.ucp);
  const service = parsed.ucp.services?.["dev.ucp.shopping"]?.[0];
  check("no-manifest: shopping service scaffolded", !!service, parsed.ucp.services);
  check("no-manifest: service transport is rest (default scaffold)", service?.transport === "rest", service);
  check("no-manifest: service has canonical spec + schema", !!service?.spec && !!service?.schema, service);
  check("no-manifest: service endpoint is an obvious placeholder", service?.endpoint?.includes("REPLACE-WITH-YOUR-UCP-ENDPOINT"), service);
  const caps = parsed.ucp.capabilities ?? {};
  check(
    "no-manifest: all four shopping capabilities scaffolded",
    !!caps["dev.ucp.shopping.checkout"] && !!caps["dev.ucp.shopping.cart"] && !!caps["dev.ucp.shopping.catalog"] && !!caps["dev.ucp.shopping.fulfillment"],
    caps,
  );
  check("no-manifest: identity_linking NOT added", !caps["dev.ucp.common.identity_linking"], caps);
  check(
    "no-manifest: changelog.flagged mentions identity_linking",
    draft1!.changelog.flagged.some((f) => f.includes("identity_linking")),
    draft1!.changelog,
  );
  check(
    "no-manifest: changelog.must_complete mentions the endpoint",
    draft1!.changelog.must_complete.some((m) => m.toLowerCase().includes("endpoint")),
    draft1!.changelog,
  );
  check(
    "no-manifest: resolves_signal_keys covers the auto-fixed signals",
    ["ucp_manifest_present", "ucp_manifest_version_declared", "ucp_services_declared", "capability_checkout_declared", "capability_cart_declared", "capability_catalog_declared", "capability_fulfillment_declared"].every(
      (k) => draft1!.resolves_signal_keys.includes(k),
    ),
    draft1!.resolves_signal_keys,
  );
  check(
    "no-manifest: resolves_signal_keys excludes flag-only signals",
    !draft1!.resolves_signal_keys.includes("capability_identity_linking_declared") && !draft1!.resolves_signal_keys.includes("endpoint_reachability"),
    draft1!.resolves_signal_keys,
  );
}

// ---------------------------------------------------------------------------
// 2. Partial-manifest (skims-like) case
// ---------------------------------------------------------------------------

const CATALOG_SEARCH_FIXTURE = [{ version: CURRENT_UCP_VERSION }];
const CATALOG_LOOKUP_FIXTURE = [{ version: CURRENT_UCP_VERSION }];

const PARTIAL_MANIFEST: ManifestState = {
  url: "https://skims.example.com/.well-known/ucp",
  reachable: true,
  httpStatus: 200,
  contentType: "application/json",
  requiresAuth: false,
  redirectChain: [],
  isValidJson: true,
  parsed: {
    ucp: {
      version: "2025-11-01", // stale
      services: {
        "dev.ucp.shopping": [
          {
            version: CURRENT_UCP_VERSION,
            spec: "https://ucp.dev/specification/overview",
            transport: "rest",
            endpoint: "https://real-endpoint.example/ucp/v1", // real, existing — must be preserved
            // schema missing -> services_declared partial
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [
          {
            version: CURRENT_UCP_VERSION,
            spec: "https://evilcdn.example.net/specification/checkout", // wrong host, canonical PATH -> mappable
            schema: `https://ucp.dev/${CURRENT_UCP_VERSION}/schemas/shopping/checkout.json`,
          },
        ],
        // cart: missing entirely
        "dev.ucp.shopping.catalog.search": CATALOG_SEARCH_FIXTURE, // skims-like sub-capability shape -> PASSES
        "dev.ucp.shopping.catalog.lookup": CATALOG_LOOKUP_FIXTURE,
        "dev.ucp.shopping.fulfillment": [
          { version: CURRENT_UCP_VERSION, spec: `https://ucp.dev/specification/fulfillment`, schema: `https://ucp.dev/${CURRENT_UCP_VERSION}/schemas/shopping/fulfillment.json` },
        ],
      },
    },
  },
};

const partialSignals = allSignalsFor(PARTIAL_MANIFEST);
const sigByKey = new Map(partialSignals.map((s) => [s.signal_key, s]));

{
  // Sanity-check the fixture actually produces the statuses this test assumes.
  check("fixture sanity: version is partial (stale)", sigByKey.get("ucp_manifest_version_declared")?.status === "partial");
  check("fixture sanity: services is partial (missing schema)", sigByKey.get("ucp_services_declared")?.status === "partial");
  check("fixture sanity: namespace authority is partial (checkout bad host)", sigByKey.get("ucp_namespace_authority_valid")?.status === "partial");
  check("fixture sanity: checkout capability passes on its own criteria", sigByKey.get("capability_checkout_declared")?.status === "pass");
  check("fixture sanity: cart capability fails (not declared)", sigByKey.get("capability_cart_declared")?.status === "fail");
  check("fixture sanity: catalog capability passes via sub-capabilities", sigByKey.get("capability_catalog_declared")?.status === "pass");
  check("fixture sanity: fulfillment capability passes", sigByKey.get("capability_fulfillment_declared")?.status === "pass");
}

const draft2 = generateManifestArtifact(mctx(PARTIAL_MANIFEST, partialSignals));

{
  check("partial: generator returns a draft (not null)", draft2 !== null, draft2);
  const parsed = JSON.parse(draft2!.content);
  const ucp = parsed.ucp;

  check("partial: version corrected to current", ucp.version === CURRENT_UCP_VERSION, ucp.version);

  const service = ucp.services["dev.ucp.shopping"][0];
  check("partial: existing valid endpoint preserved untouched", service.endpoint === "https://real-endpoint.example/ucp/v1", service);
  check("partial: existing valid transport preserved (not forced/changed)", service.transport === "rest", service);
  check("partial: missing schema filled with canonical value", service.schema === `https://ucp.dev/${CURRENT_UCP_VERSION}/services/shopping/rest.openapi.json`, service);
  check(
    "partial: no must_complete entry for the endpoint (it was already real)",
    !draft2!.changelog.must_complete.some((m) => m.toLowerCase().includes("endpoint")),
    draft2!.changelog,
  );

  const cart = ucp.capabilities["dev.ucp.shopping.cart"];
  check("partial: missing cart capability added", Array.isArray(cart) && cart.length === 1 && cart[0].version === CURRENT_UCP_VERSION, cart);

  // Catalog: passing sub-capability shape preserved BYTE-FOR-BYTE, no flat key added.
  check(
    "partial: catalog.search sub-capability preserved byte-for-byte",
    JSON.stringify(ucp.capabilities["dev.ucp.shopping.catalog.search"]) === JSON.stringify(CATALOG_SEARCH_FIXTURE),
    ucp.capabilities["dev.ucp.shopping.catalog.search"],
  );
  check(
    "partial: catalog.lookup sub-capability preserved byte-for-byte",
    JSON.stringify(ucp.capabilities["dev.ucp.shopping.catalog.lookup"]) === JSON.stringify(CATALOG_LOOKUP_FIXTURE),
    ucp.capabilities["dev.ucp.shopping.catalog.lookup"],
  );
  check("partial: no redundant flat dev.ucp.shopping.catalog key added", ucp.capabilities["dev.ucp.shopping.catalog"] === undefined, ucp.capabilities);

  // Checkout: capability itself untouched by the capability loop (it already
  // passes), but its bad-authority spec URL is corrected by the namespace pass.
  const checkout = ucp.capabilities["dev.ucp.shopping.checkout"][0];
  check("partial: checkout spec host corrected to ucp.dev, path preserved", checkout.spec === "https://ucp.dev/specification/checkout", checkout);
  check(
    "partial: checkout schema untouched (was already canonical)",
    checkout.schema === `https://ucp.dev/${CURRENT_UCP_VERSION}/schemas/shopping/checkout.json`,
    checkout,
  );

  // Fulfillment: already fully valid, untouched.
  const fulfillment = ucp.capabilities["dev.ucp.shopping.fulfillment"][0];
  check("partial: fulfillment left untouched (already valid)", fulfillment.spec === "https://ucp.dev/specification/fulfillment", fulfillment);

  check("partial: identity_linking not added", ucp.capabilities["dev.ucp.common.identity_linking"] === undefined);
  check(
    "partial: resolves_signal_keys includes version/services/cart/namespace",
    ["ucp_manifest_version_declared", "ucp_services_declared", "capability_cart_declared", "ucp_namespace_authority_valid"].every((k) =>
      draft2!.resolves_signal_keys.includes(k),
    ),
    draft2!.resolves_signal_keys,
  );
  check(
    "partial: resolves_signal_keys excludes already-passing signals",
    !draft2!.resolves_signal_keys.includes("ucp_manifest_present") &&
      !draft2!.resolves_signal_keys.includes("capability_checkout_declared") &&
      !draft2!.resolves_signal_keys.includes("capability_catalog_declared") &&
      !draft2!.resolves_signal_keys.includes("capability_fulfillment_declared"),
    draft2!.resolves_signal_keys,
  );
}

// ---------------------------------------------------------------------------
// 2b. Namespace authority: all-flagged, none-correctable case (grounded
//     against a real skims.com finding — a vendor capability's URLs live on
//     a completely different path, not just a wrong host on a known path)
// ---------------------------------------------------------------------------

{
  // Isolated from PARTIAL_MANIFEST deliberately: checkout here already has a
  // canonical-host spec (nothing else correctable), so the ONLY namespace
  // issue is the unmappable dev.shopify.catalog vendor URLs.
  const unmappableManifest: ManifestState = {
    ...PARTIAL_MANIFEST,
    parsed: {
      ucp: {
        ...PARTIAL_MANIFEST.parsed.ucp,
        capabilities: {
          ...PARTIAL_MANIFEST.parsed.ucp.capabilities,
          "dev.ucp.shopping.checkout": [{ version: CURRENT_UCP_VERSION, spec: "https://ucp.dev/specification/checkout", schema: `https://ucp.dev/${CURRENT_UCP_VERSION}/schemas/shopping/checkout.json` }],
          "dev.shopify.catalog": [
            { version: CURRENT_UCP_VERSION, spec: "https://shopify.dev/docs/agents/catalog/storefront-catalog", schema: "https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog.json" },
          ],
        },
      },
    },
  };
  const signals = allSignalsFor(unmappableManifest);
  const draft = generateManifestArtifact(mctx(unmappableManifest, signals));
  const flaggedCountBefore = draft!.changelog.flagged.length;

  check(
    "unmappable authority: both vendor URLs flagged, not silently dropped",
    draft!.changelog.flagged.filter((f) => f.includes("shopify.dev")).length === 2,
    draft!.changelog.flagged,
  );
  check(
    "unmappable authority: vendor URLs left untouched in the output (not guessed)",
    JSON.parse(draft!.content).ucp.capabilities["dev.shopify.catalog"][0].spec === "https://shopify.dev/docs/agents/catalog/storefront-catalog",
  );
  check(
    "unmappable authority: ucp_namespace_authority_valid NOT in resolves_signal_keys when nothing was actually correctable there",
    !draft!.resolves_signal_keys.includes("ucp_namespace_authority_valid"),
    draft!.resolves_signal_keys,
  );
  check("sanity: flagged list is non-empty", flaggedCountBefore > 0);
}

// ---------------------------------------------------------------------------
// 3. Closed-loop validation (using the no-manifest draft)
// ---------------------------------------------------------------------------

{
  const regenerated: ManifestState = {
    url: "https://shop.example.com/.well-known/ucp",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    requiresAuth: false,
    redirectChain: [],
    isValidJson: true,
    parsed: JSON.parse(draft1!.content),
  };

  const autoFixSignals = [
    sig_manifest_present(regenerated),
    sig_version_declared(regenerated),
    sig_services_declared(regenerated),
    sig_namespace_authority_valid(regenerated),
    sig_capability_checkout_declared(regenerated),
    sig_capability_cart_declared(regenerated),
    sig_capability_catalog_declared(regenerated),
    sig_capability_fulfillment_declared(regenerated),
  ];
  for (const s of autoFixSignals) {
    check(`closed-loop: ${s.signal_key} passes after applying the generated manifest`, s.status === "pass", s);
  }

  const identityLinking = sig_capability_identity_linking_declared(regenerated);
  check("closed-loop: identity_linking is NOT claimed fixed (still fail)", identityLinking.status === "fail", identityLinking);

  const unreachablePlaceholder: Fetcher = async () => {
    throw new Error("ENOTFOUND REPLACE-WITH-YOUR-UCP-ENDPOINT.example");
  };
  const endpointSignal = await checkEndpointReachability(regenerated, unreachablePlaceholder);
  check("closed-loop: endpoint_reachability is NOT claimed fixed (placeholder is unreachable)", endpointSignal.status === "fail", endpointSignal);
}

// ---------------------------------------------------------------------------
// 4. Purity
// ---------------------------------------------------------------------------

{
  const result = generateManifestArtifact(mctx(PARTIAL_MANIFEST, partialSignals));
  check("purity: generator is synchronous, not a Promise", !(result instanceof Promise));

  const before = JSON.stringify(PARTIAL_MANIFEST);
  generateManifestArtifact(mctx(PARTIAL_MANIFEST, partialSignals));
  check("purity: does not mutate the input ManifestState", JSON.stringify(PARTIAL_MANIFEST) === before);

  const again = generateManifestArtifact(mctx(PARTIAL_MANIFEST, partialSignals));
  check("purity: identical output across repeated calls with the same input", JSON.stringify(result) === JSON.stringify(again));
}

// ---------------------------------------------------------------------------
// Feed generator (artifact_type='feed_fix')
// ---------------------------------------------------------------------------

function mockFeedItem(id: string, hasNativeCommerce: boolean): FeedItem {
  return {
    id,
    title: `Product ${id}`,
    description: null,
    price: 10,
    currency: null,
    available: true,
    link: null,
    raw: { native_commerce: hasNativeCommerce },
  };
}

function mockFeed(items: FeedItem[], format: FeedState["format"] = "shopify_json"): FeedState {
  return {
    url: "https://shop.example.com/products.json",
    reachable: true,
    httpStatus: 200,
    contentType: "application/json",
    format,
    items,
  };
}

// 5. native_commerce fail (0 of 30 have it) -> full supplemental feed.
{
  const feed = mockFeed(Array.from({ length: 30 }, (_, i) => mockFeedItem(`P${i + 1}`, false)));
  const nativeCommerceSignal = sig_native_commerce_attribute(feed);
  check("feed fixture sanity: fails when 0/30 have the attribute", nativeCommerceSignal.status === "fail", nativeCommerceSignal);

  const draft = generateFeedArtifact(mctx(NO_MANIFEST, [nativeCommerceSignal], feed));
  check("feed_fix: generator returns a draft (not null)", draft !== null, draft);
  check("feed_fix: artifact_type is feed_fix", draft!.artifact_type === "feed_fix");
  check("feed_fix: target_url has no leading slash (upload-artifact convention)", !draft!.target_url.startsWith("/"), draft!.target_url);
  const idCount = (draft!.content.match(/<g:id>/g) ?? []).length;
  const nativeCommerceCount = (draft!.content.match(/<g:native_commerce>true<\/g:native_commerce>/g) ?? []).length;
  check("feed_fix: supplemental feed contains all 30 missing products", idCount === 30, { idCount });
  check("feed_fix: every item marks native_commerce=true", nativeCommerceCount === 30, { nativeCommerceCount });
  check(
    "feed_fix: resolves_signal_keys is exactly [native_commerce_attribute]",
    JSON.stringify(draft!.resolves_signal_keys) === JSON.stringify(["native_commerce_attribute"]),
    draft!.resolves_signal_keys,
  );
  check(
    "feed_fix: must_complete carries the review warning (merchant-intent guardrail)",
    draft!.changelog.must_complete.some((m) => m.toUpperCase().includes("REVIEW")),
    draft!.changelog,
  );
}

// 6. native_commerce partial (10 of 30 have it) -> only the missing 20.
{
  const present = Array.from({ length: 10 }, (_, i) => mockFeedItem(`HAS${i + 1}`, true));
  const missing = Array.from({ length: 20 }, (_, i) => mockFeedItem(`MISS${i + 1}`, false));
  const feed = mockFeed([...present, ...missing]);
  const nativeCommerceSignal = sig_native_commerce_attribute(feed);
  check("feed fixture sanity: partial when some (10/30) have the attribute", nativeCommerceSignal.status === "partial", nativeCommerceSignal);

  const draft = generateFeedArtifact(mctx(NO_MANIFEST, [nativeCommerceSignal], feed));
  const idCount = (draft!.content.match(/<g:id>/g) ?? []).length;
  check("feed_fix (partial): only the 20 missing products are included", idCount === 20, { idCount });
  check(
    "feed_fix (partial): none of the already-passing product ids appear",
    !present.some((p) => draft!.content.includes(`<g:id>${p.id}</g:id>`)),
  );
  check(
    "feed_fix (partial): all 20 missing product ids appear",
    missing.every((m) => draft!.content.includes(`<g:id>${m.id}</g:id>`)),
  );
}

// 7. native_commerce pass -> null (nothing to do).
{
  const feed = mockFeed(Array.from({ length: 5 }, (_, i) => mockFeedItem(`OK${i + 1}`, true)));
  const nativeCommerceSignal = sig_native_commerce_attribute(feed);
  check("feed fixture sanity: passes when all have the attribute", nativeCommerceSignal.status === "pass", nativeCommerceSignal);

  const draft = generateFeedArtifact(mctx(NO_MANIFEST, [nativeCommerceSignal], feed));
  check("feed_fix: returns null when native_commerce already passes and nothing else fails", draft === null, draft);
}

// 8. No feed configured but native_commerce is fail — hand-built edge case:
//    the real sig_native_commerce_attribute always returns not_applicable
//    when feed is null, so this combination can't occur via the real
//    pipeline today. It still tests the generator's own guard against
//    fabricating a feed it has no data for.
{
  const fakeFailSignal: SignalRow = {
    pillar: "ucp",
    category: "product_data_hygiene",
    signal_key: "native_commerce_attribute",
    status: "fail",
    weight: 2,
    score_contribution: 0,
    impact: 5,
    effort: 2,
    evidence_json: {},
    fix_summary: null,
  };
  const draft = generateFeedArtifact(mctx(NO_MANIFEST, [fakeFailSignal], null));
  check("feed_fix: no feed configured -> does not fabricate content", draft !== null && draft.content === "", draft);
  check(
    "feed_fix: no feed configured -> flags rather than acts",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("no usable product feed")),
    draft?.changelog,
  );
  check("feed_fix: no feed configured -> resolves nothing", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
}

// 9. Purity + determinism.
{
  const feed = mockFeed(Array.from({ length: 5 }, (_, i) => mockFeedItem(`P${i + 1}`, false)));
  const nativeCommerceSignal = sig_native_commerce_attribute(feed);
  const ctx = mctx(NO_MANIFEST, [nativeCommerceSignal], feed);

  const result = generateFeedArtifact(ctx);
  check("feed_fix purity: synchronous, not a Promise", !(result instanceof Promise));

  const beforeFeed = JSON.stringify(feed);
  generateFeedArtifact(ctx);
  check("feed_fix purity: does not mutate the input feed", JSON.stringify(feed) === beforeFeed);

  const again = generateFeedArtifact(ctx);
  check("feed_fix purity: identical output across repeated calls", JSON.stringify(result) === JSON.stringify(again));
}

// 10. A consistency-signal failure (price mismatch) -> flagged, not
//     auto-fixed, resolves nothing.
{
  const feed = mockFeed(Array.from({ length: 5 }, (_, i) => mockFeedItem(`P${i + 1}`, true))); // native_commerce passes
  const nativeCommerceSignal = sig_native_commerce_attribute(feed);
  const priceFailSignal: SignalRow = {
    pillar: "ucp",
    category: "product_data_hygiene",
    signal_key: "price_consistency_cross_surface",
    status: "fail",
    weight: 2,
    score_contribution: 0,
    impact: 5,
    effort: 2,
    evidence_json: {},
    fix_summary: null,
  };
  const draft = generateFeedArtifact(mctx(NO_MANIFEST, [nativeCommerceSignal, priceFailSignal], feed));
  check("feed_fix: price mismatch triggers a flag-only draft", draft !== null, draft);
  check(
    "feed_fix: price mismatch flagged with a manual-reconciliation message",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("price mismatch")),
    draft?.changelog,
  );
  check("feed_fix: price mismatch is NOT auto-fixed (no content generated)", draft?.content === "", draft);
  check("feed_fix: price mismatch resolves nothing", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
}

// ---------------------------------------------------------------------------
// Orchestrator integration: both generators wired into runArtifacts(ctx)
// ---------------------------------------------------------------------------

{
  const feed = mockFeed(Array.from({ length: 3 }, (_, i) => mockFeedItem(`P${i + 1}`, false)));
  const signals = [...allSignalsFor(NO_MANIFEST), sig_native_commerce_attribute(feed)];
  const drafts = runArtifacts({ manifest: NO_MANIFEST, feed, signals });
  check("runArtifacts: produces both a ucp_manifest and a feed_fix draft", drafts.length === 2, drafts.map((d) => d.artifact_type));
  check(
    "runArtifacts: includes one ucp_manifest and one feed_fix",
    drafts.some((d) => d.artifact_type === "ucp_manifest") && drafts.some((d) => d.artifact_type === "feed_fix"),
    drafts.map((d) => d.artifact_type),
  );
}

console.log(failures === 0 ? "\nAll artifact tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
