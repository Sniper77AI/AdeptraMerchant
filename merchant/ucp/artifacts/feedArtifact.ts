/**
 * Adeptra Merchant — Feed Fix Artifact Generator (artifact_type = 'feed_fix').
 *
 * PURE module: no network, no DB, no secrets. Takes an ArtifactContext
 * (manifest + feed + signals — see ./types.ts) and returns a draft artifact
 * (or null if there's nothing worth emitting). Only reads ctx.feed/ctx.signals;
 * ctx.manifest is unused here.
 *
 * v1 SCOPE: exactly ONE fix — a Google Merchant supplemental feed adding
 * native_commerce=true for products currently missing it. This generator
 * NEVER authors product data (titles/prices/availability) — it references
 * products only by id. Every other Category-2 signal is flag-only in this
 * file; a true feed regeneration is out of scope (see signal-specs.md:
 * product_id/price/availability consistency need a merchant decision on
 * which surface is the source of truth, not an auto-fix).
 *
 * MERCHANT-INTENT GUARDRAIL (the identity_linking lesson from
 * manifestArtifact.ts): marking a product native_commerce=true opts it into
 * agent checkout — a merchant decision, not a pure structural gap. The
 * generated feed opts in every product currently missing the attribute;
 * changelog.must_complete always tells the merchant to review and prune
 * before uploading. Never presented as silently done.
 *
 * target_url convention: no leading slash ("supplemental-feed/native-commerce.xml")
 * signals this is an UPLOAD artifact, not a served route — contrast with
 * manifestArtifact.ts's "/.well-known/ucp", which IS served at that path.
 */

import type { SignalRow } from "../manifestChecks.ts";
import { truthy } from "../feedChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";

const TARGET_URL = "supplemental-feed/native-commerce.xml";

/** fail/partial on these means "reconcile manually" — the correct value is a
 *  merchant/source-of-truth decision, not something this generator can guess. */
const CONSISTENCY_FLAG_MESSAGES: Record<string, string> = {
  product_id_consistency:
    "Feed/page product ID mismatch — reconcile manually; the correct value is a merchant decision, not auto-resolvable. (A reconciliation report is a planned separate artifact.)",
  price_consistency_cross_surface:
    "Feed/page price mismatch — reconcile manually; the correct value is a merchant decision, not auto-resolvable. (A reconciliation report is a planned separate artifact.)",
  availability_consistency:
    "Feed/page availability mismatch — reconcile manually; the correct value is a merchant decision, not auto-resolvable. (A reconciliation report is a planned separate artifact.)",
};

/** Out of scope for feed_fix entirely — a future content_rewrite artifact's job. */
const CONTENT_FLAG_MESSAGES: Record<string, string> = {
  title_description_consistency: "Title/description inconsistency flagged — out of scope for feed_fix; a future content_rewrite artifact will address this.",
  discovery_attributes_enrichment: "Sparse attribute coverage flagged — out of scope for feed_fix; a future content_rewrite artifact will address this.",
};

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

function needsFix(s: SignalRow | undefined): boolean {
  return s?.status === "fail" || s?.status === "partial";
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildSupplementalFeedXml(productIds: string[]): string {
  const items = productIds
    .map((id) => `  <item>\n    <g:id>${escapeXml(id)}</g:id>\n    <g:native_commerce>true</g:native_commerce>\n  </item>`)
    .join("\n");
  return `<?xml version="1.0"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n${items}\n</channel>\n</rss>\n`;
}

export function generateFeedArtifact(ctx: ArtifactContext): ArtifactDraft | null {
  const sig = byKey(ctx.signals);
  const nativeCommerce = sig.get("native_commerce_attribute");
  const changelog: ArtifactChangelog = { added: [], corrected: [], must_complete: [], flagged: [] };
  const resolvedKeys: string[] = [];
  let content: string | null = null;

  if (needsFix(nativeCommerce)) {
    if (ctx.feed && ctx.feed.items.length > 0) {
      const missing = ctx.feed.items.filter((it) => !truthy(it.raw?.native_commerce));
      if (missing.length > 0) {
        content = buildSupplementalFeedXml(missing.map((it) => it.id));
        changelog.added.push(`supplemental feed marking ${missing.length} products checkout-eligible (native_commerce=true)`);
        changelog.must_complete.push(
          "REVIEW before uploading: remove any products that should NOT be agent-checkout-eligible. This template opts in ALL products currently missing the attribute.",
        );
        if (ctx.feed.format === "shopify_json") {
          changelog.added.push(
            "Shopify stores add this via Merchant Center → Products → Feeds → add a supplemental feed (native_commerce isn't a Shopify products.json field).",
          );
        }
        resolvedKeys.push("native_commerce_attribute");
      } else {
        // Defensive: shouldn't occur via the real signal function (fail/partial
        // implies at least one missing product), but never fabricate content.
        changelog.flagged.push("native_commerce_attribute is failing/partial but no missing products were found in the feed — verify feed data.");
      }
    } else {
      changelog.flagged.push("No usable product feed; a feed can't be generated from missing data — provide a valid feed URL at onboarding.");
    }
  }

  // --- Other Category 2 signals: flag-only, never acted on -------------------
  for (const [key, message] of Object.entries(CONSISTENCY_FLAG_MESSAGES)) {
    if (needsFix(sig.get(key))) changelog.flagged.push(message);
  }
  for (const [key, message] of Object.entries(CONTENT_FLAG_MESSAGES)) {
    if (needsFix(sig.get(key))) changelog.flagged.push(message);
  }

  const nothingToEmit = content === null && changelog.flagged.length === 0;
  if (nothingToEmit) return null;

  return {
    artifact_type: "feed_fix",
    target_url: TARGET_URL,
    content: content ?? "",
    resolves_signal_keys: resolvedKeys,
    changelog,
  };
}
