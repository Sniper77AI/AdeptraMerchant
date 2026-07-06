/**
 * Adeptra Merchant — Artifact orchestrator.
 *
 * Runs each artifact generator over a shared ArtifactContext, returning every
 * non-null draft. Today: the UCP manifest generator and the feed_fix
 * generator. Future artifact types (jsonld, llms_txt, robots_patch,
 * content_rewrite) are sibling modules added here, not folded into this file
 * — and since every generator takes the same ArtifactContext, adding one
 * never requires changing runArtifacts()'s signature again.
 */

import { generateManifestArtifact } from "./manifestArtifact.ts";
import { generateFeedArtifact } from "./feedArtifact.ts";
import type { ArtifactContext, ArtifactDraft } from "./types.ts";

export type { ArtifactType, ArtifactChangelog, ArtifactDraft, ArtifactContext } from "./types.ts";
export { generateManifestArtifact } from "./manifestArtifact.ts";
export { generateFeedArtifact } from "./feedArtifact.ts";

export function runArtifacts(ctx: ArtifactContext): ArtifactDraft[] {
  const drafts: ArtifactDraft[] = [];
  const manifestDraft = generateManifestArtifact(ctx);
  if (manifestDraft) drafts.push(manifestDraft);
  const feedDraft = generateFeedArtifact(ctx);
  if (feedDraft) drafts.push(feedDraft);
  return drafts;
}
