/**
 * Adeptra Merchant — agent_readability pillar (Build 1: signals + evidence layer).
 *
 * PILLAR BOUNDARY (locked, see signal_evidence migration + project notes):
 *   ucp pillar = protocol compliance (manifest, capabilities, feed data,
 *     feed/page consistency, payment readiness).
 *   agent_readability pillar = site legibility to ANY machine — crawler
 *     access, raw-HTML content, page-level schema markup, discovery
 *     surfaces. NOT AEO/GEO: this makes no claim about AI citation lift,
 *     only about access and machine-legibility. aeo_geo stays a separate,
 *     empty pillar until credible evidence justifies scoring it.
 *
 * KEY TECHNICAL FACT (measured, not vendor-documented — see signal_evidence):
 *   Vercel + MERJ's network-level analysis of 569M+ real GPTBot fetches found
 *   that no major AI crawler (Gemini and AppleBot are the exceptions)
 *   executes JavaScript. Adeptra's own httpFetcher already doesn't execute
 *   JS either — it already sees exactly what GPTBot/ClaudeBot/PerplexityBot
 *   see. Every signal here is checked against the RAW HTML httpFetcher
 *   already fetched. No headless browser, no rendering dependency.
 *
 * PORTABILITY CONTRACT (same shape as the other check groups):
 *  - fetchRobotsTxt / fetchSitemap / fetchLlmsTxt are the only new impure
 *    functions, using the same injectable Fetcher type as the rest of the
 *    pipeline. Product-page fetching is REUSED, not duplicated: pageChecks.ts's
 *    fetchProductPage / sampleAndCompare / ProductPageState already do this
 *    for the UCP pillar; this module either consumes the ProductPageState[]
 *    handed to it (feed-grounded sampling already done by pageChecks.ts) or,
 *    when there's no feed, falls back to its own sitemap-driven sampling
 *    using the SAME fetchProductPage function.
 *  - rawHtml on ProductPageState is in-memory only. It is NEVER written into
 *    an evidence_json value here — only derived fields (lengths, booleans,
 *    the threshold constant) are. See test_readability.ts's no-persist assertion.
 *
 * ROBOTS.TXT PARSING: hand-rolled, zero-npm-deps, per-token semantics — a
 * `User-agent: ClaudeBot` block does NOT apply to `Claude-SearchBot`; each
 * literal token gets its own lookup, falling back to `User-agent: *` only
 * when no bot-specific block exists.
 */

import type { SignalRow, Fetcher } from "./manifestChecks.ts";
import type { FeedVariant } from "./feedChecks.ts";
import { jsonLdBlocks, fetchProductPage, type ProductPageState } from "./pageChecks.ts";
import { fetchHomepage, type HomepageState } from "./policyChecks.ts";
import { getDef, contribution } from "./signalDefinitions.ts";

const ROBOTS_FETCH_TIMEOUT_MS = 8000;
const SITEMAP_FETCH_TIMEOUT_MS = 8000;
const LLMS_TXT_FETCH_TIMEOUT_MS = 8000;
const NO_FEED_FALLBACK_SAMPLE_SIZE = 5;
const MAX_CHILD_SITEMAPS_TO_FOLLOW = 3;
const LLMS_TXT_MIN_LENGTH = 20; // below this, treat as an empty/placeholder file

/** Raw-HTML body-text length below which a page is suspected of being an
 *  unrendered SPA shell. Named + exported so it's surfaced in evidence_json
 *  rather than a silent magic number. */
export const CONTENT_BODY_TEXT_THRESHOLD = 200;

// Canonical weight/impact/effort values (including the 2026-07-10
// reconciliation against the original Build 1 spec table) now live in
// signalDefinitions.ts's header comment — the documented home of that
// history. This file reads them via getDef(), never redeclares them.

