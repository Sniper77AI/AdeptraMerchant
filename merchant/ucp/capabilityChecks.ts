/**
 * Adeptra Merchant — UCP Capability Check Group (Category 3: Capabilities)
 *
 * PORTABILITY CONTRACT (same shape as manifestChecks.ts):
 *  - Five of six signals are PURE: (manifestState) -> SignalRow, reading straight
 *    from the manifest `fetchManifest` already fetched — no extra network call.
 *  - `checkEndpointReachability` is the one impure signal: it probes the declared
 *    shopping service endpoint via the same injectable `Fetcher` type used by
 *    manifestChecks.ts, so tests pass a mock and production passes httpFetcher.
 *  - Nothing here imports n8n or Supabase.
 *
 * Grounded against UCP spec version 2026-04-08 (ucp.dev) — capability ids:
 *   ucp.capabilities["dev.ucp.shopping.checkout" | ".cart" | ".catalog" | ".fulfillment"],
 *   ucp.capabilities["dev.ucp.common.identity_linking"].
 *
 * WEIGHT/IMPACT/EFFORT: read from ./signalDefinitions.ts (getDef), not
 * declared here — see that file's header for the full provenance note
 * (these six were never given explicit numbers in the spec doc, unlike
 * Category 1 — chosen proportional to impact so the category's total lined
 * up with its 0.25 weight class).
 */

import type { SignalRow, ManifestState, Fetcher } from "./manifestChecks.ts";
import { getDef, contribution } from "./signalDefinitions.ts";

function capabilityEntries(m: ManifestState, capabilityId: string): any[] {
  const entries = m.parsed?.ucp?.capabilities?.[capabilityId];
  return Array.isArray(entries) ? entries : [];
}

/** Catalog is commonly split into sub-capabilities in production manifests
 *  (e.g. Shopify's dev.ucp.shopping.catalog.search / .catalog.lookup, layered
 *  under a vendor capability that `extends` them) rather than declared as a
 *  single flat `dev.ucp.shopping.catalog` key. Match either shape. */
function catalogCapability(m: ManifestState): { entries: any[]; matchedKeys: string[] } {
  const capabilities = m.parsed?.ucp?.capabilities;
  const matchedKeys: string[] = [];
  const entries: any[] = [];
  if (capabilities && typeof capabilities === "object") {
    for (const key of Object.keys(capabilities)) {
      if (key !== "dev.ucp.shopping.catalog" && !key.startsWith("dev.ucp.shopping.catalog.")) continue;
      const arr = capabilities[key];
      if (Array.isArray(arr) && arr.length > 0) {
        matchedKeys.push(key);
        entries.push(...arr);
      }
    }
  }
  return { entries, matchedKeys };
}

// ---------------------------------------------------------------------------
// Signal functions (pure) — one per signal_key in Category 3
// ---------------------------------------------------------------------------

