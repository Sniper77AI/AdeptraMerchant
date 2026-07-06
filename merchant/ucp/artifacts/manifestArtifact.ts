/**
 * Adeptra Merchant — UCP Manifest Artifact Generator (artifact_type = 'ucp_manifest').
 *
 * PURE module: no network, no DB, no secrets, no n8n/Supabase imports. Takes
 * an ArtifactContext (manifest + feed + signals — see ./types.ts) and returns
 * a draft artifact (or null if there's nothing to fix) — same portability
 * contract as every signal-check module. Only reads ctx.manifest/ctx.signals;
 * ctx.feed is unused here (it's feedArtifact.ts's input).
 *
 * SCOPE: only signals whose fix lives INSIDE the manifest file — Category 1
 * (discovery_manifest) + the Category 3 capability *declarations*.
 * endpoint_reachability is a property of the merchant's live server, not the
 * manifest, so it's flag-only here (signal-specs.md is explicit about this).
 *
 * CRITICAL HONESTY RULE: never craft the manifest to LOOK compliant when it
 * isn't. Auto-fixes use real canonical values and only ever touch fields tied
 * to a fail/partial signal — existing valid config (including a passing
 * sub-capability shape like catalog.search/.lookup) is preserved untouched.
 * Anything that depends on merchant infrastructure (the service endpoint) is
 * an obvious placeholder listed in changelog.must_complete, never fabricated.
 * identity_linking is never auto-added/auto-filled — it's a merchant
 * preference signal, not a structural gap — flagged only, on both fail and
 * partial (a guessed scope is still a guess).
 */

import { CURRENT_UCP_VERSION, VALID_AUTHORITY_HOSTS, ALLOWED_TRANSPORTS, type SignalRow } from "../manifestChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";

// ---------------------------------------------------------------------------
// Canonical values (verified against signal-specs.md — the spec doc gives the
// authority host and version but no literal example URLs, so these match the
// project's existing mock-fixture convention in test.ts / test_live_pipeline.ts).
// Centralized here in one block; nothing below re-hardcodes a literal URL.
// ---------------------------------------------------------------------------

const CANONICAL_AUTHORITY_HOST = Array.from(VALID_AUTHORITY_HOSTS)[0]!; // "ucp.dev"
const SERVICE_SPEC_URL = "https://ucp.dev/specification/overview";
const SERVICE_SCHEMA_URL = `https://ucp.dev/${CURRENT_UCP_VERSION}/services/shopping/rest.openapi.json`;
const ENDPOINT_PLACEHOLDER = "https://REPLACE-WITH-YOUR-UCP-ENDPOINT.example/ucp/v1";
const SHOPPING_SERVICE_KEY = "dev.ucp.shopping";

type CapabilityName = "checkout" | "cart" | "catalog" | "fulfillment";

const CAPABILITY_KEYS: Record<CapabilityName, string> = {
  checkout: "dev.ucp.shopping.checkout",
  cart: "dev.ucp.shopping.cart",
  catalog: "dev.ucp.shopping.catalog",
  fulfillment: "dev.ucp.shopping.fulfillment",
};

const CAPABILITY_SIGNAL_KEYS: Record<CapabilityName, string> = {
  checkout: "capability_checkout_declared",
  cart: "capability_cart_declared",
  catalog: "capability_catalog_declared",
  fulfillment: "capability_fulfillment_declared",
};

function capabilitySpecUrl(name: CapabilityName): string {
  return `https://ucp.dev/specification/${name}`;
}

function capabilitySchemaUrl(name: CapabilityName): string {
  return `https://ucp.dev/${CURRENT_UCP_VERSION}/schemas/shopping/${name}.json`;
}

/** Pathnames we recognize as "canonical" for the namespace-authority rewrite
 *  pass — a non-ucp.dev URL is only host-rewritten when its path matches one
 *  of these exactly; otherwise we can't verify a correct replacement, so we
 *  flag it instead of guessing. */
