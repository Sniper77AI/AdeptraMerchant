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
 * Content rewrite generator (artifact_type='content_rewrite', async/impure):
 * 11. STRUCTURE: return-policy partial -> mock fetcher+LLM produce grounded
 *     JSON-LD; resolved, must_complete = verify-and-add.
 * 12. FLAG-on-fail: signal missing entirely -> no content, flagged, resolves
 *     nothing, fetcher/LLM never called.
 * 13. FLAG: discovery_attributes_enrichment sparse -> flagged with the
 *     missing attribute types, nothing drafted.
 * 14. FLAG: title/description contradiction -> flagged, never drafted.
 * 15. Anti-fabrication gate: LLM hallucinates a value absent from the source
 *     page -> whole generation rejected, downgrades to FLAG.
 * 16. ctx.llm null -> STRUCTURE paths skip without crashing; FLAGs still emitted.
 * 17. Determinism + async signature; orchestrator produces all three
 *     artifact types together through the now-async runArtifacts(ctx).
 *
 * mcp_scaffold generator (artifact_type='mcp_scaffold', pure/sync,
 * platform-GATED not platform-guessed — ctx.platform comes from the
 * onboarding-declared sites.platform column). Third major generation of
 * this section: the tool surface is now UCP's own canonical catalog+cart
 * names (search_catalog/lookup_catalog/get_product/create_cart/get_cart/
 * update_cart/cancel_cart) with a real session state machine and a diff-
 * and-reconcile shim for update_cart's full-replacement semantics — see
 * scaffold/shared.ts's mcpToolsTs(). Checkout is permanently out of scope
 * (payment stays with the merchant via the cart's continue_url); the
 * generated manifest declares catalog+cart only, never checkout.
 * 18. Platform gate: no platform declared -> null; unsupported platform
 *     ('shopify') -> null; 'woocommerce'/'wix'/'custom' -> their own tree;
 *     cart+catalog already passing -> null (nothing to add) REGARDLESS of
 *     checkout's status — the gate bug fix: checkout can never reach "pass"
 *     for a scaffold-platform store (this scaffold never implements it), so
 *     including it in the gate would mean the generator never stops
 *     claiming there's work to do, even for a fully, correctly deployed
 *     store. A dedicated test proves cart+catalog passing + checkout
 *     failing -> null.
 * 19. REGRESSION: full output for all three providers compared against
 *     golden fixtures captured from this round's shipped baseline — byte-
 *     identical, protecting against accidental future drift.
 * 20. Canonical UCP tool surface present (search_catalog, lookup_catalog,
 *     get_product, create_cart, get_cart, update_cart, cancel_cart) and the
 *     old incremental tool names ABSENT (search_products, add_to_cart,
 *     update_cart_item, remove_cart_item, begin_checkout) — in all three
 *     providers' server.ts + the shared mcpTools.ts.
 * 21. meta["ucp-agent"] required (not optional) in every tool's input
 *     schema; not_found returned as a JSON-RPC SUCCESS with UCP's business-
 *     outcome envelope shape, never thrown; structuredContent present
 *     alongside content on every tool response.
 * 22. Session state machine + diff-and-reconcile shim source-level checks:
 *     the shared mcpTools.ts implements create/get/update/cancel with the
 *     documented state machine, the quantity-minimum-1 schema constraint,
 *     and continue_url caching. (Full RUNTIME behavior — the actual
 *     diff-shim edge cases — is exercised separately in
 *     _verify_session_machine.mjs against a real installed copy of a
 *     generated scaffold, since executing the generated code requires the
 *     MCP SDK + zod, which this project's own zero-dependency test process
 *     deliberately does not install. See that script for: item add/remove/
 *     qty-change, same-product-as-two-lines, add+remove-together, zero-
 *     platform-calls-when-unchanged, quantity<1-rejected-at-schema-
 *     boundary, invalid-line-id-errors-not-silently-adds, and the full
 *     create/active-error/cancel/not_found/recreate session lifecycle.)
 * 23. WooCommerce BOUNDARY (Store API only, no checkout endpoint, no /wc/v3
 *     admin route) + no-secrets + loadEnv-first + determinism.
 * 24. Wix BOUNDARY (no order-creation, no payment-submission endpoint,
 *     Catalog V3 startup check present) + no-secrets + loadEnv-first +
 *     determinism.
 * 25. Wix README: the not-Wix warning, the numbered OAuth walkthrough, the
 *     minimum-scopes disclosure table (prominent, not buried), the
 *     Developer-Preview note, the pre-headless-data gotcha, the Catalog
 *     V1/V3 gotcha, and the new first-variant-only gotcha.
 * 26. Custom BOUNDARY-BY-CONTRACT: StoreAdapter (src/types.ts) has exactly
 *     the eight documented methods (seven plus the new emptyCart) and no
 *     payment/order/admin method; getCheckoutUrl's doc comment states it
 *     must NOT authorize/capture/process payment.
 * 27. Custom HONESTY: README's first line is the not-a-runnable-server
 *     warning; every store.ts method's thrown Error literally starts with
 *     "IMPLEMENT-THIS"; server.ts's startup check reads that exact marker
 *     and never calls the adapter to detect it (source-text check, not
 *     live-invoke, not a separate flag) + no-secrets + loadEnv-first.
 * 28. Tool annotations: readOnlyHint/destructiveHint/idempotentHint/
 *     openWorldHint present and correct on the NEW tool surface, in all
 *     three providers (via the shared mcpTools.ts), plus the SDK-caveat
 *     comment quoted verbatim (annotations are hints, not a security
 *     boundary).
 * 29. README UCP-conformance disclosure: the new three-point structure
 *     (catalog conformant; cart conformant except transport; checkout
 *     deliberately not implemented) present in all three providers, and the
 *     transport gap is never glossed over as "UCP cart conformant"
 *     unqualified.
 * 30. Manifest + mcp_scaffold integration: for a scaffold-platform store,
 *     the generated manifest declares catalog + cart but NEVER checkout
 *     (flagged instead, with an explanation), even when checkout's own
 *     signal is failing.
 * 31. capabilityChecks.ts: capability_checkout_declared is not_applicable
 *     ONLY when checkoutHandoffOptIn is explicitly true (never inferred
 *     from platform or from cart being declared); otherwise fails honestly
 *     with a fix_summary that presents the handoff profile as a legitimate
 *     choice, not just "add checkout."
 * 32. Determinism/purity for all three providers.
 *
 * Run: node --experimental-strip-types test_artifacts.ts
 */

import { readFileSync } from "node:fs";
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
import type { LlmClient } from "./llmChecks.ts";
import { generateManifestArtifact } from "./artifacts/manifestArtifact.ts";
import { generateFeedArtifact } from "./artifacts/feedArtifact.ts";
import { generateContentRewriteArtifact } from "./artifacts/contentRewriteArtifact.ts";
import { generateMcpScaffoldArtifact } from "./artifacts/mcpScaffoldArtifact.ts";
import { runArtifacts, decodeFileTree, type ArtifactContext } from "./artifacts/index.ts";

// Captured from this round's actual shipped output for each provider (not
// hand-written) — see the REGRESSION test below. Protects against
// accidental future drift from today's baseline; a deliberate future
// change updates these fixtures alongside the code, same as any snapshot
// test.
const GOLDEN_WOOCOMMERCE: Record<string, string> = JSON.parse(
  readFileSync(`${(import.meta as any).dirname}/test_fixtures/mcp_scaffold_woocommerce_golden.json`, "utf8"),
);
const GOLDEN_WIX: Record<string, string> = JSON.parse(
  readFileSync(`${(import.meta as any).dirname}/test_fixtures/mcp_scaffold_wix_golden.json`, "utf8"),
);
const GOLDEN_CUSTOM: Record<string, string> = JSON.parse(
  readFileSync(`${(import.meta as any).dirname}/test_fixtures/mcp_scaffold_custom_golden.json`, "utf8"),
);

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
  const drafts = await runArtifacts({ manifest: NO_MANIFEST, feed, signals });
  check("runArtifacts: produces both a ucp_manifest and a feed_fix draft (no content_rewrite signals present)", drafts.length === 2, drafts.map((d) => d.artifact_type));
  check(
    "runArtifacts: includes one ucp_manifest and one feed_fix",
    drafts.some((d) => d.artifact_type === "ucp_manifest") && drafts.some((d) => d.artifact_type === "feed_fix"),
    drafts.map((d) => d.artifact_type),
  );
}

