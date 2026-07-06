/**
 * Adeptra Merchant — Policy & Post-Purchase Transparency (Category 5,
 * weight class 0.10): return_policy_present_consistent,
 * shipping_info_present_consistent, support_contact_present.
 *
 * SCOPE / HONEST LIMITATION: the spec's pass condition includes "consistent
 * with feed/Merchant Center," but we don't have reliable feed-side policy
 * data to compare against — Shopify's products.json carries no return/
 * shipping-policy fields, and Google Merchant feeds only sometimes do.
 * pass/partial/fail here is judged on presence + machine-readability alone;
 * evidence_json.feed_match is always null to make that limitation explicit
 * rather than fabricating a "consistent" claim we didn't check.
 *
 * POLICY PAGE DISCOVERY: grounded against real stores (skims.com, gymshark.com)
 * — there is NO single reliable URL convention. Shopify's auto-generated
 * /policies/refund-policy et al. often 404 on a merchant's main domain (they
 * only resolve on the *.myshopify.com backend or a checkout subdomain);
 * custom storefronts use their own /pages/* slugs instead (skims.com uses
 * /pages/returns and /pages/shipping). This probes a short list of known
 * candidate paths and reports the first one found — a best-effort heuristic,
 * not full-site discovery (there's no crawler yet; see README open items).
 *
 * support_contact_present instead reads the schema.org Organization node's
 * contactPoint, which — per real-world grounding against skims.com — appears
 * on ordinary product pages, not just the homepage, but this file fetches
 * the site root once for a single canonical read.
 *
 * PORTABILITY CONTRACT: `probeCandidatePaths` and `fetchHomepage` are the only
 * impure functions, using the same injectable `Fetcher` type as the rest of
 * the pipeline.
 */

import type { SignalRow, Fetcher } from "./manifestChecks.ts";
import { jsonLdBlocks, flattenNodes, typesOf } from "./pageChecks.ts";

const CATEGORY = "policy_transparency";
const POLICY_FETCH_TIMEOUT_MS = 8000;

const W = {
  returnPolicy: { weight: 1.5, impact: 4, effort: 2 },
  shippingInfo: { weight: 1.25, impact: 3, effort: 2 },
  supportContact: { weight: 1.25, impact: 3, effort: 1 },
} as const;

const RETURN_POLICY_CANDIDATES = ["/policies/refund-policy", "/pages/returns", "/pages/return-policy", "/pages/returns-policy"];
const SHIPPING_INFO_CANDIDATES = ["/policies/shipping-policy", "/pages/shipping", "/pages/shipping-policy", "/pages/shipping-info"];

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

// ---------------------------------------------------------------------------
// Network boundary (the only impure functions)
// ---------------------------------------------------------------------------

export interface PagePresenceProbe {
  checkedUrls: string[];
  foundUrl: string | null;
  hasStructuredData: boolean;
}

/** Tries each candidate path in order against rootUrl; the first 200 wins.
 *  Every candidate tried is recorded, found or not, for evidence auditability. */
export async function probeCandidatePaths(rootUrl: string, candidates: string[], fetcher: Fetcher): Promise<PagePresenceProbe> {
  const checkedUrls: string[] = [];
  for (const path of candidates) {
    const url = `${rootUrl.replace(/\/+$/, "")}${path}`;
    checkedUrls.push(url);
    try {
      const res = await fetcher(url, POLICY_FETCH_TIMEOUT_MS);
      if (res.status >= 200 && res.status < 300) {
        return { checkedUrls, foundUrl: url, hasStructuredData: jsonLdBlocks(res.body).length > 0 };
      }
    } catch {
      // treat as not-found and keep trying the remaining candidates
    }
  }
  return { checkedUrls, foundUrl: null, hasStructuredData: false };
}

export interface HomepageState {
  reachable: boolean;
  httpStatus: number | null;
  blocks: any[];
  errorNote?: string;
}

export async function fetchHomepage(rootUrl: string, fetcher: Fetcher): Promise<HomepageState> {
  try {
    const res = await fetcher(rootUrl, POLICY_FETCH_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      return { reachable: true, httpStatus: res.status, blocks: [], errorNote: `http_${res.status}` };
    }
    return { reachable: true, httpStatus: res.status, blocks: jsonLdBlocks(res.body) };
  } catch (e) {
    return { reachable: false, httpStatus: null, blocks: [], errorNote: `fetch_failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Signal functions (pure, over pre-computed probes)
// ---------------------------------------------------------------------------

function sig_from_page_probe(
  signalKey: string,
  cfg: { weight: number; impact: number; effort: number },
  probe: PagePresenceProbe,
  notFoundFix: string,
  notStructuredFix: string,
): SignalRow {
  let status: SignalRow["status"];
  let fix: string | null = null;
  if (probe.foundUrl && probe.hasStructuredData) {
    status = "pass";
  } else if (probe.foundUrl) {
    status = "partial";
    fix = notStructuredFix;
  } else {
    status = "fail";
    fix = notFoundFix;
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: signalKey,
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      found_on_site: !!probe.foundUrl,
      structured: probe.hasStructuredData,
      feed_match: null, // not checked — see file header
      checked_urls: probe.checkedUrls,
      found_url: probe.foundUrl,
    },
    fix_summary: fix,
  };
}

export function sig_return_policy_present(probe: PagePresenceProbe): SignalRow {
  return sig_from_page_probe(
    "return_policy_present_consistent",
    W.returnPolicy,
    probe,
    "Publish a return policy at a discoverable URL (e.g. /policies/refund-policy or /pages/returns).",
    "Return policy page exists but isn't machine-readable (no structured data found).",
  );
}

export function sig_shipping_info_present(probe: PagePresenceProbe): SignalRow {
  return sig_from_page_probe(
    "shipping_info_present_consistent",
    W.shippingInfo,
    probe,
    "Publish shipping information at a discoverable URL (e.g. /policies/shipping-policy or /pages/shipping).",
    "Shipping info page exists but isn't machine-readable (no structured data found).",
  );
}

export function sig_support_contact_present(homepage: HomepageState): SignalRow {
  const cfg = W.supportContact;
  const org = flattenNodes(homepage.blocks).find((n) => typesOf(n).includes("Organization"));
  const contactPoint = Array.isArray(org?.contactPoint) ? org.contactPoint[0] : org?.contactPoint;
  const hasStructured = !!(contactPoint && (contactPoint.telephone || contactPoint.email || contactPoint.contactType));

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (hasStructured) {
    status = "pass";
  } else if (org) {
    status = "partial";
    fix = "Add a structured contactPoint (telephone/email) to the Organization schema.";
  } else {
    status = "fail";
    fix = "Publish structured customer support contact details (schema.org Organization.contactPoint).";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "support_contact_present",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      found: !!org,
      machine_readable: hasStructured,
      method: contactPoint ? "schema.org Organization.contactPoint" : null,
    },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runPolicyChecks(rootUrl: string, fetcher: Fetcher): Promise<SignalRow[]> {
  const [returnProbe, shippingProbe, homepage] = await Promise.all([
    probeCandidatePaths(rootUrl, RETURN_POLICY_CANDIDATES, fetcher),
    probeCandidatePaths(rootUrl, SHIPPING_INFO_CANDIDATES, fetcher),
    fetchHomepage(rootUrl, fetcher),
  ]);

  return [sig_return_policy_present(returnProbe), sig_shipping_info_present(shippingProbe), sig_support_contact_present(homepage)];
}
