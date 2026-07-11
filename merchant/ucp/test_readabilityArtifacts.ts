/**
 * Tests for the agent_readability pillar's fix artifacts (Build 2):
 * robots_patch, llms_txt, jsonld, plus the three flag-only signals folded
 * into contentRewriteArtifact.ts. Mock-driven, no network.
 *
 * 1. robots_patch: missing robots.txt -> full minimal file; existing file
 *    blocking OAI-SearchBot -> patch names the exact line to remove, unrelated
 *    rules untouched (the removal set never references them).
 * 2. robots_patch NEVER emits an unblock for GPTBot/ClaudeBot, opted out or not.
 * 3. llms_txt: generated from real policy/feed/manifest URLs; a placeholder
 *    (never an invented description) when none is extractable; the contested-
 *    basis note is sourced from signalEvidence, not hardcoded.
 * 4. jsonld/organization: complete block from real data, resolves the signal.
 * 5. jsonld/product: template + one real worked example, resolves NOTHING.
 * 6. HAZARD: feed/page disagreement blocks product/offer JSON-LD generation
 *    entirely — flagged, no Offer block anywhere in content.
 * 7. content_server_rendered / schema_in_raw_html / sitemap_present: flag-only
 *    via contentRewriteArtifact.ts, sitemap guidance keyed off platform.
 * 8. Purity/determinism for the three new generators; existing five
 *    generators' golden fixtures / full suite unaffected (run separately).
 *
 * Run: node --experimental-strip-types test_readabilityArtifacts.ts
 */

import type { SignalRow } from "./manifestChecks.ts";
import type { ManifestState } from "./manifestChecks.ts";
import type { FeedState } from "./feedChecks.ts";
import type { ArtifactContext } from "./artifacts/index.ts";
import { generateRobotsPatchArtifact } from "./artifacts/robotsPatchArtifact.ts";
import { generateLlmsTxtArtifact } from "./artifacts/llmsTxtArtifact.ts";
import { generateJsonldArtifact } from "./artifacts/jsonldArtifact.ts";
import { generateContentRewriteArtifact } from "./artifacts/contentRewriteArtifact.ts";
import { parseRobotsTxt, type RobotsTxtState } from "./readabilityChecks.ts";
import type { HomepageState } from "./policyChecks.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

function sig(signal_key: string, status: SignalRow["status"], evidence_json: Record<string, unknown> = {}): SignalRow {
  return { pillar: "agent_readability", category: "x", signal_key, status, weight: 1, score_contribution: 0, impact: 1, effort: 1, evidence_json, fix_summary: null };
}

const EMPTY_MANIFEST: ManifestState = {
  url: "https://shop.example.com/.well-known/ucp",
  reachable: false,
  httpStatus: null,
  contentType: null,
  requiresAuth: false,
  redirectChain: [],
  isValidJson: false,
  parsed: null,
};

const BASE_CTX: ArtifactContext = {
  manifest: EMPTY_MANIFEST,
  feed: null,
  signals: [],
  rootUrl: "https://shop.example.com",
};

// ---------------------------------------------------------------------------
// 1 + 2. robots_patch
// ---------------------------------------------------------------------------

{
  // Missing robots.txt -> full minimal file, resolves robots_txt_valid.
  const robots: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 404, raw: null, errorNote: "http_404" };
  const parsedRobots = parseRobotsTxt("");
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    robots,
    parsedRobots,
    signals: [sig("robots_txt_valid", "fail"), sig("ai_crawler_access_retrieval", "pass"), sig("ai_crawler_access_training", "pass")],
  };
  const draft = generateRobotsPatchArtifact(ctx);
  check("robots_patch: missing file -> draft generated", draft !== null, draft);
  check("robots_patch: missing file -> full minimal file (User-agent: * / Allow: /)", !!draft && draft.content.includes("User-agent: *") && draft.content.includes("Allow: /"), draft?.content);
  check("robots_patch: missing file -> resolves robots_txt_valid", !!draft?.resolves_signal_keys.includes("robots_txt_valid"), draft);
  check("robots_patch: target_url is /robots.txt", draft?.target_url === "/robots.txt", draft);
}

