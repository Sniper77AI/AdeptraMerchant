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
