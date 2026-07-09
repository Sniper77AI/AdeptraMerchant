/**
 * Adeptra Merchant — MCP scaffold: pieces genuinely identical across every
 * platform provider (currently woocommerce.ts, wix.ts, custom.ts). Anything
 * here is byte-identical output regardless of platform; keeping it in ONE
 * place means a future fix (like the loadEnv.ts import-order bug found live
 * against WooCommerce, or a session-state/diff-reconcile bug in
 * mcpToolsTs()) applies to every platform automatically, instead of needing
 * the same patch copied into two more files by hand.
 */

import type { ArtifactContext, ArtifactFile } from "../types.ts";

/**
 * What a per-platform provider (woocommerce.ts, wix.ts, custom.ts) hands
 * back to the spine (mcpScaffoldArtifact.ts). The spine owns the
 * ArtifactDraft shape and the changelog lines that are genuinely identical
 * across every platform ("Deploy mcp-server/...", "...point your UCP
 * manifest...", the payment-boundary flagged line); each provider owns its
 * own files and the platform-specific changelog fragments slotted in around
 * those shared lines.
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
// tool behavior (including descriptive properties like 'title'). Clients
// should never make tool use decisions based on ToolAnnotations received
// from untrusted servers." They supplement this server's own code
// discipline (the payment boundary described above) — they never replace it.`;

/**
 * Shared UCP-protocol-conformance disclosure, verbatim across every
 * provider's README. Second generation of this section (first generation
 * disclosed three divergences on tool names/session model/transport/
 * checkout, when nothing was UCP-canonical yet). Now that catalog+cart are
 * genuinely canonical (names, argument shapes, session semantics — verified
 * directly against docs/specification/{cart,cart-mcp,catalog,catalog-mcp}.md
 * in Universal-Commerce-Protocol/ucp, not guessed), the honest disclosure
 * narrows to exactly two remaining gaps: cart's transport requirement, and
 * checkout being permanently out of scope. Never state "UCP cart
 * conformant" unqualified — the transport gap is real and load-bearing
 * (cart-mcp.md's own conformance section requires it).
 */
