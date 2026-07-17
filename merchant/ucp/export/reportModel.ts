/**
 * Adeptra Merchant — the pure report MODEL (PURE: no DB, no HTML, no
 * secrets, no Node-only APIs). Extracted from reportBuilder.ts (Stage 3,
 * 2026-07-12) so the dashboard can import the exact same model-building
 * logic the downloadable report uses — one source of truth for "what a
 * report/store view shows and how it's grouped/sorted," never two
 * implementations that could drift. reportBuilder.ts (HTML/markdown
 * rendering) imports from here; it no longer defines any of this itself.
 *
 * Cross-directory import note: this file is imported directly by
 * dashboard/ (a separate Next.js app) via a relative path reaching outside
 * its project root — the same mechanism validated in Stage 2
 * (turbopack.root + allowImportingTsExtensions in dashboard/tsconfig.json).
 * That's exactly why this file must stay free of Node-only APIs: it needs
 * to run inside Next's bundler/runtime, not just plain Node.
 */

import type { PillarScoreRow } from "../scorer.ts";
import type { ArtifactChangelog } from "../artifacts/types.ts";
import { decodeFileTree } from "../artifacts/types.ts";

// ---------------------------------------------------------------------------
// Input contract (supabaseSink.fetchRunBundleData conforms to this; the
// dashboard builds an object of this exact shape from its own RLS queries —
// see dashboard/lib/runBundle.ts)
// ---------------------------------------------------------------------------

export interface RunBundleSignal {
  signal_key: string;
  pillar: string;
  category: string;
  status: "pass" | "partial" | "fail" | "not_applicable";
  weight: number;
  priority_score: number;
  fix_summary: string | null;
  // From signal_evidence — joined by signal_key at read time, not snapshotted
  // onto the signals row (basis is a fact about external evidence, which can
  // be revised after the run; looking it up fresh keeps every re-render
  // current without ever mutating a completed run's scored signals).
  basis: string | null;
  merchant_note: string | null;
}

export interface RunBundleArtifact {
  artifact_type: string;
  target_url: string | null;
  content: string | null;
  changelog: ArtifactChangelog | null;
  resolves_signal_ids: string[] | null;
}

export interface RunBundleData {
  runId: string;
  siteId: string; // not used by rendering — carried through for storageSink's exports-row insert
  domain: string;
  status: string; // 'complete' | 'no_manifest' | 'failed' | ...
  createdAt: string;
  pillars: PillarScoreRow[];
  signals: RunBundleSignal[];
  artifacts: RunBundleArtifact[];
}

// ---------------------------------------------------------------------------
// artifact_type -> friendly name (add one line per new type; unknown types
// still get a reasonable auto-generated name via the fallback)
// ---------------------------------------------------------------------------

const ARTIFACT_TYPE_DISPLAY_NAMES: Record<string, string> = {
  ucp_manifest: "UCP Manifest",
  feed_fix: "Product Feed Fix (Supplemental Feed)",
  jsonld: "Structured Data (JSON-LD)",
  llms_txt: "llms.txt",
  robots_patch: "robots.txt Patch",
  content_rewrite: "Content Rewrite",
  mcp_scaffold: "WooCommerce MCP Shopping Server",
};

// ---------------------------------------------------------------------------
// pillar -> friendly section name + exact claim sentence. aeo_geo isn't
// listed: it's an intentionally empty pillar (see README) and never appears
// in real signal data, so it never needs a display name here.
//
// NO COMPOSITE: these two pillars measure non-commensurable things — whether
// agents can reach/read/understand a store at all (searchable) vs. whether an
// agent can actually transact with it (buyable). They are always shown side
// by side, each labeled with its own claim, never averaged into one number.
// See scorer.ts's header comment for why.
// ---------------------------------------------------------------------------

export const PILLAR_DISPLAY_NAMES: Record<string, string> = {
  ucp: "UCP Protocol Compliance",
  agent_readability: "Agent Readability",
};

export const PILLAR_DESCRIPTIONS: Record<string, string> = {
  agent_readability: "Can AI systems reach, read, and correctly understand your store?",
  ucp: "Can an AI shopping agent actually transact with your store?",
};

// agent_readability first: it's the precondition ("searchable") for
// everything ucp ("buyable") measures. Any pillar not listed here (a future
// aeo_geo, once it's ever populated) falls back to first-seen order.
export const PILLAR_DISPLAY_ORDER = ["agent_readability", "ucp"];

export function canonicalPillarOrder(pillarKeys: string[]): string[] {
  const seen: string[] = [];
  for (const p of pillarKeys) if (!seen.includes(p)) seen.push(p);
  const known = PILLAR_DISPLAY_ORDER.filter((p) => seen.includes(p));
  const rest = seen.filter((p) => !PILLAR_DISPLAY_ORDER.includes(p));
  return [...known, ...rest];
}