export function sig_capability_checkout_declared(m: ManifestState, opts?: { checkoutHandoffOptIn?: boolean }): SignalRow {
  const def = getDef("capability_checkout_declared");
  const entries = capabilityEntries(m, "dev.ucp.shopping.checkout");
  const declared = entries.length > 0;
  const version: string | null = entries.find((e) => e?.version)?.version ?? null;
  const schemaPresent = entries.some((e) => !!e?.schema);
  const handoffOptIn = !!opts?.checkoutHandoffOptIn;

  // UCP's own checkout capability is not the only conformant path: a store
  // can adopt catalog+cart only, with payment handed off via the cart's
  // continue_url to the merchant's own checkout — a spec-sanctioned profile
  // (cart.md: "basket building without the complexity of checkout"; payment
  // = "None"; capabilities are independently adoptable), not a compromise.
  // A store correctly choosing that profile will have no checkout capability
  // declared at all — the SAME manifest shape as a store that just hasn't
  // gotten around to declaring checkout yet. Those two cases can't be told
  // apart from the manifest alone, so this only ever returns not_applicable
  // on an explicit merchant attestation (sites.checkout_handoff_opt_in) —
  // never inferred from ctx.platform or from cart being declared — so this
  // signal's status is always a merchant decision, never a side effect of
  // which artifact Adeptra happened to generate.
  if (!declared && handoffOptIn) {
    return {
      pillar: def.pillar,
      category: def.category,
      signal_key: def.signal_key,
      status: "not_applicable",
      weight: def.weight,
      score_contribution: contribution(def.weight, "not_applicable"),
      impact: def.impact,
      effort: def.effort,
      evidence_json: { declared, version, schema_present: schemaPresent, checkout_handoff_opt_in: true },
      fix_summary: null,
    };
  }

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix =
      "Declare dev.ucp.shopping.checkout in ucp.capabilities with a version and schema — OR, if you're intentionally handling payment on your own checkout via a cart continue_url handoff (a valid, spec-sanctioned catalog+cart-only profile), attest to that choice so this signal reflects it instead of failing.";
  } else if (version && schemaPresent) {
    status = "pass";
  } else {
    status = "partial";
    fix = !schemaPresent
      ? "checkout capability declared but missing a schema URL."
      : "checkout capability declared but missing a version.";
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
    evidence_json: { declared, version, schema_present: schemaPresent, checkout_handoff_opt_in: handoffOptIn },
    fix_summary: fix,
  };
}

/** Scoring-consistency correction, 2026-07-14 (v2026-04-08 spec-delta audit,
 *  CHANGE 2): brought into line with its structurally-identical siblings
 *  sig_capability_checkout_declared / sig_capability_fulfillment_declared —
 *  requires version AND schema for pass (previously version alone was
 *  enough), and checks across ALL declared entries via .find()/.some()
 *  (previously only entries[0]). A store already declaring a complete cart
 *  capability is unaffected; a store with a cart entry that has a version
 *  but no schema now correctly scores partial instead of pass — the same
 *  bar checkout/fulfillment have always held declarations to. This can move
 *  a real store's score (unlike every other change in this file, which are
 *  purely additive) — see D-024/README for the before/after on any store it
 *  actually moved. weight/impact/effort are UNCHANGED; this is a status-
 *  logic correction, not a value change. */
export function sig_capability_cart_declared(m: ManifestState): SignalRow {
  const def = getDef("capability_cart_declared");
  const entries = capabilityEntries(m, "dev.ucp.shopping.cart");
  const declared = entries.length > 0;
  const version: string | null = entries.find((e) => e?.version)?.version ?? null;
  const schemaPresent = entries.some((e) => !!e?.schema);

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.shopping.cart in ucp.capabilities to support multi-item carts.";
  } else if (version && schemaPresent) {
    status = "pass";
  } else {
    status = "partial";
    fix = !schemaPresent
      ? "cart capability declared but missing a schema URL."
      : "cart capability declared but missing a version.";
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
    evidence_json: { declared, version, schema_present: schemaPresent },
    fix_summary: fix,
  };
}

export function sig_capability_catalog_declared(m: ManifestState): SignalRow {
  const def = getDef("capability_catalog_declared");
  const { entries, matchedKeys } = catalogCapability(m);
  const declared = entries.length > 0;

  const status: SignalRow["status"] = declared ? "pass" : "fail";
  const fix = declared
    ? null
    : "Declare dev.ucp.shopping.catalog (or its .search/.lookup sub-capabilities) in ucp.capabilities for product catalog access.";

  return {
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: { declared, matched_keys: matchedKeys },
    fix_summary: fix,
  };
}