// ---------------------------------------------------------------------------
// robots.txt: fetch + hand-rolled parser + per-token blocked lookup
// ---------------------------------------------------------------------------

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
  // 1-indexed line number in the raw robots.txt text. Purely additive — no
  // existing evidence_json serializes RobotsRule objects directly (both
  // robots_txt_valid and ai_crawler_access_retrieval only derive counts/
  // booleans), so this is invisible to every persisted signal shape. Used by
  // artifacts/robotsPatchArtifact.ts to name the exact line to remove.
  line: number;
}

export interface RobotsGroup {
  userAgents: string[]; // literal declared tokens, e.g. ["GPTBot"] or ["*"]
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export interface RobotsTxtState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  raw: string | null; // in-memory only — never written to evidence_json
  errorNote?: string;
}

export async function fetchRobotsTxt(rootUrl: string, fetcher: Fetcher): Promise<RobotsTxtState> {
  const url = `${rootUrl.replace(/\/+$/, "")}/robots.txt`;
  try {
    const res = await fetcher(url, ROBOTS_FETCH_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      return { url, reachable: true, httpStatus: res.status, raw: null, errorNote: `http_${res.status}` };
    }
    return { url, reachable: true, httpStatus: res.status, raw: res.body };
  } catch (e) {
    return { url, reachable: false, httpStatus: null, raw: null, errorNote: `fetch_failed: ${(e as Error).message}` };
  }
}

/** A `User-agent:` line starts a NEW group unless it immediately follows
 *  another `User-agent:` line with no rule in between (consecutive UA lines
 *  share one rule set — the standard robots.txt grouping convention). */
export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let awaitingNewGroup = true;

  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1; // 1-indexed, matches how a merchant's editor shows lines
    const line = rawLines[i].split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || awaitingNewGroup) {
        current = { userAgents: [value], rules: [] };
        groups.push(current);
        awaitingNewGroup = false;
      } else {
        current.userAgents.push(value);
      }
    } else if (field === "allow" || field === "disallow") {
      if (current) {
        current.rules.push({ type: field, path: value, line: lineNumber });
        awaitingNewGroup = true;
      }
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

/** Exported for artifacts/robotsPatchArtifact.ts: it needs to know whether a
 *  bot's blocking rule came from a bot-specific group or the shared wildcard
 *  group, to decide whether removing that rule is safely scoped to one bot
 *  or would affect every other crawler too. */
export function findGroupForToken(groups: RobotsGroup[], token: string): RobotsGroup | undefined {
  const lower = token.toLowerCase();
  return (
    groups.find((g) => g.userAgents.some((ua) => ua.toLowerCase() === lower)) ??
    groups.find((g) => g.userAgents.some((ua) => ua === "*"))
  );
}

/** Longest-matching-rule-wins against `path` (default site root); on a tie
 *  in path length, Allow wins (the documented least-restrictive-wins tie-
 *  break). No rules at all for this token (no specific block, no wildcard
 *  block) => null, matching real crawler behavior for a missing/silent
 *  robots.txt. An empty `Disallow:` value is a documented no-op ("disallow
 *  nothing"), not a block. Returns the winning RULE (with its line number),
 *  not just a boolean — artifacts/robotsPatchArtifact.ts needs the exact
 *  line to name for removal; isUserAgentBlocked is a thin wrapper for the
 *  many callers that only need the boolean. */
export function findBlockingRule(parsed: ParsedRobots, token: string, path = "/"): RobotsRule | null {
  const group = findGroupForToken(parsed.groups, token);
  if (!group || group.rules.length === 0) return null;
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (rule.type === "disallow" && rule.path === "") continue;
    if (path.startsWith(rule.path)) {
      if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.type === "allow")) {
        best = rule;
      }
    }
  }
  return best?.type === "disallow" ? best : null;
}

export function isUserAgentBlocked(parsed: ParsedRobots, token: string, path = "/"): boolean {
  return findBlockingRule(parsed, token, path) !== null;
}

// ---------------------------------------------------------------------------
// sitemap.xml: fetch + <loc> extraction + one-level index-sitemap follow
// ---------------------------------------------------------------------------

export interface SitemapState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  locs: string[];
  errorNote?: string;
}

export function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

