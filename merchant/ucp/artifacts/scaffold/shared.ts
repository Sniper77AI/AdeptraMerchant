/**
 * Adeptra Merchant — MCP scaffold: pieces genuinely identical across every
 * platform provider (currently woocommerce.ts, wix.ts). Anything here is
 * byte-identical output regardless of platform; keeping it in ONE place means
 * a future fix (like the loadEnv.ts import-order bug found live against
 * WooCommerce) applies to every platform automatically, instead of needing
 * the same patch copied into each provider file.
 */

import type { ArtifactContext, ArtifactFile } from "../types.ts";

/**
 * What a per-platform provider (woocommerce.ts, wix.ts) hands back to the
 * spine (mcpScaffoldArtifact.ts). The spine owns the ArtifactDraft shape and
 * the changelog lines that are genuinely identical across every platform
 * ("Deploy mcp-server/...", "...point your UCP manifest...", the payment-
 * boundary flagged line); each provider owns its own files and the
 * platform-specific changelog fragments slotted in around those shared lines.
 */
export interface ScaffoldProvider {
  files: ArtifactFile[];
  addedLines: string[]; // changelog.added — describes this platform's files
  setupMustComplete: string[]; // changelog.must_complete — platform-specific setup steps
  extraFlagged: string[]; // changelog.flagged — platform-specific flags beyond the shared payment-boundary line
}

export const TARGET_FOLDER = "mcp-server";
export const MCP_SDK_VERSION = "^1.29.0"; // @modelcontextprotocol/sdk — confirmed via npm registry, not guessed
export const ZOD_VERSION = "^3.25.0"; // matches the SDK's own accepted range (^3.25 || ^4.0)

/** Best-effort, honest label for a README only (never baked into src/* or
 *  .env.example, which use obvious placeholders exclusively). Falls back to a
 *  generic phrase rather than guessing when rootUrl is absent/unparsable. */
export function storeLabel(ctx: ArtifactContext): string {
  if (ctx.rootUrl) {
    try {
      return new URL(ctx.rootUrl).host;
    } catch {
      // fall through
    }
  }
  return "your store";
}

export function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          resolveJsonModule: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Comment block every provider's server.ts inserts once, right before its
 * tool registrations, explaining what the readOnlyHint/destructiveHint/
 * idempotentHint/openWorldHint annotations below do and don't mean. Quotes
 * the MCP SDK's own ToolAnnotations doc comment verbatim (src/types.ts,
 * @modelcontextprotocol/sdk) so nobody mistakes these for a security
 * boundary — they're a machine-readable statement of the boundary this
 * server's own code already enforces, not a replacement for it.
 */
export const TOOL_ANNOTATIONS_NOTE = `// Tool annotations (readOnlyHint/destructiveHint/idempotentHint/openWorldHint)
// below are HINTS, not a security boundary. Per the MCP SDK's own doc
// comment on ToolAnnotations: "all properties in ToolAnnotations are
// **hints**. They are not guaranteed to provide a faithful description of
// tool behavior (including descriptive properties like \`title\`). Clients
// should never make tool use decisions based on ToolAnnotations received
// from untrusted servers." They supplement this server's own code
// discipline (the payment boundary described above) — they never replace it.`;

/**
 * Shared UCP-protocol-conformance disclosure, verbatim across every
 * provider's README. Replaces an earlier, overstated line ("Its tools
 * follow the same catalog/cart vocabulary your UCP manifest declares") that
 * read as an interop claim without being one: this server's tool names and
 * cart/checkout model do NOT literally match UCP's own MCP transport
 * binding (docs/specification/{cart,catalog,checkout}-mcp.md in
 * Universal-Commerce-Protocol/ucp, verified directly, not guessed).
 *
 * Three concrete, disclosed divergences, plus what IS actually true (this
 * server genuinely satisfies Adeptra's own capability-declaration and
 * endpoint-reachability checks once deployed — verified against
 * capabilityChecks.ts: those checks read manifest JSON + probe HTTP
 * reachability, they don't require literal UCP MCP-transport conformance).
 */
export function ucpConformanceDisclosure(): string {
  return `## About UCP protocol conformance — what this server is, and isn't

This server's tools are inspired by UCP's shopping vocabulary, but this is a
**simplified, incremental-cart MCP server for direct MCP clients — not a
literal implementation of UCP's \`dev.ucp.shopping\` MCP transport binding.**
Three concrete divergences, disclosed here rather than left to discover the
hard way:

1. **Different tool names and a different cart model.** UCP's MCP binding
   defines canonical tools (\`search_catalog\`, \`create_cart\`/\`get_cart\`/
   \`update_cart\`/\`cancel_cart\`, \`create_checkout\`/.../\`complete_checkout\`)
   built around session-based, replace-style state — \`create_cart\` returns a
   cart id, and every later call submits the FULL desired cart state under
   that id, wrapped in a required \`meta.ucp-agent\` envelope. This server uses
   simpler, incremental tools instead (\`add_to_cart\`, \`update_cart_item\`,
   \`remove_cart_item\`, one implicit cart) — easier for a direct MCP client to
   drive, but not UCP's literal vocabulary or session model.
2. **Transport.** UCP's MCP binding requires HTTP transport with streaming
   (and recommends request signing on checkout completion). This server uses
   stdio — the standard "one local process per agent session" MCP deployment
   model, not a hosted HTTP service.
3. **No payment-carrying checkout-completion tool.** UCP's \`complete_checkout\`
   tool is defined to accept payment credentials and place the order. This
   server intentionally never implements anything like it — \`begin_checkout\`
   returns a checkout URL and stops there, on purpose, as this document's
   hard-boundary section above describes.

**What IS true:** deploying this server and pointing your UCP manifest's
\`dev.ucp.shopping\` endpoint at it genuinely satisfies Adeptra's own
capability-declaration and endpoint-reachability checks for checkout/cart/
catalog — those checks read your manifest's JSON and confirm the endpoint
responds; they don't require literal UCP MCP-transport conformance. A
strictly UCP-protocol-conformant agent, though, would need more than this
server provides today.
`;
}

export function loadEnvTs(): string {
  return `/**
 * Loads .env into process.env, if present, before anything else runs.
 *
 * MUST be the FIRST import in server.ts (not just textually first — ES
 * modules evaluate ALL static imports, in declaration order, before the
 * importing file's own top-level code runs). The platform client module
 * reads its required env vars at its own module top level, so if this file
 * were imported after it (or .env were loaded inline in server.ts instead of
 * via a dedicated first import), that check would run against an empty
 * environment even when a real .env file exists on disk. (Found live as a
 * real bug in the first WooCommerce scaffold — fixed once, here, for every
 * platform.)
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
}
`;
}