// ---------------------------------------------------------------------------
// content_rewrite generator (artifact_type='content_rewrite')
// ---------------------------------------------------------------------------

function mockSignal(signalKey: string, status: SignalRow["status"], evidence: Record<string, unknown> = {}): SignalRow {
  return {
    pillar: "ucp",
    category: "test",
    signal_key: signalKey,
    status,
    weight: 1,
    score_contribution: 0,
    impact: 3,
    effort: 2,
    evidence_json: evidence,
    fix_summary: null,
  };
}

function mockFetcherReturning(url: string, body: string, status = 200): Fetcher {
  return async (reqUrl: string) => {
    if (reqUrl === url) return { status, headers: {}, body, redirectChain: [], requiresAuth: false };
    return { status: 404, headers: {}, body: "", redirectChain: [], requiresAuth: false };
  };
}

function mockLlmReturning(responses: string[]): { client: LlmClient; calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const client: LlmClient = async (prompt: string) => {
    calls.push(prompt);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  };
  return { client, calls };
}

// 1. STRUCTURE: return policy partial -> mock fetcher/LLM produce grounded
//    MerchantReturnPolicy JSON-LD; resolved + must_complete = verify-and-add.
{
  const foundUrl = "https://shop.example.com/pages/returns";
  const policyHtml = "<html><body><h1>Returns</h1><p>You may return items within 30 days of purchase for a full refund.</p></body></html>";
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: foundUrl });
  const fetcher = mockFetcherReturning(foundUrl, policyHtml);
  const jsonld = { "@context": "https://schema.org", "@type": "MerchantReturnPolicy", merchantReturnDays: 30, returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow" };
  const { client: llm, calls } = mockLlmReturning([JSON.stringify({ jsonld })]);

  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal], fetcher, llm });
  check("content_rewrite STRUCTURE: draft produced", draft !== null, draft);
  check("content_rewrite STRUCTURE: artifact_type is content_rewrite", draft?.artifact_type === "content_rewrite");
  check("content_rewrite STRUCTURE: content contains the generated JSON-LD", !!draft && draft.content.includes("MerchantReturnPolicy") && draft.content.includes("30"), draft?.content);
  check("content_rewrite STRUCTURE: content names where to add it", !!draft && draft.content.includes(foundUrl), draft?.content);
  check("content_rewrite STRUCTURE: resolves_signal_keys includes the signal", !!draft && draft.resolves_signal_keys.includes("return_policy_present_consistent"), draft?.resolves_signal_keys);
  check(
    "content_rewrite STRUCTURE: must_complete is verify-and-add",
    !!draft && draft.changelog.must_complete.some((m) => m.toLowerCase().includes("verify")),
    draft?.changelog,
  );
  check("content_rewrite STRUCTURE: LLM was actually called", calls.length === 1);
}

// 1b. @context/@type are set deterministically even when the mock LLM omits
//     them entirely — regression test for a real bug found live against
//     gymshark.com's return-policy page (the model returned bare properties
//     with no @context/@type wrapper, which isn't valid standalone JSON-LD).
{
  const foundUrl = "https://shop.example.com/pages/returns";
  const policyHtml = "<html><body><p>Returns accepted within 30 days of delivery.</p></body></html>";
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: foundUrl });
  const fetcher = mockFetcherReturning(foundUrl, policyHtml);
  const { client: llm } = mockLlmReturning([JSON.stringify({ jsonld: { merchantReturnDays: 30 } })]); // no @context/@type

  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal], fetcher, llm });
  check(
    "content_rewrite: @context is injected even when the model omits it",
    !!draft && draft.content.includes('"@context": "https://schema.org"'),
    draft?.content,
  );
  check(
    "content_rewrite: @type is injected even when the model omits it",
    !!draft && draft.content.includes('"@type": "MerchantReturnPolicy"'),
    draft?.content,
  );
}

// 2. FLAG-on-fail: return policy missing entirely -> no content, flagged,
//    resolves nothing, fetcher/LLM not called (nothing to fetch/structure).
{
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "fail", { found_url: null });
  let fetcherCalled = false;
  const fetcher: Fetcher = async () => {
    fetcherCalled = true;
    return { status: 200, headers: {}, body: "", redirectChain: [], requiresAuth: false };
  };
  let llmCalled = false;
  const llm: LlmClient = async () => {
    llmCalled = true;
    return "{}";
  };

  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal], fetcher, llm });
  check("content_rewrite FLAG-on-fail: draft produced (flag-only)", draft !== null, draft);
  check(
    "content_rewrite FLAG-on-fail: no content generated",
    !!draft && draft.content.includes("No structured-data fixes were generated"),
    draft?.content,
  );
  check(
    "content_rewrite FLAG-on-fail: flagged with a plain-English message",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("return policy")),
    draft?.changelog,
  );
  check("content_rewrite FLAG-on-fail: resolves nothing", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
  check("content_rewrite FLAG-on-fail: fetcher NOT called", fetcherCalled === false);
  check("content_rewrite FLAG-on-fail: LLM NOT called", llmCalled === false);
}

// 3. FLAG: discovery_attributes_enrichment sparse -> no drafted content,
//    missing types listed in the flag, no fabricated values.
{
  const discoverySignal = mockSignal("discovery_attributes_enrichment", "fail", { missing_attribute_types: ["material", "care instructions"] });
  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [discoverySignal] });
  check("content_rewrite FLAG discovery: draft produced", draft !== null, draft);
  check(
    "content_rewrite FLAG discovery: missing types listed",
    !!draft && draft.changelog.flagged.some((f) => f.includes("material") && f.includes("care instructions")),
    draft?.changelog,
  );
  check("content_rewrite FLAG discovery: no content drafted", !!draft && !draft.content.includes("```json"), draft?.content);
  check("content_rewrite FLAG discovery: resolves nothing", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
}

// 4. FLAG: title/description contradiction -> flagged, never drafted.
{
  const titleDescSignal = mockSignal("title_description_consistency", "fail", {});
  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [titleDescSignal] });
  check("content_rewrite FLAG title/desc: draft produced", draft !== null, draft);
  check(
    "content_rewrite FLAG title/desc: flagged as contradictory, can't pick a side",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("contradict")),
    draft?.changelog,
  );
  check("content_rewrite FLAG title/desc: resolves nothing", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
}