export async function fetchSitemap(url: string, fetcher: Fetcher): Promise<SitemapState> {
  try {
    const res = await fetcher(url, SITEMAP_FETCH_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      return { url, reachable: true, httpStatus: res.status, locs: [], errorNote: `http_${res.status}` };
    }
    return { url, reachable: true, httpStatus: res.status, locs: extractSitemapLocs(res.body) };
  } catch (e) {
    return { url, reachable: false, httpStatus: null, locs: [], errorNote: `fetch_failed: ${(e as Error).message}` };
  }
}

const PRODUCT_PATH_HINTS = ["/product/", "/products/", "/item/", "/p/", "/shop/"];

export function filterLikelyProductUrls(locs: string[]): string[] {
  return locs.filter((u) => {
    try {
      const path = new URL(u).pathname.toLowerCase();
      return PRODUCT_PATH_HINTS.some((hint) => path.includes(hint));
    } catch {
      return false;
    }
  });
}

function looksLikeChildSitemap(u: string): boolean {
  try {
    const path = new URL(u).pathname.toLowerCase();
    return path.includes("sitemap") && path.endsWith(".xml");
  } catch {
    return false;
  }
}

/** sitemap.xml often points to child sitemaps (product/collection/page),
 *  not products directly (e.g. Shopify's default /sitemap.xml). Best-effort,
 *  unconfirmed: if the primary sitemap has no product-like URLs, follow up
 *  to MAX_CHILD_SITEMAPS_TO_FOLLOW entries that look like sitemaps and merge
 *  their <loc> lists in. Not a full crawler — one level deep, bounded. */
export async function resolveSitemapLocs(primary: SitemapState, fetcher: Fetcher): Promise<string[]> {
  if (filterLikelyProductUrls(primary.locs).length > 0) return primary.locs;
  const childUrls = primary.locs.filter(looksLikeChildSitemap).slice(0, MAX_CHILD_SITEMAPS_TO_FOLLOW);
  if (childUrls.length === 0) return primary.locs;
  const children = await Promise.all(childUrls.map((u) => fetchSitemap(u, fetcher)));
  return [...primary.locs, ...children.flatMap((c) => c.locs)];
}

/** The no-feed fallback: samples product pages via sitemap discovery instead
 *  of feed variants, using the SAME fetchProductPage as pageChecks.ts (one
 *  fetch implementation, two sampling sources). Best-effort/unconfirmed —
 *  URLs are guessed from path conventions, not grounded against a feed. */
export async function sampleFallbackProductPages(
  sitemapLocs: string[],
  fetcher: Fetcher,
  sampleSize = NO_FEED_FALLBACK_SAMPLE_SIZE,
): Promise<ProductPageState[]> {
  const candidates = filterLikelyProductUrls(sitemapLocs).slice(0, sampleSize);
  return Promise.all(candidates.map((url) => fetchProductPage(url, fetcher)));
}

// ---------------------------------------------------------------------------
// llms.txt: fetch only — presence + non-triviality is all this checks
// ---------------------------------------------------------------------------

export interface LlmsTxtState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  bodyLength: number;
  errorNote?: string;
}

