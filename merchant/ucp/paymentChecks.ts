/**
 * Adeptra Merchant — Payment / AP2 Readiness (Category 4, weight class 0.15).
 *
 * SCOPE: this category is mostly "external gates" per the spec — Adeptra
 * checks readiness, never wires or observes live payment flows. All three
 * signals read only what the manifest itself declares (already fetched by
 * fetchManifest — no new network call), the same portability contract as
 * capabilityChecks.ts: pure functions over an already-fetched ManifestState.
 *
 * Grounded against a real production manifest (skims.com):
 *   ucp.payment_handlers["com.google.pay"][0].config.allowed_payment_methods[0]
 *     .tokenization_specification — a real, observable field for
 *     credential_security_posture to check.
 *
 * `merchant_of_record_declared` has NO standard UCP manifest field to read —
 * skims.com's manifest has no such field anywhere. It scores not_applicable
 * rather than guessing, the same "don't guess when it's not observable" rule
 * the spec itself gives for credential_security_posture. This keeps the row
 * in `signals` (auditable: "checked, couldn't determine, here's why") ready
 * to light up once UCP defines a field or onboarding captures an attestation.
 */

import type { SignalRow, ManifestState } from "./manifestChecks.ts";

const CATEGORY = "payment_ap2_readiness";

const W = {
  ap2Compatibility: { weight: 2.5, impact: 4, effort: 4 },
  credentialSecurity: { weight: 2.0, impact: 3, effort: 4 },
  merchantOfRecord: { weight: 1.5, impact: 2, effort: 2 },
} as const;

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

function paymentHandlerEntries(m: ManifestState): Array<{ key: string; entry: any }> {
  const handlers = m.parsed?.ucp?.payment_handlers;
  const out: Array<{ key: string; entry: any }> = [];
  if (handlers && typeof handlers === "object") {
    for (const key of Object.keys(handlers)) {
      const arr = handlers[key];
      if (Array.isArray(arr)) for (const entry of arr) out.push({ key, entry });
    }
  }
  return out;
}

const AP2_HINT_RE = /\bap2\b|agent[- ]payments?[- ]protocol/i;

export function sig_ap2_compatibility_declared(m: ManifestState): SignalRow {
  const cfg = W.ap2Compatibility;
  const handlers = paymentHandlerEntries(m);
  const declared = handlers.length > 0;
  const ap2Mentioned = handlers.some(({ entry }) => AP2_HINT_RE.test(JSON.stringify(entry ?? {})));

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare at least one payment handler in ucp.payment_handlers.";
  } else if (ap2Mentioned) {
    status = "pass";
  } else {
    status = "partial";
    fix = "Payment handler(s) declared, but AP2 (Agent Payments Protocol) compatibility isn't explicitly indicated.";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "ap2_compatibility_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { payment_handlers: handlers.map((h) => h.key), ap2_declared: ap2Mentioned, external_gate: true },
    fix_summary: fix,
  };
}

export function sig_credential_security_posture(m: ManifestState): SignalRow {
  const cfg = W.credentialSecurity;
  const handlers = paymentHandlerEntries(m);

  if (handlers.length === 0) {
    return {
      pillar: "ucp",
      category: CATEGORY,
      signal_key: "credential_security_posture",
      status: "not_applicable",
      weight: cfg.weight,
      score_contribution: 0,
      impact: cfg.impact,
      effort: cfg.effort,
      evidence_json: { tokenization_referenced: false, external_gate: true, observable: false },
      fix_summary: null,
    };
  }

  const tokenizationReferenced = handlers.some(({ entry }) => {
    const methods = entry?.config?.allowed_payment_methods;
    if (Array.isArray(methods)) return methods.some((method: any) => !!method?.tokenization_specification);
    return !!entry?.config?.tokenization_specification;
  });

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (tokenizationReferenced) {
    status = "pass";
  } else {
    status = "partial";
    fix = "No tokenization_specification found in the declared payment handler config(s) — verify credentials aren't passed directly.";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "credential_security_posture",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { tokenization_referenced: tokenizationReferenced, external_gate: true, observable: true },
    fix_summary: fix,
  };
}

export function sig_merchant_of_record_declared(): SignalRow {
  const cfg = W.merchantOfRecord;
  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "merchant_of_record_declared",
    status: "not_applicable",
    weight: cfg.weight,
    score_contribution: 0,
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { mor_signal: null, observable: false },
    fix_summary: null,
  };
}

export function runPaymentChecks(manifest: ManifestState): SignalRow[] {
  return [sig_ap2_compatibility_declared(manifest), sig_credential_security_posture(manifest), sig_merchant_of_record_declared()];
}
