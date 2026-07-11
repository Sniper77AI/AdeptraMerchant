/**
 * Tests for the agent_readability pillar (readabilityChecks.ts).
 *
 * 1. robots.txt parsing: grouping (consecutive User-agent lines share rules,
 *    a rule line closes the group), comments/blank lines ignored, Sitemap:
 *    directives collected.
 * 2. isUserAgentBlocked: per-token lookup (a ClaudeBot block does NOT apply
 *    to Claude-SearchBot), wildcard fallback, longest-rule-wins, empty
 *    Disallow is a no-op, no rules at all => allowed.
 * 3. crawler_access signals: ai_crawler_access_retrieval (pass/partial/fail
 *    over OAI-SearchBot/Claude-SearchBot/PerplexityBot); ai_crawler_access_training
 *    (pass/partial/fail over GPTBot/ClaudeBot, and not_applicable on
 *    ai_training_opt_out regardless of block state); robots_txt_valid
 *    (pass/partial/fail).
 * 4. content_server_rendered: the CORRECTED heuristic — fail fires from raw-
 *    HTML shell detection ALONE (no feed needed); partial when body text is
 *    present but there's no feed to confirm it; pass only with feed
 *    grounding; not_applicable only when literally no page could be sampled.
 * 5. schema_in_raw_html: pass/partial/fail/not_applicable over sampled pages'
 *    raw HTML JSON-LD presence.
 * 6. structured_data: product_schema_present, offer_schema_complete (N/A when
 *    no Product schema found at all), organization_schema_present.
 * 7. discovery_surfaces: sitemap_present (incl. child-sitemap-index follow,
 *    product-path filtering) and llms_txt_present.
 * 8. No-persist guardrail: no evidence_json produced by any signal function
 *    in this file contains a full HTML document (rawHtml must stay in-memory
 *    only, never reach the DB).
 * 9. runReadabilityChecks: end-to-end orchestrator — returns exactly 10
 *    signals, all pillar 'agent_readability', falls back to sitemap-driven
 *    sampling when pageStates is empty (no feed).
 *
 * Run: node --experimental-strip-types test_readability.ts
 */

import {
  parseRobotsTxt,
  isUserAgentBlocked,
  fetchRobotsTxt,
  fetchSitemap,
  extractSitemapLocs,
  filterLikelyProductUrls,
  resolveSitemapLocs,
  sampleFallbackProductPages,
  fetchLlmsTxt,
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
  runReadabilityChecks,
  CONTENT_BODY_TEXT_THRESHOLD,
  type ParsedRobots,
} from "./readabilityChecks.ts";
import type { Fetcher, FetchResult } from "./manifestChecks.ts";
import type { FeedVariant } from "./feedChecks.ts";
import type { ProductPageState } from "./pageChecks.ts";
import type { HomepageState } from "./policyChecks.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

function mockFetcher(handler: (url: string) => FetchResult | null): Fetcher {
  return async (url: string) => {
    const res = handler(url);
    if (!res) return { status: 404, headers: {}, body: "not found", redirectChain: [], requiresAuth: false };
    return res;
  };
}

function htmlRes(body: string, status = 200): FetchResult {
  return { status, headers: {}, body, redirectChain: [], requiresAuth: false };
}