export function sig_capability_fulfillment_declared(m: ManifestState): SignalRow {
  const def = getDef("capability_fulfillment_declared");
  const entries = capabilityEntries(m, "dev.ucp.shopping.fulfillment");
  const declared = entries.length > 0;
  const version: string | null = entries.find((e) => e?.version)?.version ?? null;
  const schemaPresent = entries.some((e) => !!e?.schema);

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.shopping.fulfillment in ucp.capabilities with a version and schema.";
  } else if (version && schemaPresent) {
    status = "pass";
  } else {
    status = "partial";
    fix = !schemaPresent
      ? "fulfillment capability declared but missing a schema URL."
      : "fulfillment capability declared but missing a version.";
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
    evidence_json: { declared, version, schema_present: schemaPresent },
    fix_summary: fix,
  };
}

export function sig_capability_identity_linking_declared(
  m: ManifestState,
  opts?: { identityLinkingOptOut?: boolean },
): SignalRow {
  const def = getDef("capability_identity_linking_declared");
  const entries = capabilityEntries(m, "dev.ucp.common.identity_linking");
  const declared = entries.length > 0;
  const scopes: string[] = entries.flatMap((e) => (Array.isArray(e?.scopes) ? e.scopes : []));
  const optedOut = !!opts?.identityLinkingOptOut;

  // Spec allows N/A when a merchant opts out of account linking by design — that's
  // an onboarding-level decision (sites.identity_linking_opt_out), not something
  // derivable from the manifest itself.
  let status: SignalRow["status"];
  let fix: string | null = null;
  if (optedOut) {
    status = "not_applicable";
  } else if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.common.identity_linking in ucp.capabilities to support account-linked experiences.";
  } else if (scopes.length > 0) {
    status = "pass";
  } else {
    status = "partial";
    fix = "identity_linking capability declared without scopes (e.g. dev.ucp.shopping.order:read).";
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
    evidence_json: { declared, scopes, opted_out: optedOut },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Endpoint reachability (the only impure signal here — probes real network)
// ---------------------------------------------------------------------------

export async function checkEndpointReachability(
  m: ManifestState,
  fetcher: Fetcher,
  timeoutMs = 5000,
): Promise<SignalRow> {
  const def = getDef("endpoint_reachability");
  const shopping = m.parsed?.ucp?.services?.["dev.ucp.shopping"];
  const entries: any[] = Array.isArray(shopping) ? shopping : [];
  const endpoint: string | null = entries.find((e) => !!e?.endpoint)?.endpoint ?? null;

  let status: SignalRow["status"];
  let fix: string | null = null;
  let httpStatus: number | null = null;
  let notes = "";

  if (!endpoint) {
    status = "fail";
    fix = "No shopping service endpoint declared to probe.";
  } else {
    try {
      const res = await fetcher(endpoint, timeoutMs);
      httpStatus = res.status;
      if (res.status >= 200 && res.status < 400) {
        status = "pass";
      } else if (res.status >= 400 && res.status < 600) {
        status = "partial";
        notes = "non-2xx/3xx response on discovery probe";
        fix = `Endpoint reachable but returned HTTP ${res.status} on discovery probe.`;
      } else {
        status = "fail";
        fix = "Shopping service endpoint is unreachable.";
      }
    } catch (e) {
      status = "fail";
      notes = (e as Error).message ?? String(e);
      fix = "Shopping service endpoint is unreachable.";
    }
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
    evidence_json: { endpoint, http_status: httpStatus, notes },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: run all Category-3 signals against an already-fetched manifest.
// ---------------------------------------------------------------------------

export async function runCapabilityChecks(
  manifest: ManifestState,
  fetcher: Fetcher,
  opts?: { identityLinkingOptOut?: boolean; checkoutHandoffOptIn?: boolean },
): Promise<SignalRow[]> {
  return [
    sig_capability_checkout_declared(manifest, { checkoutHandoffOptIn: opts?.checkoutHandoffOptIn }),
    sig_capability_cart_declared(manifest),
    sig_capability_catalog_declared(manifest),
    sig_capability_fulfillment_declared(manifest),
    sig_capability_identity_linking_declared(manifest, opts),
    await checkEndpointReachability(manifest, fetcher),
  ];
}
