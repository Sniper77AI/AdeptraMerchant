/**
 * Adeptra Merchant — Product Page Check Group (Category 2 cross-surface
 * consistency: product_id_consistency / price_consistency_cross_surface /
 * availability_consistency).
 *
 * Samples feed variants, fetches each one's product page once (de-duped by
 * URL — several variants share one page), extracts schema.org JSON-LD, and
 * matches the page-side variant to the feed variant by SKU (`mpn`, falling
 * back to `sku`/`gtin` — grounded against a real Shopify + schema.org
 * ProductGroup/hasVariant page, where `mpn` is the exact join key that
 * matches the feed's variant `sku`). Compares id/price/availability.
 *
 * PORTABILITY CONTRACT (same shape as manifestChecks.ts / feedChecks.ts):
 *  - `fetchProductPage` is the only impure function, using the same
 *    injectable `Fetcher` type as the rest of the pipeline.
 *  - JSON-LD extraction is a lightweight regex-based script-tag scan +
 *    JSON.parse — no HTML parser dependency (zero-npm-deps constraint).
 *  - Sampling is deterministic (first N feed variants with a link), not
 *    random, so results are reproducible and testable. See signal-specs.md
 *    open item #2 on sample size (default 15).
 */

import type { SignalRow, Fetcher } from "./manifestChecks.ts";
import type { FeedVariant } from "./feedChecks.ts";

const CATEGORY = "product_data_hygiene";
const PAGE_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_SAMPLE_SIZE = 15; // per signal-specs.md open item #2
const MISMATCH_PARTIAL_THRESHOLD = 0.2; // < 20% mismatch => partial, per spec
const PRICE_TOLERANCE = 0.01; // rounding tolerance; same-currency assumed

const W = {
  productId: { weight: 2.0, impact: 5, effort: 3 },
  price: { weight: 2.0, impact: 5, effort: 2 },
  availability: { weight: 1.5, impact: 4, effort: 2 },
} as const;

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageVariant {
  sku: string | null; // mpn, falling back to sku/gtin
  price: number | null;
  currency: string | null;
  available: boolean | null;
  name: string | null;
}

export interface ProductPageState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  variants: PageVariant[];
  productDescription: string | null; // product/group-level description (llmChecks.ts)
  productAttributes: Record<string, unknown> | null; // extra structured fields beyond price/availability/sku (llmChecks.ts)
  errorNote?: string;
}

export interface SampledComparison {
  sku: string;
  link: string | null;
  feedPrice: number | null;
  pagePrice: number | null;
  feedAvailable: boolean | null;
  pageAvailable: boolean | null;
  pageFound: boolean; // false when no page-side variant matched this sku at all
  fetchError: string | null;
}

// ---------------------------------------------------------------------------
// JSON-LD extraction (pure)
// ---------------------------------------------------------------------------

function jsonLdBlocks(html: string): any[] {
  const blocks: any[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      // malformed block — skip it, don't fail the whole extraction over one bad script tag
    }
  }
  return blocks;
}

function typesOf(node: any): string[] {
  const t = node?.["@type"];
  if (!t) return [];
  return Array.isArray(t) ? t : [t];
}

function toPageVariant(p: any): PageVariant {
  const offers = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const availRaw = offers?.availability;
  return {
    sku: p?.mpn ?? p?.sku ?? p?.gtin ?? null,
    price: offers?.price != null ? Number(offers.price) : null,
    currency: offers?.priceCurrency ?? null,
    available: availRaw ? /instock/i.test(String(availRaw)) : null,
    name: p?.name ?? null,
  };
}

function flattenNodes(blocks: any[]): any[] {
  const nodes: any[] = [];
  for (const block of blocks) {
    if (Array.isArray(block?.["@graph"])) nodes.push(...block["@graph"]);
    else nodes.push(block);
  }
  return nodes;
}

/** A bare Product is one variant; a ProductGroup contributes each of its
 *  hasVariant entries. Handles @graph wrapping. */