// 5. Anti-fabrication: source page states no return window; LLM hallucinates
//    one anyway -> the whole generation is rejected, not partially repaired.
{
  const foundUrl = "https://shop.example.com/pages/returns";
  const policyHtml = "<html><body><p>We accept returns on unused items in original packaging.</p></body></html>"; // no day count anywhere
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: foundUrl });
  const fetcher = mockFetcherReturning(foundUrl, policyHtml);
  const jsonld = { "@type": "MerchantReturnPolicy", merchantReturnDays: 30 }; // fabricated — not in source text
  const { client: llm } = mockLlmReturning([JSON.stringify({ jsonld })]);

  const draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal], fetcher, llm });
  check("anti-fabrication: draft produced (flag-only, generation rejected)", draft !== null, draft);
  check("anti-fabrication: hallucinated value does NOT appear in the artifact content", !!draft && !draft.content.includes("merchantReturnDays"), draft?.content);
  check(
    "anti-fabrication: downgraded to FLAG instead of shipping ungrounded content",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("not found in the source")),
    draft?.changelog,
  );
  check("anti-fabrication: resolves nothing (not silently resolved with unverifiable data)", draft?.resolves_signal_keys.length === 0, draft?.resolves_signal_keys);
}

// 6. llm null: STRUCTURE paths skip gracefully (no crash), FLAGs still emitted.
{
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: "https://shop.example.com/pages/returns" });
  const discoverySignal = mockSignal("discovery_attributes_enrichment", "fail", { missing_attribute_types: ["material"] });
  let threw: unknown = null;
  let draft: Awaited<ReturnType<typeof generateContentRewriteArtifact>> = null;
  try {
    draft = await generateContentRewriteArtifact({ manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal, discoverySignal], llm: null });
  } catch (e) {
    threw = e;
  }
  check("llm null: does not crash", threw === null, threw);
  check("llm null: draft still produced (flag-only)", draft !== null, draft);
  check(
    "llm null: return policy STRUCTURE skipped, not falsely resolved",
    !!draft && !draft.resolves_signal_keys.includes("return_policy_present_consistent"),
    draft?.resolves_signal_keys,
  );
  check(
    "llm null: return policy still flagged instead of silently dropped",
    !!draft && draft.changelog.flagged.some((f) => f.toLowerCase().includes("return policy")),
    draft?.changelog,
  );
  check("llm null: discovery_attributes still flagged", !!draft && draft.changelog.flagged.some((f) => f.includes("material")), draft?.changelog);
}

// 7. Determinism with fixed mocks + async signature.
{
  const foundUrl = "https://shop.example.com/pages/returns";
  const policyHtml = "<html><body><p>Returns accepted within 14 days.</p></body></html>";
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: foundUrl });
  const fetcher = mockFetcherReturning(foundUrl, policyHtml);
  const jsonld = { "@type": "MerchantReturnPolicy", merchantReturnDays: 14 };
  const { client: llm } = mockLlmReturning([JSON.stringify({ jsonld }), JSON.stringify({ jsonld })]);
  const ctx = { manifest: NO_MANIFEST, feed: null, signals: [returnPolicySignal], fetcher, llm };

  const resultPromise = generateContentRewriteArtifact(ctx);
  check("content_rewrite: generator returns a Promise (async signature)", resultPromise instanceof Promise);
  const draftA = await resultPromise;
  const draftB = await generateContentRewriteArtifact(ctx);
  check("content_rewrite: deterministic output across repeated calls with matching mocks", JSON.stringify(draftA) === JSON.stringify(draftB));
}

// ---------------------------------------------------------------------------
// mcp_scaffold generator (artifact_type='mcp_scaffold')
// ---------------------------------------------------------------------------

function capsSignals(checkout: SignalRow["status"], cart: SignalRow["status"], catalog: SignalRow["status"]): SignalRow[] {
  return [
    mockSignal("capability_checkout_declared", checkout),
    mockSignal("capability_cart_declared", cart),
    mockSignal("capability_catalog_declared", catalog),
  ];
}

const CANONICAL_TOOLS = ["search_catalog", "lookup_catalog", "get_product", "create_cart", "get_cart", "update_cart", "cancel_cart"];
const RETIRED_TOOL_NAMES = ["search_products", "add_to_cart", "update_cart_item", "remove_cart_item", "begin_checkout"];