export function ucpConformanceDisclosure(): string {
  const q = "`"; // one backtick, built as a value (not written literally in
  // this template) so markdown code-spans below don't require escaping
  // throughout this function's own template literal.
  const c = (s: string) => q + s + q;
  return `## About UCP protocol conformance — what this server is, and isn't

This server implements UCP's shopping capabilities directly, not a
simplified approximation. Three precise statements, not one blanket claim:

1. **Catalog: conformant.** ${c("search_catalog")}, ${c("lookup_catalog")}, and
   ${c("get_product")} use UCP's canonical tool names and argument shapes
   (${c("docs/specification/catalog/mcp.md")}). Catalog's own conformance
   requirements don't include a transport requirement, so this server meets
   them fully.
2. **Cart: conformant on tool names, argument shapes, and session
   semantics — NOT on transport.** ${c("create_cart")}/${c("get_cart")}/${c("update_cart")}/
   ${c("cancel_cart")} use UCP's canonical names, the required ${c('meta["ucp-agent"]')}
   envelope, id-based resource addressing, and full-replacement update
   semantics exactly as ${c("docs/specification/cart-mcp.md")} defines them. But
   that same document's Conformance section states plainly: *"A conforming
   MCP transport implementation MUST ... Support HTTP transport with
   streaming."* This server uses stdio — the standard "one local process per
   agent session" MCP deployment model — not a hosted HTTP service. That
   makes it transport-non-conformant for cart, disclosed here rather than
   left to discover the hard way.
3. **Checkout: deliberately not declared, not implemented.** UCP's
   ${c("complete_checkout")} tool is defined to accept payment credentials and
   place the order — this server (and every Adeptra-generated MCP scaffold)
   intentionally never implements anything like it. Payment stays with the
   merchant: the cart's own ${c("continue_url")} field (UCP's own sanctioned
   cart-to-checkout handoff mechanism, not a bespoke addition) hands off to
   this store's own checkout page. The UCP manifest this server pairs with
   does not declare ${c("dev.ucp.shopping.checkout")} — declaring it without
   implementing ${c("complete_checkout")} would be non-conformant; simply not
   declaring it is a fully spec-sanctioned profile (capabilities are
   independently adoptable, and ${c("docs/specification/cart.md")} itself frames
   cart as "basket building without the complexity of checkout").

**What IS true regardless:** deploying this server and pointing your UCP
manifest's ${c("dev.ucp.shopping")} endpoint at it genuinely satisfies Adeptra's
own capability-declaration and endpoint-reachability checks for cart and
catalog — those checks read your manifest's JSON and confirm the endpoint
responds; they don't require literal MCP transport conformance. Checkout's
capability signal either fails honestly or, if you've attested to
deliberately using this handoff profile, reflects that choice instead of
failing — see your Adeptra dashboard.
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

/**
 * The full shared UCP catalog + cart tool implementation, generated
 * IDENTICALLY for every platform provider — the only thing that varies per
 * platform is which primitive functions get wired in (see each provider's
 * server.ts). Written once, here, because a session-state bug or a diff-
 * reconcile bug found live against one platform would otherwise need the
 * same fix copied into two more files by hand — exactly the class of
 * mistake sharing this logic is meant to prevent.
 *
 * Implements, in one file:
 *   - The canonical UCP tool surface: search_catalog, lookup_catalog,
 *     get_product, create_cart, get_cart, update_cart, cancel_cart.
 *   - meta["ucp-agent"] required on every tool's input (UCP: "required on
 *     all requests") — accepted and validated present, not deeply
 *     negotiated (v1 scope, disclosed in the generated README).
 *   - not_found returned as a JSON-RPC SUCCESS with UCP's business-outcome
 *     envelope shape (ucp.status="error", messages[], matching cart-mcp.md's
 *     own Get Cart "Not Found" example) — never thrown as a protocol error.
 *   - structuredContent alongside content on every response (matches UCP's
 *     literal result.structuredContent wire shape; supported by the MCP SDK
 *     without requiring a declared outputSchema).
 *   - The session state machine: ONE platform cart, ever (the underlying
 *     WooCommerce Cart-Token cart / Wix visitor cart / Custom adapter cart
 *     is a single permanent thing — this file never fabricates a second).
 *     create_cart mints a fresh id only from no-cart-yet/canceled; erroring,
 *     never silently resetting, if a cart is already active. cancel_cart
 *     empties the REAL platform cart and marks the session canceled — a
 *     state this file tracks, not one the platform itself has a concept of.
 *     Every cart tool call while canceled returns not_found, per spec ("the
 *     cart is gone as far as any agent is concerned").
 *   - update_cart's diff-and-reconcile shim: UCP requires the platform to
 *     submit the FULL desired cart state on every update
 *     (source/schemas/shopping/types/line_item.json: quantity has
 *     minimum:1 — zero is not a valid value, and NOT a removal sentinel;
 *     omitting a line from the submitted array IS the removal signal).
 *     Every provider's real API is incremental (add/update/remove one line
 *     at a time), so this reconciles a full-state submission into the
 *     minimum set of primitive calls, including issuing ZERO calls when
 *     nothing actually changed. A submitted line item WITH an id that
 *     doesn't match any current line is rejected as an error (a business-
 *     outcome message, not a silent add) — an agent referencing a line that
 *     no longer exists is a real mistake worth surfacing, not guessing past.
 *   - continue_url minted lazily via the checkoutUrl() primitive and
 *     cached, invalidated only when update_cart actually changes line
 *     items, and never minted at all for an empty cart. This matters
 *     concretely for Wix: its checkoutUrl() creates a real Wix-side
 *     checkout object on every call, not a free computation — minting it on
 *     every read would create an orphaned Wix resource on every single
 *     get_cart call.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: implement or register any
 * checkout tool (create_checkout/get_checkout/update_checkout/
 * complete_checkout/cancel_checkout). See README.md's "About UCP protocol
 * conformance" section for why that's a deliberate, disclosed scope
 * boundary, not a gap.
 *
 * NOTE ON STYLE: the generated code below deliberately uses string
 * concatenation ("a" + b + "c") instead of template literals anywhere it
 * needs to build a runtime string (cart ids, error messages) — avoids any
 * literal backtick character appearing inside THIS file's own template
 * literal, which would otherwise need careful escaping throughout. The
 * generated file is still perfectly idiomatic TypeScript either way.
 */
export function mcpToolsTs(): string {
  return `/**
 * Adeptra Merchant — shared UCP catalog + cart tool implementation.
 * Generated identically for every platform provider — see shared.ts's
 * mcpToolsTs() header comment (in the Adeptra Merchant codebase that
 * generated this file) for the full design rationale. Only server.ts
 * varies per platform (which primitive functions it wires in here).
 *
 * DELIBERATELY DOES NOT IMPLEMENT CHECKOUT: no create_checkout/
 * get_checkout/update_checkout/complete_checkout/cancel_checkout tool
 * exists in this file. Payment stays with the merchant — see README.md's
 * "About UCP protocol conformance" section.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Types every provider's primitives satisfy (see each provider's server.ts
// for how its own client module's functions get wired in as these).
// ---------------------------------------------------------------------------

export interface NormalizedProduct {
  id: string;
  title: string;
  price?: string;
  currency?: string;
  url?: string;
}

export interface NormalizedLine {
  /** This line's own id (provider-assigned) — NOT the product id. */
  id: string;
  productId: string;
  quantity: number;
  title?: string;
  price?: string;
}