export function extractVariants(blocks: any[]): PageVariant[] {
  const variants: PageVariant[] = [];
  for (const node of flattenNodes(blocks)) {
    const types = typesOf(node);
    if (types.includes("ProductGroup") && Array.isArray(node.hasVariant)) {
      for (const v of node.hasVariant) variants.push(toPageVariant(v));
    } else if (types.includes("Product")) {
      variants.push(toPageVariant(node));
    }
  }
  return variants;
}

/** Product/group-level description and extra structured attributes (for
 *  llmChecks.ts) — fields that live on the ProductGroup/Product node itself,
 *  not per-variant (a real page's hasVariant entries don't carry description). */
function extractProductLevel(blocks: any[]): { description: string | null; attributes: Record<string, unknown> | null } {
  for (const node of flattenNodes(blocks)) {
    const types = typesOf(node);
    if (types.includes("ProductGroup") || types.includes("Product")) {
      const { hasVariant, offers, "@context": _context, "@type": _type, ...rest } = node ?? {};
      return { description: node?.description ?? null, attributes: rest };
    }
  }
  return { description: null, attributes: null };
}

// ---------------------------------------------------------------------------
// Network boundary (the only impure function)
// ---------------------------------------------------------------------------

export async function fetchProductPage(url: string, fetcher: Fetcher): Promise<ProductPageState> {
  const base: ProductPageState = { url, reachable: false, httpStatus: null, variants: [], productDescription: null, productAttributes: null };
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, PAGE_FETCH_TIMEOUT_MS);
  } catch (e) {
    return { ...base, errorNote: `fetch_failed: ${(e as Error).message}` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ...base, reachable: true, httpStatus: res.status, errorNote: `http_${res.status}` };
  }
  try {
    const blocks = jsonLdBlocks(res.body);
    const { description, attributes } = extractProductLevel(blocks);
    return {
      url,
      reachable: true,
      httpStatus: res.status,
      variants: extractVariants(blocks),
      productDescription: description,
      productAttributes: attributes,
    };
  } catch (e) {
    return { ...base, reachable: true, httpStatus: res.status, errorNote: `extract_failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Sampling + comparison
// ---------------------------------------------------------------------------

export async function sampleAndCompare(
  feedVariants: FeedVariant[],
  fetcher: Fetcher,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): Promise<SampledComparison[]> {
  const sample = feedVariants.filter((v) => !!v.link).slice(0, sampleSize);

  const pageCache = new Map<string, Promise<ProductPageState>>();
  const pageFor = (link: string) => {
    let p = pageCache.get(link);
    if (!p) {
      p = fetchProductPage(link, fetcher);
      pageCache.set(link, p);
    }
    return p;
  };

  const results: SampledComparison[] = [];
  for (const v of sample) {
    const page = await pageFor(v.link!);
    const match = page.variants.find((pv) => !!pv.sku && pv.sku === v.sku);
    results.push({
      sku: v.sku,
      link: v.link,
      feedPrice: v.price,
      pagePrice: match?.price ?? null,
      feedAvailable: v.available,
      pageAvailable: match?.available ?? null,
      pageFound: !!match,
      fetchError: page.errorNote ?? null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Signal functions (pure, over pre-computed comparisons)
// ---------------------------------------------------------------------------

export function sig_product_id_consistency(comparisons: SampledComparison[] | null): SignalRow {
  const cfg = W.productId;
  let status: SignalRow["status"];
  let fix: string | null = null;
  let mismatchRate = 0;

  const checked = (comparisons ?? []).filter((c) => !c.fetchError);
  if (!comparisons || comparisons.length === 0 || checked.length === 0) {
    status = "not_applicable";
  } else {
    const mismatches = checked.filter((c) => !c.pageFound);
    mismatchRate = mismatches.length / checked.length;
    if (mismatchRate === 0) {
      status = "pass";
    } else if (mismatchRate < MISMATCH_PARTIAL_THRESHOLD) {
      status = "partial";
      fix = `${mismatches.length}/${checked.length} sampled products have a feed SKU not found on their page (matched via mpn/sku/gtin).`;
    } else {
      status = "fail";
      fix = "Feed product IDs don't map to the IDs used on-page/at checkout — an agent can't reliably match a feed listing to a purchasable item.";
    }
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "product_id_consistency",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      sampled: (comparisons ?? []).map((c) => ({ sku: c.sku, page_found: c.pageFound, fetch_error: c.fetchError })),
      mismatch_rate: mismatchRate,
    },
    fix_summary: fix,
  };
}

export function sig_price_consistency(comparisons: SampledComparison[] | null): SignalRow {
  const cfg = W.price;
  let status: SignalRow["status"];
  let fix: string | null = null;
  let mismatchRate = 0;

  const checked = (comparisons ?? []).filter((c) => !c.fetchError && c.pageFound && c.feedPrice != null && c.pagePrice != null);
  if (!comparisons || comparisons.length === 0 || checked.length === 0) {
    status = "not_applicable";
  } else {
    const mismatches = checked.filter((c) => Math.abs((c.feedPrice as number) - (c.pagePrice as number)) > PRICE_TOLERANCE);
    mismatchRate = mismatches.length / checked.length;
    if (mismatches.length === 0) {
      status = "pass";
    } else if (mismatchRate < MISMATCH_PARTIAL_THRESHOLD) {
      status = "partial";
      fix = `${mismatches.length}/${checked.length} sampled products have a price mismatch between the feed and the page.`;
    } else {
      status = "fail";
      fix = "Material price mismatches between the feed and the live page — an agent may quote or check out at the wrong price.";
    }
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "price_consistency_cross_surface",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      sampled: (comparisons ?? []).map((c) => ({
        sku: c.sku,
        page_price: c.pagePrice,
        feed_price: c.feedPrice,
        consistent: c.pagePrice != null && c.feedPrice != null ? Math.abs(c.pagePrice - c.feedPrice) <= PRICE_TOLERANCE : null,
      })),
      mismatch_rate: mismatchRate,
    },
    fix_summary: fix,
  };
}

export function sig_availability_consistency(comparisons: SampledComparison[] | null): SignalRow {
  const cfg = W.availability;
  let status: SignalRow["status"];
  let fix: string | null = null;

  const checked = (comparisons ?? []).filter((c) => !c.fetchError && c.pageFound && c.feedAvailable !== null && c.pageAvailable !== null);
  if (!comparisons || comparisons.length === 0 || checked.length === 0) {
    status = "not_applicable";
  } else {
    const mismatches = checked.filter((c) => c.feedAvailable !== c.pageAvailable);
    const mismatchRate = mismatches.length / checked.length;
    if (mismatches.length === 0) {
      status = "pass";
    } else if (mismatchRate < MISMATCH_PARTIAL_THRESHOLD) {
      status = "partial";
      fix = `${mismatches.length}/${checked.length} sampled products have mismatched stock status between the feed and the page.`;
    } else {
      status = "fail";
      fix = "Feed and page disagree on stock status for most sampled products — an agent may recommend sold-out items or skip in-stock ones.";
    }
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "availability_consistency",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      sampled: (comparisons ?? []).map((c) => ({
        sku: c.sku,
        page_availability: c.pageAvailable,
        feed_availability: c.feedAvailable,
        match: c.feedAvailable !== null && c.pageAvailable !== null ? c.feedAvailable === c.pageAvailable : null,
      })),
    },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runPageConsistencyChecks(
  feedVariants: FeedVariant[],
  fetcher: Fetcher,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): Promise<SignalRow[]> {
  const comparisons = feedVariants.length > 0 ? await sampleAndCompare(feedVariants, fetcher, sampleSize) : null;
  return [
    sig_product_id_consistency(comparisons),
    sig_price_consistency(comparisons),
    sig_availability_consistency(comparisons),
  ];
}
