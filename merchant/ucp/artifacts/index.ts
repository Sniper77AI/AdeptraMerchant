/**
 * Adeptra Merchant — Artifact orchestrator.
 *
 * Runs each artifact generator over a shared ArtifactContext, returning every
 * non-null draft. Seven generators today: ucp_manifest, feed_fix,
 * content_rewrite, mcp_scaffold (the UCP pillar's fixes), and robots_patch,
 * llms_txt, jsonld (the agent_readability pillar's fixes — see
 * robotsPatchArtifact.ts / llmsTxtArtifact.ts / jsonldArtifact.ts for the
 * honesty rules each one follows). Every generator takes the same
 * ArtifactContext, so adding one never requires changing runArtifacts()'s
 * signature again.
 *
 * ASYNC: content_rewrite is the first impure/async generator (it fetches
 * pages and calls an LLM), so runArtifacts is async and awaits each
 * generator — the other six pure/sync generators need no changes; a
 * non-Promise return value awaits to itself.
 */

import { generateManifestArtifact } from "./manifestArtifact.ts";
import { generateFeedArtifact } from "./feedArtifact.ts";
import { generateContentRewriteArtifact } from "./contentRewriteArtifact.ts";
import { generateMcpScaffoldArtifact } from "./mcpScaffoldArtifact.ts";
import { generateRobotsPatchArtifact } from "./robotsPatchArtifact.ts";
import { generateLlmsTxtArtifact } from "./llmsTxtArtifact.ts";
import { generateJsonldArtifact } from "./jsonldArtifact.ts";
import type { ArtifactContext, ArtifactDraft } from "./types.ts";

export type { ArtifactType, ArtifactChangelog, ArtifactDraft, ArtifactContext, ArtifactFile, ArtifactFileTree, SignalEvidenceRow } from "./types.ts";
export { encodeFileTree, decodeFileTree } from "./types.ts";
export { generateManifestArtifact } from "./manifestArtifact.ts";
export { generateFeedArtifact } from "./feedArtifact.ts";
export { generateContentRewriteArtifact } from "./contentRewriteArtifact.ts";
export { generateMcpScaffoldArtifact } from "./mcpScaffoldArtifact.ts";
export { generateRobotsPatchArtifact } from "./robotsPatchArtifact.ts";
export { generateLlmsTxtArtifact, extractSiteName, extractSiteDescription } from "./llmsTxtArtifact.ts";
export { generateJsonldArtifact } from "./jsonldArtifact.ts";

export async function runArtifacts(ctx: ArtifactContext): Promise<ArtifactDraft[]> {
  const drafts: ArtifactDraft[] = [];
  const manifestDraft = generateManifestArtifact(ctx);
  if (manifestDraft) drafts.push(manifestDraft);
  const feedDraft = generateFeedArtifact(ctx);
  if (feedDraft) drafts.push(feedDraft);
  const contentDraft = await generateContentRewriteArtifact(ctx);
  if (contentDraft) drafts.push(contentDraft);
  const mcpScaffoldDraft = generateMcpScaffoldArtifact(ctx);
  if (mcpScaffoldDraft) drafts.push(mcpScaffoldDraft);
  const robotsPatchDraft = generateRobotsPatchArtifact(ctx);
  if (robotsPatchDraft) drafts.push(robotsPatchDraft);
  const llmsTxtDraft = generateLlmsTxtArtifact(ctx);
  if (llmsTxtDraft) drafts.push(llmsTxtDraft);
  const jsonldDraft = generateJsonldArtifact(ctx);
  if (jsonldDraft) drafts.push(jsonldDraft);
  return drafts;
}
