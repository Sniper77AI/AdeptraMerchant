/**
 * Adeptra Merchant — canonical signal definitions (weight/impact/effort/
 * pillar/category), for every signal in both pillars, in exactly one place.
 *
 * WHY THIS FILE EXISTS: every check module used to declare its own local `W`
 * object and its own copy of `contribution()` — nine separate copies, no
 * mechanical connection between any of them and a declared definition. That
 * let values drift undetected: robots_txt_valid shipped at weight 1.5
 * instead of the spec's 1.0, and a full audit (2026-07-10) found six more
 * agent_readability signals had drifted too, invisible in every report. This
 * file makes that class of bug impossible-by-construction: check functions
 * READ from here — none redeclares a weight/impact/effort/pillar/category
 * literal of its own anymore — and a permanent guardrail test
 * (test_signal_definitions.ts) fails if what the real orchestrators emit
 * ever disagrees with this file, or if the declared/emitted signal_key sets
 * for either pillar don't match exactly (a signal added, removed, or
 * recategorized without updating its definition).
 *
 * PROVENANCE — read this before treating either pillar's numbers as
 * externally validated against the same kind of authority:
 *
 *   UCP pillar weights were NEVER externally spec'd as numbers.
 *   signal-specs.md gives each Category a weight CLASS (e.g. "Category 3 —
 *   Capabilities, weight class 0.25") but no literal per-signal weight;
 *   capabilityChecks.ts's original header said as much — weights were
 *   "chosen proportional to impact" so each category's total lined up with
 *   its class. There is no external ground truth for UCP's numbers to have
 *   drifted FROM. Canonicalizing them here freezes the original design
 *   choice; it does not confirm that choice against an outside authority.
 *
 *   agent_readability pillar weights WERE spec'd (a literal table in the
 *   Build 1 spec) and DID drift during implementation. Reconciled
 *   2026-07-10, recovered from the pre-compaction session transcript since
 *   the running conversation's summary hadn't preserved the literal table:
 *     robots_txt_valid            weight 1.5 -> 1.0
 *     ai_crawler_access_retrieval weight 2.0 -> 2.5, impact 4 -> 5, effort 2 -> 1
 *     schema_in_raw_html          weight 2.5 -> 2.0, impact 5 -> 4
 *     offer_schema_complete       weight 2.0 -> 1.5
 *     organization_schema_present weight 1.5 -> 1.0, effort 1 -> 2
 *     sitemap_present             weight 1.5 -> 1.0, impact 3 -> 2
 *     llms_txt_present            impact 2 -> 1
 *   ai_crawler_access_training, content_server_rendered, and
 *   product_schema_present already matched spec exactly. Fixed going forward
 *   only — analysis_runs are immutable, so every run scored before
 *   2026-07-10 used the old values and is left exactly as reported. Do not
 *   compare a pre-2026-07-10 agent_readability score against a post one.
 *
 * WEIGHT vs BASIS (agent_readability specifically) — do not conflate: weight/
 * impact encode how much a signal matters IF the underlying claim holds;
 * basis (the signal_evidence table) encodes how confident anyone can be that
 * the claim holds. llms_txt_present carries a low weight because its impact
 * is low even if true (a discovery aid, not a visibility lever) — never as a
 * way of encoding uncertainty about it; that's what `basis: 'contested'` is
 * for.
 *
 * aeo_geo is a third pillar value the schema has allowed since its first
 * migration, but stays intentionally empty — no signal is declared against
 * it — until credible evidence justifies scoring it.
 */

import type { SignalRow } from "./manifestChecks.ts";

export interface SignalDefinition {
  signal_key: string;
  pillar: "ucp" | "agent_readability" | "aeo_geo";
  category: string;
  weight: number;
  impact: number; // 1-5
  effort: number; // 1-5
}

