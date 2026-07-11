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
import { getDef, contribution } from "./signalDefinitions.ts";

const PAGE_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_SAMPLE_SIZE = 15; // per signal-specs.md open item #2
const MISMATCH_PARTIAL_THRESHOLD = 0.2; // < 20% mismatch => partial, per spec
const PRICE_TOLERANCE = 0.01; // rounding tolerance; same-currency assumed

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
  // Raw HTML body, in-memory only — the same bytes an AI crawler would fetch
  // (httpFetcher does not execute JS, so this IS what GPTBot/ClaudeBot see).
  // Consumed by readabilityChecks.ts's content-legibility signals. NEVER
  // persisted: it must not appear in any evidence_json written to the DB —
  // only derived fields (lengths, booleans) may. null when the fetch didn't
  // reach a 2xx response (nothing meaningful to inspect).
  rawHtml: string | null;
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

/** sampleAndCompare's result: the UCP cross-surface comparisons, plus the
 *  deduped ProductPageState for every page fetched along the way (one entry
 *  per distinct URL, in first-fetch order) — so agent_readability's content-
 *  legibility signals can inspect the same fetched pages without re-fetching. */
export interface SampleAndCompareResult {
  comparisons: SampledComparison[];
  pageStates: ProductPageState[];
}

// ---------------------------------------------------------------------------
// JSON-LD extraction (pure)
// ---------------------------------------------------------------------------

export function jsonLdBlocks(html: string): any[] {
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

export function typesOf(node: any): string[] {
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

export function flattenNodes(blocks: any[]): any[] {
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
  const base: ProductPageState = { url, reachable: false, httpStatus: null, variants: [], productDescription: null, productAttributes: null, rawHtml: null };
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
      rawHtml: res.body,
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
): Promise<SampleAndCompareResult> {
  const sample = feedVariants.filter((v) => !!v.link).slice(0, sampleSize);

  const pageCache = new Map<string, Promise<ProductPageState>>();
  const pageStates: ProductPageState[] = [];
  const pageFor = (link: string) => {
    let p = pageCache.get(link);
    if (!p) {
      p = fetchProductPage(link, fetcher).then((state) => {
        pageStates.push(state);
        return state;
      });
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
  return { comparisons: results, pageStates };
}

// ---------------------------------------------------------------------------
// Signal functions (pure, over pre-computed comparisons)
// ---------------------------------------------------------------------------

export function sig_product_id_consistency(comparisons: SampledComparison[] | null): SignalRow {
  const def = getDef("product_id_consistency");
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
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: {
      sampled: (comparisons ?? []).map((c) => ({ sku: c.sku, page_found: c.pageFound, fetch_error: c.fetchError })),
      mismatch_rate: mismatchRate,
    },
    fix_summary: fix,
  };
}

export function sig_price_consistency(comparisons: SampledComparison[] | null): SignalRow {
  const def = getDef("price_consistency_cross_surface");
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
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
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
  const def = getDef("availability_consistency");
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
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
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

/** signals: the three UCP cross-surface consistency signals, unchanged in
 *  content/shape from before pageStates was added (see test_pageChecks_golden.ts).
 *  pageStates: every distinct product page fetched along the way, for reuse
 *  by agent_readability's content-legibility signals — [] when there were no
 *  feed variants to sample (readabilityChecks.ts falls back to its own
 *  sitemap-driven sampling in that case). */
export interface PageConsistencyResult {
  signals: SignalRow[];
  pageStates: ProductPageState[];
}

export async function runPageConsistencyChecks(
  feedVariants: FeedVariant[],
  fetcher: Fetcher,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): Promise<PageConsistencyResult> {
  const sampled = feedVariants.length > 0 ? await sampleAndCompare(feedVariants, fetcher, sampleSize) : null;
  const comparisons = sampled?.comparisons ?? null;
  return {
    signals: [
      sig_product_id_consistency(comparisons),
      sig_price_consistency(comparisons),
      sig_availability_consistency(comparisons),
    ],
    pageStates: sampled?.pageStates ?? [],
  };
}
