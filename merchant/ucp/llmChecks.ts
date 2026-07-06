/**
 * Adeptra Merchant — LLM-scored signals (Category 2, the last two):
 *   - title_description_consistency's semantic half (the [D] exact-match half
 *     lives inline here too, since it's what decides whether the LLM needs to
 *     be called at all)
 *   - discovery_attributes_enrichment
 *
 * PORTABILITY CONTRACT: `openAiClient` is the only impure function that talks
 * to an LLM, and it's injectable via the `LlmClient` type — exactly like
 * `Fetcher` for HTTP — so tests pass a mock and production passes the real
 * OpenAI-backed client. Only runLive.ts reads OPENAI_API_KEY; everything here
 * takes explicit config.
 *
 * COST CONTROL (per signal-specs.md: "only 2 signals need an LLM... small
 * sample only"):
 *  - Sample size defaults to 5, well below the 15 used for the deterministic
 *    Category 2 checks.
 *  - title_description_consistency only calls the LLM for products whose
 *    feed/page title+description AREN'T already identical after normalizing
 *    whitespace/case — the [D] exact-match check is free and runs first.
 *  - Both signals degrade to not_applicable (not fail) when no LLM client is
 *    configured (OPENAI_API_KEY unset) or there's nothing to sample — same
 *    N/A-gating convention as the rest of Category 2.
 */

import type { SignalRow, Fetcher } from "./manifestChecks.ts";
import type { FeedState } from "./feedChecks.ts";
import { fetchProductPage } from "./pageChecks.ts";

const CATEGORY = "product_data_hygiene";
const DEFAULT_LLM_SAMPLE_SIZE = 5;

const W = {
  titleDescription: { weight: 1.0, impact: 3, effort: 3 },
  discoveryAttributes: { weight: 1.0, impact: 3, effort: 3 },
} as const;

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

// ---------------------------------------------------------------------------
// LLM client (the only impure piece)
// ---------------------------------------------------------------------------

/** Takes a prompt, returns the model's raw text response (expected JSON). */
export type LlmClient = (prompt: string) => Promise<string>;

export function openAiClient(apiKey: string, model = "gpt-4o-mini"): LlmClient {
  return async (prompt: string): Promise<string> => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI response missing choices[0].message.content");
    }
    return content;
  };
}

// ---------------------------------------------------------------------------
// title_description_consistency
// ---------------------------------------------------------------------------

export interface TitleDescSample {
  sku: string;
  feedTitle: string | null;
  feedDescription: string | null;
  pageTitle: string | null;
  pageDescription: string | null;
}