function productPage(url: string, opts: Partial<ProductPageState> = {}): ProductPageState {
  return {
    url,
    reachable: true,
    httpStatus: 200,
    variants: [],
    productDescription: null,
    productAttributes: null,
    rawHtml: null,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// 1. robots.txt parsing
// ---------------------------------------------------------------------------

{
  const text = `
# comment line
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
User-agent: Claude-Extended
Disallow: /private/
Allow: /private/public-page

Sitemap: https://shop.example.com/sitemap.xml
Sitemap: https://shop.example.com/sitemap2.xml
`;
  const parsed = parseRobotsTxt(text);
  check("parseRobotsTxt: three groups (GPTBot; ClaudeBot+Claude-Extended)", parsed.groups.length === 2, parsed.groups);
  check("parseRobotsTxt: consecutive User-agent lines share one rule set", parsed.groups[1].userAgents.length === 2, parsed.groups[1]);
  check("parseRobotsTxt: rules recorded on the right group", parsed.groups[1].rules.length === 2, parsed.groups[1].rules);
  check("parseRobotsTxt: comments/blank lines ignored (no phantom groups)", parsed.groups.every((g) => g.userAgents.every((u) => !u.includes("#"))), parsed.groups);
  check("parseRobotsTxt: sitemap directives collected", parsed.sitemaps.length === 2, parsed.sitemaps);

  const rulesLineBeforeUA = parseRobotsTxt("Disallow: /\nUser-agent: *\n");
  check("parseRobotsTxt: a rule line before any User-agent is ignored, not attached to a phantom group", rulesLineBeforeUA.groups.length === 1 && rulesLineBeforeUA.groups[0].rules.length === 0, rulesLineBeforeUA);
}

// ---------------------------------------------------------------------------
// 2. isUserAgentBlocked
// ---------------------------------------------------------------------------

{
  const parsed = parseRobotsTxt(`
User-agent: ClaudeBot
Disallow: /

User-agent: *
Allow: /
`);
  check("isUserAgentBlocked: ClaudeBot is blocked by its own specific block", isUserAgentBlocked(parsed, "ClaudeBot"), parsed);
  check(
    "isUserAgentBlocked: Claude-SearchBot is NOT blocked — a ClaudeBot block does not apply to a different literal token",
    !isUserAgentBlocked(parsed, "Claude-SearchBot"),
    parsed,
  );
  check("isUserAgentBlocked: an unlisted bot falls back to the wildcard group (allowed)", !isUserAgentBlocked(parsed, "OAI-SearchBot"), parsed);
}

{
  const noRulesAtAll = parseRobotsTxt("");
  check("isUserAgentBlocked: no robots.txt content at all => allowed (missing file = unrestricted)", !isUserAgentBlocked(noRulesAtAll, "GPTBot"), noRulesAtAll);

  const emptyDisallow = parseRobotsTxt("User-agent: GPTBot\nDisallow:\n");
  check("isUserAgentBlocked: an empty Disallow value is a documented no-op, not a block", !isUserAgentBlocked(emptyDisallow, "GPTBot"), emptyDisallow);

  const tieGoesToAllow = parseRobotsTxt("User-agent: GPTBot\nDisallow: /\nAllow: /\n");
  check("isUserAgentBlocked: on a tied path length, Allow wins (least-restrictive-wins tie-break)", !isUserAgentBlocked(tieGoesToAllow, "GPTBot"), tieGoesToAllow);

  const longerDisallowWins = parseRobotsTxt("User-agent: GPTBot\nAllow: /\nDisallow: /private\n");
  check("isUserAgentBlocked: a longer, more specific Disallow overrides a shorter Allow", isUserAgentBlocked(longerDisallowWins, "GPTBot", "/private/page"), longerDisallowWins);
}

// ---------------------------------------------------------------------------
// 3. crawler_access + robots_txt_valid signals
// ---------------------------------------------------------------------------

{
  const allAllowed: ParsedRobots = { groups: [], sitemaps: [] };
  const retrieval = sig_ai_crawler_access_retrieval(allAllowed);
  check("ai_crawler_access_retrieval: pass when nothing is blocked", retrieval.status === "pass", retrieval);
  check("ai_crawler_access_retrieval: pillar is agent_readability", retrieval.pillar === "agent_readability", retrieval);
  check("ai_crawler_access_retrieval: category is crawler_access", retrieval.category === "crawler_access", retrieval);

  const oneBlocked = parseRobotsTxt("User-agent: PerplexityBot\nDisallow: /\n");
  const partial = sig_ai_crawler_access_retrieval(oneBlocked);
  check("ai_crawler_access_retrieval: partial when 1/3 retrieval bots blocked", partial.status === "partial", partial);

  const allBlocked = parseRobotsTxt("User-agent: OAI-SearchBot\nDisallow: /\nUser-agent: Claude-SearchBot\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\n");
  const fail = sig_ai_crawler_access_retrieval(allBlocked);
  check("ai_crawler_access_retrieval: fail when all 3 retrieval bots blocked", fail.status === "fail", fail);
}

{
  const bothBlocked = parseRobotsTxt("User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\n");
  const failNoOptOut = sig_ai_crawler_access_training(bothBlocked);
  check("ai_crawler_access_training: fail when both training bots blocked and not opted out", failNoOptOut.status === "fail", failNoOptOut);

  const naOptOut = sig_ai_crawler_access_training(bothBlocked, { aiTrainingOptOut: true });
  check("ai_crawler_access_training: not_applicable when opted out, regardless of block state", naOptOut.status === "not_applicable", naOptOut);
  check("ai_crawler_access_training: opt-out earns zero score contribution (dropped from denominator)", naOptOut.score_contribution === 0, naOptOut);

  const naOptOutButAllowed = sig_ai_crawler_access_training({ groups: [], sitemaps: [] }, { aiTrainingOptOut: true });
  check("ai_crawler_access_training: not_applicable on opt-out even when bots are actually unblocked (attested, never inferred)", naOptOutButAllowed.status === "not_applicable", naOptOutButAllowed);

  const allAllowed = sig_ai_crawler_access_training({ groups: [], sitemaps: [] });
  check("ai_crawler_access_training: pass when neither bot is blocked and not opted out", allAllowed.status === "pass", allAllowed);
}

{
  const missing = sig_robots_txt_valid({ url: "https://x.com/robots.txt", reachable: true, httpStatus: 404, raw: null, errorNote: "http_404" }, { groups: [], sitemaps: [] });
  check("robots_txt_valid: fail on 404", missing.status === "fail", missing);

  const emptyButOk = sig_robots_txt_valid({ url: "https://x.com/robots.txt", reachable: true, httpStatus: 200, raw: "" }, { groups: [], sitemaps: [] });
  check("robots_txt_valid: partial when 200 but no recognizable directives at all", emptyButOk.status === "partial", emptyButOk);

  const good = sig_robots_txt_valid(
    { url: "https://x.com/robots.txt", reachable: true, httpStatus: 200, raw: "User-agent: *\nAllow: /\n" },
    parseRobotsTxt("User-agent: *\nAllow: /\n"),
  );
  check("robots_txt_valid: pass when 200 and has recognizable directives", good.status === "pass", good);
}

// ---------------------------------------------------------------------------
// 4. content_server_rendered — the corrected heuristic
// ---------------------------------------------------------------------------

const SPA_SHELL_HTML = `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const RICH_HTML_MATCHING_FEED = `<html><body><h1>Widget Pro</h1><p>Price: $19.99</p><p>${"filler ".repeat(60)}</p></body></html>`;
const RICH_HTML_NOT_MATCHING_FEED = `<html><body><h1>Something Else Entirely</h1><p>${"filler ".repeat(60)}</p></body></html>`;

{
  const noPages = sig_content_server_rendered([], []);
  check("content_server_rendered: not_applicable when no product pages could be sampled at all", noPages.status === "not_applicable", noPages);

  const allFetchFailed = sig_content_server_rendered([productPage("https://x.com/p/1", { reachable: false, errorNote: "fetch_failed: x" })], []);
  check("content_server_rendered: not_applicable when every sampled page failed to fetch", allFetchFailed.status === "not_applicable", allFetchFailed);
}

{
  // FAIL must fire from raw-HTML shell detection alone — NO feed data needed.
  // This is the store most likely to have the SPA problem: a no-feed custom store.
  const noFeedShellPage = [productPage("https://x.com/p/1", { rawHtml: SPA_SHELL_HTML })];
  const result = sig_content_server_rendered(noFeedShellPage, []);
  check("content_server_rendered: FAIL fires for a no-feed store from shell detection alone", result.status === "fail", result);
}

{
  // No feed, no shell pattern, plenty of body text => capped at partial, not pass.
  const noFeedRichPage = [productPage("https://x.com/p/1", { rawHtml: RICH_HTML_NOT_MATCHING_FEED })];
  const result = sig_content_server_rendered(noFeedRichPage, []);
  check("content_server_rendered: no feed + no shell pattern + real body text => partial (capped, not pass)", result.status === "partial", result);
  check("content_server_rendered: evidence_json discloses has_feed: false", (result.evidence_json as any).has_feed === false, result.evidence_json);
}

{
  // With a feed AND the page content actually matches feed title/price => pass.
  const variant: FeedVariant = { sku: "W-1", productTitle: "Widget Pro", price: 19.99, currency: "USD", available: true, link: "https://x.com/p/1" };
  const page = [productPage("https://x.com/p/1", { rawHtml: RICH_HTML_MATCHING_FEED })];
  const result = sig_content_server_rendered(page, [variant]);
  check("content_server_rendered: pass when feed-grounded and page text confirms feed title+price", result.status === "pass", result);
}

{
  // With a feed but the page content does NOT match feed title/price => partial, not pass.
  const variant: FeedVariant = { sku: "W-1", productTitle: "Widget Pro", price: 19.99, currency: "USD", available: true, link: "https://x.com/p/1" };
  const page = [productPage("https://x.com/p/1", { rawHtml: RICH_HTML_NOT_MATCHING_FEED })];
  const result = sig_content_server_rendered(page, [variant]);
  check("content_server_rendered: feed present but content unconfirmed => partial, not pass", result.status === "partial", result);
}

{
  check("CONTENT_BODY_TEXT_THRESHOLD is exported as a named constant", typeof CONTENT_BODY_TEXT_THRESHOLD === "number" && CONTENT_BODY_TEXT_THRESHOLD > 0);
}

// ---------------------------------------------------------------------------
// 5. schema_in_raw_html
// ---------------------------------------------------------------------------

{
  const withJsonLd = productPage("https://x.com/p/1", { rawHtml: `<script type="application/ld+json">{"@type":"Product","mpn":"W-1"}</script>` });
  const withoutJsonLd = productPage("https://x.com/p/2", { rawHtml: `<html><body>plain content</body></html>` });

  const pass = sig_schema_in_raw_html([withJsonLd]);
  check("schema_in_raw_html: pass when every sampled page has JSON-LD in raw HTML", pass.status === "pass", pass);

  const partial = sig_schema_in_raw_html([withJsonLd, withoutJsonLd]);
  check("schema_in_raw_html: partial when some pages have it and some don't", partial.status === "partial", partial);

  const fail = sig_schema_in_raw_html([withoutJsonLd]);
  check("schema_in_raw_html: fail when no sampled page has JSON-LD in raw HTML", fail.status === "fail", fail);

  const na = sig_schema_in_raw_html([]);
  check("schema_in_raw_html: not_applicable with nothing sampled", na.status === "not_applicable", na);
}

// ---------------------------------------------------------------------------
// 6. structured_data: product_schema_present / offer_schema_complete / organization_schema_present
// ---------------------------------------------------------------------------

{
  const withVariant = productPage("https://x.com/p/1", { variants: [{ sku: "W-1", price: 9.99, currency: "USD", available: true, name: "Widget" }] });
  const withoutVariant = productPage("https://x.com/p/2", { variants: [] });

  const pass = sig_product_schema_present([withVariant]);
  check("product_schema_present: pass when Product schema found on every sampled page", pass.status === "pass", pass);

  const fail = sig_product_schema_present([withoutVariant]);
  check("product_schema_present: fail when no sampled page has Product schema", fail.status === "fail", fail);

  const na = sig_product_schema_present([]);
  check("product_schema_present: not_applicable when nothing sampled", na.status === "not_applicable", na);
}

{
  const completeVariant = productPage("https://x.com/p/1", { variants: [{ sku: "W-1", price: 9.99, currency: "USD", available: true, name: "Widget" }] });
  const incompleteVariant = productPage("https://x.com/p/2", { variants: [{ sku: "W-2", price: null, currency: null, available: null, name: "Gadget" }] });
  const noVariant = productPage("https://x.com/p/3", { variants: [] });

  const pass = sig_offer_schema_complete([completeVariant]);
  check("offer_schema_complete: pass when all found variants have price/currency/availability", pass.status === "pass", pass);

  const partial = sig_offer_schema_complete([completeVariant, incompleteVariant]);
  check("offer_schema_complete: partial on a mix", partial.status === "partial", partial);

  const na = sig_offer_schema_complete([noVariant]);
  check("offer_schema_complete: not_applicable when no Product schema was found to evaluate Offer completeness against", na.status === "not_applicable", na);
}

{
  const completeHomepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [{ "@type": "Organization", name: "Acme", url: "https://acme.com", logo: "https://acme.com/logo.png" }] };
  const incompleteHomepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [{ "@type": "Organization", name: "Acme" }] };
  const noOrgHomepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [] };

  check("organization_schema_present: pass when name + url/logo present", sig_organization_schema_present(completeHomepage).status === "pass");
  check("organization_schema_present: partial when Organization found but incomplete", sig_organization_schema_present(incompleteHomepage).status === "partial");
  check("organization_schema_present: fail when no Organization node at all", sig_organization_schema_present(noOrgHomepage).status === "fail");
}

// ---------------------------------------------------------------------------
// 7. discovery_surfaces: sitemap_present (+ discovery helpers) / llms_txt_present
// ---------------------------------------------------------------------------

{
  check("extractSitemapLocs: extracts every <loc>", extractSitemapLocs("<urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>").length === 2);

  const pass = sig_sitemap_present({ url: "https://x.com/sitemap.xml", reachable: true, httpStatus: 200, locs: ["https://x.com/a"] });
  check("sitemap_present: pass when reachable with at least one loc", pass.status === "pass", pass);

  const partial = sig_sitemap_present({ url: "https://x.com/sitemap.xml", reachable: true, httpStatus: 200, locs: [] });
  check("sitemap_present: partial when reachable but empty", partial.status === "partial", partial);

  const fail = sig_sitemap_present({ url: "https://x.com/sitemap.xml", reachable: true, httpStatus: 404, locs: [], errorNote: "http_404" });
  check("sitemap_present: fail when unreachable/404", fail.status === "fail", fail);
}

{
  check(
    "filterLikelyProductUrls: keeps only product-path-convention URLs",
    JSON.stringify(filterLikelyProductUrls(["https://x.com/products/widget", "https://x.com/about", "https://x.com/item/42"])) ===
      JSON.stringify(["https://x.com/products/widget", "https://x.com/item/42"]),
  );
}

{
  // Sitemap index follow: primary sitemap has no product-like URLs but points
  // at a child sitemap that does.
  const fetcher = mockFetcher((url) => {
    if (url === "https://x.com/sitemap-products.xml") {
      return htmlRes(`<urlset><url><loc>https://x.com/products/widget</loc></url></urlset>`);
    }
    return null;
  });
  const primary = { url: "https://x.com/sitemap.xml", reachable: true, httpStatus: 200, locs: ["https://x.com/sitemap-products.xml"] };
  const locs = await resolveSitemapLocs(primary, fetcher);
  check("resolveSitemapLocs: follows a child sitemap when the primary has no product-like URLs", locs.includes("https://x.com/products/widget"), locs);
}