{
  // Existing file, bot-specific block on OAI-SearchBot, unrelated rules present.
  const rawRobots = ["User-agent: *", "Disallow: /admin", "", "User-agent: OAI-SearchBot", "Disallow: /", "", "Sitemap: https://shop.example.com/sitemap.xml"].join("\n");
  const robots: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 200, raw: rawRobots };
  const parsedRobots = parseRobotsTxt(rawRobots);
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    robots,
    parsedRobots,
    signals: [
      sig("robots_txt_valid", "pass"),
      sig("ai_crawler_access_retrieval", "partial", { checked: [{ bot: "OAI-SearchBot", blocked: true }], blocked_count: 1, total: 3 }),
      sig("ai_crawler_access_training", "pass", { ai_training_opt_out: false, blocked_count: 0 }),
    ],
  };
  const draft = generateRobotsPatchArtifact(ctx);
  check("robots_patch: existing file -> draft generated", draft !== null, draft);
  check("robots_patch: names the exact line to remove (line 5, the OAI-SearchBot Disallow)", !!draft && /line 5/.test(draft.content) && draft.content.includes("Disallow: /"), draft?.content);
  check("robots_patch: unrelated rule (line 2, /admin) is NEVER referenced in the removal set", !!draft && !/line 2/.test(draft.content) && !draft.content.includes("/admin"), draft?.content);
  check("robots_patch: resolves ai_crawler_access_retrieval, not robots_txt_valid (it was already passing)", !!draft && draft.resolves_signal_keys.includes("ai_crawler_access_retrieval") && !draft.resolves_signal_keys.includes("robots_txt_valid"), draft);
  check("robots_patch: content is inert robots.txt syntax (every non-blank line is a comment)", !!draft && draft.content.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#")), draft?.content);
}

{
  // Wildcard block: never propose removing the wildcard rule (affects every crawler).
  const rawRobots = ["User-agent: *", "Disallow: /"].join("\n");
  const robots: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 200, raw: rawRobots };
  const parsedRobots = parseRobotsTxt(rawRobots);
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    robots,
    parsedRobots,
    signals: [
      sig("robots_txt_valid", "pass"),
      sig("ai_crawler_access_retrieval", "fail", { checked: [], blocked_count: 3, total: 3 }),
      sig("ai_crawler_access_training", "fail", { ai_training_opt_out: false, blocked_count: 2 }),
    ],
  };
  const draft = generateRobotsPatchArtifact(ctx);
  check("robots_patch: wildcard block -> does NOT propose removing the wildcard Disallow line", !!draft && !/line 1|line 2/.test(draft.content), draft?.content);
  check("robots_patch: wildcard block -> proposes an override group per retrieval bot instead", !!draft && draft.content.includes("User-agent: OAI-SearchBot") && draft.content.includes("User-agent: Claude-SearchBot") && draft.content.includes("User-agent: PerplexityBot"), draft?.content);
}

