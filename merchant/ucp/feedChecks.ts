/**
 * Adeptra Merchant — Product Feed Check Group (Category 2: Product Data Hygiene)
 *
 * SCOPE OF THIS FILE: feed fetching/parsing, plus `feed_available` and
 * `native_commerce_attribute` (feed-only, deterministic). `extractFeedVariants`
 * also lives here (it's a pure view over the same FeedState) but the signals
 * that consume it — product_id / price / availability cross-surface
 * consistency — live in pageChecks.ts, since they need page-fetching + JSON-LD
 * extraction too. title_description_consistency and discovery_attributes_enrichment
 * need an LLM and aren't wired anywhere yet.
 *
 * PORTABILITY CONTRACT (same shape as manifestChecks.ts):
 *  - `fetchFeed` is the only function that touches the network, via the same
 *    injectable `Fetcher` type manifestChecks.ts defines — tests pass a mock,
 *    production passes httpFetcher.
 *  - Feed parsing (`parseShopifyFeed`, `parseGoogleMerchantFeed`) is pure.
 *  - No npm deps: the Google Merchant XML parser is regex-based (same
 *    zero-dependency constraint as the rest of the pipeline), not a full XML
 *    parser. It's deliberately narrow — it only reads the handful of `<g:*>`
 *    fields the signals below need.
 *
 * MVP feed formats (per signal-specs.md open item #3): Shopify `products.json`
 * and Google Merchant Center XML/RSS.
 */

import type { SignalRow, Fetcher } from "./manifestChecks.ts";

const CATEGORY = "product_data_hygiene";
const FEED_FETCH_TIMEOUT_MS = 10000; // feeds can be large; more generous than the manifest's 5s

// Weight/impact/effort for the signals implemented in this slice. Category 2 is
// the pillar's highest weight class (0.30); the remaining 5 signals' weights are
// reserved for when product_id/price/availability/title/discovery checks land,
// so the category's total stays proportionate once complete.
const W = {
  feedAvailable: { weight: 2.0, impact: 5, effort: 2 },
  nativeCommerce: { weight: 2.0, impact: 5, effort: 2 },
} as const;

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string;
  title: string | null;
  description: string | null; // plain text, HTML tags stripped where the source is HTML
  price: number | null;
  currency: string | null;
  available: boolean | null;
  link: string | null; // product page URL, when derivable
  raw: any; // original item — used for less-common attribute checks (e.g. native_commerce)
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export type FeedFormat = "shopify_json" | "google_xml" | "unknown";

export interface FeedState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  contentType: string | null;
  format: FeedFormat;
  items: FeedItem[];
  errorNote?: string;
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

export function parseShopifyFeed(products: any[], rootUrl?: string): FeedItem[] {
  return products.map((p) => {
    const variants: any[] = Array.isArray(p?.variants) ? p.variants : [];
    const primary = variants[0] ?? {};
    const anyAvailable = variants.some((v) => v?.available === true);
    const link = p?.handle && rootUrl ? `${rootUrl.replace(/\/+$/, "")}/products/${p.handle}` : null;
    return {
      id: String(p?.id ?? primary?.sku ?? p?.handle ?? ""),
      title: p?.title ?? null,
      description: typeof p?.body_html === "string" && p.body_html.trim() ? stripHtml(p.body_html) : null,
      price: primary?.price != null ? Number(primary.price) : null,
      currency: null, // products.json doesn't carry currency; it's a store-level setting
      available: variants.length > 0 ? anyAvailable : null,
      link,
      raw: p,
    };
  });
}