export function pillarDisplayName(pillar: string): string {
  return PILLAR_DISPLAY_NAMES[pillar] ?? pillar;
}

export function typeDisplayName(artifactType: string): string {
  if (ARTIFACT_TYPE_DISPLAY_NAMES[artifactType]) return ARTIFACT_TYPE_DISPLAY_NAMES[artifactType];
  return artifactType
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Derives a sensible in-zip filename from an artifact's target_url.
 *  - "/.well-known/ucp" (a served path with no extension) has a dedicated name.
 *  - No leading slash means "upload artifact, already a good relative path"
 *    (see manifestArtifact.ts / feedArtifact.ts's target_url convention) — used as-is.
 *  - Any other served path (leading slash): stripped and flattened.
 *  - No target_url at all: falls back to the artifact type. */
export function filenameForArtifact(artifactType: string, targetUrl: string | null): string {
  if (targetUrl === "/.well-known/ucp") return "ucp-manifest.json";
  if (!targetUrl) return `${artifactType}.txt`;
  if (!targetUrl.startsWith("/")) return targetUrl;
  const stripped = targetUrl.replace(/^\/+/, "");
  return stripped.includes(".") ? stripped.replace(/\//g, "-") : `${stripped.replace(/\//g, "-")}.txt`;
}

// ---------------------------------------------------------------------------
// Report model (shared by markdown + html rendering, and by the dashboard's
// React rendering — this IS the anti-drift core)
// ---------------------------------------------------------------------------

export interface ReportArtifact {
  artifactType: string;
  displayName: string;
  filename: string;
  changelog: ArtifactChangelog | null;
  fileList?: string[]; // set only for multi-file (file-tree) artifacts — see decodeFileTree
}

/** One section per pillar present in the run's signals, in first-seen order
 *  (pipeline.ts pushes ucp signals before agent_readability's, so this falls
 *  out naturally — no hardcoded pillar list to keep in sync). */
export interface PillarSection {
  pillar: string;
  displayName: string;
  description: string;
  passing: RunBundleSignal[];
  toFix: RunBundleSignal[]; // fail/partial, sorted by priority_score desc
  // not_applicable signals that carry a merchant_note — an optional-but-
  // recommended signal (e.g. ucp_signing_keys_present with no keys declared
  // anywhere) genuinely isn't non-compliance, so it must not appear in toFix
  // or drag the score, but a note worth reading shouldn't silently vanish
  // either. Added 2026-07-13; deliberately distinct from OTHER not_applicable
  // signals with no note (e.g. an attested opt-out) — those stay unlisted,
  // exactly as before, since there's nothing to recommend.
  advisories: RunBundleSignal[];
}

export interface ReportModel {
  domain: string;
  runId: string;
  createdAt: string;
  hasManifest: boolean; // false => no_manifest — the ucp pillar shows "hasn't started" framing instead of its score; agent_readability is unaffected, it's measurable either way
  pillars: PillarScoreRow[]; // canonical order (agent_readability, ucp), real numbers always — never suppressed
  sections: PillarSection[];
  artifacts: ReportArtifact[];
}

export function buildSections(data: RunBundleData): PillarSection[] {
  const pillarKeys = canonicalPillarOrder(data.signals.map((s) => s.pillar));
  return pillarKeys.map((pillar) => {
    const pillarSignals = data.signals.filter((s) => s.pillar === pillar);
    return {
      pillar,
      displayName: pillarDisplayName(pillar),
      description: PILLAR_DESCRIPTIONS[pillar] ?? "",
      passing: pillarSignals.filter((s) => s.status === "pass"),
      toFix: pillarSignals
        .filter((s) => s.status === "fail" || s.status === "partial")
        .slice()
        .sort((a, b) => b.priority_score - a.priority_score),
      advisories: pillarSignals.filter((s) => s.status === "not_applicable" && !!s.merchant_note),
    };
  });
}

export function buildModel(data: RunBundleData): ReportModel {
  const sections = buildSections(data);
  const artifacts = data.artifacts.map((a) => {
    const fileTree = a.content ? decodeFileTree(a.content) : null;
    return {
      artifactType: a.artifact_type,
      displayName: typeDisplayName(a.artifact_type),
      filename: fileTree ? `${a.target_url ?? a.artifact_type}/` : filenameForArtifact(a.artifact_type, a.target_url),
      changelog: a.changelog,
      fileList: fileTree ? fileTree.files.map((f) => f.path) : undefined,
    };
  });

  const pillarKeyOrder = canonicalPillarOrder(data.pillars.map((p) => p.pillar));
  const orderedPillars = pillarKeyOrder.map((k) => data.pillars.find((p) => p.pillar === k)!).filter(Boolean);

  return {
    domain: data.domain,
    runId: data.runId,
    createdAt: data.createdAt,
    hasManifest: data.status !== "no_manifest",
    pillars: orderedPillars,
    sections,
    artifacts,
  };
}
