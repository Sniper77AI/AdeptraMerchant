/**
 * Adeptra Merchant — JSON-LD Artifact Generator (artifact_type = 'jsonld').
 *
 * PURE module: reads ctx.homepage.rawHtml, ctx.feed, ctx.platform, ctx.signals.
 * No network, no DB, no LLM.
 *
 * TWO SUB-CASES, DELIBERATELY DIFFERENT HONESTY PROPERTIES:
 *
 *  organization_schema_present -> a COMPLETE, SITEWIDE fix. One Organization
 *    block, one place (the homepage). Generated from real known data only:
 *    url is the real domain; name comes from the homepage's own
 *    <title>/og:site_name if present (extractSiteName, shared with
 *    llmsTxtArtifact.ts) — NEVER guessed. Missing name becomes an obvious
 *    placeholder in must_complete, same convention manifestArtifact.ts uses
 *    for its endpoint placeholder — still counts as resolved once deployed,
 *    same honesty compromise that precedent already accepts, declared
 *    explicitly rather than hidden.
 *
 *  product_schema_present / offer_schema_complete -> NOT a complete fix.
 *    Adeptra samples a handful of product pages; a real catalog has many
 *    more. The honest artifact is a template + ONE worked example built
 *    from real feed data, plus platform-keyed injection guidance.
 *    resolves_signal_keys NEVER includes these two — a template is not a
 *    resolution, and claiming one would be exactly the "looks compliant,
 *    isn't" failure this whole codebase's artifact generators exist to avoid.
 *
 * HARD RULE — reconcile, don't guess (same discipline as feedArtifact.ts):
 * if the feed and the live pages disagree (price_consistency_cross_surface /
 * availability_consistency / product_id_consistency is fail/partial), NO
 * product/offer JSON-LD is generated at all — publishing feed-sourced markup
 * would publish a claim the merchant's own pages contradict. Flagged instead.
 *
 * Platform-specific injection guidance (Shopify/WooCommerce claims) is
 * independently verified against primary sources, not assumed — see the
 * inline citations below. Do not add unverified platform claims here.
 */

import type { SignalRow } from "../manifestChecks.ts";
import type { FeedItem } from "../feedChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";
import { extractSiteName } from "./llmsTxtArtifact.ts";

const TARGET_URL = "structured-data/jsonld-fixes.md";

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

function needsFix(s: SignalRow | undefined): boolean {
  return s?.status === "fail" || s?.status === "partial";
}

// ---------------------------------------------------------------------------
// Platform-specific injection guidance — verified against primary sources:
//  - Shopify's `| structured_data` Liquid filter (official, converts
//    product/article objects to schema.org markup, Product/ProductGroup as
//    of a 2024 update): shopify.dev/docs/api/liquid/filters/structured_data.
//    Dawn's main-product.liquid uses it, so most Shopify 2.0-era themes
//    already ship Product JSON-LD by default.
//  - WooCommerce core emits basic Product/Offer JSON-LD by default via its
//    WC_Structured_Data class, no plugin required:
//    github.com/woocommerce/woocommerce/wiki/Structured-data-for-products.
//    Rank Math's free tier extends WooCommerce Product schema
//    (rankmath.com/kb/woocommerce-product-schema); Yoast SEO free/Premium
//    does NOT cover WooCommerce products — that needs the separate paid
//    "Yoast WooCommerce SEO" add-on (yoast.com/features/structured-data).
//    Don't lump Yoast and Rank Math together on this specific point.
//  - Wix: no specific built-in Product-schema injection mechanism verified —
//    guidance stays generic/hedged rather than naming something unconfirmed.
// ---------------------------------------------------------------------------