export async function fetchLlmsTxt(rootUrl: string, fetcher: Fetcher): Promise<LlmsTxtState> {
  const url = `${rootUrl.replace(/\/+$/, "")}/llms.txt`;
  try {
    const res = await fetcher(url, LLMS_TXT_FETCH_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      return { url, reachable: true, httpStatus: res.status, bodyLength: 0, errorNote: `http_${res.status}` };
    }
    return { url, reachable: true, httpStatus: res.status, bodyLength: res.body.length };
  } catch (e) {
    return { url, reachable: false, httpStatus: null, bodyLength: 0, errorNote: `fetch_failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// content-legibility helpers (pure, over already-fetched rawHtml)
// ---------------------------------------------------------------------------

const SPA_SHELL_MARKERS = [/id=["']root["']/i, /id=["']app["']/i, /id=["']__next["']/i, /ng-app/i, /window\.__NUXT__/i];

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSpaShell(html: string, bodyTextLength: number): boolean {
  return bodyTextLength < CONTENT_BODY_TEXT_THRESHOLD && SPA_SHELL_MARKERS.some((re) => re.test(html));
}

/** Best-effort confirmation that a page's plain text actually contains the
 *  feed-known title/price — independent of JSON-LD (that's schema_in_raw_html's
 *  job), so a page can pass this check on visible text alone. */
function feedGroundedContentCheck(bodyText: string, feedTitle: string | null, feedPrice: number | null): boolean {
  if (!feedTitle && feedPrice == null) return false;
  const lowerBody = bodyText.toLowerCase();
  const titleMatch = feedTitle ? lowerBody.includes(feedTitle.toLowerCase().slice(0, 20)) : true;
  const priceMatch = feedPrice != null ? bodyText.includes(feedPrice.toFixed(2)) || bodyText.includes(String(feedPrice)) : true;
  return titleMatch && priceMatch;
}

function fetchedPages(pageStates: ProductPageState[]): ProductPageState[] {
  return pageStates.filter((s) => s.reachable && !s.errorNote);
}

// ---------------------------------------------------------------------------
// Signal functions — crawler_access (3)
// ---------------------------------------------------------------------------

export function sig_robots_txt_valid(robots: RobotsTxtState, parsed: ParsedRobots): SignalRow {
  const def = getDef("robots_txt_valid");
  const okStatus = robots.reachable && robots.httpStatus != null && robots.httpStatus >= 200 && robots.httpStatus < 300;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!okStatus) {
    status = "fail";
    fix = "No robots.txt found at /robots.txt (or it's unreachable) — publish one so crawlers, including AI bots, know what they may access.";
  } else if (parsed.groups.length === 0 && parsed.sitemaps.length === 0) {
    status = "partial";
    fix = "robots.txt exists but has no recognizable User-agent/Disallow/Sitemap directives — verify it's correctly formatted.";
  } else {
    status = "pass";
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
      url: robots.url,
      http_status: robots.httpStatus,
      reachable: robots.reachable,
      group_count: parsed.groups.length,
      sitemap_directive_count: parsed.sitemaps.length,
    },
    fix_summary: fix,
  };
}

const RETRIEVAL_BOTS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"];
const TRAINING_BOTS = ["GPTBot", "ClaudeBot"];

function classifyBotAccess(parsed: ParsedRobots, bots: string[]): { checked: { bot: string; blocked: boolean }[]; blockedCount: number } {
  const checked = bots.map((bot) => ({ bot, blocked: isUserAgentBlocked(parsed, bot) }));
  return { checked, blockedCount: checked.filter((c) => c.blocked).length };
}

export function sig_ai_crawler_access_retrieval(parsed: ParsedRobots): SignalRow {
  const def = getDef("ai_crawler_access_retrieval");
  const { checked, blockedCount } = classifyBotAccess(parsed, RETRIEVAL_BOTS);

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (blockedCount === 0) {
    status = "pass";
  } else if (blockedCount < RETRIEVAL_BOTS.length) {
    status = "partial";
    fix = `${blockedCount}/${RETRIEVAL_BOTS.length} AI answer-citation crawlers are blocked in robots.txt — those crawlers can't fetch your pages to cite them in AI-generated answers.`;
  } else {
    status = "fail";
    fix = "All known AI answer-citation crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) are blocked in robots.txt — your store can't be cited in AI-generated answers.";
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
    evidence_json: { checked, blocked_count: blockedCount, total: RETRIEVAL_BOTS.length },
    fix_summary: fix,
  };
}

export function sig_ai_crawler_access_training(parsed: ParsedRobots, opts?: { aiTrainingOptOut?: boolean }): SignalRow {
  const def = getDef("ai_crawler_access_training");
  const optedOut = !!opts?.aiTrainingOptOut;
  const { checked, blockedCount } = classifyBotAccess(parsed, TRAINING_BOTS);

  // Blocking GPTBot/ClaudeBot to keep content out of AI training is a
  // legitimate business decision — attested, never inferred (same pattern as
  // identity_linking_opt_out / checkout_handoff_opt_in).
  if (optedOut) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { checked, blocked_count: blockedCount, total: TRAINING_BOTS.length, ai_training_opt_out: true },
      fix_summary: null,
    };
  }

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (blockedCount === 0) {
    status = "pass";
  } else if (blockedCount < TRAINING_BOTS.length) {
    status = "partial";
    fix = `${blockedCount}/${TRAINING_BOTS.length} AI training crawlers are blocked in robots.txt. If that's intentional, attest to it so this signal reflects the choice instead of a partial score.`;
  } else {
    status = "fail";
    fix = "GPTBot and ClaudeBot are both blocked in robots.txt. If you're intentionally keeping your content out of AI model training, attest to that choice so this signal reflects it instead of failing.";
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
    evidence_json: { checked, blocked_count: blockedCount, total: TRAINING_BOTS.length, ai_training_opt_out: false },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Signal functions — content_legibility (2, highest-value)
// ---------------------------------------------------------------------------

/** CORRECTED heuristic: FAIL needs no feed data (a no-feed custom store —
 *  the store MOST likely to have the SPA problem — must still be able to
 *  fail this signal from raw-HTML shell-pattern detection alone). Only PASS
 *  needs feed grounding; without a feed, cap at partial. not_applicable means
 *  literally no product page could be sampled at all (not "no feed"). */
export function sig_content_server_rendered(pageStates: ProductPageState[], feedVariants: FeedVariant[]): SignalRow {
  const def = getDef("content_server_rendered");
  const fetched = fetchedPages(pageStates);

  if (fetched.length === 0) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { sampled: 0, body_text_threshold: CONTENT_BODY_TEXT_THRESHOLD, reason: "no product pages could be sampled" },
      fix_summary: null,
    };
  }

  const hasFeed = feedVariants.length > 0;
  const feedByUrl = new Map(feedVariants.filter((v) => v.link).map((v) => [v.link as string, v]));

  const samples = fetched.map((state) => {
    const bodyText = state.rawHtml ? stripHtmlToText(state.rawHtml) : "";
    const bodyTextLength = bodyText.length;
    const spaShellDetected = state.rawHtml ? looksLikeSpaShell(state.rawHtml, bodyTextLength) : bodyTextLength < CONTENT_BODY_TEXT_THRESHOLD;
    const feedVariant = feedByUrl.get(state.url);
    const feedGrounded = !!feedVariant;
    const feedConfirmed = feedVariant ? feedGroundedContentCheck(bodyText, feedVariant.productTitle, feedVariant.price) : false;
    return { url: state.url, body_text_length: bodyTextLength, spa_shell_detected: spaShellDetected, feed_grounded: feedGrounded, feed_confirmed: feedConfirmed };
  });

  const failCount = samples.filter((s) => s.spa_shell_detected).length;
  const confirmedCount = samples.filter((s) => s.feed_confirmed).length;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (failCount > 0) {
    status = "fail";
    fix = `${failCount}/${samples.length} sampled product pages show signs of client-side-rendered content (minimal raw HTML body text plus a known SPA-shell marker) — AI crawlers, which do not execute JavaScript, would see an effectively empty page.`;
  } else if (hasFeed) {
    if (confirmedCount === samples.length) {
      status = "pass";
    } else {
      status = "partial";
      fix = `Raw HTML has enough body text on every sampled page, but ${samples.length - confirmedCount}/${samples.length} couldn't be confirmed against known feed title/price — worth a manual check.`;
    }
  } else {
    status = "partial";
    fix = "No SPA-shell pattern detected and page body text is present, but there's no product feed to confirm the content matches your real catalog data — connect a feed for a full pass.";
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
    evidence_json: { sampled: samples, body_text_threshold: CONTENT_BODY_TEXT_THRESHOLD, has_feed: hasFeed },
    fix_summary: fix,
  };
}

