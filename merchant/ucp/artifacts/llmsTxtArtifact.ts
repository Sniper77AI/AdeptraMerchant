/**
 * Adeptra Merchant — llms.txt Artifact Generator (artifact_type = 'llms_txt').
 *
 * PURE module: reads ctx.rootUrl, ctx.feed, ctx.manifest, ctx.homepage.rawHtml,
 * ctx.signals (for policy page found_urls, same pattern contentRewriteArtifact.ts
 * already uses), and ctx.signalEvidence. No network, no DB, no LLM.
 *
 * NEVER INVENTS a store description, tagline, or product claims — same rule
 * as content_rewrite. The H1 is always the real domain (or a real extracted
 * site name — never guessed); the blockquote summary comes from the
 * homepage's own <meta property="og:description"> / <meta name="description">
 * if present, or an obvious placeholder listed in must_complete if not.
 * Every link section is built ONLY from URLs this codebase actually knows
 * are real: policy pages policyChecks.ts already found, the configured feed
 * URL, the resolved UCP manifest URL, the homepage itself.
 *
 * MANDATORY HONESTY BLOCK: llms_txt_present's basis is 'contested' —
 * generating this file is agent-readiness infrastructure, not a visibility
 * lever (Google doesn't use it; independent studies found no citation
 * effect). That framing is signal_evidence.merchant_note's job, not this
 * file's — pulled from ctx.signalEvidence at generation time so a future
 * evidence correction updates this artifact's changelog too, automatically.
 */

import type { SignalRow } from "../manifestChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";

const TARGET_URL = "/llms.txt";
const DESCRIPTION_PLACEHOLDER = "[REPLACE WITH A ONE-LINE DESCRIPTION OF WHAT THIS STORE SELLS]";

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

function needsFix(s: SignalRow | undefined): boolean {
  return s?.status === "fail" || s?.status === "partial";
}

// ---------------------------------------------------------------------------
// <title>/og:site_name/og:description extraction (pure, regex-based — same
// zero-HTML-parser-dependency style as the rest of this pipeline). Attribute
// order inside a <meta> tag isn't assumed: the tag is matched first, then
// content= is extracted from within just that tag's text.
// ---------------------------------------------------------------------------

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, tagMatcher: RegExp): string | null {
  const tag = html.match(tagMatcher)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeBasicEntities(content) : null;
}

const OG_SITE_NAME_TAG_RE = /<meta[^>]*property=["']og:site_name["'][^>]*>/i;
const OG_DESCRIPTION_TAG_RE = /<meta[^>]*property=["']og:description["'][^>]*>/i;
const META_DESCRIPTION_TAG_RE = /<meta[^>]*name=["']description["'][^>]*>/i;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** og:site_name, falling back to <title> — never guessed beyond what the
 *  page itself declares. null (not a placeholder) when neither is present;
 *  callers fall back to the real domain, which is never a guess. */
export function extractSiteName(html: string | null): string | null {
  if (!html) return null;
  const ogName = extractMetaContent(html, OG_SITE_NAME_TAG_RE);
  if (ogName) return ogName;
  const titleMatch = html.match(TITLE_TAG_RE)?.[1];
  return titleMatch ? decodeBasicEntities(titleMatch) : null;
}

/** og:description, falling back to the standard meta description. */
export function extractSiteDescription(html: string | null): string | null {
  if (!html) return null;
  return extractMetaContent(html, OG_DESCRIPTION_TAG_RE) ?? extractMetaContent(html, META_DESCRIPTION_TAG_RE);
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateLlmsTxtArtifact(ctx: ArtifactContext): ArtifactDraft | null {
  const { signals, feed, manifest, homepage, signalEvidence, rootUrl } = ctx;
  const sig = byKey(signals);
  const llmsTxtSignal = sig.get("llms_txt_present");
  if (!needsFix(llmsTxtSignal)) return null;
  if (!rootUrl) return null; // defensive — pipeline.ts always sets this

  const changelog: ArtifactChangelog = { added: [], corrected: [], must_complete: [], flagged: [] };

  const domain = (() => {
    try {
      return new URL(rootUrl).host;
    } catch {
      return rootUrl;
    }
  })();

  const rawHtml = homepage?.rawHtml ?? null;
  const siteName = extractSiteName(rawHtml) ?? domain;
  const description = extractSiteDescription(rawHtml);
  if (!description) {
    changelog.must_complete.push(`Replace the placeholder one-line description in llms.txt — Adeptra doesn't invent what your store sells.`);
  }

  const returnPolicy = sig.get("return_policy_present_consistent");
  const shippingInfo = sig.get("shipping_info_present_consistent");
  const returnPolicyUrl = (returnPolicy?.evidence_json as any)?.found_url ?? null;
  const shippingInfoUrl = (shippingInfo?.evidence_json as any)?.found_url ?? null;

  const feedUrl = feed?.url ?? null;
  const manifestUrl = manifest.parsed != null ? manifest.url : null;

  const lines: string[] = [`# ${siteName}`, "", `> ${description ?? DESCRIPTION_PLACEHOLDER}`, ""];

  if (returnPolicyUrl || shippingInfoUrl) {
    lines.push("## Policies", "");
    if (returnPolicyUrl) lines.push(`- [Return Policy](${returnPolicyUrl})`);
    if (shippingInfoUrl) lines.push(`- [Shipping Information](${shippingInfoUrl})`);
    lines.push("");
  }

  if (feedUrl) {
    lines.push("## Products", "", `- [Product Feed](${feedUrl})`, "");
  }

  lines.push("## More", "", `- [Homepage](${rootUrl})`);
  if (manifestUrl) lines.push(`- [UCP Manifest](${manifestUrl})`);
  lines.push("");

  changelog.added.push(
    `llms.txt generated from real, known data: ${[returnPolicyUrl && "your return policy page", shippingInfoUrl && "your shipping info page", feedUrl && "your product feed URL", manifestUrl && "your UCP manifest"].filter(Boolean).join(", ") || "your homepage URL"}.`,
  );

  const honestyNote = signalEvidence?.get("llms_txt_present")?.merchant_note;
  if (honestyNote) changelog.flagged.push(honestyNote);

  return {
    artifact_type: "llms_txt",
    target_url: TARGET_URL,
    content: lines.join("\n"),
    resolves_signal_keys: ["llms_txt_present"],
    changelog,
  };
}