{
  // NEVER unblock training bots — not opted out, blocked -> flagged only, no directive added.
  const rawRobots = ["User-agent: GPTBot", "Disallow: /", "", "User-agent: ClaudeBot", "Disallow: /"].join("\n");
  const robots: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 200, raw: rawRobots };
  const parsedRobots = parseRobotsTxt(rawRobots);
  const ctxNotOptedOut: ArtifactContext = {
    ...BASE_CTX,
    robots,
    parsedRobots,
    signals: [sig("robots_txt_valid", "pass"), sig("ai_crawler_access_retrieval", "pass"), sig("ai_crawler_access_training", "fail", { ai_training_opt_out: false, blocked_count: 2 })],
  };
  const draftNotOptedOut = generateRobotsPatchArtifact(ctxNotOptedOut);
  check("robots_patch: training blocked, NOT opted out -> draft still generated (flag-only)", draftNotOptedOut !== null, draftNotOptedOut);
  check("robots_patch: training blocked -> NEVER adds a GPTBot/ClaudeBot Allow directive", !!draftNotOptedOut && !draftNotOptedOut.content.includes("User-agent: GPTBot") && !draftNotOptedOut.content.includes("User-agent: ClaudeBot"), draftNotOptedOut?.content);
  check("robots_patch: training blocked -> resolves_signal_keys never includes ai_crawler_access_training", !!draftNotOptedOut && !draftNotOptedOut.resolves_signal_keys.includes("ai_crawler_access_training"), draftNotOptedOut);
  check("robots_patch: training blocked -> flags it, presents both sides (mentions citation eligibility is separate)", !!draftNotOptedOut && draftNotOptedOut.changelog.flagged.some((f) => /citation/i.test(f)), draftNotOptedOut?.changelog);
  check("robots_patch: flag never appears in changelog.added", !!draftNotOptedOut && !draftNotOptedOut.changelog.added.some((a) => /GPTBot|ClaudeBot/.test(a)), draftNotOptedOut?.changelog);

  // Opted out: same blocked state, but ai_crawler_access_training is not_applicable
  // and something ELSE needs fixing too, so the artifact still gets generated —
  // the opt-out note appears, and training directives are still untouched.
  const ctxOptedOut: ArtifactContext = {
    ...BASE_CTX,
    robots,
    parsedRobots,
    signals: [
      sig("robots_txt_valid", "pass"),
      sig("ai_crawler_access_retrieval", "fail", { checked: [], blocked_count: 0, total: 3 }), // pass, actually — force via robots_txt_valid partial instead
      sig("ai_crawler_access_training", "not_applicable", { ai_training_opt_out: true, blocked_count: 2 }),
    ],
  };
  // Force "anything to fix" via a malformed-but-present robots.txt state instead.
  ctxOptedOut.signals[1] = sig("ai_crawler_access_retrieval", "partial", { checked: [{ bot: "PerplexityBot", blocked: true }], blocked_count: 1, total: 3 });
  const draftOptedOut = generateRobotsPatchArtifact(ctxOptedOut);
  check("robots_patch: training opted out -> draft mentions the attested opt-out", !!draftOptedOut && draftOptedOut.changelog.flagged.some((f) => /ai_training_opt_out|attested/i.test(f)), draftOptedOut?.changelog);
  check("robots_patch: training opted out -> still never touches GPTBot/ClaudeBot directives", !!draftOptedOut && !draftOptedOut.content.includes("User-agent: GPTBot") && !draftOptedOut.content.includes("User-agent: ClaudeBot"), draftOptedOut?.content);
}

// ---------------------------------------------------------------------------
// 3. llms_txt
// ---------------------------------------------------------------------------

{
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [], rawHtml: `<html><head><title>Widget Shop</title></head><body></body></html>` };
  const feed: FeedState = { url: "https://shop.example.com/products.json", reachable: true, httpStatus: 200, contentType: "application/json", format: "shopify_json", items: [] };
  const manifest: ManifestState = { ...EMPTY_MANIFEST, reachable: true, httpStatus: 200, parsed: { ucp: { version: "2026-04-08" } } };
  const evidence = new Map([["llms_txt_present", { signal_key: "llms_txt_present", basis: "contested", merchant_note: "TEST-DISTINCTIVE-MERCHANT-NOTE-12345" }]]);

  const ctx: ArtifactContext = {
    ...BASE_CTX,
    feed,
    manifest,
    homepage,
    signalEvidence: evidence,
    signals: [
      sig("llms_txt_present", "fail"),
      sig("return_policy_present_consistent", "pass", { found_url: "https://shop.example.com/pages/returns" }),
      sig("shipping_info_present_consistent", "pass", { found_url: "https://shop.example.com/pages/shipping" }),
    ],
  };
  const draft = generateLlmsTxtArtifact(ctx);
  check("llms_txt: draft generated", draft !== null, draft);
  check("llms_txt: H1 uses the real extracted site name", !!draft && draft.content.startsWith("# Widget Shop"), draft?.content);
  check("llms_txt: real return-policy URL included", !!draft && draft.content.includes("https://shop.example.com/pages/returns"), draft?.content);
  check("llms_txt: real shipping-info URL included", !!draft && draft.content.includes("https://shop.example.com/pages/shipping"), draft?.content);
  check("llms_txt: real feed URL included", !!draft && draft.content.includes("https://shop.example.com/products.json"), draft?.content);
  check("llms_txt: real manifest URL included (manifest resolves)", !!draft && draft.content.includes("/.well-known/ucp"), draft?.content);
  check("llms_txt: no invented description -> uses the obvious placeholder", !!draft && draft.content.includes("[REPLACE WITH A ONE-LINE DESCRIPTION"), draft?.content);
  check("llms_txt: placeholder is flagged in must_complete", !!draft && draft.changelog.must_complete.some((m) => /placeholder/i.test(m)), draft?.changelog);
  check("llms_txt: resolves llms_txt_present", !!draft?.resolves_signal_keys.includes("llms_txt_present"), draft);
  check(
    "llms_txt: the contested-basis note is the exact signalEvidence text, not a hardcoded string",
    !!draft && draft.changelog.flagged.includes("TEST-DISTINCTIVE-MERCHANT-NOTE-12345"),
    draft?.changelog,
  );
}