function stripComments(code: string): string {
  // The negative lookbehind (?<!:) prevents matching the "//" inside a
  // "https://" (or similar protocol) string literal as a line-comment start.
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

// 18. Platform gating, including the gate-fix regression: cart+catalog
//     passing + checkout FAILING must still return null.
{
  const draft = generateMcpScaffoldArtifact({ manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail") });
  check("mcp_scaffold: platform undeclared -> returns null (never guesses platform)", draft === null, draft);
}
{
  const draft = generateMcpScaffoldArtifact({ manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "shopify" });
  check("mcp_scaffold: platform='shopify' -> returns null", draft === null, draft);
}
for (const platform of ["woocommerce", "wix", "custom"] as const) {
  const draft = generateMcpScaffoldArtifact({ manifest: NO_MANIFEST, feed: null, signals: capsSignals("pass", "pass", "pass"), platform });
  check(`mcp_scaffold: ${platform} but checkout/cart/catalog already all passing -> null`, draft === null, draft);
}
{
  // THE GATE BUG FIX: checkout can never reach "pass" for a scaffold
  // platform (this scaffold never implements it) — the gate must not
  // include checkout, or this case would incorrectly keep regenerating a
  // scaffold forever for an already-fully-deployed store.
  const draft = generateMcpScaffoldArtifact({
    manifest: NO_MANIFEST,
    feed: null,
    signals: capsSignals("fail", "pass", "pass"),
    platform: "woocommerce",
  });
  check(
    "mcp_scaffold GATE FIX: cart+catalog passing, checkout failing -> still null (checkout excluded from the gate)",
    draft === null,
    draft,
  );
}
{
  const draft = generateMcpScaffoldArtifact({ manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "wix", rootUrl: "https://mystore.example.com" });
  check("mcp_scaffold: Wix + capability gap -> draft produced (Wix tree)", draft !== null, draft);
  const paths = draft ? decodeFileTree(draft.content)?.files.map((f) => f.path) ?? [] : [];
  check("mcp_scaffold: Wix draft contains src/wix.ts, not src/woocommerce.ts or src/store.ts", paths.includes("src/wix.ts") && !paths.includes("src/woocommerce.ts") && !paths.includes("src/store.ts"), paths);
}
{
  const draft = generateMcpScaffoldArtifact({ manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "custom", rootUrl: "https://mystore.example.com" });
  check("mcp_scaffold: Custom + capability gap -> draft produced (Custom tree)", draft !== null, draft);
  const paths = draft ? decodeFileTree(draft.content)?.files.map((f) => f.path) ?? [] : [];
  check(
    "mcp_scaffold: Custom draft contains src/store.ts + src/types.ts, not src/woocommerce.ts or src/wix.ts",
    paths.includes("src/store.ts") && paths.includes("src/types.ts") && !paths.includes("src/woocommerce.ts") && !paths.includes("src/wix.ts"),
    paths,
  );
}

function scaffoldFor(platform: "woocommerce" | "wix" | "custom"): NonNullable<ReturnType<typeof generateMcpScaffoldArtifact>> {
  const draft = generateMcpScaffoldArtifact({
    manifest: NO_MANIFEST,
    feed: null,
    signals: capsSignals("fail", "fail", "fail"),
    platform,
    rootUrl: "https://mystore.example.com",
  });
  if (!draft) throw new Error(`expected a draft for ${platform}`);
  return draft;
}

const wooDraft = scaffoldFor("woocommerce");
const wixDraft = scaffoldFor("wix");
const customDraft = scaffoldFor("custom");
const wooFiles = decodeFileTree(wooDraft.content)!.files;
const wixFiles = decodeFileTree(wixDraft.content)!.files;
const customFiles = decodeFileTree(customDraft.content)!.files;
const wooByPath = new Map(wooFiles.map((f) => [f.path, f.contents]));
const wixByPath = new Map(wixFiles.map((f) => [f.path, f.contents]));
const customByPath = new Map(customFiles.map((f) => [f.path, f.contents]));

{
  check(
    "mcp_scaffold: WooCommerce generates the full expected file-tree",
    ["README.md", "package.json", "tsconfig.json", ".env.example", "src/loadEnv.ts", "src/mcpTools.ts", "src/server.ts", "src/woocommerce.ts"].every((p) => wooByPath.has(p)),
    [...wooByPath.keys()],
  );
  check(
    "mcp_scaffold: Wix generates the full expected file-tree",
    ["README.md", "package.json", "tsconfig.json", ".env.example", "src/loadEnv.ts", "src/mcpTools.ts", "src/server.ts", "src/wix.ts"].every((p) => wixByPath.has(p)),
    [...wixByPath.keys()],
  );
  check(
    "mcp_scaffold: Custom generates the full expected reference-implementation file-tree",
    ["README.md", "package.json", "tsconfig.json", ".env.example", "src/loadEnv.ts", "src/mcpTools.ts", "src/types.ts", "src/store.ts", "src/server.ts"].every((p) => customByPath.has(p)),
    [...customByPath.keys()],
  );
  check("mcp_scaffold: resolves_signal_keys is always empty (never claimed resolved pre-deployment)", wooDraft.resolves_signal_keys.length === 0 && wixDraft.resolves_signal_keys.length === 0 && customDraft.resolves_signal_keys.length === 0);
  check(
    "mcp_scaffold: shared flagged payment-boundary line mentions continue_url, not begin_checkout",
    wooDraft.changelog.flagged[0].toLowerCase().includes("continue_url") && !wooDraft.changelog.flagged[0].toLowerCase().includes("begin_checkout"),
    wooDraft.changelog.flagged[0],
  );
}

// ---------------------------------------------------------------------------
// 19. REGRESSION: full output for all three providers, byte-identical to
//     golden fixtures captured from this round's shipped baseline.
// ---------------------------------------------------------------------------
{
  for (const [path, contents] of Object.entries(GOLDEN_WOOCOMMERCE)) {
    check(`mcp_scaffold REGRESSION (WooCommerce): ${path} byte-identical to golden`, wooByPath.get(path) === contents, "mismatch");
  }
  for (const [path, contents] of Object.entries(GOLDEN_WIX)) {
    check(`mcp_scaffold REGRESSION (Wix): ${path} byte-identical to golden`, wixByPath.get(path) === contents, "mismatch");
  }
  for (const [path, contents] of Object.entries(GOLDEN_CUSTOM)) {
    check(`mcp_scaffold REGRESSION (Custom): ${path} byte-identical to golden`, customByPath.get(path) === contents, "mismatch");
  }
}

// ---------------------------------------------------------------------------
// 20. Canonical UCP tool surface present; old incremental tool names absent.
// ---------------------------------------------------------------------------
{
  for (const [label, byPath] of [
    ["WooCommerce", wooByPath],
    ["Wix", wixByPath],
    ["Custom", customByPath],
  ] as const) {
    const serverSrc = byPath.get("src/server.ts")!;
    const toolsSrc = byPath.get("src/mcpTools.ts")!;
    check(
      `mcp_scaffold (${label}): shared mcpTools.ts registers all seven canonical UCP tools`,
      CANONICAL_TOOLS.every((t) => toolsSrc.includes(`"${t}"`)),
      CANONICAL_TOOLS.filter((t) => !toolsSrc.includes(`"${t}"`)),
    );
    check(
      `mcp_scaffold (${label}): no retired incremental tool name anywhere in server.ts or mcpTools.ts`,
      RETIRED_TOOL_NAMES.every((t) => !serverSrc.includes(`"${t}"`) && !toolsSrc.includes(`"${t}"`)),
      RETIRED_TOOL_NAMES.filter((t) => serverSrc.includes(`"${t}"`) || toolsSrc.includes(`"${t}"`)),
    );
    check(`mcp_scaffold (${label}): mcpTools.ts is present and non-trivial`, toolsSrc.length > 5000, toolsSrc.length);
  }
  // mcpTools.ts is genuinely shared — byte-identical across all three providers.
  check(
    "mcp_scaffold: mcpTools.ts is byte-identical across WooCommerce/Wix/Custom (truly shared, not duplicated)",
    wooByPath.get("src/mcpTools.ts") === wixByPath.get("src/mcpTools.ts") && wixByPath.get("src/mcpTools.ts") === customByPath.get("src/mcpTools.ts"),
    null,
  );
}

// ---------------------------------------------------------------------------
// 21. meta["ucp-agent"] required; not_found as a JSON-RPC success business
//     outcome; structuredContent present.
// ---------------------------------------------------------------------------
{
  const toolsSrc = wooByPath.get("src/mcpTools.ts")!;
  check('mcp_scaffold: meta["ucp-agent"] is a required field in every tool\'s input schema (metaSchema, not optional)', toolsSrc.includes('"ucp-agent": z.object({ profile: z.string() })') && !toolsSrc.includes("metaSchema.optional()"), toolsSrc);
  check("mcp_scaffold: every tool's inputSchema includes meta: metaSchema", (toolsSrc.match(/meta: metaSchema/g) ?? []).length === 7, toolsSrc);
  check(
    "mcp_scaffold: not_found is returned as a business-outcome object (ucp.status/messages/code), never thrown as a bare Error",
    toolsSrc.includes('code: "not_found"') && toolsSrc.includes('ucp: { status: "error" }'),
    toolsSrc,
  );
  check("mcp_scaffold: not_found is never expressed as a thrown protocol-level error", !toolsSrc.includes('throw new Error("not_found")') && !toolsSrc.includes('throw new Error("Cart not found'), toolsSrc);
  check("mcp_scaffold: structuredContent is present alongside content on every tool response", toolsSrc.includes("structuredContent,") && toolsSrc.includes("structuredContent: Record<string, unknown>"), toolsSrc);
}

// ---------------------------------------------------------------------------
// 22. Session state machine + diff-and-reconcile shim — source-level checks.
//     Full RUNTIME behavior is exercised separately in
//     _verify_session_machine.mjs (see that script's own header for why:
//     executing the generated code needs the MCP SDK + zod, which this
//     project's own zero-dependency test process deliberately doesn't
//     install).
// ---------------------------------------------------------------------------
{
  const toolsSrc = wooByPath.get("src/mcpTools.ts")!;
  check("mcp_scaffold: session state machine has active/canceled states", toolsSrc.includes('"active" | "canceled"'), toolsSrc);
  check("mcp_scaffold: create_cart errors (not silently resets) when a cart is already active", toolsSrc.includes("A cart already exists"), toolsSrc);
  check("mcp_scaffold: create_cart empties the real platform cart before minting a fresh id (D1: one platform cart, ever)", /async create\(\)[\s\S]{0,600}emptyCart\(\)/.test(toolsSrc), toolsSrc);
  check("mcp_scaffold: quantity has a schema-level minimum of 1 (no quantity-0 removal sentinel)", toolsSrc.includes("z.number().int().min(1)") && toolsSrc.includes("minimum:1"), toolsSrc);
  check(
    "mcp_scaffold: update_cart's diff distinguishes id-matched (update), id-less (add), and omitted (remove) lines",
    toolsSrc.includes("toAdd") && toolsSrc.includes("toUpdate") && toolsSrc.includes("toRemove"),
    toolsSrc,
  );
  check("mcp_scaffold: a submitted line id that doesn't match any current line is an error, not a silent add", toolsSrc.includes("invalidLineId"), toolsSrc);
  check("mcp_scaffold: update_cart issues zero platform calls when nothing changed", /toAdd\.length === 0 && toUpdate\.length === 0 && toRemove\.length === 0/.test(toolsSrc), toolsSrc);
  check("mcp_scaffold: cancel_cart empties the real platform cart and returns the pre-emptying snapshot", /async cancel\(id: string\)[\s\S]{0,200}emptyCart\(\)/.test(toolsSrc), toolsSrc);
  check("mcp_scaffold: continue_url is never resolved for an empty cart", /if \(cart\.lines\.length === 0\) return undefined;/.test(toolsSrc), toolsSrc);
  check("mcp_scaffold: continue_url is cached and only invalidated on an actual line-item change", toolsSrc.includes("continueUrlDirty"), toolsSrc);
}

// ---------------------------------------------------------------------------
// 23. WooCommerce BOUNDARY + no-secrets + loadEnv-first + determinism.
// ---------------------------------------------------------------------------
{
  const serverSrc = stripComments(wooByPath.get("src/server.ts")!);
  const wooSrc = stripComments(wooByPath.get("src/woocommerce.ts")!);
  const toolsSrc = stripComments(wooByPath.get("src/mcpTools.ts")!);
  const allCode = serverSrc + wooSrc + toolsSrc;

  check("mcp_scaffold (Woo): woocommerce.ts talks to the Store API base path", wooSrc.includes("/wp-json/wc/store/v1"), wooSrc);
  // woocommerce.ts legitimately mentions "checkout" now — the checkoutUrl()
  // primitive (a static, payment-free URL for handoff) and the
  // WOOCOMMERCE_CHECKOUT_PATH env var are both honest, disclosed additions,
  // not a boundary violation. The real boundary check is that no call to
  // WooCommerce's actual checkout/payment API endpoint is ever made — see
  // the checkoutUrl-is-static assertion right below.
  check("mcp_scaffold (Woo): no file's code ever references the admin /wc/v3/ API", !allCode.includes("/wc/v3"), null);
  check("mcp_scaffold (Woo): no file's code ever calls the Store API's own /checkout (payment) endpoint", !allCode.includes("wc/store/v1/checkout") && !allCode.includes('"/checkout"') && !allCode.includes("storeApiFetch(\"/checkout"), allCode);
  check("mcp_scaffold (Woo): checkoutUrl is a static computed URL, no Store API call", !/checkoutUrl[\s\S]{0,50}storeApiFetch/.test(wooSrc), wooSrc);

  const readme = wooByPath.get("README.md")!;
  const envExample = wooByPath.get(".env.example")!;
  check("mcp_scaffold (Woo): README.md personalizes with the real store domain (a label, not a secret)", readme.includes("mystore.example.com"), readme);
  check("mcp_scaffold (Woo): .env.example contains the obvious REPLACE placeholder", envExample.includes("REPLACE-WITH-YOUR-STORE-URL"), envExample);
  check("mcp_scaffold (Woo): no real store domain baked into .env.example/server.ts/woocommerce.ts", ![envExample, serverSrc, wooSrc].some((s) => s.includes("mystore.example.com")), null);
  check("mcp_scaffold (Woo): src files read the store URL from env, not a literal", serverSrc.includes("process.env.WOOCOMMERCE_STORE_URL") && wooSrc.includes("process.env.WOOCOMMERCE_STORE_URL"), null);

  const firstImportLine = serverSrc
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("import "));
  check("mcp_scaffold (Woo): loadEnv.js is server.ts's FIRST import (ESM import-order fix)", firstImportLine?.includes("./loadEnv.js") ?? false, firstImportLine);
  const loadEnvSrc = wooByPath.get("src/loadEnv.ts")!;
  check("mcp_scaffold (Woo): loadEnv.ts has no imports of its own", !stripComments(loadEnvSrc).includes("import "), loadEnvSrc);
  check(
    "mcp_scaffold (Woo): woocommerce.ts does NOT throw at module load for a missing env var (the latent import-order bug fixed this round — matches Wix's already-fixed pattern)",
    !/^const STORE_URL[\s\S]{0,80}if \(!STORE_URL\) \{\s*throw/m.test(wooByPath.get("src/woocommerce.ts")!),
    wooByPath.get("src/woocommerce.ts"),
  );

  const ctx: ArtifactContext = { manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "woocommerce" };
  const result = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Woo) purity: synchronous, not a Promise", !(result instanceof Promise));
  const beforeSignals = JSON.stringify(ctx.signals);
  generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Woo) purity: does not mutate ctx.signals", JSON.stringify(ctx.signals) === beforeSignals);
  const again = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Woo) purity: identical output across repeated calls", JSON.stringify(result) === JSON.stringify(again));
}

