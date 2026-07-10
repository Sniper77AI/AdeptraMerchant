/**
 * Golden-fixture regression guard for pageChecks.ts's UCP page-consistency
 * signals (product_id_consistency / price_consistency_cross_surface /
 * availability_consistency).
 *
 * This file is a REGRESSION LOCK, not a design spec: it exists because
 * pageChecks.ts is about to gain a `rawHtml` field on ProductPageState and an
 * exposed page-state map (for the new agent_readability content-legibility
 * signals to reuse the same fetch), and that signature change must not alter
 * a single byte of the UCP pillar's existing signal output.
 *
 * Usage:
 *   node --experimental-strip-types test_pageChecks_golden.ts capture   -> writes fixture
 *   node --experimental-strip-types test_pageChecks_golden.ts verify    -> diffs against fixture
 *
 * Run: node --experimental-strip-types test_pageChecks_golden.ts <capture|verify>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runPageConsistencyChecks } from "./pageChecks.ts";
import type { Fetcher, FetchResult } from "./manifestChecks.ts";
import type { FeedVariant } from "./feedChecks.ts";

const FIXTURE_PATH = new URL("./__fixtures__/pageChecks_golden.json", import.meta.url);

// ---------------------------------------------------------------------------
// Deterministic mock fetcher + feed covering every branch: pass, partial,
// fail, not_applicable, a fetch error, and a page missing the sku entirely.
// ---------------------------------------------------------------------------

const PAGES: Record<string, { status: number; body: string }> = {
  "https://shop.example.com/products/pass-item": {
    status: 200,
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      mpn: "SKU-PASS",
      name: "Pass Item",
      offers: { price: "19.99", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    })}</script>`,
  },
  "https://shop.example.com/products/partial-mismatch": {
    status: 200,
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      mpn: "SKU-PARTIAL",
      name: "Partial Item",
      offers: { price: "25.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    })}</script>`,
  },
  "https://shop.example.com/products/group-page": {
    status: 200,
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "ProductGroup",
      hasVariant: [
        { "@type": "Product", mpn: "SKU-GROUP-A", name: "Group A", offers: { price: "10.00", priceCurrency: "USD", availability: "https://schema.org/OutOfStock" } },
        { "@type": "Product", mpn: "SKU-GROUP-B", name: "Group B", offers: { price: "12.00", priceCurrency: "USD", availability: "https://schema.org/InStock" } },
      ],
    })}</script>`,
  },
  "https://shop.example.com/products/missing-sku": {
    status: 200,
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      mpn: "SKU-DIFFERENT",
      name: "Wrong Sku Item",
      offers: { price: "5.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    })}</script>`,
  },
  "https://shop.example.com/products/broken": { status: 500, body: "server error" },
};

const feedVariants: FeedVariant[] = [
  { sku: "SKU-PASS", productTitle: "Pass Item", price: 19.99, currency: "USD", available: true, link: "https://shop.example.com/products/pass-item" },
  { sku: "SKU-PARTIAL", productTitle: "Partial Item", price: 30.0, currency: "USD", available: false, link: "https://shop.example.com/products/partial-mismatch" },
  { sku: "SKU-GROUP-A", productTitle: "Group A", price: 10.0, currency: "USD", available: false, link: "https://shop.example.com/products/group-page" },
  { sku: "SKU-GROUP-B", productTitle: "Group B", price: 12.0, currency: "USD", available: true, link: "https://shop.example.com/products/group-page" },
  { sku: "SKU-NOT-ON-PAGE", productTitle: "Missing Sku Item", price: 5.0, currency: "USD", available: true, link: "https://shop.example.com/products/missing-sku" },
  { sku: "SKU-UNFETCHABLE", productTitle: "Broken Item", price: 1.0, currency: "USD", available: true, link: "https://shop.example.com/products/broken" },
  { sku: "SKU-NO-LINK", productTitle: "No Link Item", price: 2.0, currency: "USD", available: true, link: null },
];

const mockFetcher: Fetcher = async (url: string): Promise<FetchResult> => {
  const page = PAGES[url];
  if (!page) return { status: 404, headers: {}, body: "not found", redirectChain: [], requiresAuth: false };
  return { status: page.status, headers: {}, body: page.body, redirectChain: [], requiresAuth: false };
};

// ---------------------------------------------------------------------------

async function main() {
  const mode = process.argv[2];
  if (mode !== "capture" && mode !== "verify") {
    console.error("Usage: node --experimental-strip-types test_pageChecks_golden.ts <capture|verify>");
    process.exit(2);
  }

  const { signals } = await runPageConsistencyChecks(feedVariants, mockFetcher);
  const serialized = JSON.stringify(signals, null, 2);

  if (mode === "capture") {
    writeFileSync(FIXTURE_PATH, serialized + "\n");
    console.log(`✅ Captured golden fixture -> ${FIXTURE_PATH.pathname}`);
    console.log(serialized);
    return;
  }

  // verify
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`❌ No fixture found at ${FIXTURE_PATH.pathname} — run with 'capture' first.`);
    process.exit(1);
  }
  const expected = readFileSync(FIXTURE_PATH, "utf8").trimEnd();
  const actual = serialized;
  if (actual === expected) {
    console.log("✅ UCP page-consistency signals are byte-identical to the golden fixture.");
    process.exit(0);
  } else {
    console.error("❌ UCP page-consistency signals DIFFER from the golden fixture.");
    console.error("--- expected (golden) ---");
    console.error(expected);
    console.error("--- actual (current) ---");
    console.error(actual);
    process.exit(1);
  }
}

main();