{
  const fetcher = mockFetcher((url) => (url === "https://x.com/products/widget" ? htmlRes(`<html><body>ok</body></html>`) : null));
  const pages = await sampleFallbackProductPages(["https://x.com/products/widget", "https://x.com/about"], fetcher);
  check("sampleFallbackProductPages: samples only product-path-convention URLs", pages.length === 1 && pages[0].url === "https://x.com/products/widget", pages);
}

{
  const pass = sig_llms_txt_present({ url: "https://x.com/llms.txt", reachable: true, httpStatus: 200, bodyLength: 500 });
  check("llms_txt_present: pass when reachable with real content", pass.status === "pass", pass);

  const partial = sig_llms_txt_present({ url: "https://x.com/llms.txt", reachable: true, httpStatus: 200, bodyLength: 3 });
  check("llms_txt_present: partial when trivially short", partial.status === "partial", partial);

  const fail = sig_llms_txt_present({ url: "https://x.com/llms.txt", reachable: true, httpStatus: 404, bodyLength: 0, errorNote: "http_404" });
  check("llms_txt_present: fail when missing", fail.status === "fail", fail);
}

// ---------------------------------------------------------------------------
// 8. No-persist guardrail: rawHtml (or any full HTML document) must never
//    reach evidence_json.
// ---------------------------------------------------------------------------