{
  // og:description present -> used verbatim, no placeholder.
  const homepage: HomepageState = {
    reachable: true,
    httpStatus: 200,
    blocks: [],
    rawHtml: `<html><head><title>Widget Shop</title><meta property="og:description" content="We sell handmade widgets."></head></html>`,
  };
  const ctx: ArtifactContext = { ...BASE_CTX, homepage, signals: [sig("llms_txt_present", "fail")] };
  const draft = generateLlmsTxtArtifact(ctx);
  check("llms_txt: real og:description used, no placeholder", !!draft && draft.content.includes("We sell handmade widgets.") && !draft.content.includes("[REPLACE WITH"), draft?.content);
}

{
  // Already passing -> nothing to fix -> null.
  const ctx: ArtifactContext = { ...BASE_CTX, signals: [sig("llms_txt_present", "pass")] };
  check("llms_txt: pass -> no draft generated", generateLlmsTxtArtifact(ctx) === null);
}

// ---------------------------------------------------------------------------
// 4. jsonld / organization
// ---------------------------------------------------------------------------

{
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [], rawHtml: `<html><head><title>Widget Shop</title></head></html>` };
  const ctx: ArtifactContext = { ...BASE_CTX, homepage, signals: [sig("organization_schema_present", "fail")] };
  const draft = generateJsonldArtifact(ctx);
  check("jsonld/org: draft generated", draft !== null, draft);
  check("jsonld/org: complete block from real data (name + url)", !!draft && draft.content.includes('"name": "Widget Shop"') && draft.content.includes('"url": "https://shop.example.com"'), draft?.content);
  check("jsonld/org: resolves organization_schema_present", !!draft?.resolves_signal_keys.includes("organization_schema_present"), draft);
  check("jsonld/org: no placeholder needed when a real name was extracted", !!draft && !draft.changelog.must_complete.some((m) => /placeholder/i.test(m)), draft?.changelog);
}

{
  // No extractable name -> obvious placeholder, still resolves (same convention as manifestArtifact.ts's endpoint placeholder).
  const homepage: HomepageState = { reachable: true, httpStatus: 200, blocks: [], rawHtml: `<html><head></head><body>no title here</body></html>` };
  const ctx: ArtifactContext = { ...BASE_CTX, homepage, signals: [sig("organization_schema_present", "fail")] };
  const draft = generateJsonldArtifact(ctx);
  check("jsonld/org: no name extractable -> obvious placeholder used", !!draft && draft.content.includes("[REPLACE WITH YOUR STORE'S NAME]"), draft?.content);
  check("jsonld/org: placeholder flagged in must_complete", !!draft && draft.changelog.must_complete.some((m) => /placeholder|store's name/i.test(m)), draft?.changelog);
}

// ---------------------------------------------------------------------------
// 5 + 6. jsonld / product+offer, and the price-disagreement HAZARD
// ---------------------------------------------------------------------------

const REAL_FEED: FeedState = {
  url: "https://shop.example.com/products.json",
  reachable: true,
  httpStatus: 200,
  contentType: "application/json",
  format: "shopify_json",
  items: [{ id: "W-1", title: "Widget Pro", description: null, price: 19.99, currency: "USD", available: true, link: "https://shop.example.com/products/widget", raw: {} }],
};

{
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    feed: REAL_FEED,
    platform: "woocommerce",
    signals: [
      sig("product_schema_present", "fail"),
      sig("offer_schema_complete", "not_applicable"),
      sig("price_consistency_cross_surface", "pass"),
      sig("availability_consistency", "pass"),
      sig("product_id_consistency", "pass"),
    ],
  };
  const draft = generateJsonldArtifact(ctx);
  check("jsonld/product: draft generated", draft !== null, draft);
  check("jsonld/product: field mapping table present", !!draft && draft.content.includes("schema.org property") && draft.content.includes("offers.price"), draft?.content);
  check("jsonld/product: worked example uses REAL feed data (title, price)", !!draft && draft.content.includes("Widget Pro") && draft.content.includes("19.99"), draft?.content);
  check("jsonld/product: platform-keyed guidance present (woocommerce)", !!draft && /WooCommerce/.test(draft.content), draft?.content);
  check("jsonld/product: resolves NOTHING", !!draft && draft.resolves_signal_keys.length === 0, draft);
  check("jsonld/product: must_complete states per-product injection is required", !!draft && draft.changelog.must_complete.some((m) => /per product/i.test(m)), draft?.changelog);
}

{
  // HAZARD: feed/page disagree on price -> no product/offer JSON-LD at all.
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    feed: REAL_FEED,
    signals: [
      sig("product_schema_present", "fail"),
      sig("offer_schema_complete", "not_applicable"),
      sig("price_consistency_cross_surface", "fail"),
      sig("availability_consistency", "pass"),
      sig("product_id_consistency", "pass"),
    ],
  };
  const draft = generateJsonldArtifact(ctx);
  check("jsonld/hazard: draft still generated (carries the flag)", draft !== null, draft);
  check("jsonld/hazard: NO Offer block anywhere in content", !!draft && !draft.content.includes('"@type": "Offer"'), draft?.content);
  check("jsonld/hazard: NO Product block anywhere in content", !!draft && !draft.content.includes('"@type": "Product"'), draft?.content);
  check("jsonld/hazard: flag explains the reconcile-first reasoning", !!draft && draft.changelog.flagged.some((f) => /disagree/i.test(f)), draft?.changelog);
  check("jsonld/hazard: resolves nothing", !!draft && draft.resolves_signal_keys.length === 0, draft);
}