// Built from an array, not a hand-typed object literal keyed by signal_key —
// a duplicate key in an object literal silently overwrites with no error;
// an array lets duplicates be detected and rejected below, at import time,
// not just in a test someone might forget to run.
const DEFINITIONS: SignalDefinition[] = [
  // ===========================================================================
  // UCP pillar — 25 signals
  // ===========================================================================

  // --- discovery_manifest (manifestChecks.ts) --------------------------------
  { signal_key: "ucp_manifest_present", pillar: "ucp", category: "discovery_manifest", weight: 3.0, impact: 5, effort: 2 },
  { signal_key: "ucp_manifest_version_declared", pillar: "ucp", category: "discovery_manifest", weight: 1.5, impact: 4, effort: 1 },
  { signal_key: "ucp_services_declared", pillar: "ucp", category: "discovery_manifest", weight: 2.5, impact: 5, effort: 3 },
  { signal_key: "ucp_namespace_authority_valid", pillar: "ucp", category: "discovery_manifest", weight: 1.0, impact: 3, effort: 1 },

  // --- capabilities (capabilityChecks.ts) ------------------------------------
  { signal_key: "capability_checkout_declared", pillar: "ucp", category: "capabilities", weight: 2.5, impact: 5, effort: 3 },
  { signal_key: "capability_cart_declared", pillar: "ucp", category: "capabilities", weight: 2.0, impact: 4, effort: 3 },
  { signal_key: "capability_catalog_declared", pillar: "ucp", category: "capabilities", weight: 2.0, impact: 4, effort: 3 },
  { signal_key: "capability_fulfillment_declared", pillar: "ucp", category: "capabilities", weight: 1.5, impact: 3, effort: 3 },
  { signal_key: "capability_identity_linking_declared", pillar: "ucp", category: "capabilities", weight: 1.0, impact: 2, effort: 3 },
  { signal_key: "endpoint_reachability", pillar: "ucp", category: "capabilities", weight: 2.0, impact: 4, effort: 3 },

  // --- product_data_hygiene (feedChecks.ts, pageChecks.ts, llmChecks.ts) ----
  { signal_key: "feed_available", pillar: "ucp", category: "product_data_hygiene", weight: 2.0, impact: 5, effort: 2 },
  { signal_key: "native_commerce_attribute", pillar: "ucp", category: "product_data_hygiene", weight: 2.0, impact: 5, effort: 2 },
  { signal_key: "product_id_consistency", pillar: "ucp", category: "product_data_hygiene", weight: 2.0, impact: 5, effort: 3 },
  { signal_key: "price_consistency_cross_surface", pillar: "ucp", category: "product_data_hygiene", weight: 2.0, impact: 5, effort: 2 },
  { signal_key: "availability_consistency", pillar: "ucp", category: "product_data_hygiene", weight: 1.5, impact: 4, effort: 2 },
  { signal_key: "title_description_consistency", pillar: "ucp", category: "product_data_hygiene", weight: 1.0, impact: 3, effort: 3 },
  { signal_key: "discovery_attributes_enrichment", pillar: "ucp", category: "product_data_hygiene", weight: 1.0, impact: 3, effort: 3 },

  // --- policy_transparency (policyChecks.ts) ---------------------------------
  { signal_key: "return_policy_present_consistent", pillar: "ucp", category: "policy_transparency", weight: 1.5, impact: 4, effort: 2 },
  { signal_key: "shipping_info_present_consistent", pillar: "ucp", category: "policy_transparency", weight: 1.25, impact: 3, effort: 2 },
  { signal_key: "support_contact_present", pillar: "ucp", category: "policy_transparency", weight: 1.25, impact: 3, effort: 1 },

  // --- payment_ap2_readiness (paymentChecks.ts) ------------------------------
  { signal_key: "ap2_compatibility_declared", pillar: "ucp", category: "payment_ap2_readiness", weight: 2.5, impact: 4, effort: 4 },
  { signal_key: "credential_security_posture", pillar: "ucp", category: "payment_ap2_readiness", weight: 2.0, impact: 3, effort: 4 },
  { signal_key: "merchant_of_record_declared", pillar: "ucp", category: "payment_ap2_readiness", weight: 1.5, impact: 2, effort: 2 },

  // --- merchant_center_eligibility (readinessChecks.ts) ----------------------
  // Deliberately weight 0 — a readiness CHECKLIST, not part of capability-
  // quality scoring; scorer.ts's weight>0 filter drops these from the score
  // and signals_total/signals_passed entirely, while they still land as real
  // rows in `signals`. See test_signal_definitions.ts's explicit zero-weight
  // assertion: exactly these two, nothing else.
  { signal_key: "merchant_center_account_ready", pillar: "ucp", category: "merchant_center_eligibility", weight: 0, impact: 5, effort: 2 },
  { signal_key: "ucp_early_access_status", pillar: "ucp", category: "merchant_center_eligibility", weight: 0, impact: 4, effort: 1 },

  // ===========================================================================
  // agent_readability pillar — 10 signals (readabilityChecks.ts)
  // ===========================================================================

  // --- crawler_access ---------------------------------------------------------
  { signal_key: "robots_txt_valid", pillar: "agent_readability", category: "crawler_access", weight: 1.0, impact: 3, effort: 1 },
  { signal_key: "ai_crawler_access_retrieval", pillar: "agent_readability", category: "crawler_access", weight: 2.5, impact: 5, effort: 1 },
  { signal_key: "ai_crawler_access_training", pillar: "agent_readability", category: "crawler_access", weight: 1.0, impact: 2, effort: 1 },

  // --- content_legibility (highest-value category) ---------------------------
  { signal_key: "content_server_rendered", pillar: "agent_readability", category: "content_legibility", weight: 3.0, impact: 5, effort: 4 },
  { signal_key: "schema_in_raw_html", pillar: "agent_readability", category: "content_legibility", weight: 2.0, impact: 4, effort: 3 },

  // --- structured_data ---------------------------------------------------------
  { signal_key: "product_schema_present", pillar: "agent_readability", category: "structured_data", weight: 2.0, impact: 4, effort: 2 },
  { signal_key: "offer_schema_complete", pillar: "agent_readability", category: "structured_data", weight: 1.5, impact: 4, effort: 2 },
  { signal_key: "organization_schema_present", pillar: "agent_readability", category: "structured_data", weight: 1.0, impact: 3, effort: 2 },

  // --- discovery_surfaces -------------------------------------------------------
  { signal_key: "sitemap_present", pillar: "agent_readability", category: "discovery_surfaces", weight: 1.0, impact: 2, effort: 1 },
  { signal_key: "llms_txt_present", pillar: "agent_readability", category: "discovery_surfaces", weight: 0.5, impact: 1, effort: 1 },
];