export interface NormalizedCart {
  lines: NormalizedLine[];
  currency?: string;
}

export interface CatalogPrimitives {
  searchProducts(query: string, limit: number): Promise<NormalizedProduct[]>;
  getProduct(id: string): Promise<NormalizedProduct>;
}

export interface CartPrimitives {
  getCartRaw(): Promise<NormalizedCart>;
  addItem(productId: string, quantity: number): Promise<unknown>;
  setItemQty(lineItemId: string, quantity: number): Promise<unknown>;
  removeItem(lineItemId: string): Promise<unknown>;
  /** Removes every line from the REAL platform cart. Used to guarantee a
   *  truly empty starting cart on create_cart (the platform cart may hold
   *  stale contents from before this session ever ran) and to make
   *  cancel_cart's platform-side emptying real, not just a session-state
   *  flag flip. */
  emptyCart(): Promise<unknown>;
  /** Mints a URL where the shopper completes payment on the merchant's own
   *  checkout, for the CURRENT platform cart. May be expensive / have real
   *  side effects (e.g. Wix creates an actual checkout object) — this file
   *  calls it lazily and caches the result; see resolveContinueUrl below. */
  checkoutUrl(): Promise<string>;
}

// ---------------------------------------------------------------------------
// meta["ucp-agent"] — REQUIRED on every request per UCP's MCP binding
// ("The meta['ucp-agent'] field is required on all requests" — both
// cart-mcp.md and catalog/mcp.md). Required here too, not optional; this
// server accepts and passes through whatever the calling agent sends but
// does not implement full capability-negotiation semantics against it
// (v1 scope — disclosed in README.md).
// ---------------------------------------------------------------------------

const metaSchema = z
  .object({
    "ucp-agent": z.object({ profile: z.string() }).passthrough(),
  })
  .passthrough();

// A submitted line item — quantity has minimum:1 per UCP's own
// line_item.json schema (zero is out of range, not a removal sentinel).
const lineItemInputSchema = z.object({
  id: z.string().optional(),
  item: z.object({ id: z.string() }),
  quantity: z.number().int().min(1),
});

