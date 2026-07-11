/**
 * Adeptra Merchant — Merchant Center Eligibility (Category 6, readiness gate
 * — cross-cutting, per signal-specs.md).
 *
 * "Not scored into capability quality; scored as a readiness checklist
 * because these are external gates that determine whether ANY of the above
 * can go live on Google surfaces." The weight classes for Categories 1–5
 * already sum to 1.00 on their own — Category 6 intentionally has none.
 * Both signals here carry weight: 0 so scorer.ts's weight>0 filter drops
 * them from the score and signals_total/signals_passed entirely, while they
 * still land as real, queryable rows in `signals` for a separate readiness
 * checklist UI.
 *
 * Both signals are pure functions over onboarding-level attestation — there
 * is nothing to fetch or observe, this category is entirely self-attested.
 * Deliberately NOT typed against supabaseSink.ts's SiteConfig (this file has
 * zero Supabase/n8n dependency, same portability contract as every other
 * check group); the caller passes a plain MerchantCenterAttestation object,
 * same pattern as capabilityChecks.ts's identityLinkingOptOut option.
 *
 * Unattested (the relevant field is NULL) scores not_applicable, not fail —
 * we don't penalize a merchant for a question onboarding hasn't asked yet.
 */

import type { SignalRow } from "./manifestChecks.ts";
import { getDef, contribution } from "./signalDefinitions.ts";

export interface MerchantCenterAttestation {
  accountReady: boolean | null; // null = not attested yet
  feedsConfigured: boolean;
  earlyAccessStatus: "not_applied" | "pending" | "approved" | null; // null = not attested yet
}

export function sig_merchant_center_account_ready(a: MerchantCenterAttestation): SignalRow {
  const def = getDef("merchant_center_account_ready");
  let status: SignalRow["status"];
  let fix: string | null = null;

  if (a.accountReady === null) {
    status = "not_applicable";
  } else if (a.accountReady === false) {
    status = "fail";
    fix = "Set up a Merchant Center account with shipping, returns, and product feeds configured.";
  } else if (a.feedsConfigured) {
    status = "pass";
  } else {
    status = "partial";
    fix = "Merchant Center account is active, but shipping/returns/product feeds aren't fully configured yet.";
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
    evidence_json: { attested: a.accountReady, feeds_configured: a.feedsConfigured, external_gate: true },
    fix_summary: fix,
  };
}

export function sig_ucp_early_access_status(a: MerchantCenterAttestation): SignalRow {
  const def = getDef("ucp_early_access_status");
  let status: SignalRow["status"];
  let fix: string | null = null;

  if (a.earlyAccessStatus === null) {
    status = "not_applicable";
  } else if (a.earlyAccessStatus === "approved") {
    status = "pass";
  } else if (a.earlyAccessStatus === "pending") {
    status = "partial";
    fix = "UCP early-access application is pending approval.";
  } else {
    status = "fail";
    fix = "Apply for UCP checkout early access.";
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
    evidence_json: { status: a.earlyAccessStatus, region_eligible: null, external_gate: true }, // region_eligible: not modeled yet
    fix_summary: fix,
  };
}

export function runReadinessChecks(a: MerchantCenterAttestation): SignalRow[] {
  return [sig_merchant_center_account_ready(a), sig_ucp_early_access_status(a)];
}