// Fail at import time, not just in a test someone might skip running.
(function assertNoDuplicates() {
  const seen = new Set<string>();
  for (const def of DEFINITIONS) {
    if (seen.has(def.signal_key)) {
      throw new Error(`signalDefinitions.ts: duplicate signal_key "${def.signal_key}" — every signal must be declared exactly once.`);
    }
    seen.add(def.signal_key);
  }
})();

export const SIGNAL_DEFINITIONS: Readonly<Record<string, SignalDefinition>> = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.signal_key, d])));

/** Throws immediately, by name, when a signal_key has no declaration — the
 *  earliest possible point a typo or a forgotten declaration can fail,
 *  rather than an opaque "cannot read property 'weight' of undefined"
 *  several lines later with no indication which signal was wrong. */
export function getDef(signal_key: string): SignalDefinition {
  const def = SIGNAL_DEFINITIONS[signal_key];
  if (!def) {
    throw new Error(`No SIGNAL_DEFINITIONS entry for signal_key "${signal_key}" — declare it in signalDefinitions.ts before using it in a check function.`);
  }
  return def;
}

/** The single scoring rule, previously duplicated identically across all nine
 *  check modules (confirmed byte-for-byte identical before consolidating —
 *  no second hidden drift found there). pass -> full weight; partial ->
 *  half; fail/not_applicable -> zero. */
export function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}