function productSchemaInjectionGuidance(platform: string | undefined): string {
  switch (platform) {
    case "shopify":
      return 'Most Shopify 2.0-era themes (including Dawn) already inject Product schema automatically via Shopify\'s own `| structured_data` Liquid filter — check your theme\'s product template first, you may already have this. If not, add `{{ product | structured_data }}` to your product template.';
    case "woocommerce":
      return 'WooCommerce core already emits basic Product/Offer JSON-LD by default (via its WC_Structured_Data class) — check your product pages\' raw HTML first, you may already have this covered. For more control, Rank Math\'s free tier extends WooCommerce Product schema; Yoast SEO does NOT cover WooCommerce products without its separate paid "Yoast WooCommerce SEO" add-on.';
    case "wix":
      return "Check your Wix site's SEO settings and any installed apps for structured-data support — Adeptra hasn't verified a specific built-in mechanism for injecting custom Product schema on Wix; coverage varies by plan and app.";
    default:
      return 'Inject this JSON-LD into each product page (e.g. a `<script type="application/ld+json">` tag in the page\'s `<head>` or body), generated from YOUR real per-product data using the field mapping above.';
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateJsonldArtifact(ctx: ArtifactContext): ArtifactDraft | null {
  const { signals, feed, homepage, platform, rootUrl } = ctx;
  const sig = byKey(signals);
  const changelog: ArtifactChangelog = { added: [], corrected: [], must_complete: [], flagged: [] };
  const resolvedKeys: string[] = [];
  const sections: string[] = [];

  // --- organization_schema_present: complete, sitewide fix ------------------
  const org = sig.get("organization_schema_present");
  if (needsFix(org) && rootUrl) {
    const extractedName = extractSiteName(homepage?.rawHtml ?? null);
    const finalName = extractedName ?? "[REPLACE WITH YOUR STORE'S NAME]";
    if (!extractedName) {
      changelog.must_complete.push("Replace the placeholder store name in the Organization markup below with your real business name.");
    }
    const orgJsonld = { "@context": "https://schema.org", "@type": "Organization", name: finalName, url: rootUrl };
    sections.push(
      `## Organization (sitewide)\n\nAdd this once, site-wide (e.g. your homepage's \`<head>\` or footer):\n\n\`\`\`json\n${JSON.stringify(orgJsonld, null, 2)}\n\`\`\`\n`,
    );
    changelog.added.push("A schema.org Organization block from your real domain (and site name, where extractable) — this resolves organization_schema_present once deployed.");
    resolvedKeys.push("organization_schema_present");
  }

  // --- product_schema_present / offer_schema_complete: template only --------
  const productSchema = sig.get("product_schema_present");
  const offerSchema = sig.get("offer_schema_complete");
  if (needsFix(productSchema) || needsFix(offerSchema)) {
    const priceConsistency = sig.get("price_consistency_cross_surface");
    const availabilityConsistency = sig.get("availability_consistency");
    const productIdConsistency = sig.get("product_id_consistency");
    const hazard = needsFix(priceConsistency) || needsFix(availabilityConsistency) || needsFix(productIdConsistency);

    if (hazard) {
      changelog.flagged.push(
        "Your feed and product pages disagree on price, availability, or product IDs (see product_id_consistency / price_consistency_cross_surface / availability_consistency) — Adeptra will NOT generate Product/Offer structured data while that's true. Publishing markup sourced from the feed would contradict your own pages. Reconcile them first, then re-run this analysis.",
      );
    } else {
      const example: FeedItem | undefined = feed?.items.find((it) => it.price != null && !!it.title);
      const fieldMapping = [
        "| schema.org property | Source |",
        "|---|---|",
        "| name | feed product title |",
        "| sku / mpn | feed product id |",
        "| offers.price | feed price |",
        "| offers.priceCurrency | feed currency (if your feed provides one) |",
        "| offers.availability | feed stock status |",
      ].join("\n");

      let workedExample = "";
      if (example) {
        const productJsonld: Record<string, unknown> = {
          "@context": "https://schema.org",
          "@type": "Product",
          name: example.title,
          sku: example.id,
        };
        const offers: Record<string, unknown> = {
          "@type": "Offer",
          price: example.price,
          availability: example.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        };
        if (example.currency) offers.priceCurrency = example.currency;
        else changelog.flagged.push('The worked example has no priceCurrency — your feed doesn\'t provide one. Add your store\'s real currency code (e.g. "USD") when you inject this.');
        productJsonld.offers = offers;
        workedExample = `\n\n### Worked example (real data — "${example.title}")\n\n\`\`\`json\n${JSON.stringify(productJsonld, null, 2)}\n\`\`\`\n`;
      } else {
        changelog.flagged.push("No product in your feed has complete enough data (title + price) to build a worked example — the field mapping template below still applies.");
      }

      const platformGuidance = productSchemaInjectionGuidance(platform);
      sections.push(
        `## Product / Offer structured data — template + worked example\n\n**This does NOT resolve product_schema_present or offer_schema_complete on its own.** Adeptra samples a handful of product pages; your catalog likely has many more. The markup below is a template and ONE real worked example — you (or your developer) must generate and inject this per product.\n\n### Field mapping\n\n${fieldMapping}${workedExample}\n\n### Injection guidance for ${platform ?? "your platform"}\n\n${platformGuidance}\n`,
      );
      changelog.must_complete.push(
        "Product/Offer structured data must be generated and injected PER PRODUCT — this template is not auto-applied anywhere and resolves nothing on its own.",
      );
      // resolvedKeys intentionally never gets product_schema_present/offer_schema_complete.
    }
  }

  if (sections.length === 0 && changelog.flagged.length === 0 && changelog.added.length === 0) return null;

  const content =
    sections.length > 0
      ? `# Structured data (JSON-LD) fixes\n\n${sections.join("\n\n")}`
      : "# Structured data (JSON-LD) fixes\n\nNo structured data was generated for this run — see the flagged items below for what needs manual attention.";

  return {
    artifact_type: "jsonld",
    target_url: TARGET_URL,
    content,
    resolves_signal_keys: resolvedKeys,
    changelog,
  };
}