export function sig_schema_in_raw_html(pageStates: ProductPageState[]): SignalRow {
  const def = getDef("schema_in_raw_html");
  const fetched = fetchedPages(pageStates);

  if (fetched.length === 0) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { sampled: 0, reason: "no product pages could be sampled" },
      fix_summary: null,
    };
  }

  const withSchema = fetched.filter((s) => !!s.rawHtml && jsonLdBlocks(s.rawHtml).length > 0);
  const rate = withSchema.length / fetched.length;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (rate === 1) {
    status = "pass";
  } else if (rate > 0) {
    status = "partial";
    fix = `${fetched.length - withSchema.length}/${fetched.length} sampled pages have no JSON-LD in the raw HTML response — if it's injected by client-side JavaScript, AI crawlers never see it.`;
  } else {
    status = "fail";
    fix = "No sampled page has JSON-LD structured data in the raw HTML response — AI crawlers, which don't execute JavaScript, see none of it even if it's added client-side.";
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
    evidence_json: { sampled: fetched.length, with_schema_in_raw_html: withSchema.length },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Signal functions — structured_data (3)
// ---------------------------------------------------------------------------

export function sig_product_schema_present(pageStates: ProductPageState[]): SignalRow {
  const def = getDef("product_schema_present");
  const fetched = fetchedPages(pageStates);

  if (fetched.length === 0) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { sampled: 0, reason: "no product pages could be sampled" },
      fix_summary: null,
    };
  }

  const withProduct = fetched.filter((s) => s.variants.length > 0);
  const rate = withProduct.length / fetched.length;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (rate === 1) {
    status = "pass";
  } else if (rate > 0) {
    status = "partial";
    fix = `${fetched.length - withProduct.length}/${fetched.length} sampled product pages have no schema.org Product/ProductGroup markup.`;
  } else {
    status = "fail";
    fix = "None of the sampled product pages have schema.org Product markup — add JSON-LD Product schema so agents can identify what's for sale.";
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
    evidence_json: { sampled: fetched.length, with_product_schema: withProduct.length },
    fix_summary: fix,
  };
}

