/**
 * Adeptra Merchant — UCP Manifest Check Group (Category 1: Discovery & Manifest)
 *
 * PORTABILITY CONTRACT (the whole point of how this is structured):
 *  - `fetchManifest` is the ONLY function that touches the network. It takes an
 *    injectable `fetcher`, so tests pass a mock and production passes real HTTP.
 *  - The four signal functions are PURE: (manifestState) -> SignalRow. No I/O.
 *  - Nothing here imports n8n or Supabase. It runs verbatim inside an n8n code
 *    node today and lifts into a standalone worker later, unchanged.
 *
 * Grounded against UCP spec version 2026-04-08 (ucp.dev) — real field names:
 *   ucp.version, ucp.services["dev.ucp.shopping"], ucp.capabilities, spec/schema URLs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row destined for the Supabase `signals` table. run_id + priority_score are
 *  added/derived at insert time, so they are intentionally absent here. */
export interface SignalRow {
  pillar: "ucp";
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
const CURRENT_UCP_VERSION = "2026-04-08";

/** Legitimate namespace authority hosts for spec/schema URLs. */
const VALID_AUTHORITY_HOSTS = new Set(["ucp.dev"]);

const ALLOWED_TRANSPORTS = new Set(["rest", "mcp", "a2a"]);

// Per-signal weights/impact/effort (from the signal spec doc).
const W = {
  present: { weight: 3.0, impact: 5, effort: 2 },
  version: { weight: 1.5, impact: 4, effort: 1 },
  services: { weight: 2.5, impact: 5, effort: 3 },
  namespace: { weight: 1.0, impact: 3, effort: 1 },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contribution(weight: number, status: SignalRow["status"]): number {
  if (status === "pass") return weight;
  if (status === "partial") return weight / 2;
  return 0; // fail or not_applicable earn nothing
}

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
  const cfg = W.present;
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
    pillar: "ucp",
    category: "discovery_manifest",
    signal_key: "ucp_manifest_present",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
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
  const cfg = W.version;
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
    pillar: "ucp",
    category: "discovery_manifest",
    signal_key: "ucp_manifest_version_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: {
      declared_version: declared ?? null,
      is_current: declared === CURRENT_UCP_VERSION,
      supported_versions_map: supportedVersionsMap,
    },
    fix_summary: fix,
  };
}

export function sig_services_declared(m: ManifestState): SignalRow {
  const cfg = W.services;
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
    pillar: "ucp",
    category: "discovery_manifest",
    signal_key: "ucp_services_declared",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { services: analyzed },
    fix_summary: fix,
  };
}

export function sig_namespace_authority_valid(m: ManifestState): SignalRow {
  const cfg = W.namespace;
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
    pillar: "ucp",
    category: "discovery_manifest",
    signal_key: "ucp_namespace_authority_valid",
    status,
    weight: cfg.weight,
    score_contribution: contribution(cfg.weight, status),
    impact: cfg.impact,
    effort: cfg.effort,
    evidence_json: { urls_checked: checked },
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
  ];
  return { manifest, signals };
}
