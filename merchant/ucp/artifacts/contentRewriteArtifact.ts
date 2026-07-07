/**
 * Adeptra Merchant — Content Rewrite Artifact Generator (artifact_type = 'content_rewrite').
 *
 * The first ASYNC + IMPURE generator: needs ctx.fetcher (to re-fetch the
 * merchant's OWN existing policy/support page) and ctx.llm (to structure that
 * EXISTING content into schema.org JSON-LD) — reuses LlmClient/openAiClient
 * from llmChecks.ts rather than a second LLM path. Degrades gracefully to
 * FLAG-only when ctx.llm is null/undefined, the same N/A-gating convention
 * llmChecks.ts uses for OPENAI_API_KEY being unset — never crashes.
 *
 * THE CORE RULE — two behaviors only, no content-authoring path exists:
 *   STRUCTURE: signal is PARTIAL (the content EXISTS but isn't machine-
 *     readable). Fetch the existing page, pass its visible text to the LLM,
 *     get back schema.org JSON-LD that encodes THAT TEXT verbatim-in-meaning.
 *     Adds nothing; invents no terms/dates/fees/values not present in the
 *     source. Resolves the signal (deploying the markup flips partial→pass).
 *   FLAG (no generated content, ever): signal is FAIL (missing entirely —
 *     Adeptra does not draft or template policy language), or either
 *     LLM-scored Category-2 signal (title/description contradiction — can't
 *     pick the "true" claim; sparse attributes — never invent product facts).
 *
 * ANTI-FABRICATION GATE (mechanical, not just a prompt instruction): prompt
 * discipline alone isn't trusted for a legal/trust-sensitive artifact — an
 * LLM can still round out a plausible-sounding value even when told not to.
 * Every standalone number in the generated JSON-LD (day counts, fees, phone
 * digits, etc. — the exact categories the hard rule names) must also appear
 * in the fetched source text. If the model invents ANY number not grounded
 * in the source, the WHOLE generation is rejected (never partially edited/
 * repaired) and that signal downgrades to FLAG instead of shipping content
 * we can't verify. This intentionally over-rejects on ambiguous cases
 * (e.g. an incidental digit in a URL) — a false FLAG is safe; a false
 * acceptance of a fabricated fact is not.
 */

import type { SignalRow, Fetcher } from "../manifestChecks.ts";
import type { LlmClient } from "../llmChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";

const TARGET_URL = "content-fixes/schema-markup.md";
const PAGE_FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_TEXT_CHARS = 6000; // keep prompts small; policy/contact pages are short

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

function needsAction(s: SignalRow | undefined): boolean {
  return s?.status === "fail" || s?.status === "partial";
}

// ---------------------------------------------------------------------------
// HTML -> visible text (lightweight, zero-dependency — same style as the
// rest of the pipeline's regex-based extraction, e.g. feedChecks.ts's XML reading)
// ---------------------------------------------------------------------------

function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Anti-fabrication gate
// ---------------------------------------------------------------------------

function extractNumbers(text: string): Set<string> {
  const matches = text.match(/\d[\d,.]*\d|\d/g) ?? [];
  return new Set(matches.map((m) => m.replace(/,/g, "")));
}

/** Every number in the generated JSON-LD must appear somewhere in the source
 *  text. Deliberately conservative (see file header) — over-rejection is the
 *  safe failure mode. */
