/**
 * Golden-fixture regression lock for the signal-definitions guardrail refactor
 * (2026-07-11): proves moving weight/impact/effort/pillar/category out of nine
 * scattered `W` objects into one canonical `signalDefinitions.ts` changed
 * WHERE those values live, not WHAT they are. Calls every exported `sig_*`
 * function directly (these are pure — no need to route through full
 * HTTP-mocked orchestrators just to prove a value didn't move) with minimal,
 * deterministic mock inputs, and captures the FULL emitted SignalRow for all
 * 37 signals across both pillars — not just the 5-tuple, so a refactor typo
 * that perturbed evidence_json/status/fix_summary would also be caught.
 * (35 -> 36, 2026-07-13: ucp_signing_keys_present added — v2026-04-08
 * spec-delta patch. RICH_MANIFEST has no signing_keys anywhere, so it
 * captures the not_applicable/advisory branch.)
 * (36 -> 37, 2026-07-14: payment_instruments_declared added — v2026-04-08
 * spec-delta audit, CHANGE 1. RICH_MANIFEST's payment handler has no
 * available_instruments, so it also captures the not_applicable branch.)
 *
 * `capture` was run BEFORE any check-module file was touched (against the
 * nine still-scattered `W` objects). `verify` runs after the refactor and
 * asserts byte-for-byte equality — same discipline as
 * test_pageChecks_golden.ts's rawHtml/pageStates refactor proof in Build 1.
 *
 * Usage:
 *   node --experimental-strip-types test_signal_values_golden.ts capture
 *   node --experimental-strip-types test_signal_values_golden.ts verify
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { SignalRow, ManifestState, Fetcher, FetchResult } from "./manifestChecks.ts";
import { sig_manifest_present, sig_version_declared, sig_services_declared, sig_namespace_authority_valid, sig_signing_keys_present } from "./manifestChecks.ts";
import {
  sig_capability_checkout_declared,
  sig_capability_cart_declared,
  sig_capability_catalog_declared,
  sig_capability_fulfillment_declared,
  sig_capability_identity_linking_declared,
  checkEndpointReachability,
} from "./capabilityChecks.ts";
import { sig_feed_available, sig_native_commerce_attribute, type FeedState, type FeedVariant } from "./feedChecks.ts";
import { sig_product_id_consistency, sig_price_consistency, sig_availability_consistency } from "./pageChecks.ts";
import { sig_title_description_consistency, sig_discovery_attributes_enrichment, type LlmClient } from "./llmChecks.ts";
import { sig_return_policy_present, sig_shipping_info_present, sig_support_contact_present, type PagePresenceProbe, type HomepageState as PolicyHomepageState } from "./policyChecks.ts";
import { sig_ap2_compatibility_declared, sig_credential_security_posture, sig_merchant_of_record_declared, sig_payment_instruments_declared } from "./paymentChecks.ts";
import { sig_merchant_center_account_ready, sig_ucp_early_access_status, type MerchantCenterAttestation } from "./readinessChecks.ts";
import {
  sig_robots_txt_valid,
  sig_ai_crawler_access_retrieval,
  sig_ai_crawler_access_training,
  sig_content_server_rendered,
  sig_schema_in_raw_html,
  sig_product_schema_present,
  sig_offer_schema_complete,
  sig_organization_schema_present,
  sig_sitemap_present,
  sig_llms_txt_present,
  parseRobotsTxt,
  type RobotsTxtState,
  type SitemapState,
  type LlmsTxtState,
} from "./readabilityChecks.ts";
import type { ProductPageState } from "./pageChecks.ts";

const FIXTURE_PATH = new URL("./__fixtures__/signal_values_golden.json", import.meta.url);

// ---------------------------------------------------------------------------
// Shared minimal mocks — enough for every sig_* function to run without
// crashing. The exact STATUS each lands on is irrelevant here (that's the
// existing behavioral test suites' job, unchanged by this refactor); only
// the emitted weight/impact/effort/pillar/category/signal_key (and, as a
// belt-and-braces check, the whole row) need to survive the move untouched.
// ---------------------------------------------------------------------------

const RICH_MANIFEST: ManifestState = {
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
  },
};

const mockFetcher: Fetcher = async (): Promise<FetchResult> => ({ status: 200, headers: {}, body: "", redirectChain: [], requiresAuth: false });

const FEED: FeedState = {
  url: "https://shop.example.com/products.json",
  reachable: true,
  httpStatus: 200,
  contentType: "application/json",
  format: "shopify_json",
  items: [{ id: "1", title: "Widget", description: null, price: 9.99, currency: null, available: true, link: "https://shop.example.com/products/widget", raw: {} }],
};

const mockLlm: LlmClient = async () => "{}"; // never invoked — both sig_* calls below use empty samples

const PROBE: PagePresenceProbe = { checkedUrls: [], foundUrl: null, hasStructuredData: false };
const POLICY_HOMEPAGE: PolicyHomepageState = { reachable: true, httpStatus: 200, blocks: [], rawHtml: null };

const ATTESTATION: MerchantCenterAttestation = { accountReady: null, feedsConfigured: false, earlyAccessStatus: null };

const ROBOTS: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 200, raw: "User-agent: *\nAllow: /\n" };
const PARSED_ROBOTS = parseRobotsTxt(ROBOTS.raw!);
const PAGE_STATES: ProductPageState[] = [];
const FEED_VARIANTS: FeedVariant[] = [];
const READABILITY_HOMEPAGE: PolicyHomepageState = { reachable: true, httpStatus: 200, blocks: [], rawHtml: null };
const SITEMAP: SitemapState = { url: "https://shop.example.com/sitemap.xml", reachable: true, httpStatus: 200, locs: [] };
const LLMS_TXT: LlmsTxtState = { url: "https://shop.example.com/llms.txt", reachable: true, httpStatus: 404, bodyLength: 0, errorNote: "http_404" };

async function buildAllSignals(): Promise<SignalRow[]> {
  const rows: SignalRow[] = [
    // manifestChecks.ts
    sig_manifest_present(RICH_MANIFEST),
    sig_version_declared(RICH_MANIFEST),
    sig_services_declared(RICH_MANIFEST),
    sig_namespace_authority_valid(RICH_MANIFEST),
    sig_signing_keys_present(RICH_MANIFEST),
    // capabilityChecks.ts
    sig_capability_checkout_declared(RICH_MANIFEST),
    sig_capability_cart_declared(RICH_MANIFEST),
    sig_capability_catalog_declared(RICH_MANIFEST),
    sig_capability_fulfillment_declared(RICH_MANIFEST),
    sig_capability_identity_linking_declared(RICH_MANIFEST),
    await checkEndpointReachability(RICH_MANIFEST, mockFetcher),
    // feedChecks.ts
    sig_feed_available(FEED),
    sig_native_commerce_attribute(FEED),
    // pageChecks.ts
    sig_product_id_consistency(null),
    sig_price_consistency(null),
    sig_availability_consistency(null),
    // llmChecks.ts
    await sig_title_description_consistency([], mockLlm),
    await sig_discovery_attributes_enrichment([], mockLlm),
    // policyChecks.ts
    sig_return_policy_present(PROBE),
    sig_shipping_info_present(PROBE),
    sig_support_contact_present(POLICY_HOMEPAGE),
    // paymentChecks.ts
    sig_ap2_compatibility_declared(RICH_MANIFEST),
    sig_credential_security_posture(RICH_MANIFEST),
    sig_merchant_of_record_declared(),
    sig_payment_instruments_declared(RICH_MANIFEST),
    // readinessChecks.ts
    sig_merchant_center_account_ready(ATTESTATION),
    sig_ucp_early_access_status(ATTESTATION),
    // readabilityChecks.ts
    sig_robots_txt_valid(ROBOTS, PARSED_ROBOTS),
    sig_ai_crawler_access_retrieval(PARSED_ROBOTS),
    sig_ai_crawler_access_training(PARSED_ROBOTS),
    sig_content_server_rendered(PAGE_STATES, FEED_VARIANTS),
    sig_schema_in_raw_html(PAGE_STATES),
    sig_product_schema_present(PAGE_STATES),
    sig_offer_schema_complete(PAGE_STATES),
    sig_organization_schema_present(READABILITY_HOMEPAGE),
    sig_sitemap_present(SITEMAP),
    sig_llms_txt_present(LLMS_TXT),
  ];
  return rows.slice().sort((a, b) => a.signal_key.localeCompare(b.signal_key));
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "capture" && mode !== "verify") {
    console.error("Usage: node --experimental-strip-types test_signal_values_golden.ts <capture|verify>");
    process.exit(2);
  }

  const rows = await buildAllSignals();
  console.log(`Built ${rows.length} signals (expect 37).`);
  const serialized = JSON.stringify(rows, null, 2);

  if (mode === "capture") {
    writeFileSync(FIXTURE_PATH, serialized + "\n");
    console.log(`✅ Captured golden fixture -> ${FIXTURE_PATH.pathname}`);
    return;
  }

  if (!existsSync(FIXTURE_PATH)) {
    console.error(`❌ No fixture found at ${FIXTURE_PATH.pathname} — run with 'capture' first.`);
    process.exit(1);
  }
  const expected = readFileSync(FIXTURE_PATH, "utf8").trimEnd();
  const actual = serialized;
  if (actual === expected) {
    console.log(`✅ All ${rows.length} signals' full output is byte-identical to the golden fixture.`);
    process.exit(0);
  } else {
    console.error("❌ Signal output DIFFERS from the golden fixture.");
    const expectedRows: SignalRow[] = JSON.parse(expected);
    const actualByKey = new Map(rows.map((r) => [r.signal_key, r]));
    const expectedByKey = new Map(expectedRows.map((r) => [r.signal_key, r]));
    for (const key of new Set([...actualByKey.keys(), ...expectedByKey.keys()])) {
      const a = JSON.stringify(actualByKey.get(key));
      const e = JSON.stringify(expectedByKey.get(key));
      if (a !== e) {
        console.error(`--- ${key} ---`);
        console.error(`expected: ${e}`);
        console.error(`actual:   ${a}`);
      }
    }
    process.exit(1);
  }
}

main();
