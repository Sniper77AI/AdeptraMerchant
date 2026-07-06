/**
 * Adeptra Merchant — Artifact orchestrator.
 *
 * Runs each artifact generator over a run's already-computed ManifestState +
 * SignalRow[], returning every non-null draft. Today: only the UCP manifest
 * generator. Future artifact types (feed_fix, jsonld, llms_txt, robots_patch,
 * content_rewrite) are sibling modules added here, not folded into this file.
 */

import type { ManifestState, SignalRow } from "../manifestChecks.ts";
import { generateManifestArtifact, type ArtifactDraft } from "./manifestArtifact.ts";

export type { ArtifactDraft, ArtifactChangelog } from "./manifestArtifact.ts";
export { generateManifestArtifact } from "./manifestArtifact.ts";

export function runArtifacts(manifest: ManifestState, signals: SignalRow[]): ArtifactDraft[] {
  const drafts: ArtifactDraft[] = [];
  const manifestDraft = generateManifestArtifact(manifest, signals);
  if (manifestDraft) drafts.push(manifestDraft);
  return drafts;
}
