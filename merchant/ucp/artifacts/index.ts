/**
 * Adeptra Merchant — Artifact orchestrator.
 *
 * Runs each artifact generator over a shared ArtifactContext, returning every
 * non-null draft. Today: the UCP manifest generator, the feed_fix generator,
 * and the content_rewrite generator. Future artifact types (jsonld, llms_txt,
 * robots_patch) are sibling modules added here, not folded into this file —
 * and since every generator takes the same ArtifactContext, adding one never
 * requires changing runArtifacts()'s signature again.
 *
 * ASYNC: content_rewrite is the first impure/async generator (it fetches
 * pages and calls an LLM), so runArtifacts is async and awaits each
 * generator — the existing pure/sync generators (manifest, feed) need no
 * changes; a non-Promise return value awaits to itself.
 */

import { generateManifestArtifact } from "./manifestArtifact.ts";
import { generateFeedArtifact } from "./feedArtifact.ts";
import { generateContentRewriteArtifact } from "./contentRewriteArtifact.ts";
import type { ArtifactContext, ArtifactDraft } from "./types.ts";

export type { ArtifactType, ArtifactChangelog, ArtifactDraft, ArtifactContext } from "./types.ts";
export { generateManifestArtifact } from "./manifestArtifact.ts";
export { generateFeedArtifact } from "./feedArtifact.ts";
export { generateContentRewriteArtifact } from "./contentRewriteArtifact.ts";

export async function runArtifacts(ctx: ArtifactContext): Promise<ArtifactDraft[]> {
  const drafts: ArtifactDraft[] = [];
  const manifestDraft = generateManifestArtifact(ctx);
  if (manifestDraft) drafts.push(manifestDraft);
  const feedDraft = generateFeedArtifact(ctx);
  if (feedDraft) drafts.push(feedDraft);
  const contentDraft = await generateContentRewriteArtifact(ctx);
  if (contentDraft) drafts.push(contentDraft);
  return drafts;
}