// ---------------------------------------------------------------------------
// 24. Wix BOUNDARY + no-secrets + loadEnv-first + determinism.
// ---------------------------------------------------------------------------
{
  const serverSrc = stripComments(wixByPath.get("src/server.ts")!);
  const wixSrc = stripComments(wixByPath.get("src/wix.ts")!);
  const toolsSrc = stripComments(wixByPath.get("src/mcpTools.ts")!);
  const allCode = serverSrc + wixSrc + toolsSrc;

  check("mcp_scaffold (Wix): talks to the Wix eCommerce API base", wixSrc.includes("wixapis.com"), null);
  check("mcp_scaffold (Wix): code never references order creation (/ecom/v1/orders)", !allCode.includes("/ecom/v1/orders"), allCode);
  check(
    // wix.ts is the ONLY file that calls the Wix API — the real boundary.
    // server.ts/mcpTools.ts legitimately mention "payment" in honest
    // disclosure strings, so checking them for the bare word would
    // false-positive on the honesty itself.
    "mcp_scaffold (Wix): wix.ts (the only file that calls the Wix API) never references payment submission",
    !wixSrc.toLowerCase().includes("payment") && !wixSrc.includes("/pay"),
    wixSrc,
  );
  check("mcp_scaffold (Wix): checkout-URL mint uses create-checkout + redirect-session (two calls), never completes payment itself", wixSrc.includes("create-checkout") && wixSrc.includes("redirect-session"), wixSrc);
  check("mcp_scaffold (Wix): startup calls the Catalog V3 check before registering tools", serverSrc.includes("assertCatalogV3") && wixSrc.includes("provision/version"), { serverSrc, wixSrc });
  check("mcp_scaffold (Wix): exits with a clear message when the site isn't on Catalog V3", wixSrc.includes("requires Wix Catalog V3"), wixSrc);
  check("mcp_scaffold (Wix): wix.ts documents the endpoints it deliberately never calls", wixByPath.get("src/wix.ts")!.toLowerCase().includes("deliberately never call"), null);

  const readme = wixByPath.get("README.md")!;
  const envExample = wixByPath.get(".env.example")!;
  check("mcp_scaffold (Wix): README.md personalizes with the real store domain (a label, not a secret)", readme.includes("mystore.example.com"), readme);
  check("mcp_scaffold (Wix): .env.example contains obvious REPLACE placeholders for client id + site url", envExample.includes("REPLACE-WITH-YOUR-WIX-OAUTH-CLIENT-ID") && envExample.includes("REPLACE-WITH-YOUR-STORE-URL"), envExample);
  check("mcp_scaffold (Wix): no real store domain baked into .env.example/server.ts/wix.ts", ![envExample, serverSrc, wixSrc].some((s) => s.includes("mystore.example.com")), null);
  check("mcp_scaffold (Wix): src files read WIX_CLIENT_ID from env, not a literal", serverSrc.includes("process.env.WIX_CLIENT_ID") || wixSrc.includes("WIX_CLIENT_ID"), null);
  check("mcp_scaffold (Wix): no client secret field anywhere (public-client flow only)", !wixSrc.toLowerCase().includes("client_secret") && !wixSrc.toLowerCase().includes("clientsecret"), wixSrc);

  const firstImportLine = serverSrc
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("import "));
  check("mcp_scaffold (Wix): loadEnv.js is server.ts's FIRST import (ESM import-order fix)", firstImportLine?.includes("./loadEnv.js") ?? false, firstImportLine);
  const loadEnvSrc = wixByPath.get("src/loadEnv.ts")!;
  check("mcp_scaffold (Wix): loadEnv.ts has no imports of its own", !stripComments(loadEnvSrc).includes("import "), loadEnvSrc);
  check("mcp_scaffold (Wix): loadEnv.ts is IDENTICAL to the WooCommerce one (truly shared, not duplicated)", loadEnvSrc === wooByPath.get("src/loadEnv.ts"), null);

  const ctx: ArtifactContext = { manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "wix" };
  const result = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Wix) purity: synchronous, not a Promise", !(result instanceof Promise));
  const beforeSignals = JSON.stringify(ctx.signals);
  generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Wix) purity: does not mutate ctx.signals", JSON.stringify(ctx.signals) === beforeSignals);
  const again = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Wix) purity: identical output across repeated calls", JSON.stringify(result) === JSON.stringify(again));
}

