/**
 * Adeptra Merchant — MCP Shopping Server scaffold generator
 * (artifact_type = 'mcp_scaffold').
 *
 * PURE module: no network, no LLM, no DB. Emits a deployable Node/TypeScript
 * MCP server that makes a store agent-shoppable — catalog search + cart
 * building — with payment explicitly handed off to the merchant's own
 * checkout. Adeptra GENERATES and CONFIGURES; the merchant (or a future setup
 * service) DEPLOYS. Adeptra never hosts this server.
 *
 * PLATFORM-GATED, NOT PLATFORM-GUESSED: only runs for a platform with a
 * registered provider below — an onboarding-declared fact (sites.platform),
 * never detected/guessed here. No confirmed/supported platform, no scaffold:
 * generating a platform-specific server for a store we don't know runs that
 * platform would be exactly the kind of "looks-compliant-but-isn't" artifact
 * this codebase has repeatedly guarded against elsewhere (see
 * manifestArtifact.ts's header).
 *
 * SPINE + PROVIDER: this file owns everything platform-agnostic — the
 * platform dispatch, the capability-signal gate ("is there actually
 * something to add"), the ArtifactDraft/file-tree assembly, and the
 * changelog lines genuinely identical across every platform ("Deploy
 * mcp-server/...", "...point your UCP manifest...", the payment-boundary
 * flag). Each platform's actual file contents (API client, README, env vars,
 * deps) live in a sibling provider module — scaffold/woocommerce.ts,
 * scaffold/wix.ts — that exports one build(ctx): ScaffoldProvider function.
 * Adding a third platform means adding one more provider module and one more
 * line in PLATFORM_PROVIDERS; this file's assembly logic doesn't change.
 *
 * MULTI-FILE OUTPUT: ArtifactDraft.content is one string, but a server is many
 * files. content holds a tagged, versioned JSON payload (see
 * artifacts/types.ts: ArtifactFileTree / encodeFileTree) rather than a single
 * file's text — reportBuilder.ts detects this by a stable content-shape tag
 * (not by artifact_type) and expands it into a mcp-server/ subfolder in the
 * exported zip. No DB migration: the file tree round-trips through the
 * existing `artifacts.content` text column unchanged.
 *
 * HONESTY: resolves_signal_keys is always empty, for every platform.
 * Generating a shopping server that COULD make an agent's checkout/cart/
 * catalog capability real is not the same as it BEING real — that only
 * happens once the server is deployed and the UCP manifest's shopping
 * endpoint points at it, which a future run's live checks would then observe
 * and score. Same principle as feedArtifact.ts's supplemental feed resolving
 * nothing pre-upload.
 */

import type { SignalRow } from "../manifestChecks.ts";
import type { ArtifactContext, ArtifactDraft, ArtifactChangelog } from "./types.ts";
import { encodeFileTree } from "./types.ts";
import { TARGET_FOLDER, type ScaffoldProvider } from "./scaffold/shared.ts";
import { build as buildWooCommerceScaffold } from "./scaffold/woocommerce.ts";
import { build as buildWixScaffold } from "./scaffold/wix.ts";

const PLATFORM_PROVIDERS: Record<string, (ctx: ArtifactContext) => ScaffoldProvider> = {
  woocommerce: buildWooCommerceScaffold,
  wix: buildWixScaffold,
};

function byKey(signals: SignalRow[]): Map<string, SignalRow> {
  return new Map(signals.map((s) => [s.signal_key, s]));
}

export function generateMcpScaffoldArtifact(ctx: ArtifactContext): ArtifactDraft | null {
  const provider = ctx.platform ? PLATFORM_PROVIDERS[ctx.platform] : undefined;
  if (!provider) return null; // known-platform gate, never guessed — see file header

  const sig = byKey(ctx.signals);
  const checkout = sig.get("capability_checkout_declared");
  const cart = sig.get("capability_cart_declared");
  const catalog = sig.get("capability_catalog_declared");

  const allAlreadyPassing = [checkout, cart, catalog].every((s) => s?.status === "pass");
  if (allAlreadyPassing) return null; // agent-shopability already declared+working; nothing to add

  const scaffold = provider(ctx);

  const changelog: ArtifactChangelog = {
    added: scaffold.addedLines,
    corrected: [],
    must_complete: [
      "Deploy mcp-server/ to a host you control (Node 18+) — Adeptra does not host this for you.",
      ...scaffold.setupMustComplete,
      "Once deployed, point your UCP manifest's dev.ucp.shopping service endpoint at this server's deployed URL and re-run analysis — that's what turns checkout/cart/catalog capability signals from \"enabled once deployed\" into a genuine pass.",
    ],
    flagged: [
      "Payment is intentionally NOT handled by this server — begin_checkout returns the cart summary and a checkout URL for handoff; this is a deliberate boundary, not a gap.",
      ...scaffold.extraFlagged,
    ],
  };

  return {
    artifact_type: "mcp_scaffold",
    target_url: TARGET_FOLDER,
    content: encodeFileTree(scaffold.files),
    resolves_signal_keys: [], // never claimed resolved pre-deployment — see file header
    changelog,
  };
}
