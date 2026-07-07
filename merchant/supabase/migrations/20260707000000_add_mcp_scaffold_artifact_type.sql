-- Adds 'mcp_scaffold' to the artifacts.artifact_type check constraint —
-- the WooCommerce MCP Shopping Server scaffold generator (artifact_type =
-- 'mcp_scaffold'), a multi-file artifact whose content is a tagged JSON
-- file-tree (see merchant/ucp/artifacts/types.ts: ArtifactFileTree).
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_artifact_type_check;
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_artifact_type_check
  CHECK (artifact_type IN ('jsonld', 'llms_txt', 'ucp_manifest', 'feed_fix',
                            'content_rewrite', 'robots_patch', 'mcp_scaffold'));