// ---------------------------------------------------------------------------
// 25. Wix README content checks.
// ---------------------------------------------------------------------------
{
  const readme = wixByPath.get("README.md")!;
  const readmeLower = readme.toLowerCase();
  const readmeNormalized = readmeLower.replace(/\s+/g, " ");

  check(
    "mcp_scaffold (Wix) README: opens with a not-Wix warning near the top",
    readmeLower.indexOf("if your store is not on wix, do not deploy this") > -1 && readmeLower.indexOf("if your store is not on wix, do not deploy this") < 300,
    readme.slice(0, 300),
  );
  check("mcp_scaffold (Wix) README: numbered OAuth setup walkthrough present", /##\s*wix setup, step by step/i.test(readme) && readme.includes("1.") && readme.includes("6."), readme);
  check("mcp_scaffold (Wix) README: mentions creating a Headless project and an OAuth app", readmeLower.includes("headless project") && readmeLower.includes("oauth app"), readme);

  const scopeSectionIdx = readme.indexOf("About the permissions you're granting");
  const setupSectionIdx = readme.indexOf("Wix setup, step by step");
  check("mcp_scaffold (Wix) README: scope disclosure section exists", scopeSectionIdx > -1, readme);
  check("mcp_scaffold (Wix) README: scope disclosure appears BEFORE the setup walkthrough (prominent, not a footnote)", scopeSectionIdx > -1 && setupSectionIdx > -1 && scopeSectionIdx < setupSectionIdx, { scopeSectionIdx, setupSectionIdx });
  check(
    "mcp_scaffold (Wix) README: scope table lists all four verified scopes",
    ["SCOPE.STORES.PRODUCT_READ", "SCOPE.STORES.CATALOG_READ_LIMITED", "SCOPE.DC-ECOM-MEGA.MANAGE-ECOM", "SCOPE.DC-STORES.MANAGE-ORDERS"].every((s) => readme.includes(s)),
    readme,
  );
  check("mcp_scaffold (Wix) README: states plainly that Wix offers no narrower scope", readmeNormalized.includes("does not currently offer a narrower permission scope"), readme);
  check("mcp_scaffold (Wix) README: tells the merchant to treat the deployed server/credentials as sensitive", readmeLower.includes("sensitive"), readme);
  check("mcp_scaffold (Wix) README: discloses the OAuth token endpoint is Developer Preview", readmeLower.includes("developer preview"), readme);
  check("mcp_scaffold (Wix) README: pre-headless product-field gotcha documented", readmeLower.includes("pre-headless") && readmeLower.includes("product field"), readme);
  check("mcp_scaffold (Wix) README: Catalog V1 vs V3 gotcha documented, with how to tell", readmeLower.includes("catalog v1") && readmeLower.includes("catalog v3"), readme);
  check("mcp_scaffold (Wix) README: first-variant-only gotcha documented (a real, disclosed simplification)", readmeLower.includes("first variant"), readme);
}

// ---------------------------------------------------------------------------
// 26. Custom BOUNDARY-BY-CONTRACT: StoreAdapter has exactly eight methods,
//     no payment/order/admin method; getCheckoutUrl's doc comment states
//     the must-not-process-payment instruction.
// ---------------------------------------------------------------------------
{
  const typesSrc = customByPath.get("src/types.ts")!;
  const storeSrc = customByPath.get("src/store.ts")!;
  const typesCode = stripComments(typesSrc);

  const adapterMatch = typesCode.match(/export interface StoreAdapter \{([\s\S]*?)\n\}/);
  check("mcp_scaffold (Custom): src/types.ts declares the StoreAdapter interface", !!adapterMatch, typesCode);
  const adapterBody = adapterMatch?.[1] ?? "";
  const methodNames = [...adapterBody.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]);
  check(
    "mcp_scaffold (Custom): StoreAdapter has exactly the eight documented methods (seven plus emptyCart), nothing more",
    JSON.stringify([...methodNames].sort()) === JSON.stringify(["addToCart", "emptyCart", "getCart", "getCheckoutUrl", "getProduct", "removeCartItem", "searchProducts", "updateCartItem"].sort()),
    methodNames,
  );
  check("mcp_scaffold (Custom): StoreAdapter has no payment/order/admin method (the boundary IS this absence)", !/pay|charge|order|customer|admin/i.test(methodNames.join(" ")), methodNames);
  check(
    "mcp_scaffold (Custom): the interface documents that it intentionally cannot express payment authorization",
    typesSrc
      .toLowerCase()
      .replace(/[\r\n]+\s*\*\s?/g, " ")
      .replace(/\s+/g, " ")
      .includes("intentionally cannot express payment authorization"),
    typesSrc,
  );
  check("mcp_scaffold (Custom): getCheckoutUrl's doc comment states it must NOT authorize/capture/process payment", typesSrc.includes("must NOT authorize, capture, or process payment"), typesSrc);
  check(
    "mcp_scaffold (Custom): store.ts's getCheckoutUrl stub ALSO documents the must-not-process-payment instruction (not just types.ts)",
    storeSrc.includes("must NOT authorize, capture, or process payment") || storeSrc.includes("Must NOT process payment itself"),
    storeSrc,
  );
  check("mcp_scaffold (Custom): emptyCart is documented as a REAL total removal, not a session flag", typesSrc.includes("real, total removal") || typesSrc.includes("EVERY line item"), typesSrc);
}