function normalize(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function judgeContradiction(llm: LlmClient, s: TitleDescSample): Promise<{ contradiction: boolean; note: string }> {
  const prompt = `You are checking whether a product's marketplace feed and its live webpage make CONTRADICTORY factual claims about the same physical product (not just wording differences).

Feed title: ${s.feedTitle ?? "(none)"}
Feed description: ${s.feedDescription ?? "(none)"}
Page title: ${s.pageTitle ?? "(none)"}
Page description: ${s.pageDescription ?? "(none)"}

Respond with ONLY a JSON object: {"contradiction": boolean, "note": string}. "contradiction" is true only if the two sources assert something that cannot both be true (e.g. different material, different fit, incompatible claims like "waterproof" vs "water-resistant"). Cosmetic wording differences are NOT contradictions.`;
  const raw = await llm(prompt);
  const parsed = JSON.parse(raw);
  return { contradiction: !!parsed.contradiction, note: String(parsed.note ?? "") };
}

export async function sig_title_description_consistency(samples: TitleDescSample[], llm: LlmClient): Promise<SignalRow> {
  const cfg = W.titleDescription;

  if (samples.length === 0) {
    return {
      pillar: "ucp",
      category: CATEGORY,
      signal_key: "title_description_consistency",
      status: "not_applicable",
      weight: cfg.weight,
      score_contribution: 0,
      impact: cfg.impact,
      effort: cfg.effort,
      evidence_json: { sampled: [] },
      fix_summary: null,
    };
  }

  const evaluated: Array<{ sku: string; semantic_conflict: boolean | null; note: string }> = [];
  let anyContradiction = false;
  let anyDiff = false;

  for (const s of samples) {
    const identical = normalize(s.feedTitle) === normalize(s.pageTitle) && normalize(s.feedDescription) === normalize(s.pageDescription);
    if (identical) {
      evaluated.push({ sku: s.sku, semantic_conflict: false, note: "identical" });
      continue;
    }
    anyDiff = true;
    try {
      const { contradiction, note } = await judgeContradiction(llm, s);
      if (contradiction) anyContradiction = true;
      evaluated.push({ sku: s.sku, semantic_conflict: contradiction, note });
    } catch (e) {
      evaluated.push({ sku: s.sku, semantic_conflict: null, note: `llm_error: ${(e as Error).message}` });
    }
  }

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (anyContradiction) {
    status = "fail";
    fix = "Feed and page make contradictory claims about at least one sampled product — this could mislead a shopping agent.";
  } else if (anyDiff) {
    status = "partial";
    fix = "Feed and page wording differs on some sampled products, but no factual contradictions were found.";
  } else {
    status = "pass";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "title_description_consistency",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { sampled: evaluated },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// discovery_attributes_enrichment
// ---------------------------------------------------------------------------

export interface EnrichmentSample {
  sku: string;
  productType: string | null;
  attributeKeys: string[];
}

type Coverage = "rich" | "basic" | "sparse";

async function scoreEnrichment(llm: LlmClient, s: EnrichmentSample): Promise<{ coverage: Coverage; missing: string[] }> {
  const prompt = `A product exposes these structured attribute keys to an AI shopping agent: ${JSON.stringify(s.attributeKeys)}.
Product category: ${s.productType ?? "unknown"}.

Judge how rich this attribute coverage is for helping an AI shopping agent compare products and answer shopper questions, versus what's typical for this category (e.g. material, fit, care instructions, compatible accessories, size chart, Q&A, reviews).

Respond with ONLY a JSON object: {"coverage": "rich" | "basic" | "sparse", "missing": string[]}. "missing" lists attribute types a shopper/agent would expect for this category that aren't present.`;
  const raw = await llm(prompt);
  const parsed = JSON.parse(raw);
  const coverage: Coverage = parsed.coverage === "rich" || parsed.coverage === "basic" ? parsed.coverage : "sparse";
  return { coverage, missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [] };
}

export async function sig_discovery_attributes_enrichment(samples: EnrichmentSample[], llm: LlmClient): Promise<SignalRow> {
  const cfg = W.discoveryAttributes;

  if (samples.length === 0) {
    return {
      pillar: "ucp",
      category: CATEGORY,
      signal_key: "discovery_attributes_enrichment",
      status: "not_applicable",
      weight: cfg.weight,
      score_contribution: 0,
      impact: cfg.impact,
      effort: cfg.effort,
      evidence_json: { coverage_score: null, missing_attribute_types: [] },
      fix_summary: null,
    };
  }

  const results: Array<{ sku: string; coverage: Coverage; missing: string[] }> = [];
  for (const s of samples) {
    try {
      const { coverage, missing } = await scoreEnrichment(llm, s);
      results.push({ sku: s.sku, coverage, missing });
    } catch (e) {
      results.push({ sku: s.sku, coverage: "sparse", missing: [`llm_error: ${(e as Error).message}`] });
    }
  }

  const richCount = results.filter((r) => r.coverage === "rich").length;
  const sparseCount = results.filter((r) => r.coverage === "sparse").length;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (richCount === results.length) {
    status = "pass";
  } else if (sparseCount === results.length) {
    status = "fail";
    fix = "Sampled products expose sparse structured attributes (little beyond title/price) — an agent has less to compare/answer with.";
  } else {
    status = "partial";
    fix = "Some sampled products have only basic attribute coverage; consider enriching with the missing attribute types noted in evidence.";
  }

  const missingAll = Array.from(new Set(results.flatMap((r) => r.missing)));

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "discovery_attributes_enrichment",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { coverage_score: results, missing_attribute_types: missingAll },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function naSignal(signalKey: string, cfg: { weight: number; impact: number; effort: number }, evidence: Record<string, unknown>): SignalRow {
  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: signalKey,
    status: "not_applicable",
    weight: cfg.weight,
    score_contribution: 0,
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: evidence,
    fix_summary: null,
  };
}

/** llm === null means "not configured" (OPENAI_API_KEY unset) — degrades to
 *  not_applicable for both signals rather than failing the whole run. */
export async function runLlmChecks(
  feed: FeedState | null,
  fetcher: Fetcher,
  llm: LlmClient | null,
  sampleSize = DEFAULT_LLM_SAMPLE_SIZE,
): Promise<SignalRow[]> {
  if (!llm) {
    return [
      naSignal("title_description_consistency", W.titleDescription, { sampled: [], reason: "llm_not_configured" }),
      naSignal("discovery_attributes_enrichment", W.discoveryAttributes, { coverage_score: null, missing_attribute_types: [], reason: "llm_not_configured" }),
    ];
  }
  if (!feed || feed.items.length === 0) {
    return [await sig_title_description_consistency([], llm), await sig_discovery_attributes_enrichment([], llm)];
  }

  const sampled = feed.items.filter((it) => !!it.link).slice(0, sampleSize);
  const titleDescSamples: TitleDescSample[] = [];
  const enrichmentSamples: EnrichmentSample[] = [];

  for (const item of sampled) {
    const page = await fetchProductPage(item.link!, fetcher);
    titleDescSamples.push({
      sku: item.id,
      feedTitle: item.title,
      feedDescription: item.description,
      pageTitle: page.variants[0]?.name ?? null,
      pageDescription: page.productDescription,
    });
    enrichmentSamples.push({
      sku: item.id,
      productType: item.raw?.product_type ?? null,
      attributeKeys: page.productAttributes ? Object.keys(page.productAttributes) : [],
    });
  }

  return [
    await sig_title_description_consistency(titleDescSamples, llm),
    await sig_discovery_attributes_enrichment(enrichmentSamples, llm),
  ];
}