{
  const bigHtml = `<html><body><div id="root"></div>${"x".repeat(500)}</body></html>`;
  const pages = [productPage("https://x.com/p/1", { rawHtml: bigHtml, variants: [{ sku: "W-1", price: 9.99, currency: "USD", available: true, name: "Widget" }] })];
  const feedVariant: FeedVariant = { sku: "W-1", productTitle: "Widget", price: 9.99, currency: "USD", available: true, link: "https://x.com/p/1" };

  const rowsToCheck = [
    sig_content_server_rendered(pages, [feedVariant]),
    sig_schema_in_raw_html(pages),
    sig_product_schema_present(pages),
    sig_offer_schema_complete(pages),
  ];

  for (const row of rowsToCheck) {
    const serialized = JSON.stringify(row.evidence_json);
    check(`no-persist guardrail: ${row.signal_key}'s evidence_json contains no raw HTML`, !serialized.includes("<html") && !serialized.includes("<div"), serialized);
  }
}

// ---------------------------------------------------------------------------
// 9. runReadabilityChecks: end-to-end orchestrator
// ---------------------------------------------------------------------------

{
  const fetcher = mockFetcher((url) => {
    if (url === "https://shop.example.com/robots.txt") return htmlRes("User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml\n");
    if (url === "https://shop.example.com/sitemap.xml") return htmlRes(`<urlset><url><loc>https://shop.example.com/products/widget</loc></url></urlset>`);
    if (url === "https://shop.example.com/llms.txt") return htmlRes("# Widget Shop\n\nWe sell widgets. ".repeat(3));
    if (url === "https://shop.example.com") return htmlRes(`<script type="application/ld+json">{"@type":"Organization","name":"Widget Shop","url":"https://shop.example.com"}</script>`);
    if (url === "https://shop.example.com/products/widget") {
      return htmlRes(
        `<html><body><h1>Widget</h1><p>${"filler ".repeat(60)}</p><script type="application/ld+json">${JSON.stringify({
          "@type": "Product",
          mpn: "W-1",
          offers: { price: 19.99, priceCurrency: "USD", availability: "https://schema.org/InStock" },
        })}</script></body></html>`,
      );
    }
    return null;
  });

  const { signals, robots, parsedRobots, homepage } = await runReadabilityChecks({ rootUrl: "https://shop.example.com", fetcher, feedVariants: [], pageStates: [] });
  check("runReadabilityChecks: returns exactly 10 signals", signals.length === 10, signals.map((s) => s.signal_key));
  check("runReadabilityChecks: every signal is pillar agent_readability", signals.every((s) => s.pillar === "agent_readability"), signals);
  check(
    "runReadabilityChecks: all 10 expected signal_keys present",
    [
      "robots_txt_valid",
      "ai_crawler_access_retrieval",
      "ai_crawler_access_training",
      "content_server_rendered",
      "schema_in_raw_html",
      "product_schema_present",
      "offer_schema_complete",
      "organization_schema_present",
      "sitemap_present",
      "llms_txt_present",
    ].every((k) => signals.some((s) => s.signal_key === k)),
    signals.map((s) => s.signal_key),
  );
  const contentSignal = signals.find((s) => s.signal_key === "content_server_rendered")!;
  check("runReadabilityChecks: no-feed fallback sampling found the sitemap-discovered product page", contentSignal.status !== "not_applicable", contentSignal);
  check("runReadabilityChecks: exposes the already-fetched robots state (for robotsPatchArtifact.ts to reuse)", robots.reachable === true && typeof robots.raw === "string", robots);
  check("runReadabilityChecks: exposes the already-parsed robots groups", Array.isArray(parsedRobots.groups), parsedRobots);
  check("runReadabilityChecks: exposes the already-fetched homepage state (for jsonldArtifact.ts to reuse)", homepage.reachable === true, homepage);
}

console.log(failures === 0 ? "\nAll readability tests passed." : `\n${failures} readability test(s) failed.`);
if (failures > 0) process.exit(1);