// ---------------------------------------------------------------------------
// 27. Custom HONESTY + no-secrets + loadEnv-first.
// ---------------------------------------------------------------------------
{
  const readme = customByPath.get("README.md")!;
  const storeSrc = customByPath.get("src/store.ts")!;
  const serverSrc = customByPath.get("src/server.ts")!;
  const envExample = customByPath.get(".env.example")!;

  check(
    "mcp_scaffold (Custom) README: first line is the not-a-runnable-server warning",
    readme.trimStart().startsWith("# Custom Store MCP Shopping Server") && readme.slice(0, 400).includes("This is a reference implementation, not a runnable server."),
    readme.slice(0, 400),
  );
  check("mcp_scaffold (Custom) README: states the developer must implement src/store.ts before it works", readme.toLowerCase().includes("implement the store adapter"), readme.slice(0, 400));

  const stubThrows = [...storeSrc.matchAll(/throw new Error\(\s*"(IMPLEMENT-THIS[^"]*)"/g)].map((m) => m[1]);
  check("mcp_scaffold (Custom): store.ts has exactly eight IMPLEMENT-THIS stub throws (one per method)", stubThrows.length === 8, stubThrows);
  check(
    "mcp_scaffold (Custom): every stub's marker lives in the thrown string literal, not a comment",
    (stripComments(storeSrc).match(/IMPLEMENT-THIS/g) ?? []).length === 8,
    stripComments(storeSrc),
  );
  check("mcp_scaffold (Custom): server.ts's startup check reads source text via .toString(), never calls the adapter", serverSrc.includes(".toString().includes(STUB_MARKER)") && !serverSrc.includes("adapterImplemented"), serverSrc);
  check('mcp_scaffold (Custom): the stub marker constant is literally "IMPLEMENT-THIS"', serverSrc.includes('STUB_MARKER = "IMPLEMENT-THIS"'), serverSrc);
  check("mcp_scaffold (Custom): startup check names the still-stubbed methods explicitly in its failure message", serverSrc.includes("stillStubbed.join"), serverSrc);
  check(
    "mcp_scaffold (Custom): server.ts documents that this check can't verify CORRECTNESS, only that implementation has started",
    serverSrc.toLowerCase().includes("not that your implementation is") || serverSrc.toLowerCase().includes("only confirms the adapter has been started"),
    serverSrc,
  );

  check("mcp_scaffold (Custom): README.md personalizes with the real store domain (a label, not a secret)", readme.includes("mystore.example.com"), readme);
  check("mcp_scaffold (Custom): .env.example contains obvious REPLACE placeholders for STORE_BASE_URL + CHECKOUT_URL", envExample.includes("REPLACE-WITH-YOUR-STORE-URL") && envExample.includes("REPLACE-WITH-YOUR-CHECKOUT-URL"), envExample);
  check("mcp_scaffold (Custom): no real store domain baked into .env.example/server.ts/store.ts", ![envExample, serverSrc, storeSrc].some((s) => s.includes("mystore.example.com")), null);

  const firstImportLine = stripComments(serverSrc)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("import "));
  check("mcp_scaffold (Custom): loadEnv.js is server.ts's FIRST import (ESM import-order fix)", firstImportLine?.includes("./loadEnv.js") ?? false, firstImportLine);
  const loadEnvSrc = customByPath.get("src/loadEnv.ts")!;
  check("mcp_scaffold (Custom): loadEnv.ts has no imports of its own", !stripComments(loadEnvSrc).includes("import "), loadEnvSrc);
  check("mcp_scaffold (Custom): loadEnv.ts is IDENTICAL to the WooCommerce/Wix one (truly shared, not duplicated)", loadEnvSrc === wooByPath.get("src/loadEnv.ts"), null);

  check("mcp_scaffold (Custom) README: mentions Adeptra's paid setup-service option, factually, not a hard sell", readme.toLowerCase().includes("paid setup service"), readme);

  const ctx: ArtifactContext = { manifest: NO_MANIFEST, feed: null, signals: capsSignals("fail", "fail", "fail"), platform: "custom" };
  const result = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Custom) purity: synchronous, not a Promise", !(result instanceof Promise));
  const beforeSignals = JSON.stringify(ctx.signals);
  generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Custom) purity: does not mutate ctx.signals", JSON.stringify(ctx.signals) === beforeSignals);
  const again = generateMcpScaffoldArtifact(ctx);
  check("mcp_scaffold (Custom) purity: identical output across repeated calls", JSON.stringify(result) === JSON.stringify(again));
}

// ---------------------------------------------------------------------------
// 28. Tool annotations on the new tool surface, all three providers (via
//     the shared mcpTools.ts).
// ---------------------------------------------------------------------------
{
  const EXPECTED_ANNOTATIONS: Record<string, string> = {
    search_catalog: "{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }",
    lookup_catalog: "{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }",
    get_product: "{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }",
    create_cart: "{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }",
    get_cart: "{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }",
    update_cart: "{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }",
    cancel_cart: "{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }",
  };
  const CAVEAT_SNIPPETS = ["all properties in ToolAnnotations are", "**hints**", "Clients", "should never make tool use decisions based on ToolAnnotations received", "from untrusted servers."];

  // mcpTools.ts is byte-identical across providers (test 20 already proved
  // this) — checking it once is sufficient, but re-check per label for a
  // clear failure message if that ever stops being true.
  for (const [label, byPath] of [
    ["WooCommerce", wooByPath],
    ["Wix", wixByPath],
    ["Custom", customByPath],
  ] as const) {
    const toolsSrc = byPath.get("src/mcpTools.ts")!;
    for (const [toolName, expected] of Object.entries(EXPECTED_ANNOTATIONS)) {
      const toolBlockMatch = toolsSrc.match(new RegExp(`"${toolName}"[\\s\\S]*?annotations: (\\{[^}]*\\})`));
      check(`mcp_scaffold (${label}) annotations: ${toolName} has the expected annotations object`, toolBlockMatch?.[1] === expected, { found: toolBlockMatch?.[1], expected });
    }
    check(`mcp_scaffold (${label}) annotations: SDK caveat comment quoted verbatim`, CAVEAT_SNIPPETS.every((s) => toolsSrc.includes(s)), toolsSrc);
    check(`mcp_scaffold (${label}) annotations: comment states annotations supplement, never replace, this server's own code discipline`, toolsSrc.includes("they never replace it"), toolsSrc);
  }
}

// ---------------------------------------------------------------------------
// 29. README UCP-conformance disclosure: the new three-point structure, and
//     never an unqualified "UCP cart conformant" claim.
// ---------------------------------------------------------------------------
{
  for (const [label, byPath] of [
    ["WooCommerce", wooByPath],
    ["Wix", wixByPath],
    ["Custom", customByPath],
  ] as const) {
    const readme = byPath.get("README.md")!;
    const normalized = readme.toLowerCase().replace(/\s+/g, " ");
    check(`mcp_scaffold (${label}) README: carries the UCP protocol-conformance disclosure section`, readme.includes("About UCP protocol conformance"), null);
    check(`mcp_scaffold (${label}) README: states catalog is conformant`, normalized.includes("catalog: conformant"), null);
    check(`mcp_scaffold (${label}) README: states cart is conformant on names/shapes/session but NOT transport`, normalized.includes("not on transport"), null);
    check(`mcp_scaffold (${label}) README: quotes cart-mcp.md's own HTTP-streaming transport requirement`, normalized.includes("support http transport with streaming"), null);
    check(`mcp_scaffold (${label}) README: states checkout is deliberately not declared/implemented`, normalized.includes("checkout: deliberately not declared"), null);
    check(`mcp_scaffold (${label}) README: never claims "UCP cart conformant" unqualified (no bare claim without the transport caveat nearby)`, !/\bucp cart conformant\b(?!.{0,200}transport)/.test(normalized), null);
    check(`mcp_scaffold (${label}) README: mentions continue_url as the sanctioned checkout handoff mechanism`, normalized.includes("continue_url"), null);
  }
}