function xmlTag(block: string, tag: string): string | null {
  const re = new RegExp(`<(?:g:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:g:)?${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return (cdata ? cdata[1] : raw).trim();
}

export function parseGoogleMerchantFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return blocks.map((block) => {
    const id = xmlTag(block, "id");
    const priceRaw = xmlTag(block, "price"); // e.g. "64.00 USD"
    const [priceNum, currency] = priceRaw ? priceRaw.split(/\s+/) : [null, null];
    const availabilityRaw = xmlTag(block, "availability");
    return {
      id: id ?? "",
      title: xmlTag(block, "title"),
      description: xmlTag(block, "description"),
      price: priceNum ? Number(priceNum) : null,
      currency: currency ?? null,
      available: availabilityRaw ? /in[\s_]?stock/i.test(availabilityRaw) : null,
      link: xmlTag(block, "link"),
      raw: { id, price: priceRaw, availability: availabilityRaw, native_commerce: xmlTag(block, "native_commerce") },
    };
  });
}

// ---------------------------------------------------------------------------
// Variant-level view (for cross-surface consistency checks in pageChecks.ts)
//
// feed_available / native_commerce_attribute operate at product granularity
// (one FeedItem per product, as shipped). The consistency checks need
// variant granularity instead — a merchant's checkout/page-level SKU is
// per-variant (size/color), not per-product. This derives variant rows from
// the same FeedState without touching the product-level shape above.
// ---------------------------------------------------------------------------

export interface FeedVariant {
  sku: string;
  productTitle: string | null;
  price: number | null;
  currency: string | null;
  available: boolean | null;
  link: string | null; // product page URL — shared across a product's variants
}

export function extractFeedVariants(feed: FeedState): FeedVariant[] {
  if (feed.format === "shopify_json") {
    const out: FeedVariant[] = [];
    for (const item of feed.items) {
      const product = item.raw;
      const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
      for (const v of variants) {
        if (!v?.sku) continue;
        out.push({
          sku: String(v.sku),
          productTitle: product?.title ?? null,
          price: v.price != null ? Number(v.price) : null,
          currency: null,
          available: v.available === true,
          link: item.link,
        });
      }
    }
    return out;
  }
  if (feed.format === "google_xml") {
    return feed.items
      .filter((it) => !!it.id)
      .map((it) => ({ sku: it.id, productTitle: it.title, price: it.price, currency: it.currency, available: it.available, link: it.link }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Network boundary (the only impure function)
// ---------------------------------------------------------------------------

export async function fetchFeed(feedUrl: string, fetcher: Fetcher, rootUrl?: string): Promise<FeedState> {
  const base: FeedState = {
    url: feedUrl,
    reachable: false,
    httpStatus: null,
    contentType: null,
    format: "unknown",
    items: [],
  };

  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(feedUrl, FEED_FETCH_TIMEOUT_MS);
  } catch (e) {
    return { ...base, errorNote: `fetch_failed: ${(e as Error).message}` };
  }

  const contentType = (res.headers["content-type"] || res.headers["Content-Type"] || "").toLowerCase();
  if (res.status < 200 || res.status >= 300) {
    return { ...base, reachable: true, httpStatus: res.status, contentType: contentType || null, errorNote: `http_${res.status}` };
  }

  const trimmed = res.body.trim();
  let format: FeedFormat = "unknown";
  let items: FeedItem[] = [];
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed?.products)) {
        format = "shopify_json";
        items = parseShopifyFeed(parsed.products, rootUrl);
      }
    } else if (trimmed.startsWith("<") && /<item[\s>]/i.test(trimmed)) {
      format = "google_xml";
      items = parseGoogleMerchantFeed(trimmed);
    }
  } catch (e) {
    return { ...base, reachable: true, httpStatus: res.status, contentType: contentType || null, errorNote: `parse_failed: ${(e as Error).message}` };
  }

  return { url: feedUrl, reachable: true, httpStatus: res.status, contentType: contentType || null, format, items };
}

// ---------------------------------------------------------------------------
// Signal functions (pure)
// ---------------------------------------------------------------------------

/** `feed` is null when no feed_url was configured at onboarding — the gate. */
export function sig_feed_available(feed: FeedState | null): SignalRow {
  const cfg = W.feedAvailable;
  let status: SignalRow["status"];
  let fix: string | null = null;

  // "reachable" only means the network round-trip succeeded — a 404/5xx still
  // means there's no usable feed at this URL, so gate on the 2xx status too.
  const fetchedOk = !!feed?.reachable && feed.httpStatus !== null && feed.httpStatus >= 200 && feed.httpStatus < 300;

  if (!feed) {
    status = "not_applicable";
  } else if (fetchedOk && feed.format !== "unknown" && feed.items.length > 0 && !feed.errorNote) {
    status = "pass";
  } else if (fetchedOk) {
    status = "partial";
    fix =
      feed.format === "unknown"
        ? "Feed is reachable but not in a recognized format (Google Merchant XML or Shopify products.json)."
        : "Feed is reachable but has no parseable items.";
  } else {
    status = "fail";
    fix = "Provide a reachable product feed URL (Google Merchant XML or Shopify products.json) at onboarding.";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "feed_available",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: feed
      ? {
          feed_url: feed.url,
          reachable: feed.reachable,
          http_status: feed.httpStatus,
          format: feed.format,
          item_count: feed.items.length,
          error_note: feed.errorNote ?? null,
        }
      : { feed_url: null, reachable: null, format: null, item_count: 0 },
    fix_summary: fix,
  };
}

/** Shared with artifacts/feedArtifact.ts — the "does this item already carry
 *  the attribute" test must stay identical between detection and generation. */
export function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}

/** Gated the same way as feed_available's dependents: no feed (or nothing
 *  parseable) drops this to not_applicable rather than penalizing a store we
 *  simply couldn't check. */
export function sig_native_commerce_attribute(feed: FeedState | null): SignalRow {
  const cfg = W.nativeCommerce;
  let status: SignalRow["status"];
  let fix: string | null = null;
  let withAttr = 0;
  const total = feed?.items.length ?? 0;

  if (!feed || total === 0) {
    status = "not_applicable";
  } else {
    withAttr = feed.items.filter((it) => truthy(it.raw?.native_commerce)).length;
    if (withAttr === total) {
      status = "pass";
    } else if (withAttr > 0) {
      status = "partial";
      fix = `native_commerce attribute present on ${withAttr}/${total} products; add it to the rest via the supplemental feed.`;
    } else {
      status = "fail";
      fix = "No products carry the native_commerce attribute — none are checkout-eligible for UCP-powered checkout.";
    }
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "native_commerce_attribute",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { products_with_attr: withAttr, products_total: total, external_gate: true },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: fetch the feed once (if configured), run the implemented
// Category-2 signals, return rows.
// ---------------------------------------------------------------------------

export async function runFeedChecks(
  feedUrl: string | null,
  fetcher: Fetcher,
  rootUrl?: string,
): Promise<{ feed: FeedState | null; signals: SignalRow[] }> {
  const feed = feedUrl ? await fetchFeed(feedUrl, fetcher, rootUrl) : null;
  const signals = [sig_feed_available(feed), sig_native_commerce_attribute(feed)];
  return { feed, signals };
}