// ---------------------------------------------------------------------------
// 7. Flag-only signals via contentRewriteArtifact.ts
// ---------------------------------------------------------------------------

{
  const ctx: ArtifactContext = {
    ...BASE_CTX,
    platform: "shopify",
    signals: [sig("content_server_rendered", "fail"), sig("schema_in_raw_html", "fail"), sig("sitemap_present", "fail")],
  };
  const draft = await generateContentRewriteArtifact(ctx);
  check("content_rewrite: agent_readability flags surface (content_server_rendered)", !!draft && draft.changelog.flagged.some((f) => /JavaScript/i.test(f) && /SSR|SSG|prerender/i.test(f)), draft?.changelog);
  check("content_rewrite: agent_readability flags surface (schema_in_raw_html)", !!draft && draft.changelog.flagged.some((f) => /injects via client-side JavaScript/i.test(f)), draft?.changelog);
  check("content_rewrite: sitemap guidance matches platform (shopify)", !!draft && draft.changelog.flagged.some((f) => /Shopify auto-generates/i.test(f)), draft?.changelog);
  check("content_rewrite: never claims to fix content_server_rendered/schema_in_raw_html/sitemap_present", !!draft && draft.resolves_signal_keys.length === 0, draft);
}

{
  for (const [platform, expectedSubstring] of [
    ["wix", "Let search engines index your site"],
    ["woocommerce", "wp-sitemap.xml"],
    ["custom", "partial crawl"],
    [undefined, "partial crawl"],
  ] as const) {
    const ctx: ArtifactContext = { ...BASE_CTX, platform, signals: [sig("sitemap_present", "fail")] };
    const draft = await generateContentRewriteArtifact(ctx);
    check(`content_rewrite: sitemap guidance for platform=${platform ?? "(none)"} mentions "${expectedSubstring}"`, !!draft && draft.changelog.flagged.some((f) => f.includes(expectedSubstring)), draft?.changelog);
  }
}

// ---------------------------------------------------------------------------
// 8. Purity / determinism (new generators)
// ---------------------------------------------------------------------------

{
  const rawRobots = "User-agent: OAI-SearchBot\nDisallow: /\n";
  const robots: RobotsTxtState = { url: "https://shop.example.com/robots.txt", reachable: true, httpStatus: 200, raw: rawRobots };
  const parsedRobots = parseRobotsTxt(rawRobots);
  const ctx: ArtifactContext = { ...BASE_CTX, robots, parsedRobots, signals: [sig("ai_crawler_access_retrieval", "partial", { blocked_count: 1, total: 3 })] };
  const a = generateRobotsPatchArtifact(ctx);
  const b = generateRobotsPatchArtifact(ctx);
  check("robots_patch: deterministic (identical output on repeated calls)", JSON.stringify(a) === JSON.stringify(b));

  const before = JSON.stringify(ctx);
  generateRobotsPatchArtifact(ctx);
  check("robots_patch: does not mutate ctx", JSON.stringify(ctx) === before);
}

console.log(failures === 0 ? "\nAll readability-artifact tests passed." : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
