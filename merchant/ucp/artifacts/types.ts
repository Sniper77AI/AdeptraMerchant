/**
 * Adeptra Merchant — Shared artifact types.
 *
 * ArtifactContext exists so generators can receive new inputs without ever
 * changing runArtifacts()'s signature again: add a field here, read it in the
 * generator that needs it, every other generator and the orchestrator stay
 * untouched. This is the fix for having to re-plumb manifest+feed+signals
 * through runLive.ts by hand every time a second generator needed a new input.
 */

import type { ManifestState, SignalRow, Fetcher } from "../manifestChecks.ts";
import type { FeedState } from "../feedChecks.ts";
import type { LlmClient } from "../llmChecks.ts";
import type { RobotsTxtState, ParsedRobots } from "../readabilityChecks.ts";
import type { HomepageState } from "../policyChecks.ts";

/** Union, extensible — each generator still returns one literal member of this. */
export type ArtifactType = "ucp_manifest" | "feed_fix" | "content_rewrite" | "mcp_scaffold" | "robots_patch" | "llms_txt" | "jsonld";

/** signal_evidence row shape — defined here (not imported from
 *  supabaseSink.ts) to avoid a types.ts -> supabaseSink.ts -> artifacts/
 *  index.ts -> types.ts type cycle; supabaseSink.ts imports this one back. */
export interface SignalEvidenceRow {
  signal_key: string;
  basis: string;
  merchant_note: string | null;
}

export interface ArtifactChangelog {
  added: string[];
  corrected: string[];
  must_complete: string[];
  flagged: string[];
}

export interface ArtifactDraft {
  artifact_type: ArtifactType;
  target_url: string;
  content: string;
  resolves_signal_keys: string[];
  changelog: ArtifactChangelog;
}

export interface ArtifactContext {
  manifest: ManifestState;
  feed: FeedState | null; // null when no feed_url is configured for the site
  signals: SignalRow[];
  // Optional — used only by impure/async generators (e.g. contentRewriteArtifact.ts).
  // Pure generators (manifest, feed) ignore these; adding a field here instead of
  // widening runArtifacts()'s signature is the whole point of this context object.
  fetcher?: Fetcher;
  llm?: LlmClient | null;
  rootUrl?: string;
  // Known platform (e.g. "woocommerce", "shopify", "custom") from sites.platform —
  // an onboarding-declared fact, never guessed/detected here. Platform-gated
  // generators (mcpScaffoldArtifact.ts) return null when this doesn't match,
  // rather than generating a scaffold for a platform that hasn't been confirmed.
  platform?: string;
  // Already-fetched agent_readability state (readabilityChecks.ts's
  // runReadabilityChecks), for robotsPatchArtifact.ts / jsonldArtifact.ts —
  // never re-fetched. Optional: absent when a run's manifest/feed checks ran
  // but readability checks didn't (shouldn't happen via pipeline.ts today,
  // but keeps this context type honest about what's guaranteed).
  robots?: RobotsTxtState;
  parsedRobots?: ParsedRobots;
  homepage?: HomepageState;
  // signal_evidence rows, fetched ONCE by pipeline.ts and injected here — the
  // one DB read every new readability-artifact generator needs (merchant_note
  // text), kept out of the generators themselves so they stay pure functions.
  signalEvidence?: Map<string, SignalEvidenceRow>;
}

// ---------------------------------------------------------------------------
// Multi-file artifact payload — a tagged, versioned JSON shape stored directly
// in ArtifactDraft.content (the `artifacts` table has one `content` text
// column; no new column needed). Detected by this stable tag, NOT by
// artifact_type, so any future multi-file generator gets zip-expansion in
// reportBuilder.ts for free. See mcpScaffoldArtifact.ts for the first user.
// ---------------------------------------------------------------------------

export interface ArtifactFile {
  path: string; // relative path within the artifact's folder, e.g. "src/server.ts"
  contents: string;
}

export interface ArtifactFileTree {
  adeptra_file_tree: true;
  version: 1;
  files: ArtifactFile[];
}

export function encodeFileTree(files: ArtifactFile[]): string {
  const tree: ArtifactFileTree = { adeptra_file_tree: true, version: 1, files };
  return JSON.stringify(tree);
}

/** Safely decodes content as an ArtifactFileTree, or returns null if it isn't
 *  one (not JSON, or JSON without the tag) — never throws. */
export function decodeFileTree(content: string): ArtifactFileTree | null {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed && parsed.adeptra_file_tree === true && Array.isArray(parsed.files)) {
    return parsed as ArtifactFileTree;
  }
  return null;
}
