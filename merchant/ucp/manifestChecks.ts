/**
 * Adeptra Merchant — UCP Manifest Check Group (Category 1: Discovery & Manifest)
 *
 * PORTABILITY CONTRACT (the whole point of how this is structured):
 *  - `fetchManifest` is the ONLY function that touches the network. It takes an
 *    injectable `fetcher`, so tests pass a mock and production passes real HTTP.
 *  - The five signal functions are PURE: (manifestState) -> SignalRow. No I/O.
 *  - Nothing here imports n8n or Supabase. It runs verbatim inside an n8n code
 *    node today and lifts into a standalone worker later, unchanged.
 *
 * Grounded against UCP spec version 2026-04-08 (ucp.dev) — real field names:
 *   ucp.version, ucp.services["dev.ucp.shopping"], ucp.capabilities, spec/schema URLs,
 *   signing_keys (document root, sibling of ucp — see sig_signing_keys_present).
 *
 * WEIGHT/IMPACT/EFFORT: each signal function reads its definition from
 * ./signalDefinitions.ts (getDef) rather than declaring its own literal —
 * see that file for why. Safe despite signalDefinitions.ts importing
 * `SignalRow` back from here: that import is `import type`, fully erased at
 * runtime, so there's no real circular dependency, only a type-only one.
 */

import { getDef, contribution } from "./signalDefinitions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row destined for the Supabase `signals` table. run_id + priority_score are
 *  added/derived at insert time, so they are intentionally absent here. */
export interface SignalRow {
  pillar: "ucp" | "agent_readability" | "aeo_geo";
  category: string;
  signal_key: string;
  status: "pass" | "partial" | "fail" | "not_applicable";
  weight: number;
  score_contribution: number; // weight on pass, weight/2 on partial, else 0
  impact: number; // 1-5
  effort: number; // 1-5
  evidence_json: Record<string, unknown>;
  fix_summary: string | null;
}

/** Result of fetching /.well-known/ucp once, passed to every signal fn. */
export interface ManifestState {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  contentType: string | null;
  requiresAuth: boolean;
  redirectChain: string[];
  isValidJson: boolean;
  parsed: any | null; // parsed manifest object (the `{ ucp: {...} }` document)
  errorNote?: string;
}

/** Minimal shape a fetcher must return. Real HTTP and mocks both satisfy this. */
export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  redirectChain: string[];
  requiresAuth: boolean;
}

export type Fetcher = (url: string, timeoutMs: number) => Promise<FetchResult>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 5000; // strict backpressure cap (see specs open item #1)
const MAX_REDIRECTS = 1; // spec wants manifest directly at the well-known path

/** Known UCP versions. In production this is read from the `ucp_versions`
 *  Supabase table (open item #5) so new versions are a data update, not a deploy.
 *  Hardcoded here only for the portable/mock version. */
const KNOWN_UCP_VERSIONS = new Set(["2026-04-08"]);
export const CURRENT_UCP_VERSION = "2026-04-08";

/** Legitimate namespace authority hosts for spec/schema URLs. */
export const VALID_AUTHORITY_HOSTS = new Set(["ucp.dev"]);