export function sig_offer_schema_complete(pageStates: ProductPageState[]): SignalRow {
  const def = getDef("offer_schema_complete");
  const fetched = fetchedPages(pageStates);
  const allVariants = fetched.flatMap((s) => s.variants);

  if (allVariants.length === 0) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { variants_checked: 0, reason: "no Product schema found to evaluate Offer completeness against" },
      fix_summary: null,
    };
  }

  const complete = allVariants.filter((v) => v.price != null && v.currency != null && v.available !== null);
  const rate = complete.length / allVariants.length;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (rate === 1) {
    status = "pass";
  } else if (rate > 0) {
    status = "partial";
    fix = `${allVariants.length - complete.length}/${allVariants.length} product variants have an incomplete Offer (missing price, priceCurrency, or availability).`;
  } else {
    status = "fail";
    fix = "Product schema is present but Offer data (price/priceCurrency/availability) is missing on every sampled variant — an agent can't reason about purchasability.";
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
    evidence_json: { variants_checked: allVariants.length, complete: complete.length },
    fix_summary: fix,
  };
}

export function sig_organization_schema_present(homepage: HomepageState): SignalRow {
  const def = getDef("organization_schema_present");
  const org = homepage.blocks
    .flatMap((b) => (Array.isArray(b?.["@graph"]) ? b["@graph"] : [b]))
    .find((n) => {
      const t = n?.["@type"];
      const types = Array.isArray(t) ? t : t ? [t] : [];
      return types.includes("Organization") || types.includes("LocalBusiness");
    });
  const hasName = !!org?.name;
  const hasIdentifier = !!(org?.url || org?.logo);
  const complete = hasName && hasIdentifier;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (complete) {
    status = "pass";
  } else if (org) {
    status = "partial";
    fix = "Organization schema found but incomplete — add name, url, and logo so agents can positively identify the merchant.";
  } else {
    status = "fail";
    fix = "Publish a schema.org Organization (or LocalBusiness) node with name/url/logo so agents can identify who they're buying from.";
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
    evidence_json: { found: !!org, has_name: hasName, has_identifier: hasIdentifier, homepage_reachable: homepage.reachable },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Signal functions — discovery_surfaces (2)
// ---------------------------------------------------------------------------

export function sig_sitemap_present(sitemap: SitemapState): SignalRow {
  const def = getDef("sitemap_present");
  const okStatus = sitemap.reachable && sitemap.httpStatus != null && sitemap.httpStatus >= 200 && sitemap.httpStatus < 300;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!okStatus) {
    status = "fail";
    fix = "No sitemap.xml found (checked robots.txt's Sitemap: directive and the default /sitemap.xml) — publish one so crawlers can discover your product pages.";
  } else if (sitemap.locs.length === 0) {
    status = "partial";
    fix = "sitemap.xml exists but contains no <loc> entries.";
  } else {
    status = "pass";
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
    evidence_json: { url: sitemap.url, http_status: sitemap.httpStatus, url_count: sitemap.locs.length },
    fix_summary: fix,
  };
}

export function sig_llms_txt_present(state: LlmsTxtState): SignalRow {
  const def = getDef("llms_txt_present");
  const okStatus = state.reachable && state.httpStatus != null && state.httpStatus >= 200 && state.httpStatus < 300;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!okStatus) {
    status = "fail";
    fix = "No llms.txt found at /llms.txt. Low priority: there's no established evidence it affects AI citation visibility, but some agentic/coding tools do read it.";
  } else if (state.bodyLength < LLMS_TXT_MIN_LENGTH) {
    status = "partial";
    fix = "llms.txt exists but is empty or trivially short.";
  } else {
    status = "pass";
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
    evidence_json: { url: state.url, http_status: state.httpStatus, body_length: state.bodyLength },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ReadabilityInput {
  rootUrl: string;
  fetcher: Fetcher;
  feedVariants: FeedVariant[]; // [] when there's no feed
  pageStates: ProductPageState[]; // already-fetched by pageChecks.ts's sampleAndCompare; [] when there was no feed to sample from
  opts?: { aiTrainingOptOut?: boolean };
}

/** signals: the ten agent_readability signals. robots/parsedRobots/homepage:
 *  the already-fetched state artifacts/robotsPatchArtifact.ts and
 *  artifacts/jsonldArtifact.ts need, exposed so those generators never
 *  re-fetch what this orchestrator already got — same reuse discipline as
 *  pageChecks.ts's pageStates exposure. */
export interface ReadabilityResult {
  signals: SignalRow[];
  robots: RobotsTxtState;
  parsedRobots: ParsedRobots;
  homepage: HomepageState;
}

export async function runReadabilityChecks(input: ReadabilityInput): Promise<ReadabilityResult> {
  const { rootUrl, fetcher, feedVariants, opts } = input;

  const robots = await fetchRobotsTxt(rootUrl, fetcher);
  const parsed = parseRobotsTxt(robots.raw ?? "");

  const sitemapUrl = parsed.sitemaps[0] ?? `${rootUrl.replace(/\/+$/, "")}/sitemap.xml`;
  const sitemap = await fetchSitemap(sitemapUrl, fetcher);

  const llmsTxt = await fetchLlmsTxt(rootUrl, fetcher);
  const homepage = await fetchHomepage(rootUrl, fetcher);

  let pageStates = input.pageStates;
  if (pageStates.length === 0) {
    const locs = await resolveSitemapLocs(sitemap, fetcher);
    pageStates = await sampleFallbackProductPages(locs, fetcher);
  }

  return {
    signals: [
      sig_robots_txt_valid(robots, parsed),
      sig_ai_crawler_access_retrieval(parsed),
      sig_ai_crawler_access_training(parsed, opts),
      sig_content_server_rendered(pageStates, feedVariants),
      sig_schema_in_raw_html(pageStates),
      sig_product_schema_present(pageStates),
      sig_offer_schema_complete(pageStates),
      sig_organization_schema_present(homepage),
      sig_sitemap_present(sitemap),
      sig_llms_txt_present(llmsTxt),
    ],
    robots,
    parsedRobots: parsed,
    homepage,
  };
}
