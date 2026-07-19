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
import { getDef, contribution } from "./signalDefinitions.ts";

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
  const def = getDef("ap2_compatibility_declared");
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
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: { payment_handlers: handlers.map((h) => h.key), ap2_declared: ap2Mentioned, external_gate: true },
    fix_summary: fix,
  };
}

export function sig_credential_security_posture(m: ManifestState): SignalRow {
  const def = getDef("credential_security_posture");
  const handlers = paymentHandlerEntries(m);

  if (handlers.length === 0) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: 0,
      impact: def.impact,
      effort: def.effort,
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
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: { tokenization_referenced: tokenizationReferenced, external_gate: true, observable: true },
    fix_summary: fix,
  };
}

export function sig_merchant_of_record_declared(): SignalRow {
  const def = getDef("merchant_of_record_declared");
  return {
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status: "not_applicable",
    weight: def.weight,
    score_contribution: 0,
    impact: def.impact,
    effort: def.effort,
    evidence_json: { mor_signal: null, observable: false },
    fix_summary: null,
  };
}

/** true when x is a non-empty array of instrument-shaped objects (each with
 *  a truthy string `type` — the field the v2026-04-08 spec-delta audit
 *  formalized: payment_handlers[*][].available_instruments = [{type,
 *  constraints}]). Presence + basic shape only, same discipline as
 *  sig_signing_keys_present's JWK check — not full validation of
 *  `constraints`. */
function isValidInstrumentArray(x: unknown): boolean {
  return Array.isArray(x) && x.length > 0 && x.every((item) => !!item && typeof item === "object" && !Array.isArray(item) && typeof (item as any).type === "string" && (item as any).type.length > 0);
}

/** available_instruments is a declaration-quality nicety on an already-
 *  optional field, nested inside an already-optional capability (payment
 *  handlers aren't required to declare it at all) — one level more optional
 *  than sig_signing_keys_present's own field. No malformed-partial branch:
 *  unlike a broken JWK (which an agent genuinely can't use), a handler that
 *  simply doesn't list its instrument types isn't broken, just less
 *  descriptive — unset and malformed both collapse to the same
 *  not_applicable advisory, distinguished only in evidence_json. Never
 *  fail: this is strictly a nice-to-have, never table stakes. */
export function sig_payment_instruments_declared(m: ManifestState): SignalRow {
  const def = getDef("payment_instruments_declared");
  const handlers = paymentHandlerEntries(m);

  const checked = handlers.map(({ key, entry }) => ({
    handler: key,
    available_instruments_valid: isValidInstrumentArray(entry?.available_instruments),
  }));
  const anyValid = checked.some((c) => c.available_instruments_valid);

  const status: SignalRow["status"] = anyValid ? "pass" : "not_applicable";

  return {
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: { payment_handlers: handlers.map((h) => h.key), checked, external_gate: false },
    fix_summary: null,
  };
}

export function runPaymentChecks(manifest: ManifestState): SignalRow[] {
  return [sig_ap2_compatibility_declared(manifest), sig_credential_security_posture(manifest), sig_merchant_of_record_declared(), sig_payment_instruments_declared(manifest)];
}