// v2026-04-08's four valid transports. "embedded" added 2026-07-13 — it was
// missing from the original set, which meant a store correctly declaring it
// was falsely penalized (sig_services_declared) and had it wrongly
// downgraded to "rest" by the manifest-fix generator (manifestArtifact.ts).
export const ALLOWED_TRANSPORTS = new Set(["rest", "mcp", "a2a", "embedded"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Network boundary (the only impure function)
// ---------------------------------------------------------------------------

export async function fetchManifest(domain: string, fetcher: Fetcher): Promise<ManifestState> {
  const url = `https://${domain.replace(/\/+$/, "")}/.well-known/ucp`;
  const base: ManifestState = {
    url,
    reachable: false,
    httpStatus: null,
    contentType: null,
    requiresAuth: false,
    redirectChain: [],
    isValidJson: false,
    parsed: null,
  };

  let res: FetchResult;
  try {
    res = await fetcher(url, FETCH_TIMEOUT_MS);
  } catch (e) {
    return { ...base, errorNote: `fetch_failed: ${(e as Error).message}` };
  }

  const contentType = (res.headers["content-type"] || res.headers["Content-Type"] || "").toLowerCase();
  let parsed: any = null;
  let isValidJson = false;
  if (res.status >= 200 && res.status < 300) {
    try {
      parsed = JSON.parse(res.body);
      isValidJson = true;
    } catch {
      isValidJson = false;
    }
  }

  return {
    url,
    reachable: res.status > 0,
    httpStatus: res.status,
    contentType: contentType || null,
    requiresAuth: res.requiresAuth,
    redirectChain: res.redirectChain || [],
    isValidJson,
    parsed,
  };
}

// ---------------------------------------------------------------------------
// Signal functions (pure) — one per signal_key in Category 1
// ---------------------------------------------------------------------------

export function sig_manifest_present(m: ManifestState): SignalRow {
  const def = getDef("ucp_manifest_present");
  let status: SignalRow["status"];
  let fix: string | null = null;

  const ok2xx = m.httpStatus !== null && m.httpStatus >= 200 && m.httpStatus < 300;
  const jsonCT = (m.contentType || "").includes("json");
  const redirected = m.redirectChain.length > MAX_REDIRECTS;

  if (ok2xx && m.isValidJson && jsonCT && !m.requiresAuth && !redirected) {
    status = "pass";
  } else if (ok2xx && m.isValidJson && (!jsonCT || m.requiresAuth || redirected)) {
    // reachable & parseable but violates a spec nicety (content-type / auth / redirect)
    status = "partial";
    fix = m.requiresAuth
      ? "Manifest must be publicly accessible with no authentication."
      : redirected
      ? "Serve the manifest directly at /.well-known/ucp without redirects."
      : "Set Content-Type: application/json on the manifest response.";
  } else {
    status = "fail";
    fix = "Publish a valid JSON UCP profile at /.well-known/ucp (HTTP 200, public, no auth).";
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
    evidence_json: {
      url: m.url,
      http_status: m.httpStatus,
      content_type: m.contentType,
      is_valid_json: m.isValidJson,
      requires_auth: m.requiresAuth,
      redirect_chain: m.redirectChain,
    },
    fix_summary: fix,
  };
}

export function sig_version_declared(m: ManifestState): SignalRow {
  const def = getDef("ucp_manifest_version_declared");
  const ucp = m.parsed?.ucp;
  const declared: string | undefined = ucp?.version;
  const supportedVersionsMap = ucp?.supported_versions ?? null;

  let status: SignalRow["status"];
  let fix: string | null = null;

  if (!m.isValidJson || !ucp) {
    status = "fail";
    fix = "Declare ucp.version in the manifest.";
  } else if (declared && KNOWN_UCP_VERSIONS.has(declared)) {
    status = "pass";
  } else if (declared && !KNOWN_UCP_VERSIONS.has(declared)) {
    status = "partial";
    fix = `Declared UCP version "${declared}" is unrecognized/older; upgrade to ${CURRENT_UCP_VERSION}.`;
  } else if (!declared && supportedVersionsMap) {
    status = "partial";
    fix = `No top-level ucp.version; ensure current version ${CURRENT_UCP_VERSION} is present.`;
  } else {
    status = "fail";
    fix = "Declare ucp.version in the manifest.";
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
    evidence_json: {
      declared_version: declared ?? null,
      is_current: declared === CURRENT_UCP_VERSION,
      supported_versions_map: supportedVersionsMap,
    },
    fix_summary: fix,
  };
}

export function sig_services_declared(m: ManifestState): SignalRow {
  const def = getDef("ucp_services_declared");
  const shopping = m.parsed?.ucp?.services?.["dev.ucp.shopping"];
  const entries: any[] = Array.isArray(shopping) ? shopping : [];

  const analyzed = entries.map((e) => ({
    version: e?.version ?? null,
    transport: e?.transport ?? null,
    endpoint: e?.endpoint ?? null,
    transport_ok: ALLOWED_TRANSPORTS.has(e?.transport),
    endpoint_is_url: !!hostOf(e?.endpoint ?? ""),
    schema_present: !!e?.schema,
  }));

  let status: SignalRow["status"];
  let fix: string | null = null;

  if (entries.length === 0) {
    status = "fail";
    fix = 'Declare a "dev.ucp.shopping" service with version, transport, and endpoint.';
  } else {
    const fullyValid = analyzed.filter((a) => a.endpoint_is_url && a.transport_ok && a.schema_present);
    const anyUsable = analyzed.filter((a) => a.endpoint_is_url && a.transport_ok);
    if (fullyValid.length > 0) {
      status = "pass";
    } else if (anyUsable.length > 0) {
      status = "partial";
      fix = "Shopping service present but missing schema URL or using a non-standard transport.";
    } else {
      status = "partial";
      fix = "Shopping service declared but endpoint/transport invalid; provide a resolvable REST/MCP/A2A endpoint.";
    }
  }
  // NOTE: endpoint *reachability* is a separate signal (endpoint_reachability, Cat 3).

  return {
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: { services: analyzed },
    fix_summary: fix,
  };
}

export function sig_namespace_authority_valid(m: ManifestState): SignalRow {
  const def = getDef("ucp_namespace_authority_valid");
  const ucp = m.parsed?.ucp;

  // Collect all spec/schema URLs across services + capabilities.
  const urls: string[] = [];
  const collect = (container: any) => {
    if (!container) return;
    for (const key of Object.keys(container)) {
      const arr = container[key];
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (e?.spec) urls.push(e.spec);
          if (e?.schema) urls.push(e.schema);
        }
      }
    }
  };
  collect(ucp?.services);
  collect(ucp?.capabilities);

  const checked = urls.map((u) => ({ url: u, authority_ok: VALID_AUTHORITY_HOSTS.has(hostOf(u) ?? "") }));

  let status: SignalRow["status"];
  let fix: string | null = null;

  if (checked.length === 0) {
    // Nothing to validate (e.g., no manifest / no spec URLs). Don't penalize —
    // drop out of denominator. The missing manifest is already caught elsewhere.
    status = "not_applicable";
  } else if (checked.every((c) => c.authority_ok)) {
    status = "pass";
  } else if (checked.some((c) => c.authority_ok)) {
    status = "partial";
    fix = "Some spec/schema URLs are not on the canonical UCP authority (ucp.dev). Correct them.";
  } else {
    status = "fail";
    fix = "spec/schema URLs must originate from the correct namespace authority (ucp.dev).";
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
    evidence_json: { urls_checked: checked },
    fix_summary: fix,
  };
}

