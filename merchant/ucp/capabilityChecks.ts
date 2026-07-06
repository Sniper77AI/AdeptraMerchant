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
 */

import type { SignalRow, ManifestState, Fetcher } from "./manifestChecks.ts";

const CATEGORY = "capabilities";

// Weight/impact/effort per signal (Category 3, weight class 0.25 of the UCP pillar).
// Weights aren't given explicit numbers in the spec doc (unlike Category 1) — chosen
// proportional to impact so the category's total weight lines up with its 0.25 class.
const W = {
  checkout: { weight: 2.5, impact: 5, effort: 3 },
  cart: { weight: 2.0, impact: 4, effort: 3 },
  catalog: { weight: 2.0, impact: 4, effort: 3 },
  fulfillment: { weight: 1.5, impact: 3, effort: 3 },
  identityLinking: { weight: 1.0, impact: 2, effort: 3 },
  endpoint: { weight: 2.0, impact: 4, effort: 3 },
} as const;

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

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

export function sig_capability_checkout_declared(m: ManifestState): SignalRow {
  const cfg = W.checkout;
  const entries = capabilityEntries(m, "dev.ucp.shopping.checkout");
  const declared = entries.length > 0;
  const version: string | null = entries.find((e) => e?.version)?.version ?? null;
  const schemaPresent = entries.some((e) => !!e?.schema);

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.shopping.checkout in ucp.capabilities with a version and schema.";
  } else if (version && schemaPresent) {
    status = "pass";
  } else {
    status = "partial";
    fix = !schemaPresent
      ? "checkout capability declared but missing a schema URL."
      : "checkout capability declared but missing a version.";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "capability_checkout_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { declared, version, schema_present: schemaPresent },
    fix_summary: fix,
  };
}

export function sig_capability_cart_declared(m: ManifestState): SignalRow {
  const cfg = W.cart;
  const entries = capabilityEntries(m, "dev.ucp.shopping.cart");
  const declared = entries.length > 0;
  const config = entries[0] ?? null;
  const fullyConfigured = declared && !!config?.version;

  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.shopping.cart in ucp.capabilities to support multi-item carts.";
  } else if (fullyConfigured) {
    status = "pass";
  } else {
    status = "partial";
    fix = "cart capability declared without full configuration (e.g. version).";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "capability_cart_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { declared, config },
    fix_summary: fix,
  };
}

export function sig_capability_catalog_declared(m: ManifestState): SignalRow {
  const cfg = W.catalog;
  const { entries, matchedKeys } = catalogCapability(m);
  const declared = entries.length > 0;

  const status: SignalRow["status"] = declared ? "pass" : "fail";
  const fix = declared
    ? null
    : "Declare dev.ucp.shopping.catalog (or its .search/.lookup sub-capabilities) in ucp.capabilities for product catalog access.";

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "capability_catalog_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { declared, matched_keys: matchedKeys },
    fix_summary: fix,
  };
}

export function sig_capability_fulfillment_declared(m: ManifestState): SignalRow {
  const cfg = W.fulfillment;
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
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "capability_fulfillment_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { declared, version, schema_present: schemaPresent },
    fix_summary: fix,
  };
}

export function sig_capability_identity_linking_declared(m: ManifestState): SignalRow {
  const cfg = W.identityLinking;
  const entries = capabilityEntries(m, "dev.ucp.common.identity_linking");
  const declared = entries.length > 0;
  const scopes: string[] = entries.flatMap((e) => (Array.isArray(e?.scopes) ? e.scopes : []));

  // NOTE: spec allows N/A when a merchant opts out of account linking by design,
  // but detecting that requires an onboarding-level flag we don't model yet.
  // MVP treats "not declared" as fail; revisit once onboarding captures the opt-out.
  let status: SignalRow["status"];
  let fix: string | null = null;
  if (!declared) {
    status = "fail";
    fix = "Declare dev.ucp.common.identity_linking in ucp.capabilities to support account-linked experiences.";
  } else if (scopes.length > 0) {
    status = "pass";
  } else {
    status = "partial";
    fix = "identity_linking capability declared without scopes (e.g. dev.ucp.shopping.order:read).";
  }

  return {
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "capability_identity_linking_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { declared, scopes },
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
  const cfg = W.endpoint;
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
    pillar: "ucp",
    category: CATEGORY,
    signal_key: "endpoint_reachability",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { endpoint, http_status: httpStatus, notes },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: run all Category-3 signals against an already-fetched manifest.
// ---------------------------------------------------------------------------

export async function runCapabilityChecks(manifest: ManifestState, fetcher: Fetcher): Promise<SignalRow[]> {
  return [
    sig_capability_checkout_declared(manifest),
    sig_capability_cart_declared(manifest),
    sig_capability_catalog_declared(manifest),
    sig_capability_fulfillment_declared(manifest),
    sig_capability_identity_linking_declared(manifest),
    await checkEndpointReachability(manifest, fetcher),
  ];
}