function canonicalPathnames(): Set<string> {
  const urls = [SERVICE_SPEC_URL, SERVICE_SCHEMA_URL];
  for (const name of Object.keys(CAPABILITY_KEYS) as CapabilityName[]) {
    urls.push(capabilitySpecUrl(name), capabilitySchemaUrl(name));
  }
  return new Set(urls.map((u) => new URL(u).pathname));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

function needsFix(s: SignalRow | undefined): boolean {
  return s?.status === "fail" || s?.status === "partial";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Rewrites a spec/schema URL's host to the canonical authority ONLY when its
 *  path exactly matches a canonical pathname we recognize. Otherwise leaves
 *  it untouched and records why in changelog.flagged — we never guess a
 *  replacement we can't verify. */
function rewriteAuthorityIfMappable(url: unknown, canonicalPaths: Set<string>, fieldLabel: string, changelog: ArtifactChangelog): unknown {
  if (typeof url !== "string" || !url) return url;
  const host = hostOf(url);
  if (!host || VALID_AUTHORITY_HOSTS.has(host)) return url; // already canonical, or unparseable — leave alone

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }

  if (canonicalPaths.has(pathname)) {
    const fixed = `https://${CANONICAL_AUTHORITY_HOST}${pathname}`;
    changelog.corrected.push(`${fieldLabel}: host corrected to ${CANONICAL_AUTHORITY_HOST} ("${url}" → "${fixed}")`);
    return fixed;
  }

  changelog.flagged.push(
    `${fieldLabel} ("${url}") is not on the canonical authority (${CANONICAL_AUTHORITY_HOST}) and doesn't match a recognized canonical path — verify and correct manually.`,
  );
  return url;
}

function fixAuthorityInContainer(container: any, containerLabel: string, canonicalPaths: Set<string>, changelog: ArtifactChangelog): void {
  if (!container || typeof container !== "object") return;
  for (const key of Object.keys(container)) {
    const arr = container[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.spec) entry.spec = rewriteAuthorityIfMappable(entry.spec, canonicalPaths, `["${key}"].spec`, changelog);
      if (entry.schema) entry.schema = rewriteAuthorityIfMappable(entry.schema, canonicalPaths, `["${key}"].schema`, changelog);
    }
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateManifestArtifact(ctx: ArtifactContext): ArtifactDraft | null {
  const { manifest, signals } = ctx;
  const sig = byKey(signals);
  const manifestPresent = sig.get("ucp_manifest_present");
  const versionDeclared = sig.get("ucp_manifest_version_declared");
  const servicesDeclared = sig.get("ucp_services_declared");
  const namespaceAuthority = sig.get("ucp_namespace_authority_valid");
  const endpointReachability = sig.get("endpoint_reachability");
  const identityLinking = sig.get("capability_identity_linking_declared");
  const capabilitySignals: Record<CapabilityName, SignalRow | undefined> = {
    checkout: sig.get(CAPABILITY_SIGNAL_KEYS.checkout),
    cart: sig.get(CAPABILITY_SIGNAL_KEYS.cart),
    catalog: sig.get(CAPABILITY_SIGNAL_KEYS.catalog),
    fulfillment: sig.get(CAPABILITY_SIGNAL_KEYS.fulfillment),
  };

  const anythingToFix =
    needsFix(manifestPresent) ||
    needsFix(versionDeclared) ||
    needsFix(servicesDeclared) ||
    needsFix(namespaceAuthority) ||
    (Object.values(capabilitySignals) as (SignalRow | undefined)[]).some(needsFix);
  // identity_linking / endpoint_reachability are flag-only — on their own
  // they don't warrant generating a manifest, since there's nothing to WRITE.
  if (!anythingToFix) return null;

  const changelog: ArtifactChangelog = { added: [], corrected: [], must_complete: [], flagged: [] };
  const resolvedKeys = new Set<string>();
  const noManifestAtAll = manifest.parsed == null;
  const ucp: any = noManifestAtAll ? {} : structuredClone(manifest.parsed.ucp ?? {});

  // --- ucp_manifest_present --------------------------------------------------
  if (noManifestAtAll) {
    changelog.added.push("the entire manifest (previously missing/unreachable)");
    resolvedKeys.add("ucp_manifest_present");
  } else if (manifestPresent?.status === "partial") {
    // Content parses fine; the issue is how it's SERVED (content-type/auth/
    // redirect) — a hosting/server config issue, not fixable by editing content.
    changelog.flagged.push(
      `Manifest content is valid, but how it's served has an issue (${manifestPresent.fix_summary ?? "see evidence"}) — this is a hosting/server configuration fix, not a manifest-content fix.`,
    );
  }

  // --- ucp_manifest_version_declared -----------------------------------------
  if (needsFix(versionDeclared) || noManifestAtAll) {
    const had = ucp.version;
    ucp.version = CURRENT_UCP_VERSION;
    if (had && had !== CURRENT_UCP_VERSION) changelog.corrected.push(`ucp.version: "${had}" → "${CURRENT_UCP_VERSION}"`);
    else if (!had) changelog.added.push(`ucp.version = "${CURRENT_UCP_VERSION}"`);
    resolvedKeys.add("ucp_manifest_version_declared");
  }

  // --- ucp_services_declared --------------------------------------------------
  if (needsFix(servicesDeclared) || noManifestAtAll) {
    ucp.services = ucp.services ?? {};
    const existing: any[] = Array.isArray(ucp.services[SHOPPING_SERVICE_KEY]) ? ucp.services[SHOPPING_SERVICE_KEY] : [];
    const isNewEntry = existing.length === 0;
    const entry: any = isNewEntry ? {} : { ...existing[0] };

    if (!entry.version || entry.version !== CURRENT_UCP_VERSION) {
      const had = entry.version;
      entry.version = CURRENT_UCP_VERSION;
      if (had) changelog.corrected.push(`services["${SHOPPING_SERVICE_KEY}"].version: "${had}" → "${CURRENT_UCP_VERSION}"`);
    }
    if (!entry.spec) {
      entry.spec = SERVICE_SPEC_URL;
      changelog.added.push(`services["${SHOPPING_SERVICE_KEY}"].spec`);
    }
    // Preserve an existing valid transport (rest/mcp/a2a) — only scaffolding
    // from scratch defaults to "rest"; we never downgrade a working mcp/a2a.
    if (!entry.transport || !ALLOWED_TRANSPORTS.has(entry.transport)) {
      const had = entry.transport;
      entry.transport = "rest";
      if (had) changelog.corrected.push(`services["${SHOPPING_SERVICE_KEY}"].transport: "${had}" → "rest"`);
      else changelog.added.push(`services["${SHOPPING_SERVICE_KEY}"].transport = "rest"`);
    }
    if (!entry.endpoint) {
      entry.endpoint = ENDPOINT_PLACEHOLDER;
      changelog.must_complete.push("Replace the placeholder shopping service endpoint with your real UCP endpoint URL.");
    }
    if (!entry.schema) {
      if (entry.transport === "rest") {
        entry.schema = SERVICE_SCHEMA_URL;
        changelog.added.push(`services["${SHOPPING_SERVICE_KEY}"].schema`);
      } else {
        changelog.flagged.push(
          `services["${SHOPPING_SERVICE_KEY}"] is missing a schema URL for transport "${entry.transport}" — no canonical schema pattern is known for non-REST transports; add one manually.`,
        );
      }
    }

    ucp.services[SHOPPING_SERVICE_KEY] = [entry, ...existing.slice(1)];
    if (isNewEntry) changelog.added.push(`services["${SHOPPING_SERVICE_KEY}"] entry`);
    resolvedKeys.add("ucp_services_declared");
  }

  // --- capabilities: checkout / cart / catalog / fulfillment ------------------
  // Only touches capabilities whose OWN signal is fail/partial — a passing
  // capability (e.g. catalog declared via .search/.lookup sub-capabilities)
  // is preserved byte-for-byte, never flattened/replaced.
  ucp.capabilities = ucp.capabilities ?? {};
  for (const name of Object.keys(CAPABILITY_KEYS) as CapabilityName[]) {
    const s = capabilitySignals[name];
    if (!needsFix(s)) continue;
    const key = CAPABILITY_KEYS[name];
    const existing: any[] = Array.isArray(ucp.capabilities[key]) ? ucp.capabilities[key] : [];

    if (existing.length === 0) {
      // Emit the flat key — the simplest valid form when generating from
      // scratch (detection separately also accepts split sub-capabilities,
      // but we don't invent that shape here).
      ucp.capabilities[key] = [{ version: CURRENT_UCP_VERSION, spec: capabilitySpecUrl(name), schema: capabilitySchemaUrl(name) }];
      changelog.added.push(`capabilities["${key}"]`);
    } else {
      const entry = { ...existing[0] };
      if (!entry.version) {
        entry.version = CURRENT_UCP_VERSION;
        changelog.corrected.push(`capabilities["${key}"].version added`);
      }
      if (!entry.schema) {
        entry.schema = capabilitySchemaUrl(name);
        changelog.corrected.push(`capabilities["${key}"].schema added`);
      }
      ucp.capabilities[key] = [entry, ...existing.slice(1)];
    }
    resolvedKeys.add(s!.signal_key);
  }

  // --- identity_linking: never auto-added/auto-filled — flag only ------------
  if (needsFix(identityLinking)) {
    changelog.flagged.push(
      identityLinking!.status === "fail"
        ? "Add dev.ucp.common.identity_linking only if you support account-linked experiences — not added automatically."
        : "dev.ucp.common.identity_linking is declared without scopes — add scopes (e.g. dev.ucp.shopping.order:read) only if you support account-linked experiences; not filled in automatically.",
    );
  }

  // --- namespace authority: rewrite host where the path is canonical ---------
  // Runs last, over the FINAL state — catches authority issues on entries we
  // didn't otherwise touch (e.g. a passing capability with a bad-authority URL).
  // Only counts as "resolved" if we actually corrected at least one URL —
  // if every offending URL got flagged instead (unmappable path), nothing
  // was fixed, so claiming resolution would be misleading.
  if (needsFix(namespaceAuthority)) {
    const correctedBefore = changelog.corrected.length;
    const canonicalPaths = canonicalPathnames();
    fixAuthorityInContainer(ucp.services, "services", canonicalPaths, changelog);
    fixAuthorityInContainer(ucp.capabilities, "capabilities", canonicalPaths, changelog);
    if (changelog.corrected.length > correctedBefore) resolvedKeys.add("ucp_namespace_authority_valid");
  }

  // --- endpoint_reachability: flag only, never touches the manifest ----------
  if (needsFix(endpointReachability)) {
    changelog.flagged.push("Endpoint reachability is a property of your live server, not the manifest file — verify the declared endpoint responds once it's live.");
  }

  return {
    artifact_type: "ucp_manifest",
    target_url: "/.well-known/ucp",
    content: JSON.stringify({ ucp }, null, 2),
    resolves_signal_keys: Array.from(resolvedKeys),
    changelog,
  };
}