function allNumbersGrounded(jsonld: unknown, sourceText: string): boolean {
  const outputNumbers = extractNumbers(JSON.stringify(jsonld));
  const sourceNumbers = extractNumbers(sourceText);
  for (const n of outputNumbers) {
    if (!sourceNumbers.has(n)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// STRUCTURE: return_policy_present_consistent / shipping_info_present_consistent
// (structurally identical — fetch the discovered page, structure its text)
// ---------------------------------------------------------------------------

interface StructureResult {
  markdown: string;
  foundUrl: string;
}

/** Named schema.org properties each type should decompose into — passed to the
 *  LLM explicitly so it extracts discrete typed facts rather than dumping the
 *  raw page text into one opaque string field (which would pass the lenient
 *  "any JSON-LD present" detector and the numeric groundedness gate while
 *  producing nothing an agent can actually reason over — found live against
 *  a real merchant's return-policy page during testing). */
const FIELD_GUIDE: Record<string, string> = {
  MerchantReturnPolicy:
    "merchantReturnDays (integer, only if a specific day count is stated), returnPolicyCategory (one of the schema.org enum values: https://schema.org/MerchantReturnFiniteReturnWindow, https://schema.org/MerchantReturnUnlimitedWindow, https://schema.org/MerchantReturnNotPermitted — only if determinable), returnFees, refundType, returnMethod, applicableCountry.",
  OfferShippingDetails:
    "shippingRate (with currency and value, only if a specific amount is stated), deliveryTime (with a specific handling/transit range if stated), shippingDestination (countries served, if stated).",
};

async function structurePagePolicy(opts: {
  foundUrl: string | null;
  fetcher: Fetcher;
  llm: LlmClient;
  schemaType: string;
  label: string;
  changelog: ArtifactChangelog;
}): Promise<StructureResult | null> {
  const { foundUrl, fetcher, llm, schemaType, label, changelog } = opts;
  if (!foundUrl) return null; // defensive — shouldn't happen when status is partial

  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(foundUrl, PAGE_FETCH_TIMEOUT_MS);
  } catch (e) {
    changelog.flagged.push(`Could not re-fetch the ${label.toLowerCase()} page at ${foundUrl} to generate markup (${(e as Error).message}) — flagged for manual review.`);
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    changelog.flagged.push(`${label} page at ${foundUrl} returned HTTP ${res.status} on re-fetch — flagged for manual review.`);
    return null;
  }

  const text = extractVisibleText(res.body);
  if (text.length < 40) {
    changelog.flagged.push(`${label} page at ${foundUrl} has too little visible text to structure reliably — flagged for manual review.`);
    return null;
  }

  const fieldGuide = FIELD_GUIDE[schemaType] ?? "";
  const prompt = `Below is the visible text of a merchant's ${label.toLowerCase()} page. Decompose it into schema.org JSON-LD (${schemaType}) using ONLY these specific typed properties: ${fieldGuide}

Do not invent, infer, or add any term, number, date, fee, or condition not explicitly present in the text below. If the text doesn't state a particular field, OMIT that field entirely rather than guessing a typical value.

Do NOT include the raw page text, an HTML dump, or any single free-text "body"/"description" field as a substitute for real decomposition — every fact must land in one of the named properties above, as a properly typed JSON value (numbers as numbers, not strings). If none of the listed properties can be confidently extracted from this text, respond with {"jsonld": null}.

PAGE TEXT:
"""
${text.slice(0, MAX_SOURCE_TEXT_CHARS)}
"""

Respond with ONLY a JSON object with this shape: {"jsonld": <the ${schemaType} JSON-LD object, or null>}.`;

  let parsed: any;
  try {
    const raw = await llm(prompt);
    parsed = JSON.parse(raw);
  } catch (e) {
    changelog.flagged.push(`${label} markup generation failed (${(e as Error).message ?? "LLM error"}) — flagged for manual review.`);
    return null;
  }

  const jsonld = parsed?.jsonld;
  if (parsed?.jsonld === null) {
    changelog.flagged.push(`${label} page at ${foundUrl} didn't contain any of the specific fields structured markup requires — flagged for manual review.`);
    return null;
  }
  if (!jsonld || typeof jsonld !== "object") {
    changelog.flagged.push(`${label} markup generation didn't return usable JSON-LD — flagged for manual review.`);
    return null;
  }
  if (!allNumbersGrounded(jsonld, text)) {
    changelog.flagged.push(
      `${label} markup generation produced a value not found in the source page (${foundUrl}) — flagged for manual review rather than risking an inaccurate structured claim.`,
    );
    return null;
  }

  // @context/@type are a fixed vocabulary declaration, not a fact about the
  // merchant — set deterministically rather than trusting the model to
  // include them, so the output is always valid standalone JSON-LD.
  const finalJsonld = { ...jsonld, "@context": "https://schema.org", "@type": schemaType };

  return {
    foundUrl,
    markdown: `## ${label}\n\nAdd this to **${foundUrl}**:\n\n\`\`\`json\n${JSON.stringify(finalJsonld, null, 2)}\n\`\`\`\n`,
  };
}

// ---------------------------------------------------------------------------
// STRUCTURE: support_contact_present (from contact details already on the
// homepage's visible text — no found_url in this signal's evidence, so this
// uses ctx.rootUrl instead)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

async function structureSupportContact(rootUrl: string | undefined, fetcher: Fetcher, llm: LlmClient, changelog: ArtifactChangelog): Promise<StructureResult | null> {
  if (!rootUrl) return null;

  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(rootUrl, PAGE_FETCH_TIMEOUT_MS);
  } catch (e) {
    changelog.flagged.push(`Could not re-fetch the homepage at ${rootUrl} to generate support-contact markup (${(e as Error).message}) — flagged for manual review.`);
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    changelog.flagged.push(`Homepage at ${rootUrl} returned HTTP ${res.status} on re-fetch — flagged for manual review.`);
    return null;
  }

  const text = extractVisibleText(res.body);
  if (!EMAIL_RE.test(text) && !PHONE_RE.test(text)) {
    changelog.flagged.push(`No email or phone number found in the homepage text at ${rootUrl} — publish visible contact details before structured markup can be generated.`);
    return null;
  }

  const prompt = `Below is the visible text of a merchant's homepage. It should contain customer support contact details (email and/or phone). Extract ONLY the contact details explicitly present in this text and structure them as a schema.org Organization with a contactPoint using ONLY these properties: telephone, email, contactType.

Do not invent, infer, or add any phone number, email address, or contact type not explicitly present in the text below. Do NOT include a raw text dump of the homepage in any field — only the specific extracted contactPoint properties. If no email or phone can be confidently extracted, respond with {"jsonld": null}.

PAGE TEXT:
"""
${text.slice(0, MAX_SOURCE_TEXT_CHARS)}
"""

Respond with ONLY a JSON object with this shape: {"jsonld": <a schema.org Organization object with a contactPoint, or null>}.`;

  let parsed: any;
  try {
    const raw = await llm(prompt);
    parsed = JSON.parse(raw);
  } catch (e) {
    changelog.flagged.push(`Support-contact markup generation failed (${(e as Error).message ?? "LLM error"}) — flagged for manual review.`);
    return null;
  }

  const jsonld = parsed?.jsonld;
  if (parsed?.jsonld === null) {
    changelog.flagged.push(`No confidently-extractable email or phone found in the homepage text at ${rootUrl} — flagged for manual review.`);
    return null;
  }
  if (!jsonld || typeof jsonld !== "object") {
    changelog.flagged.push("Support-contact markup generation didn't return usable JSON-LD — flagged for manual review.");
    return null;
  }
  if (!allNumbersGrounded(jsonld, text)) {
    changelog.flagged.push(
      `Support-contact markup generation produced a value not found in the source page (${rootUrl}) — flagged for manual review rather than risking an inaccurate structured claim.`,
    );
    return null;
  }

  // @context/@type are a fixed vocabulary declaration, not a fact about the
  // merchant — set deterministically rather than trusting the model to
  // include them, so the output is always valid standalone JSON-LD.
  const contactPoint = jsonld.contactPoint && typeof jsonld.contactPoint === "object" ? { ...jsonld.contactPoint, "@type": "ContactPoint" } : jsonld.contactPoint;
  const finalJsonld = { ...jsonld, "@context": "https://schema.org", "@type": "Organization", ...(contactPoint ? { contactPoint } : {}) };

  return {
    foundUrl: rootUrl,
    markdown: `## Support contact\n\nAdd this to **${rootUrl}** (site-wide, e.g. in the page \`<head>\` or footer):\n\n\`\`\`json\n${JSON.stringify(finalJsonld, null, 2)}\n\`\`\`\n`,
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export async function generateContentRewriteArtifact(ctx: ArtifactContext): Promise<ArtifactDraft | null> {
  const sig = byKey(ctx.signals);
  const changelog: ArtifactChangelog = { added: [], corrected: [], must_complete: [], flagged: [] };
  const resolvedKeys: string[] = [];
  const markdownSections: string[] = [];

  const canStructure = !!ctx.llm && !!ctx.fetcher;
  const fetcher = ctx.fetcher;
  const llm = ctx.llm;

  const returnPolicy = sig.get("return_policy_present_consistent");
  const shippingInfo = sig.get("shipping_info_present_consistent");
  const supportContact = sig.get("support_contact_present");
  const titleDesc = sig.get("title_description_consistency");
  const discoveryAttrs = sig.get("discovery_attributes_enrichment");

  // --- return_policy_present_consistent --------------------------------------
  if (returnPolicy?.status === "partial") {
    if (canStructure) {
      const result = await structurePagePolicy({
        foundUrl: (returnPolicy.evidence_json as any)?.found_url ?? null,
        fetcher: fetcher!,
        llm: llm!,
        schemaType: "MerchantReturnPolicy",
        label: "Return policy",
        changelog,
      });
      if (result) {
        markdownSections.push(result.markdown);
        changelog.must_complete.push(`Verify the generated return-policy markup matches your published policy at ${result.foundUrl}, then add it to the page.`);
        resolvedKeys.push("return_policy_present_consistent");
      }
    } else {
      changelog.flagged.push("Return policy exists but isn't machine-readable — structured markup would be generated automatically with an LLM configured; publish it manually in the meantime.");
    }
  } else if (returnPolicy?.status === "fail") {
    changelog.flagged.push("No return policy was found on the site — publish one; Adeptra does not draft policy language for you.");
  }

  // --- shipping_info_present_consistent ---------------------------------------
  if (shippingInfo?.status === "partial") {
    if (canStructure) {
      const result = await structurePagePolicy({
        foundUrl: (shippingInfo.evidence_json as any)?.found_url ?? null,
        fetcher: fetcher!,
        llm: llm!,
        schemaType: "OfferShippingDetails",
        label: "Shipping info",
        changelog,
      });
      if (result) {
        markdownSections.push(result.markdown);
        changelog.must_complete.push(`Verify the generated shipping-info markup matches your published policy at ${result.foundUrl}, then add it to the page.`);
        resolvedKeys.push("shipping_info_present_consistent");
      }
    } else {
      changelog.flagged.push("Shipping info exists but isn't machine-readable — structured markup would be generated automatically with an LLM configured; publish it manually in the meantime.");
    }
  } else if (shippingInfo?.status === "fail") {
    changelog.flagged.push("No shipping info was found on the site — publish it; Adeptra does not draft policy language for you.");
  }

  // --- support_contact_present -------------------------------------------------
  if (supportContact?.status === "partial") {
    if (canStructure) {
      const result = await structureSupportContact(ctx.rootUrl, fetcher!, llm!, changelog);
      if (result) {
        markdownSections.push(result.markdown);
        changelog.must_complete.push(`Verify the generated support-contact markup matches your real contact details, then add it to your site (e.g. ${result.foundUrl}).`);
        resolvedKeys.push("support_contact_present");
      }
    } else {
      changelog.flagged.push("Support contact details exist but aren't machine-readable — structured markup would be generated automatically with an LLM configured; publish it manually in the meantime.");
    }
  } else if (supportContact?.status === "fail") {
    changelog.flagged.push("No customer support contact details were found on the site — publish them; Adeptra does not invent contact details.");
  }

  // --- title_description_consistency: flag-only, never drafted ----------------
  if (needsAction(titleDesc)) {
    changelog.flagged.push(
      titleDesc!.status === "fail"
        ? "Feed and page make contradictory product claims — a person must decide which claim is accurate; Adeptra does not pick a side automatically."
        : "Feed and page wording differs on some products — review manually; Adeptra does not rewrite product copy automatically.",
    );
  }

  // --- discovery_attributes_enrichment: flag-only, never invented --------------
  if (needsAction(discoveryAttrs)) {
    const missing = (discoveryAttrs!.evidence_json as any)?.missing_attribute_types;
    const missingList = Array.isArray(missing) && missing.length > 0 ? missing.join(", ") : "see evidence for details";
    changelog.flagged.push(`Sparse product attribute coverage — consider adding: ${missingList}. Adeptra does not invent product facts or attribute values.`);
  }

  if (markdownSections.length === 0 && changelog.flagged.length === 0) return null;

  const content =
    markdownSections.length > 0
      ? `# Content & structured-data fixes\n\n${markdownSections.join("\n\n")}`
      : "# Content & structured-data fixes\n\nNo structured-data fixes were generated for this run — see the flagged items below for what needs manual attention.";

  return {
    artifact_type: "content_rewrite",
    target_url: TARGET_URL,
    content,
    resolves_signal_keys: resolvedKeys,
    changelog,
  };
}