/** True JWK-shape check: a non-null object (not an array) with a string,
 *  non-empty `kty` field. Presence + basic shape only — this is not real
 *  cryptographic/algorithm validation (out of scope; see manifestChecks.ts's
 *  sibling checks, e.g. endpoint_is_url just resolves a host, it doesn't
 *  probe the endpoint). */
function looksLikeJwk(x: unknown): boolean {
  return !!x && typeof x === "object" && !Array.isArray(x) && typeof (x as any).kty === "string" && (x as any).kty.length > 0;
}

function isValidJwkArray(x: unknown): boolean {
  return Array.isArray(x) && x.length > 0 && x.every(looksLikeJwk);
}

function hasArrayContent(x: unknown): boolean {
  return Array.isArray(x) && x.length > 0;
}

/** v2026-04-08 moved signing_keys from nested `ucp.signing_keys` to the
 *  document root (a sibling of `ucp`). Third-party validators report this
 *  relocation as the #1 real-world validation defect — stores that upgraded
 *  their declared ucp.version but never moved the array. OPTIONAL but
 *  RECOMMENDED per spec: genuine absence is not non-compliance, so it scores
 *  not_applicable (advisory via signal_evidence.merchant_note), never fail —
 *  same pattern as sig_namespace_authority_valid's "nothing to check" case. */
export function sig_signing_keys_present(m: ManifestState): SignalRow {
  const def = getDef("ucp_signing_keys_present");
  const rootKeys = m.parsed?.signing_keys;
  const nestedKeys = m.parsed?.ucp?.signing_keys;

  const rootPresent = rootKeys !== undefined && rootKeys !== null;
  const nestedPresent = nestedKeys !== undefined && nestedKeys !== null;
  const rootValid = isValidJwkArray(rootKeys);
  // "absent/empty" per spec — undefined/null OR a present-but-empty array;
  // any OTHER malformed root shape (string, non-empty array of bad objects)
  // takes priority as "malformed", even if nested also has content.
  const rootAbsentOrEmpty = !rootPresent || (Array.isArray(rootKeys) && rootKeys.length === 0);

  let status: SignalRow["status"];
  let fix: string | null = null;

  if (rootValid) {
    status = "pass";
  } else if (hasArrayContent(nestedKeys) && rootAbsentOrEmpty) {
    status = "partial";
    fix =
      "signing_keys are nested under `ucp` (pre-2026-04-08 location). v2026-04-08 requires them at the document root, as a sibling of `ucp`. Move the signing_keys array to the top level of the manifest.";
  } else if (rootPresent) {
    status = "partial";
    fix = "signing_keys must be a non-empty array of JWK objects (each with at least a `kty` field).";
  } else {
    // No signing_keys anywhere. Advisory only — see signal_evidence.merchant_note.
    status = "not_applicable";
  }

  const location: "root" | "nested" | "none" = rootPresent ? "root" : nestedPresent ? "nested" : "none";
  const keyCount = rootPresent ? (Array.isArray(rootKeys) ? rootKeys.length : 0) : nestedPresent ? (Array.isArray(nestedKeys) ? nestedKeys.length : 0) : 0;

  return {
    pillar: def.pillar,
    category: def.category,
    signal_key: def.signal_key,
    status,
    weight: def.weight,
    score_contribution: contribution(def.weight, status),
    impact: def.impact,
    effort: def.effort,
    evidence_json: {
      root_present: rootPresent,
      nested_present: nestedPresent,
      root_is_valid_jwk_array: rootValid,
      location,
      key_count: keyCount,
    },
    fix_summary: fix,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: fetch once, run all Category-1 signals, return rows.
// ---------------------------------------------------------------------------

export async function runManifestChecks(domain: string, fetcher: Fetcher): Promise<{
  manifest: ManifestState;
  signals: SignalRow[];
}> {
  const manifest = await fetchManifest(domain, fetcher);
  const signals = [
    sig_manifest_present(manifest),
    sig_version_declared(manifest),
    sig_services_declared(manifest),
    sig_namespace_authority_valid(manifest),
    sig_signing_keys_present(manifest),
  ];
  return { manifest, signals };
}

/** True when there's no manifest to score at all (unreachable or 404) — distinct
 *  from a manifest that's present but scores poorly (e.g. malformed JSON, wrong
 *  content-type). Lets the caller mark the run with a distinct status ('no_manifest')
 *  instead of a punitive 0%, so "hasn't started UCP" and "scored zero" don't collapse
 *  into the same number on a dashboard. */
export function isManifestMissing(m: ManifestState): boolean {
  return !m.reachable || m.httpStatus === 404;
}