const cartPayloadSchema = z.object({
  line_items: z.array(lineItemInputSchema),
  context: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Business-outcome envelope helpers. UCP's wire shape returns a JSON-RPC
// SUCCESS (never a thrown/protocol error) for business outcomes like
// not_found — the MCP SDK's CallToolResult carries both a text-serialized
// content block (for plain-text MCP clients) and a structuredContent object
// matching UCP's literal result.structuredContent shape.
// ---------------------------------------------------------------------------

function toolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function notFoundResult() {
  return toolResult({
    ucp: { status: "error" },
    messages: [{ type: "error", code: "not_found", content: "Cart not found or has expired", severity: "unrecoverable" }],
  });
}

function errorResult(code: string, message: string) {
  return toolResult({
    ucp: { status: "error" },
    messages: [{ type: "error", code, content: message, severity: "unrecoverable" }],
  });
}

function toUcpLineItems(lines: NormalizedLine[]) {
  return lines.map((l) => ({
    id: l.id,
    item: { id: l.productId, ...(l.title ? { title: l.title } : {}), ...(l.price ? { price: l.price } : {}) },
    quantity: l.quantity,
  }));
}

// ---------------------------------------------------------------------------
// Session state machine — ONE platform cart, ever. active/canceled.
// Module-level state: matches the same "one process = one shopper session"
// assumption every provider's own client module already makes (WooCommerce
// Cart-Token, Wix visitor token, Custom's single adapter instance) — this
// class formalizes it into the explicit state machine UCP's session model
// requires, instead of relying on the platform's own implicit single-cart
// behavior.
// ---------------------------------------------------------------------------

interface DesiredLine {
  id?: string;
  productId: string;
  quantity: number;
}

type CreateResult = { ok: true; id: string; cart: NormalizedCart } | { ok: false; error: string };
type GetResult = { ok: true; id: string; cart: NormalizedCart } | { ok: false; notFound: true };
type UpdateResult = { ok: true; cart: NormalizedCart } | { ok: false; notFound: true } | { ok: false; invalidLineId: string };
type CancelResult = { ok: true; cart: NormalizedCart } | { ok: false; notFound: true };

class CartSession {
  private state: "active" | "canceled" = "canceled"; // no cart yet behaves like canceled
  private cartId: string | null = null;
  private cachedContinueUrl: string | null = null;
  private continueUrlDirty = true;

  constructor(private primitives: CartPrimitives) {}

  private mintCartId(): string {
    return "cart_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private matches(id: string): boolean {
    return this.state === "active" && this.cartId === id;
  }

  /** create_cart while a cart is ACTIVE is an error — never silently reset
   *  or return the existing cart. Destroying a basket must go through an
   *  explicit cancel_cart. On success, empties the real platform cart first
   *  (it may hold stale contents from before this session existed). */
  async create(): Promise<CreateResult> {
    if (this.state === "active") {
      return {
        ok: false,
        error: "A cart already exists (id: " + this.cartId + "). Call get_cart to read it, or cancel_cart to discard it before creating a new one.",
      };
    }
    await this.primitives.emptyCart();
    this.cartId = this.mintCartId();
    this.state = "active";
    this.cachedContinueUrl = null;
    this.continueUrlDirty = true;
    return { ok: true, id: this.cartId, cart: { lines: [] } };
  }

  async get(id: string): Promise<GetResult> {
    if (!this.matches(id)) return { ok: false, notFound: true };
    const cart = await this.primitives.getCartRaw();
    return { ok: true, id, cart };
  }

  /** The diff-and-reconcile shim. Matches submitted line items to existing
   *  ones by id when present (a submitted id that doesn't match any current
   *  line is an ERROR, not a silent add); id-less submitted items are new
   *  additions; any current line omitted from the submitted array is
   *  removed. Issues ZERO platform calls when the submitted state exactly
   *  matches the current state. */
  async update(id: string, desired: DesiredLine[]): Promise<UpdateResult> {
    if (!this.matches(id)) return { ok: false, notFound: true };

    const current = await this.primitives.getCartRaw();
    const currentById = new Map(current.lines.map((l) => [l.id, l]));
    const toAdd: DesiredLine[] = [];
    const toUpdate: Array<{ id: string; quantity: number }> = [];
    const seen = new Set<string>();

    for (const d of desired) {
      if (d.id) {
        const existing = currentById.get(d.id);
        if (!existing) return { ok: false, invalidLineId: d.id };
        seen.add(d.id);
        if (existing.quantity !== d.quantity) toUpdate.push({ id: d.id, quantity: d.quantity });
      } else {
        toAdd.push(d);
      }
    }
    const toRemove = current.lines.filter((l) => !seen.has(l.id)).map((l) => l.id);

    if (toAdd.length === 0 && toUpdate.length === 0 && toRemove.length === 0) {
      return { ok: true, cart: current }; // nothing changed — zero platform calls
    }

    for (const lineId of toRemove) await this.primitives.removeItem(lineId);
    for (const u of toUpdate) await this.primitives.setItemQty(u.id, u.quantity);
    for (const a of toAdd) await this.primitives.addItem(a.productId, a.quantity);

    this.continueUrlDirty = true;
    const updated = await this.primitives.getCartRaw();
    return { ok: true, cart: updated };
  }

  /** Empties the REAL platform cart (no orphaned state) and marks the
   *  session canceled. Returns the cart's state from just BEFORE emptying —
   *  UCP's own spec: "Business MUST return the cart state before deletion." */
  async cancel(id: string): Promise<CancelResult> {
    if (!this.matches(id)) return { ok: false, notFound: true };
    const snapshot = await this.primitives.getCartRaw();
    await this.primitives.emptyCart();
    this.state = "canceled";
    this.cachedContinueUrl = null;
    this.continueUrlDirty = true;
    return { ok: true, cart: snapshot };
  }

  /** Lazy, cached, invalidated only on an actual line-item change — never
   *  minted for an empty cart. See this file's header comment for why. */
  async resolveContinueUrl(cart: NormalizedCart): Promise<string | undefined> {
    if (cart.lines.length === 0) return undefined;
    if (!this.continueUrlDirty && this.cachedContinueUrl) return this.cachedContinueUrl;
    const url = await this.primitives.checkoutUrl();
    this.cachedContinueUrl = url;
    this.continueUrlDirty = false;
    return url;
  }
}

// ---------------------------------------------------------------------------
// Tool registration — the canonical UCP catalog + cart surface, and nothing
// else. Call once from server.ts with this platform's primitives.
// ---------------------------------------------------------------------------

${TOOL_ANNOTATIONS_NOTE}

export function registerUcpTools(server: McpServer, primitives: { catalog: CatalogPrimitives; cart: CartPrimitives }): void {
  const session = new CartSession(primitives.cart);

  server.registerTool(
    "search_catalog",
    {
      title: "Search catalog",
      description: "Search this store's product catalog by keyword.",
      inputSchema: {
        meta: metaSchema,
        catalog: z.object({
          query: z.string(),
          context: z.record(z.string(), z.unknown()).optional(),
          filters: z.record(z.string(), z.unknown()).optional(),
          pagination: z.object({ limit: z.number().int().min(1).max(50).optional() }).optional(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ catalog }) => {
      const limit = catalog.pagination?.limit ?? 10;
      const products = await primitives.catalog.searchProducts(catalog.query, limit);
      return toolResult({ products, pagination: { has_next_page: false } });
    },
  );

  server.registerTool(
    "lookup_catalog",
    {
      title: "Lookup catalog",
      description:
        "Look up one or more products by identifier. Unknown identifiers are reported in messages, not errors — a partial result is a normal outcome.",
      inputSchema: {
        meta: metaSchema,
        catalog: z.object({ ids: z.array(z.string()).min(1), context: z.record(z.string(), z.unknown()).optional() }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ catalog }) => {
      const products: NormalizedProduct[] = [];
      const messages: Array<{ type: string; code: string; content: string }> = [];
      for (const id of catalog.ids) {
        try {
          products.push(await primitives.catalog.getProduct(id));
        } catch {
          messages.push({ type: "info", code: "not_found", content: id });
        }
      }
      return toolResult({ products, ...(messages.length ? { messages } : {}) });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Get full detail for one product by identifier.",
      inputSchema: {
        meta: metaSchema,
        catalog: z.object({
          id: z.string(),
          selected: z.array(z.unknown()).optional(),
          preferences: z.array(z.string()).optional(),
          context: z.record(z.string(), z.unknown()).optional(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ catalog }) => {
      try {
        const product = await primitives.catalog.getProduct(catalog.id);
        return toolResult({ product });
      } catch {
        return errorResult("not_found", "Product not found: " + catalog.id);
      }
    },
  );

  server.registerTool(
    "create_cart",
    {
      title: "Create cart",
      description:
        "Create a new cart session. Always starts EMPTY — this server does not apply initial line_items from the request; call update_cart immediately after to populate it. Errors if a cart is already active (call get_cart to read it, or cancel_cart to discard it, first).",
      inputSchema: { meta: metaSchema, cart: cartPayloadSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      const result = await session.create();
      if (!result.ok) return errorResult("cart_already_exists", result.error);
      return toolResult({ id: result.id, line_items: [] });
    },
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get cart",
      description: "Get a cart session by id. Returns not_found if the cart doesn't exist, has expired, or was canceled.",
      inputSchema: { meta: metaSchema, id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ id }) => {
      const result = await session.get(id);
      if (!result.ok) return notFoundResult();
      const continue_url = await session.resolveContinueUrl(result.cart);
      return toolResult({
        id: result.id,
        line_items: toUcpLineItems(result.cart.lines),
        ...(result.cart.currency ? { currency: result.cart.currency } : {}),
        ...(continue_url ? { continue_url } : {}),
      });
    },
  );

  server.registerTool(
    "update_cart",
    {
      title: "Update cart",
      description:
        "Replace the cart's full contents. Submit ALL desired line items — omitting an existing line item removes it. A submitted line item's id must reference an existing line (errors otherwise); a line item with no id is treated as a new addition. Quantity must be at least 1 — there is no quantity-0 removal signal.",
      inputSchema: { meta: metaSchema, id: z.string(), cart: cartPayloadSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, cart }) => {
      const desired: DesiredLine[] = cart.line_items.map((li) => ({ id: li.id, productId: li.item.id, quantity: li.quantity }));
      const result = await session.update(id, desired);
      if (!result.ok) {
        if ("notFound" in result) return notFoundResult();
        return errorResult("not_found", "Line item '" + result.invalidLineId + "' not found in the current cart.");
      }
      const continue_url = await session.resolveContinueUrl(result.cart);
      return toolResult({
        id,
        line_items: toUcpLineItems(result.cart.lines),
        ...(result.cart.currency ? { currency: result.cart.currency } : {}),
        ...(continue_url ? { continue_url } : {}),
      });
    },
  );

  server.registerTool(
    "cancel_cart",
    {
      title: "Cancel cart",
      description:
        "Cancel the cart session — empties it for real on the store and marks it gone. Subsequent operations on this cart id return not_found; call create_cart to start a new one.",
      inputSchema: { meta: metaSchema, id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const result = await session.cancel(id);
      if (!result.ok) return notFoundResult();
      return toolResult({
        id,
        line_items: toUcpLineItems(result.cart.lines),
        ...(result.cart.currency ? { currency: result.cart.currency } : {}),
      });
    },
  );
}
`;
}