// ---------------------------------------------------------------------------
// 30. Manifest + mcp_scaffold integration: for a scaffold-platform store,
//     the generated manifest declares catalog + cart but never checkout.
// ---------------------------------------------------------------------------
{
  const signals = capsSignals("fail", "fail", "fail");
  const manifestDraft = generateManifestArtifact({ manifest: NO_MANIFEST, feed: null, signals, platform: "woocommerce" });
  check("mcp_scaffold+manifest: manifest draft still produced for a scaffold-platform store (cart/catalog need fixing)", manifestDraft !== null, manifestDraft);
  const ucp = manifestDraft ? JSON.parse(manifestDraft.content).ucp : null;
  check("mcp_scaffold+manifest: generated manifest declares cart", !!ucp?.capabilities?.["dev.ucp.shopping.cart"], ucp?.capabilities);
  check("mcp_scaffold+manifest: generated manifest declares catalog", !!ucp?.capabilities?.["dev.ucp.shopping.catalog"], ucp?.capabilities);
  check("mcp_scaffold+manifest: generated manifest does NOT declare checkout", !ucp?.capabilities?.["dev.ucp.shopping.checkout"], ucp?.capabilities);
  check(
    "mcp_scaffold+manifest: checkout's absence is flagged with an explanation, not silently dropped",
    !!manifestDraft && manifestDraft.changelog.flagged.some((f) => f.includes("dev.ucp.shopping.checkout") && f.toLowerCase().includes("catalog + cart only")),
    manifestDraft?.changelog.flagged,
  );
  check(
    "mcp_scaffold+manifest: capability_checkout_declared is NOT in resolves_signal_keys (never claimed resolved)",
    !manifestDraft?.resolves_signal_keys.includes("capability_checkout_declared"),
    manifestDraft?.resolves_signal_keys,
  );

  // Non-scaffold platform (or none declared): unaffected, still auto-adds
  // checkout the old way — this behavior must NOT regress.
  const noPlatformDraft = generateManifestArtifact({ manifest: NO_MANIFEST, feed: null, signals });
  const noPlatformUcp = noPlatformDraft ? JSON.parse(noPlatformDraft.content).ucp : null;
  check("mcp_scaffold+manifest: with NO platform declared, checkout IS still auto-added (unaffected by the scaffold-platform exception)", !!noPlatformUcp?.capabilities?.["dev.ucp.shopping.checkout"], noPlatformUcp?.capabilities);
}

// ---------------------------------------------------------------------------
// 31. capabilityChecks.ts: capability_checkout_declared not_applicable ONLY
//     on explicit checkoutHandoffOptIn=true; otherwise fails honestly with
//     an improved fix_summary.
// ---------------------------------------------------------------------------
{
  const noCheckoutManifest: ManifestState = { ...NO_MANIFEST, parsed: { ucp: { capabilities: {} } } };

  const notOptedIn = sig_capability_checkout_declared(noCheckoutManifest, { checkoutHandoffOptIn: false });
  check("capabilityChecks: checkout not declared, NOT opted into handoff -> fails honestly", notOptedIn.status === "fail", notOptedIn);
  check(
    "capabilityChecks: fail fix_summary presents the handoff profile as a legitimate alternative, not just 'add checkout'",
    notOptedIn.fix_summary?.toLowerCase().includes("continue_url") || notOptedIn.fix_summary?.toLowerCase().includes("handoff"),
    notOptedIn.fix_summary,
  );

  const optedIn = sig_capability_checkout_declared(noCheckoutManifest, { checkoutHandoffOptIn: true });
  check("capabilityChecks: checkout not declared, opted into handoff -> not_applicable", optedIn.status === "not_applicable", optedIn);
  check("capabilityChecks: not_applicable earns zero score_contribution (excluded from the denominator by scorer.ts's existing rule)", optedIn.score_contribution === 0, optedIn);

  // The opt-in must NOT be inferred from platform or from cart being
  // declared — only the explicit flag matters. A manifest WITH cart
  // declared but checkout absent, with the flag false, still fails.
  const cartDeclaredManifest: ManifestState = {
    ...NO_MANIFEST,
    parsed: { ucp: { capabilities: { "dev.ucp.shopping.cart": [{ version: CURRENT_UCP_VERSION }] } } },
  };
  const cartDeclaredNotOptedIn = sig_capability_checkout_declared(cartDeclaredManifest, { checkoutHandoffOptIn: false });
  check(
    "capabilityChecks: cart declared + checkout absent + NOT opted in -> still fails (never inferred from cart's presence alone)",
    cartDeclaredNotOptedIn.status === "fail",
    cartDeclaredNotOptedIn,
  );

  // A genuinely declared, fully-configured checkout still passes normally —
  // the opt-in path doesn't interfere with the honest pass case.
  const realCheckoutManifest: ManifestState = {
    ...NO_MANIFEST,
    parsed: { ucp: { capabilities: { "dev.ucp.shopping.checkout": [{ version: CURRENT_UCP_VERSION, schema: "https://ucp.dev/schemas/shopping/checkout.json" }] } } },
  };
  const realCheckout = sig_capability_checkout_declared(realCheckoutManifest, { checkoutHandoffOptIn: true });
  check("capabilityChecks: a genuinely declared checkout still passes even with the opt-in flag set (opt-in doesn't override a real declaration)", realCheckout.status === "pass", realCheckout);
}


// ---------------------------------------------------------------------------
// Orchestrator integration: all four generators together through the async
// runArtifacts(ctx) — manifest + feed + mcp_scaffold remain deterministic/
// unaffected by the async content_rewrite generator sharing the same context.
// ---------------------------------------------------------------------------

{
  const foundUrl = "https://shop.example.com/pages/returns";
  const policyHtml = "<html><body><p>Returns accepted within 21 days of delivery.</p></body></html>";
  const feed = mockFeed(Array.from({ length: 3 }, (_, i) => mockFeedItem(`P${i + 1}`, false)));
  const returnPolicySignal = mockSignal("return_policy_present_consistent", "partial", { found_url: foundUrl });
  const signals = [...allSignalsFor(NO_MANIFEST), sig_native_commerce_attribute(feed), returnPolicySignal];
  const fetcher = mockFetcherReturning(foundUrl, policyHtml);
  const jsonld = { "@type": "MerchantReturnPolicy", merchantReturnDays: 21 };
  const { client: llm } = mockLlmReturning([JSON.stringify({ jsonld })]);

  const drafts = await runArtifacts({ manifest: NO_MANIFEST, feed, signals, fetcher, llm, platform: "woocommerce" });
  check(
    "runArtifacts: produces all four draft types when all four have work to do",
    drafts.length === 4 && ["ucp_manifest", "feed_fix", "content_rewrite", "mcp_scaffold"].every((t) => drafts.some((d) => d.artifact_type === t)),
    drafts.map((d) => d.artifact_type),
  );
}

console.log(failures === 0 ? "\nAll artifact tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
