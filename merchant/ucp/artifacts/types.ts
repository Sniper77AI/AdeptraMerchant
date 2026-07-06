/**
 * Adeptra Merchant — Shared artifact types.
 *
 * ArtifactContext exists so generators can receive new inputs without ever
 * changing runArtifacts()'s signature again: add a field here, read it in the
 * generator that needs it, every other generator and the orchestrator stay
 * untouched. This is the fix for having to re-plumb manifest+feed+signals
 * through runLive.ts by hand every time a second generator needed a new input.
 */

import type { ManifestState, SignalRow } from "../manifestChecks.ts";
import type { FeedState } from "../feedChecks.ts";

/** Union, extensible — each generator still returns one literal member of this. */
export type ArtifactType = "ucp_manifest" | "feed_fix";

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
}
