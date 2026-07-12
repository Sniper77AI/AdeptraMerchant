# Adeptra Merchant

The UCP (Universal Commerce Protocol) compliance product in the **Adeptra** platform — an AI-agentic system that makes ecommerce sites discoverable, parseable, trusted, and **buyable** by AI shopping agents (ChatGPT, Gemini, Perplexity, Google AI Mode).

Adeptra Merchant analyzes a store, scores its UCP readiness, generates the fixes (manifest, feed corrections, policy structuring), and — on the subscription tier — serves the agent-readable layer from the edge and keeps it current as UCP evolves.

> Adeptra Merchant is the first product under the Adeptra house brand. A second product (edge AI-readiness, working name *CrawlTrust*) follows once Merchant is shipped.

## What's here

```
merchant/
  supabase/
    migrations/
      20260703000000_aeo_geo_ucp_mvp_schema.sql        # DB spine: 16 tables, membership-based RLS,
                                                        # immutable runs, signals-as-source-of-truth
      20260706000000_no_manifest_status_and_...sql     # analysis_runs.no_manifest status +
                                                        # sites.identity_linking_opt_out
      20260706010000_sites_feed_url.sql                # sites.feed_url (Category 2 onboarding input)
      20260706020000_sites_merchant_center_eligibility.sql # Category 6 onboarding attestation columns
      20260706030000_add_artifacts_changelog_json.sql  # artifacts.changelog_json (persists ArtifactChangelog)
      20260707000000_add_mcp_scaffold_artifact_type.sql # artifacts.artifact_type CHECK constraint += 'mcp_scaffold'
      20260709000000_sites_checkout_handoff_opt_in.sql  # sites.checkout_handoff_opt_in — same shape/reasoning as
                                                        # identity_linking_opt_out: an explicit merchant attestation,
                                                        # never inferred from platform, that lets
                                                        # capability_checkout_declared score not_applicable instead
                                                        # of fail for a store deliberately using the catalog+cart-only
                                                        # UCP profile (payment via the cart's continue_url handoff)
      20260711000000_signal_evidence.sql                # signal_evidence table — evidence as DATA, not code.
                                                        # basis CHECK constraint: specified/measured/documented/
                                                        # contested/no_evidence. Seeded with the 10 agent_readability
                                                        # signals' citations. Global reference data (not tenant-
                                                        # scoped) — RLS is a simple authenticated-read-all policy
      20260711000010_sites_ai_training_opt_out.sql      # sites.ai_training_opt_out — same shape/reasoning as
                                                        # checkout_handoff_opt_in: blocking GPTBot/ClaudeBot for AI
                                                        # training is a legitimate merchant decision, attested here,
                                                        # never inferred from robots.txt contents alone
      # Note: the applied Supabase migration version (see `list_migrations`) doesn't match this
      # filename's timestamp prefix — a pre-existing quirk for every migration in this list, not
      # unique to these two; the filename is for human organization, the DB tracks its own version
      # Storage bucket "merchant-exports" (private) and exports table predate this — see Export & Delivery below
      # sites.platform (TEXT, nullable, no CHECK) predates this too — set manually until onboarding writes it
  ucp/
    signal-specs.md        # The core IP: exact pass/partial/fail rule + evidence + fix
                           # for every UCP compliance signal, grounded in UCP 2026-04-08
    manifestChecks.ts      # Category 1 (Discovery & Manifest) checks — portable, framework-agnostic
    capabilityChecks.ts    # Category 3 (Capabilities) checks — checkout/cart/catalog/fulfillment/
                           # identity_linking declarations + endpoint_reachability probe
    feedChecks.ts          # Category 2 (Product Data Hygiene): feed_available + native_commerce_attribute
                           # (product-level), plus extractFeedVariants (variant-level view feeding
                           # pageChecks.ts). Parses Shopify products.json and Google Merchant XML/RSS
                           # (zero-dependency, regex-based XML reading)
    pageChecks.ts          # Category 2 cross-surface consistency: product_id_consistency /
                           # price_consistency_cross_surface / availability_consistency. Samples feed
                           # variants, fetches each product page once (de-duped), extracts schema.org
                           # JSON-LD (Product or ProductGroup→hasVariant), matches by mpn/sku/gtin
    llmChecks.ts           # Category 2, the 2 LLM-scored signals: title_description_consistency's
                           # semantic half + discovery_attributes_enrichment. [D] exact-match runs
                           # first (skips the LLM call when feed/page text is already identical);
                           # injectable LlmClient (openAiClient is the real impl); degrades to
                           # not_applicable when OPENAI_API_KEY isn't set
    policyChecks.ts        # Category 5 (Policy & Post-Purchase Transparency): return_policy_present_consistent
                           # / shipping_info_present_consistent (best-effort probe of known Shopify +
                           # custom-storefront path conventions — no general crawler yet) /
                           # support_contact_present (schema.org Organization.contactPoint)
    readabilityChecks.ts   # SECOND PILLAR — agent_readability (pillar='agent_readability', NOT UCP,
                           # NOT AEO/GEO): "can a generic AI system access, parse, and correctly
                           # understand this store?" No claim about AI citation lift. 10 signals across
                           # 4 categories — crawler_access (robots_txt_valid, ai_crawler_access_retrieval,
                           # ai_crawler_access_training), content_legibility (content_server_rendered,
                           # schema_in_raw_html — highest-value, since Vercel/MERJ's network analysis of
                           # 569M+ real GPTBot fetches found no major AI crawler executes JavaScript,
                           # Gemini/AppleBot excepted — httpFetcher.ts already doesn't either, so every
                           # signal here checks the exact raw HTML an AI crawler would see), structured_data
                           # (product_schema_present, offer_schema_complete, organization_schema_present),
                           # discovery_surfaces (sitemap_present, llms_txt_present). Hand-rolled,
                           # zero-dependency robots.txt parser with per-token semantics (a `ClaudeBot`
                           # block does NOT apply to `Claude-SearchBot`) and longest-rule-wins/tie-goes-
                           # to-Allow matching. Reuses pageChecks.ts's fetchProductPage/sampleAndCompare
                           # for feed-grounded sampling (rawHtml exposed on ProductPageState, in-memory
                           # only — never written to evidence_json); falls back to its own sitemap-driven
                           # sampling (one-level index-sitemap follow + product-path filtering) for a
                           # no-feed store, since that's the store most likely to have the
                           # content_server_rendered SPA problem. ai_crawler_access_training respects
                           # sites.ai_training_opt_out (not_applicable when attested, never inferred).
                           # Every claim's evidentiary strength lives in the signal_evidence table
                           # (looked up at report-build time, not snapshotted), not hardcoded here.
    paymentChecks.ts       # Category 4 (Payment / AP2 Readiness): ap2_compatibility_declared /
                           # credential_security_posture read ucp.payment_handlers from the already-
                           # fetched manifest (no new network call); merchant_of_record_declared is
                           # always not_applicable — no UCP field exists yet to read it from
    readinessChecks.ts     # Category 6 (Merchant Center Eligibility, readiness checklist — NOT
                           # scored into capability quality): merchant_center_account_ready /
                           # ucp_early_access_status, entirely self-attested (sites onboarding
                           # columns). Both carry weight: 0 so scorer.ts excludes them from the
                           # score and signals_total/signals_passed while still landing as real rows
    httpFetcher.ts         # Production Fetcher: native fetch, shared 5s deadline, manual
                           # redirect tracking (chain in evidence), 401/403 → requiresAuth
    scorer.ts              # Pure rollup: SignalRow[] → pillar_scores rows + overall score
                           # (excludes not_applicable AND weight=0 signals from scoring)
    artifacts/
      types.ts             # Shared ArtifactType / ArtifactChangelog / ArtifactDraft / ArtifactContext
                           # ({ manifest, feed, signals, fetcher?, llm?, rootUrl?, platform? }) — adding
                           # a generator input never again requires changing runArtifacts()'s
                           # signature, just this one context shape. fetcher/llm/rootUrl are
                           # optional, used only by impure/async generators (content_rewrite today);
                           # platform is an onboarding-declared fact (sites.platform), never guessed,
                           # used by platform-gated generators (mcp_scaffold today). Also: ArtifactFile /
                           # ArtifactFileTree + encodeFileTree/decodeFileTree — a tagged, versioned JSON
                           # shape multi-file generators put in ArtifactDraft.content (the one `content`
                           # text column, no new DB column) — detected by content shape, not
                           # artifact_type, so any future multi-file generator gets zip-expansion in
                           # reportBuilder.ts for free
      manifestArtifact.ts  # Artifact #1 — pure generator for artifact_type='ucp_manifest'. Takes an
                           # ArtifactContext, returns a draft (or null if nothing to fix). Preserves
                           # all valid existing config (including a passing sub-capability catalog
                           # shape, byte-for-byte); auto-fixes use real canonical values; the service
                           # endpoint is an obvious placeholder (never fabricated); identity_linking
                           # and endpoint_reachability are flag-only, never auto-added/auto-filled
      feedArtifact.ts      # Artifact #2 — pure generator for artifact_type='feed_fix'. v1 scope:
                           # exactly one fix — a Google Merchant supplemental feed adding
                           # native_commerce=true for products currently missing it (references
                           # products by id only, never authors titles/prices/availability).
                           # Merchant-intent guardrail: opts in ALL missing products but always
                           # flags a REVIEW-before-uploading warning in must_complete, the same
                           # "don't silently claim a merchant-preference decision" lesson as
                           # identity_linking. Everything else in Category 2 (consistency signals,
                           # title/description, discovery attributes) is flag-only here
      contentRewriteArtifact.ts # Artifact #3 — the first ASYNC/IMPURE generator, for
                           # artifact_type='content_rewrite'. Two behaviors only, no
                           # content-authoring path: STRUCTURE (signal partial — content exists
                           # but isn't machine-readable — fetch the merchant's own page, ask the
                           # LLM to decompose ONLY its stated facts into named schema.org
                           # properties — merchantReturnDays, returnFees, contactPoint, etc. —
                           # never a raw-text/body dump); FLAG (signal fail, or either LLM-scored
                           # Category-2 signal — never drafted, a person must decide). Reuses
                           # LlmClient/openAiClient from llmChecks.ts. Anti-fabrication is
                           # two-layered: prompt discipline PLUS a mechanical gate
                           # (allNumbersGrounded) that rejects the WHOLE generation if any number
                           # in the output isn't traceable to the source page text.
                           # @context/@type are injected deterministically after parsing (never
                           # trusted to the model) so the output is always valid standalone JSON-LD.
                           # ALSO handles three agent_readability flag-only signals (content_server_
                           # rendered, schema_in_raw_html, sitemap_present — platform-keyed guidance) —
                           # reused rather than a fourth new artifact type, since this generator
                           # already IS "rich guidance, nothing auto-fixable"
      mcpScaffoldArtifact.ts # Artifact #4 — pure generator for artifact_type='mcp_scaffold'. SPINE:
                           # owns platform dispatch (PLATFORM_PROVIDERS keyed by ctx.platform — an
                           # onboarding-declared fact, sites.platform, never guessed), the
                           # capability-signal gate (nothing to add once checkout/cart/catalog are
                           # all already passing), ArtifactDraft/file-tree assembly, and the
                           # changelog lines genuinely identical across every platform ("Deploy
                           # mcp-server/...", "...point your UCP manifest...", the payment-boundary
                           # flag). Each platform's actual files (API client, README, env vars, deps)
                           # live in a sibling scaffold/<platform>.ts provider — adding a third
                           # platform is one more provider module + one more PLATFORM_PROVIDERS line,
                           # this file's assembly logic doesn't change. resolves_signal_keys is
                           # always empty for every platform (never claimed resolved
                           # pre-deployment, same principle as feedArtifact.ts)
      scaffold/
        shared.ts           # Genuinely platform-agnostic pieces every provider uses: TARGET_FOLDER,
                           # MCP SDK/zod version constants, tsconfigJson(), loadEnvTs() (the
                           # side-effect-only .env-loading module every platform's server.ts imports
                           # FIRST — see Open items below for the import-order bug this fixed originally,
                           # now fixed once here for every platform instead of per-platform),
                           # TOOL_ANNOTATIONS_NOTE (the MCP SDK's own "hints, not a security boundary"
                           # caveat, quoted verbatim), ucpConformanceDisclosure() (the honest "what this
                           # server is, and isn't" README section — see Open items below: catalog is
                           # fully UCP-conformant, cart is conformant on names/shapes/session but not
                           # transport, checkout is permanently out of scope), and — the bulk of this
                           # round's work — mcpToolsTs(), which generates ONE shared src/mcpTools.ts
                           # file (byte-identical across all three providers) implementing UCP's actual
                           # canonical catalog+cart tool surface: search_catalog/lookup_catalog/
                           # get_product/create_cart/get_cart/update_cart/cancel_cart, a real session
                           # state machine (one platform cart, ever — active/canceled, create_cart
                           # errors rather than resets on an already-active cart, cancel_cart empties
                           # the real platform cart and marks the session gone), and a diff-and-
                           # reconcile shim for update_cart's UCP-mandated full-replacement semantics
                           # (every provider's real API is incremental) — reconciling to the minimum
                           # set of primitive calls, zero calls when nothing changed, and rejecting a
                           # submitted line id that doesn't match any current line as an error rather
                           # than silently adding it. Each provider supplies only primitives
                           # (getCartRaw/addItem/setItemQty/removeItem/emptyCart/checkoutUrl); the
                           # diff/session logic itself is written once. Also the ScaffoldProvider
                           # interface every provider module implements: { files, addedLines,
                           # setupMustComplete, extraFlagged }
        woocommerce.ts       # Provider — catalog search + cart building via WooCommerce's public
                           # Store API only (/wp-json/wc/store/v1/* — never the admin /wc/v3/ API,
                           # never the Store API's own /checkout endpoint). Supplies primitives to
                           # mcpTools.ts; server.ts itself is now thin glue (wires primitives into
                           # registerUcpTools(), nothing else). checkoutUrl() is a static computed URL,
                           # not an API call. Live-verified npm start caught and fixed a latent bug
                           # this round — see Open items below.
        wix.ts                # Provider #2 — a deployable Wix MCP shopping-server (raw REST against
                           # Wix's eCommerce API, no Wix SDK dependency). Structurally different
                           # boundary problem than WooCommerce: Wix's API CAN create checkouts/orders,
                           # so the payment/order boundary is enforced by this file's own discipline
                           # (an explicit "endpoints we deliberately never call" header comment + a
                           # boundary regression test), not by the platform. Scope reality documented
                           # up front in the generated README (before the setup walkthrough, not
                           # buried): Wix offers no narrower grantable OAuth scope than this server's 4
                           # actual scopes, so the deploy guide tells the merchant to treat the
                           # deployed server + WIX_CLIENT_ID as sensitive. Hard-fails at startup
                           # (assertCatalogV3, calling the confirmed-cheap GetCatalogVersion endpoint)
                           # with a plain-English message if the site is on Catalog V1 — Wix's
                           # V1/V3 catalog split is not backward-compatible and this scaffold only
                           # supports V3. Also discloses that Wix's OAuth token endpoint is currently
                           # Developer Preview and may change. checkoutUrl() creates a REAL Wix-side
                           # checkout object (not free) — mcpTools.ts's continue_url caching (lazy,
                           # invalidated only on an actual line-item change, skipped for an empty cart)
                           # is what keeps this from being called on every single cart read.
                           # add_to_cart always uses a product's first variant (a real, disclosed
                           # simplification — no variant selection exposed).
        custom.ts             # Provider #3 — for bespoke stores with no standard API to write a real
                           # client against. NOT a working server: a ~80%-complete REFERENCE
                           # IMPLEMENTATION for a developer (the merchant's, or Adeptra's own setup
                           # service) to finish. src/server.ts (complete, wires StoreAdapter into
                           # registerUcpTools()) is generated in full; src/types.ts is the StoreAdapter
                           # contract (8 methods this round — the 7 from before plus emptyCart, added
                           # for the session state machine's create_cart/cancel_cart guarantees —
                           # deliberately no payment/order/admin method, that absence IS the boundary,
                           # since there's no real API call to structurally forbid it the way
                           # WooCommerce/Wix do); src/store.ts stubs every method with a literal
                           # throw new Error("IMPLEMENT-THIS: ...") and a worked-example doc comment.
                           # server.ts refuses to start while any method is still stubbed — detected by
                           # reading each method's own source text for the literal marker
                           # (Function.prototype.toString(), never invoking the adapter) rather than a
                           # live call (risks false positives/side effects on a partially-done adapter)
                           # or a separate boolean flag (can drift out of sync) — live-verified:
                           # implementing methods one at a time correctly narrows the startup failure's
                           # list of remaining stubs, and the server starts cleanly once all eight are
                           # done. resolves_signal_keys is always empty here too, even more clearly
                           # than the other providers.
      robotsPatchArtifact.ts # Artifact #5 — pure generator for artifact_type='robots_patch'. A PATCH,
                           # never a wholesale robots.txt rewrite — missing file gets a complete minimal
                           # file (safe, nothing to preserve); an existing file gets plain-English,
                           # line-numbered REMOVE/ADD instructions written as `#` comments (valid, inert
                           # robots.txt syntax even if deployed as-is). Wildcard-safe: never proposes
                           # removing a `User-agent: *` rule shared with other crawlers, adds a
                           # bot-specific Allow override instead. Never touches GPTBot/ClaudeBot training
                           # directives (merchant-intent rule, third application) — flags the choice,
                           # presents both sides, lets the merchant decide.
      llmsTxtArtifact.ts    # Artifact #6 — pure generator for artifact_type='llms_txt'. Built only from
                           # data already known real: <title>/og:site_name + og:description extracted
                           # from the homepage's raw HTML (extractSiteName/extractSiteDescription,
                           # reused by jsonldArtifact.ts), policy page URLs policyChecks.ts already
                           # found, the configured feed URL, the resolved UCP manifest URL. No
                           # description ever invented — an obvious placeholder + must_complete when
                           # none is extractable. The mandatory contested-basis honesty note is read
                           # from signal_evidence.merchant_note at generation time, not hardcoded.
      jsonldArtifact.ts     # Artifact #7 — pure generator for artifact_type='jsonld'. Two sub-cases,
                           # deliberately different honesty properties: organization_schema_present is
                           # a complete sitewide fix (real domain + extracted name); product_schema_
                           # present/offer_schema_complete are explicitly NOT a complete fix (a sampled-
                           # page template + one real worked example from feed data, resolving neither
                           # signal — a real catalog has far more products than Adeptra samples). Hard
                           # rule: if the feed and live pages disagree on price/availability/product ID,
                           # NO product/offer JSON-LD is generated at all — flagged instead, same
                           # reconcile-don't-guess discipline as feedArtifact.ts. Platform-specific
                           # injection guidance (Shopify/WooCommerce) independently verified against
                           # primary sources before shipping as merchant-facing copy.
      index.ts             # runArtifacts(ctx) orchestrator — async (awaits each generator so the six
                           # sync generators and the async content_rewrite generator share one call
                           # site). Seven generators today: ucp_manifest, feed_fix, content_rewrite,
                           # mcp_scaffold, robots_patch, llms_txt, jsonld
    supabaseSink.ts        # PostgREST via plain fetch (no supabase-js): run lifecycle, signal
                           # insert (returns inserted rows for signal_key→id mapping;
                           # priority_score is DB-generated), pillar score insert, artifact insert
                           # (resolves_signal_ids mapped from keys; changelog_json persisted),
                           # site config reads. SupabaseConfig gained an optional `fetcher?` (defaults
                           # to real fetch) so rest() and storageSink.ts's upload/sign calls are
                           # injectable for tests, the same portability contract the signal-check
                           # modules already use — no globalThis.fetch monkey-patching needed.
                           # ensureClient (shared client lookup-or-create) backs both ensureDevSite
                           # (the smoke-test shortcut) and upsertIntakeSite (real intake — see
                           # pipeline.ts) — the latter dedups on (client_id, root_url), the actual
                           # `sites` UNIQUE constraint, and PATCHes only newly-provided fields on a
                           # repeat submission rather than silently ignoring an updated answer.
                           # getRunDomain is a lightweight run→domain lookup for the report/bundle
                           # proxy routes (just enough to derive the Storage path — not the full
                           # fetchRunBundleData fan-out that report-building needs)
    pipeline.ts            # Callable pipeline (no process.argv/exit/console.log): runAnalysis,
                           # runExport, ensureSiteFromIntake — the same engine called by the CLIs
                           # below, the HTTP intake endpoint (merchant/api/analyze.ts), and later an
                           # agent caller, unchanged. runAnalysis takes an optional onLog callback for
                           # progress messages (no-op default) and returns {status:"failed", error}
                           # instead of throwing/exiting on a downstream failure — every caller decides
                           # how to surface that. runExport throws typed RunNotFoundError/
                           # NoArtifactsError for the caller to handle (a store with zero fixable
                           # signals legitimately produces zero artifacts — that's good news, not a
                           # bug). ensureSiteFromIntake writes real client+site rows via
                           # upsertIntakeSite — NOT ensureDevSite's "Adeptra Dev" shortcut — defaulting
                           # clientName to the submitted domain when omitted (documented pre-auth seam:
                           # a shared placeholder name would incorrectly bucket unrelated merchants
                           # under one client; real accounts replace this once auth/dashboard exist).
                           # Also: getReportHtml/getBundleBytes (download straight from Storage via
                           # the service-role key, never minting a signed URL — back the report/bundle
                           # proxy routes below) and isEntitled (STUB, always true — the seam where
                           # billing wires in; see its own comment for exactly what to query once it does)
    runLive.ts             # End-to-end CLI (thin wrapper around pipeline.ts's runAnalysis): domain →
                           # live manifest + capability + feed + page cross-check + LLM checks +
                           # policy/contact probes + payment readiness + Merchant Center readiness
                           # checklist + artifact generation (ucp_manifest + feed_fix + content_rewrite
                           # + mcp_scaffold) → signals → score → artifacts → Postgres. Only handles
                           # argv/env/console; behavior re-verified byte-identical after the extraction
    test.ts                # Mock-driven demo harness for all signal groups
    test_live_pipeline.ts  # Automated assertions: scorer math, capability/feed/page/LLM/policy/
                           # payment/readiness signal logic (mock LlmClient), known-shortcut fixes,
                           # httpFetcher (stubbed fetch)
    test_artifacts.ts      # Manifest generator: no-manifest scaffold, partial-manifest preserve+
                           # correct (incl. byte-for-byte sub-capability preservation), closed-loop
                           # validation against the real signal functions, purity, PLUS: for a
                           # scaffold-registered platform, checkout is flagged (not auto-added) and
                           # excluded from resolves_signal_keys, while a store with no platform
                           # declared is unaffected (still auto-adds checkout the old way). Feed
                           # generator: full/partial supplemental feed, pass→null, no-feed defensive
                           # handling, purity, consistency-signal flag-only. Content-rewrite generator
                           # (mock Fetcher + mock LlmClient, no real I/O): STRUCTURE with grounded
                           # output, FLAG-on-fail, anti-fabrication gate, deterministic @context/@type
                           # injection, determinism + async signature. mcp_scaffold generator:
                           # platform-gate (undeclared/unsupported → null; woocommerce/wix/custom + a
                           # capability gap → their own tree; cart+catalog passing → null REGARDLESS
                           # of checkout's status — the gate-bug-fix regression test, since checkout
                           # can never reach "pass" for a scaffold platform); the canonical UCP tool
                           # surface present (search_catalog/lookup_catalog/get_product/create_cart/
                           # get_cart/update_cart/cancel_cart) and every retired incremental name
                           # (search_products/add_to_cart/update_cart_item/remove_cart_item/
                           # begin_checkout) absent, in all three providers; meta["ucp-agent"] required
                           # (not optional); not_found returned as a JSON-RPC success business outcome,
                           # never thrown; structuredContent present; source-level session-state-
                           # machine + diff-shim assertions (full runtime behavior is exercised
                           # separately — see below); per-platform BOUNDARY re-assertions (Store API
                           # only for WooCommerce, no order/payment endpoint for Wix, no payment/order/
                           # admin method in Custom's now-8-method StoreAdapter contract); Custom's
                           # honesty checks (not-runnable warning, IMPLEMENT-THIS markers, the
                           # source-text-not-live-invoke startup check); tool annotations on the new
                           # surface; the UCP-conformance README's exact three-point structure (catalog
                           # conformant; cart conformant except transport, with cart-mcp.md's own HTTP-
                           # streaming requirement quoted; checkout deliberately absent) and a check
                           # that "UCP cart conformant" is never claimed unqualified; a manifest+
                           # mcp_scaffold integration test proving the generated manifest declares
                           # cart+catalog but never checkout; capabilityChecks.ts tests for the
                           # checkout-handoff opt-in (not_applicable ONLY on the explicit attestation,
                           # never inferred from platform or cart); REGRESSION tests against golden
                           # fixtures for all three providers (test_fixtures/mcp_scaffold_
                           # {woocommerce,wix,custom}_golden.json, re-captured for this round's
                           # baseline); and purity for all three. Plus an orchestrator integration
                           # check that all four generators wire into the async runArtifacts(ctx)
                           # together.
                           #
                           # The session state machine + diff-and-reconcile shim's actual RUNTIME
                           # behavior (not just generated source text) is verified separately, since
                           # executing the generated mcpTools.ts needs the real MCP SDK + zod — deps
                           # this project's own zero-dependency test process deliberately doesn't
                           # install. A one-off harness (built and run against a real npm-installed
                           # copy of a generated scaffold, not committed) drove the compiled
                           # registerUcpTools() against fake in-memory primitives through 32 cases:
                           # add/remove/quantity-change, the same product as two separate line items,
                           # remove+add together, zero platform calls when nothing changed, quantity<1
                           # rejected at the zod schema boundary, a submitted line id that doesn't
                           # match any current line erroring rather than silently adding, and the full
                           # create→active-error→cancel→not_found→recreate session lifecycle — all 32
                           # passed on the first run.
    export/
      reportBuilder.ts     # PURE: turns one run's fetched data into a BundlePlan — a markdown
                           # report, a standalone self-contained report.html (inline CSS, no
                           # external requests), and the file list to zip. Iterates over whatever
                           # artifacts exist generically by artifact_type (typeDisplayName() map,
                           # one line per new type, generic fallback for unknown ones — proven by a
                           # mock "storefront_theme_patch" type in tests). Multi-file artifacts
                           # (decodeFileTree(content) returns non-null) expand into a subfolder in
                           # files[] instead of one file — keyed off content shape, not
                           # artifact_type, so mcp_scaffold needed zero new branching logic here.
                           # All dynamic values HTML-escaped
      bundle.ts            # PURE: hand-rolled zero-dependency ZIP writer (STORED/uncompressed
                           # entries — real, spec-compliant, openable by any unzip tool; CRC32 +
                           # local/central-directory/EOCD records, no third-party lib)
      storageSink.ts       # IMPURE: uploads the zip + standalone report.html to the private
                           # "merchant-exports" Storage bucket via the Storage REST API (same
                           # fetch+service-role-key pattern as supabaseSink.ts), mints 30-day
                           # signed URLs, substitutes the report's own "download the fix bundle"
                           # button target (bundleLinkForReport — defaults to the freshly-signed
                           # URL for CLI/ops use; the HTTP endpoint overrides it with its own
                           # /api/bundle/<runId> route so no signed URL ends up baked into the
                           # HTML), and records an `exports` row (via supabaseSink.insertExport).
                           # Also exports downloadObject (service-role GET, no signed URL — backs
                           # the report/bundle proxy routes) and reportPathFor/bundlePathFor (the
                           # one shared source of truth for the Storage folder convention, used by
                           # both the upload side here and the download side in pipeline.ts)
    exportRun.ts           # CLI (thin wrapper around pipeline.ts's runExport): node exportRun.ts
                           # <run_id> — fetches a run's data, builds the bundle, uploads it, prints
                           # the report page URL + zip download URL. Separate command from runLive.ts
                           # on purpose — export is a distinct "deliver this one" action, not part of
                           # every analysis. Only handles argv/env/console; behavior re-verified
                           # byte-identical after the extraction
    test_export.ts         # reportBuilder purity/determinism, no_manifest framing (never a
                           # punitive 0%), prioritized-plan ordering, artifact coverage, the
                           # unknown-artifact-type future-proofing case, the download-link
                           # placeholder/offline-copy contract, bundle file list, an independent
                           # ZIP-reader round-trip (verifies the hand-rolled format byte-for-byte,
                           # confirmed separately by the real `unzip` utility), and multi-file
                           # artifact expansion (a real encodeFileTree payload → every file lands
                           # under the expected subfolder in files[], exact contents, shows in the
                           # report, and round-trips through the real ZIP writer)
    test_readability.ts    # robots.txt parsing (grouping, per-token blocking incl. the
                           # ClaudeBot-does-not-mean-Claude-SearchBot case, wildcard fallback,
                           # longest-rule-wins with tie-goes-to-Allow), all 10 agent_readability
                           # signals' pass/partial/fail/not_applicable branches, the CORRECTED
                           # content_server_rendered heuristic (fail fires from raw-HTML shell
                           # detection alone, no feed needed; only pass needs feed grounding;
                           # not_applicable only when literally no page could be sampled),
                           # sitemap-index-follow + product-path-filtering fallback sampling, and a
                           # dedicated no-persist guardrail asserting no signal's evidence_json ever
                           # contains a full HTML document
    test_readabilityArtifacts.ts # robots_patch/llms_txt/jsonld + the three flag-only signals folded
                           # into content_rewrite (58 assertions): missing-vs-existing robots.txt modes,
                           # exact-line-removal with unrelated rules provably untouched, the wildcard-
                           # safety override-group behavior, GPTBot/ClaudeBot never auto-unblocked
                           # (opted out or not), llms.txt built from real policy/feed/manifest URLs with
                           # a placeholder (never invented) description, the contested-basis note
                           # proven to come from signalEvidence (not hardcoded) via a distinctive mock
                           # string, jsonld/organization resolving the signal vs. jsonld/product
                           # resolving nothing, the price-disagreement hazard gate (asserts zero Offer/
                           # Product blocks in content when feed and pages disagree), and sitemap
                           # guidance matching sites.platform
    test_pageChecks_golden.ts # Golden-fixture regression lock for pageChecks.ts's three UCP page-
                           # consistency signals, captured BEFORE the rawHtml/pageStates signature
                           # change (added so agent_readability's content-legibility signals could
                           # reuse the same fetched pages) — `capture` writes the fixture, `verify`
                           # diffs current output against it byte-for-byte. Verified byte-identical
                           # before and after the pageChecks.ts change
    test_pipeline.ts       # ensureSiteFromIntake (real client+site rows with platform/feed_url/
                           # opt-out written to the right columns, default clientName=domain,
                           # PATCH-not-duplicate on a repeat submission), runAnalysis (documented
                           # result shape; returns {status:"failed"} — never throws/exits — on a
                           # forced downstream failure), runExport (RunNotFoundError/NoArtifactsError,
                           # documented success shape), the intake handler (valid POST → 200 with
                           # OUR routes as reportUrl/bundleUrl — never the raw signed Storage URL
                           # runExport returns — missing url/platform → 400, non-POST → 405,
                           # analysis failure → 500, NoArtifactsError from export → 200 with a note,
                           # not an error), getReportHtml/getBundleBytes (RunNotFoundError /
                           # ReportNotFoundError|BundleNotFoundError, correct bytes/text on success),
                           # isEntitled (stub always true), and the report/bundle route handlers
                           # (content-type + content-disposition asserted per route, entitlement
                           # checked before bytes are ever fetched, 404s on not-found). Mocks
                           # PostgREST/Storage via SupabaseConfig.fetcher injection; httpFetcher.ts
                           # (used inside runAnalysis, no injection point of its own) is covered by a
                           # temporary globalThis.fetch swap, restored in a finally block
  api/
    analyze.ts             # Intake endpoint — Vercel-shaped, runs locally today. A plain Node
                           # http-compatible handler `(req: IncomingMessage, res: ServerResponse) =>
                           # Promise<void>`, no @vercel/node package: Vercel's Node runtime is
                           # documented-compatible with plain http handlers directly, so a later
                           # `vercel deploy` (Vercel project root set to merchant/) is a config flip,
                           # not a rewrite. Reads the request body manually from the raw stream +
                           # JSON.parse (portable to both local and Vercel; avoids depending on
                           # Vercel's req.body sugar a local server doesn't have). Flow: validate →
                           # ensureSiteFromIntake → runAnalysis → runExport → JSON response. A store
                           # that's already fully compliant can legitimately produce zero artifacts —
                           # NoArtifactsError from export still yields 200 with reportUrl/bundleUrl:
                           # null + a note, not a failure. reportUrl/bundleUrl in the response are
                           # OUR OWN proxy routes (/api/report/<runId>, /api/bundle/<runId>) — never
                           # the raw signed Storage URLs runExport returns; also passes
                           # bundleLinkForReport so the report page's OWN embedded download button
                           # points at our route too, not a URL baked into the HTML. createHandler(deps)
                           # exists purely for testability (dependency injection, no mocking framework
                           # needed); the default export used by serve.ts/Vercel is createHandler()
                           # with the real pipeline.ts functions. Reads env vars (SUPABASE_URL,
                           # SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY) — same names as .env today
    report/
      [runId].ts            # GET /api/report/<runId> — the ACTUAL fix for report.html not rendering
                           # in a browser (see Open items: Supabase Storage forces text/plain + a
                           # sandboxed CSP on any HTML it serves directly, a deliberate anti-phishing
                           # platform policy with no header-based bypass). Fetches report.html
                           # server-side via pipeline.ts's getReportHtml (service-role key, never a
                           # signed URL) and re-serves it with Content-Type: text/html; charset=utf-8
                           # + Content-Disposition: inline. Free, instant, no entitlement check — the
                           # report is the always-available half of a delivery. Same createHandler(deps)
                           # testability pattern and [param].ts Vercel dynamic-route file convention
                           # as analyze.ts
    bundle/
      [runId].ts            # GET /api/bundle/<runId> — the paid deliverable. Checks isEntitled()
                           # BEFORE fetching anything from Storage; 402 when not entitled (today:
                           # never, since isEntitled is a stub — see pipeline.ts). Re-serves
                           # bundle.zip (via getBundleBytes, service-role key, never a signed URL)
                           # with Content-Type: application/zip + Content-Disposition: attachment
    serve.ts               # Local dev server only (node:http, zero dependencies) — routes GET / to
                           # the static form, POST /api/analyze / GET /api/report/* / GET
                           # /api/bundle/* to the real handlers. Not deployed anywhere; exists purely
                           # so merchant/api/*.ts is runnable on your own machine
                           # before there's ever a Vercel project
    public/
      index.html           # The thin intake form: store URL, platform dropdown, optional feed URL,
                           # identity-linking opt-out checkbox. Self-contained (inline CSS/JS, no
                           # framework, light/dark aware — same style as the generated report.html).
                           # A button + fetch() POST to /api/analyze, not a <form> submit — shows an
                           # "analyzing…" state, then the score + report/download links (or the
                           # "no fixes needed" note when nothing was exportable)
```

## Architecture in one paragraph

A merchant enters a store URL. A deterministic-first pipeline crawls a sampled set of pages, detects the platform, reads the `/.well-known/ucp` manifest and product feed, and writes one row per compliance **signal** into Postgres. Scores, the prioritized remediation plan, and the generated artifacts all *derive* from the `signals` table — nothing is a computed value we can't explain back to its evidence. ~90% of UCP checks are deterministic (no LLM), which is what keeps per-analysis cost low.

## Design principles

- **`signals` is the single source of truth.** Scores, plans, and artifacts derive from it.
- **`analysis_runs` are immutable.** Re-running creates a new run → free score-over-time history.
- **Multi-tenant isolation via membership + `SECURITY DEFINER` helpers** — never via JWT metadata.
- **Deterministic-first.** LLMs are used only where they add value (2 of the 25 UCP signals).
- **Honest boundaries.** External gates (Merchant Center eligibility, live payment handler, Google
  approval) are scored as readiness checks and shown as "prerequisite you must complete," never
  "done for you."
- **Portable logic.** Signal checks are pure functions with an injectable fetcher, and the Supabase
  sink talks raw PostgREST over `fetch` (no SDK), so everything runs in an n8n code node today and
  lifts into a standalone worker later, unchanged.

## Running

Requires Node 22+ (native TypeScript type-stripping; `runLive.ts`/`exportRun.ts` also use
`process.loadEnvFile`, available unflagged since Node 20.12/21.7).

**One-time setup — environment variables.** Copy `.env.example` to `.env` at the repo root and
fill in real values:

```bash
cp .env.example .env
```

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...   # optional — enables title_description_consistency + discovery_attributes_enrichment
```

`.env` is gitignored and never committed — `.env.example` (no real values) is the committed
template. `runLive.ts`, `exportRun.ts`, and `merchant/api/analyze.ts` — the only files that read env
vars — call `process.loadEnvFile()` at startup, resolved relative to their own file location so it
works regardless of which directory you run them from. No dotenv dependency, no shell exports
needed; missing `.env` isn't an error, it just falls back to whatever's already in the shell
environment (e.g. in CI, or Vercel's injected env vars later).

**Mock harness** (four scenarios: compliant / present-but-flawed / missing / auth-walled):

```bash
cd merchant/ucp
node --experimental-strip-types test.ts
```

**Pipeline tests** (scorer math + real fetcher behavior against a stubbed `fetch`):

```bash
node --experimental-strip-types test_live_pipeline.ts
```

**Live end-to-end run** (real store → rows in `analysis_runs` / `signals` / `pillar_scores`):

```bash
node --experimental-strip-types runLive.ts shop.example.com
```

If no `site_id` is passed, a dev client + site row are created/reused for the domain. A failed
pipeline marks the run `failed` with `error_detail` — no zombie `running` rows. On success, if any
artifacts were generated, it prints the `exportRun.ts` command to deliver them.

**Export a completed run** (merchant-ready ZIP bundle + a shareable report page, both uploaded to
Supabase Storage as signed, 30-day URLs):

```bash
node --experimental-strip-types exportRun.ts <run_id>
```

Prints `report page: <url>` and `download zip: <url>` — real signed Storage URLs, meant for direct
CLI/ops use (there's no browser involved here). The report page has a working "Download the fix
bundle" button linking to the zip; the zip also contains an offline copy of the same report
(`report.html`), the markdown version (`report.md`), a `README.txt`, and one file per generated
artifact. Fails loudly if the run doesn't exist or has no artifacts.

> Note: opening a signed `report.html` URL directly in a browser shows raw HTML source instead of
> rendering — Supabase Storage deliberately forces `Content-Type: text/plain` plus a sandboxed CSP
> on any HTML object it serves (an anti-phishing platform policy; no bypass via upload headers).
> That's what the report/bundle proxy routes below are for — always use those in a browser, never a
> raw signed URL.

```bash
node --experimental-strip-types test_export.ts
```

**Pipeline unit tests** (mock-`fetch`-injected — `ensureSiteFromIntake`/`runAnalysis`/`runExport`/
the intake endpoint handler, no real network/DB):

```bash
node --experimental-strip-types test_pipeline.ts
```

**Local intake endpoint + form** (the same `runAnalysis`/`runExport` engine as the CLIs above,
driven through a browser instead — a Vercel-shaped handler that just happens to run locally today;
no Vercel account or deployment involved):

```bash
node --experimental-strip-types merchant/api/serve.ts
```

Prints `http://localhost:3000` (override with `PORT=...`). Open it in a browser, fill in a store
URL + platform, and submit — it calls `ensureSiteFromIntake` (writing a real `clients`/`sites` row,
not the `ensureDevSite` shortcut below), then `runAnalysis`, then `runExport`, and renders the score
+ report/download links. A store with nothing to fix still returns `200` with a note — that's a
good outcome, not an error. Deploying this for real later is a config change (set the Vercel project
root to `merchant/`), not a rewrite — `merchant/api/analyze.ts` is a plain Node `http` handler with
no Vercel-specific imports.

The report and bundle links the form renders are **our own routes**
(`/api/report/<runId>`, `/api/bundle/<runId>`) — never a raw signed Storage URL. The report route
proxies `report.html` from Storage server-side and re-serves it with the correct
`Content-Type`/`Content-Disposition` so it actually renders (see the note above); it's free and
instant, no entitlement check. The bundle route is the paid deliverable — it checks
`isEntitled(runId)` before fetching anything and returns `402` when that's `false`. Billing doesn't
exist yet, so `isEntitled` is a stub that always returns `true` (see `pipeline.ts` for exactly what
the real check should query once it does) — the bundle route is fully usable today, the gate just
isn't wired to anything real.

> Note: `signals.priority_score` is a `GENERATED ALWAYS` column — the DB computes
> `impact × weight ÷ effort` itself. The sink deliberately does not send it.

> Note: Category 2 (Product Data Hygiene) only scores if `sites.feed_url` is set — there's no
> onboarding UI for it yet, so it's set directly on the `sites` row (Shopify `products.json` or
> a Google Merchant XML/RSS feed URL). Unset, `feed_available` and its dependents score
> `not_applicable` rather than `fail`. The 2 LLM-scored signals additionally need `OPENAI_API_KEY`;
> unset, they score `not_applicable` too, rather than failing the whole run.

## Status

**All 25 UCP signals across all 6 categories in `signal-specs.md` are implemented, tested, and
live-verified against two real stores (skims.com, gymshark.com). A second, independent pillar —
`agent_readability` (10 signals) — is now also implemented, tested, and live-verified.**

- [x] **`dashboard/` — Next.js customer-facing app, Stages 1 + 2 + 3 (2026-07-11/12).** Separate
      top-level app (own `package.json`/deps/build), scaffolded from Supabase's official
      `create-next-app -e with-supabase` template (Next.js 16.2.10, `@supabase/ssr` 0.12.0 —
      pinned, not left floating on `"latest"`). **Stage 1**: auth foundation only — signup, email
      verification, a single protected `/dashboard` placeholder gated on `getClaims()` (verifies
      the access token's signature against our project's asymmetric ES256 JWKS; safe/non-spoofable
      — confirmed by checking the project's actual `/.well-known/jwks.json`, not assumed from
      Supabase's docs alone). **Stage 2**: the first real tenant-data write. `onboard_add_site()` —
      a new `SECURITY DEFINER` Postgres function, mirroring `user_client_ids()`'s exact hardening
      (`SET search_path = public`) — atomically bootstraps a user's first `clients` +
      `client_members(role='owner')` row (or reuses their existing client) and upserts a `sites`
      row by `(client_id, root_url)`. This is **not a convenience**, it's the only possible
      bootstrap path: `clients` has zero INSERT policy under RLS, and `client_members`'s INSERT
      policy requires the inserter to *already* be an owner/admin of that client — impossible for a
      brand-new client's first-ever membership row. (The original schema migration's own comment
      already flagged this exact "chicken-and-egg self-insert hole" as future work — this closes
      it.) Caught live during verification: Postgres grants `EXECUTE` to `anon`/`authenticated`/
      `service_role` directly via a platform-level `ALTER DEFAULT PRIVILEGES` on every new function
      in `public` — a plain `REVOKE ALL ... FROM PUBLIC` does *not* touch those (they're granted to
      each role individually, not via the `PUBLIC` pseudo-role), so `anon` still had `EXECUTE` after
      the first migration; fixed forward with a second migration explicitly revoking it, verified
      live via `information_schema.routine_privileges`.
      The onboarding form (`/onboarding`, protected) submits through a Server Action that: (1) calls
      `onboard_add_site` via the user's own SSR-cookie-scoped client (anon key + real session, so
      `auth.uid()` resolves correctly — never service-role for this step); (2) synchronously creates
      the `analysis_runs` row at `status='running'` (service-role — `analysis_runs` has no UPDATE
      policy and `signals`/`pillar_scores`/`artifacts` have no INSERT policy for `authenticated`, so
      the whole pipeline write path needs service-role regardless); (3) redirects instantly to
      `/stores/<siteId>`, a status-aware stub reading the site + latest run under normal user-scoped
      RLS. The actual pipeline run (`merchant/ucp/pipeline.ts`'s `runAnalysis` — unmodified logic,
      only a new optional `existingRunId` param added so it can reuse the pre-created run row
      instead of creating its own) is deferred into Next.js's `after()`, called from inside the
      Server Action. This was a real architecture decision, not assumed: a bare fire-and-forget
      promise in a Server Action has **no completion guarantee on Vercel serverless** — confirmed by
      quoting Next.js's own docs, which describe `waitUntil()` (the primitive `after()` is built on)
      as existing specifically to "extend the lifetime of a serverless invocation" that otherwise
      ends once the response is sent. `after()` is stable since Next.js 15.1.0, explicitly supported
      inside Server Functions, and Vercel wires the underlying `waitUntil` automatically — so this
      stays architecturally correct without needing a second deployed HTTP endpoint. Also required
      widening Turbopack's module resolution root (`turbopack.root` in `next.config.ts`) and adding
      `allowImportingTsExtensions` to `dashboard/tsconfig.json`, since `merchant/ucp/*.ts` (imported
      directly — it's zero-npm-dependency plain TS, no package boundary to cross) lives outside the
      Next.js project root and uses explicit `.ts` import extensions; both were validated by an
      actual production build, not assumed to work.
      `analysis_runs.status` already included `'running'`/`'queued'` since the very first schema
      migration (2026-07-03) and `createRun()` already wrote `'running'` before any check work
      started, with the whole pipeline body already wrapped in try/catch calling `failRun()` on any
      thrown error — the spec anticipated needing a new migration for this lifecycle; verifying
      first found it was already fully correct, so no migration was written for it.
      Live-verified end-to-end against a real store (WooCommerce's own official Storefront demo,
      `themes.woocommerce.com`): the onboarding form → instant redirect to `/stores/<siteId>`
      showing "Analysis in progress…" (the run row already existed — no race against `after()`'s
      deferred start) → reload → "Analysis complete," ~3.8s later, 35 signals written (the full real
      pipeline, not a stub). Verified directly in Supabase: exactly one new client/membership/site,
      all fields matching the submitted form, zero new orphan clients (4 pre-existing orphans predate
      `client_members`'s existence entirely — from the backend-only `ensureDevSite`/`ensureClient`
      test paths in earlier sessions, confirmed by `created_at`); RLS isolation spot-checked
      directly (`set local role authenticated; set local request.jwt.claim.sub = ...`) on `sites`/
      `analysis_runs`/`signals` — the test user sees their own rows, a different simulated user sees
      zero on all three; the service-role key confirmed absent from the built client bundle by
      scanning `.next/static` for both the literal secret value and the bare env-var name (zero
      hits for either) — cross-checked against the same scan finding the public anon key once,
      confirming the scan methodology itself isn't a false negative.
      **Stage 3**: My Stores + the full store view, sharing one pure report model with the
      downloadable export so dashboard and export can never diverge. Extracted
      `merchant/ucp/export/reportModel.ts` out of `reportBuilder.ts` — every type/function
      `buildModel` needs (`RunBundleData`/`RunBundleSignal`/`RunBundleArtifact`,
      `ReportModel`/`PillarSection`/`ReportArtifact`, `buildModel`/`buildSections`,
      `canonicalPillarOrder`/`pillarDisplayName`/`typeDisplayName`/`filenameForArtifact`, the
      pillar display-name/description/order constants) — leaving only HTML/markdown string
      rendering behind in `reportBuilder.ts`, which now imports the model and re-exports it
      wholesale (`export * from "./reportModel.ts"`) so every existing external import
      (`supabaseSink.ts`, `test_export.ts`) keeps working unchanged. No dedicated report
      golden-fixture harness existed before this (only `test_export.ts`'s inline assertions) —
      added `test_reportBuilder_golden.ts` (capture/verify, same discipline as
      `test_pageChecks_golden.ts`), captured *before* the extraction, verified **byte-identical**
      after, across three representative shapes (complete run, `no_manifest` framing, a
      multi-file-tree artifact). The dashboard builds a `RunBundleData`-shaped object from its own
      RLS-scoped reads (`dashboard/lib/merchant/runBundle.ts`, mirroring
      `supabaseSink.ts`'s `fetchRunBundleData` exactly, including the `signal_evidence` join by
      `signal_key` — confirmed that table's SELECT policy is unconditionally `true` for any
      authenticated user, since it's global reference data, not tenant-scoped) and calls the SAME
      `buildModel()` the export uses — one source of truth for grouping/sorting/framing, enforced
      by construction, not convention. New `/stores` (My Stores: each site's domain/platform +
      latest run's compact "Searchable NN% · Buyable NN%" — deliberately distinct short labels
      from the full view's formal `PILLAR_DISPLAY_NAMES`, matching the report's own prose
      shorthand) and the extended `/stores/[siteId]` (two pillar cards, what's-working/what-to-fix
      per pillar with priority order and evidence notes, the generated-fixes list with full
      changelogs, a run-history list, and a locked/unlocked fix-bundle section). The fix-bundle
      gate reads `subscriptions` directly via RLS (`dashboard/lib/merchant/entitlement.ts`),
      deliberately mirroring the exact criteria `pipeline.ts`'s `isEntitled()` docstring already
      specifies for its own future real implementation (`status IN ('trialing','active')`) —
      without touching that function, whose own comment says "do not build that query yet" (that
      instruction scopes the *server-side enforcement* path; this is a read-only UI hint with zero
      enforcement power). No subscriptions rows exist for any client yet, so this always evaluates
      `false` today — "locked by default" falls out of real (currently empty) data, not a
      hardcoded stub, and both sides will agree by construction once billing lands. The bundle
      proxy route's own `isEntitled()` stays the sole real gate; the dashboard never bypasses it.
      Not-found-vs-error: an RLS-scoped `.select().maybeSingle()` on a site the user doesn't own
      returns `null` exactly like a nonexistent id — confirmed empirically, not assumed, by loading
      both a real other-owner's site and a fabricated random UUID and diffing the rendered output
      (byte-identical). Live-verified end-to-end: My Stores showed "Searchable 85.71% · Buyable
      13.78%"; the full store view showed the identical two pillar scores plus a fully populated
      what-to-fix list (priority-ordered, with the `robots_txt_valid`/`sitemap_present` evidence
      notes rendering their `basis`) and all four generated-fix artifacts with complete
      changelogs; the fix bundle correctly showed 🔒 locked. Independently confirmed against
      Supabase: the store view's numbers equal `pillar_scores` for that run exactly (`85.71`/`4/6`,
      `13.78`/`2/13` — zero recomputation drift); RLS isolation re-verified per-table
      (`signals`/`pillar_scores`/`artifacts`/`sites`) via a simulated second user, zero rows on
      all four; the service-role key remains absent from the production client bundle even with
      the new `merchant/ucp` imports (same value + bare-name scan as Stage 2, zero hits, anon key
      still found once as the methodology sanity check).

- [x] **Signal-definition guardrail: weight/impact/effort drift made impossible-by-construction
      (2026-07-11).** Inventory (grepping every `function contribution` across `merchant/ucp/`) found
      **nine** check modules each carrying its own local `W` weight/impact/effort object and its own
      byte-identical copy of `contribution()` — not the six originally estimated. That scattering is
      exactly how `robots_txt_valid` drifted to weight 1.5 instead of spec's 1.0 undetected (see the
      entry below): nothing mechanically connected any of the nine copies to a declared source of
      truth. New `signalDefinitions.ts` is now the single canonical source for every signal in both
      pillars — an array (`SIGNAL_DEFINITIONS`, duplicate `signal_key`s rejected at import time, not
      just in a test someone might skip), a `getDef(signal_key)` accessor that throws by name on a
      missing/mistyped key, and one shared `contribution()`. Every `sig_*` function across all nine
      files (`manifestChecks.ts`, `capabilityChecks.ts`, `feedChecks.ts`, `pageChecks.ts`,
      `llmChecks.ts`, `policyChecks.ts`, `paymentChecks.ts`, `readinessChecks.ts`,
      `readabilityChecks.ts`) now reads `pillar`/`category`/`signal_key`/`weight`/`impact`/`effort`
      from `getDef()` — none redeclares a literal of its own — closing the miscategorization gap, not
      just weight drift. This was a **pure move, zero value changes**: canonical values were
      transcribed exactly from the inventory, proved with a golden fixture of all 35 signals' full
      output captured *before* touching any check module and diffed *after* — **byte-identical**
      (`test_signal_values_golden.ts`). A permanent guardrail (`test_signal_definitions.ts`) now runs
      on every future change: every declared weight `>= 0`; the zero-weight set is asserted to be
      **exactly** `{merchant_center_account_ready, ucp_early_access_status}` — not a bare `>= 0`
      check, so a scored signal accidentally zeroed, or a readiness signal accidentally given a
      nonzero weight, both fail loudly instead of passing; impact/effort in `[1,5]`; and — running the
      **real orchestrators** (`runManifestChecks`, `runCapabilityChecks`, `runFeedChecks`,
      `runPageConsistencyChecks`, `runLlmChecks`, `runPolicyChecks`, `runPaymentChecks`,
      `runReadinessChecks`, `runReadabilityChecks`) against representative mocks — the emitted
      `signal_key` set matches the declared set exactly, per pillar, in both directions (an
      undeclared-but-emitted signal, or a declared-but-unemitted one, both fail). Verified the
      guardrail actually catches drift, not just passes trivially: temporarily hardcoded a wrong
      weight in `paymentChecks.ts`, confirmed the test failed with the exact expected/actual mismatch,
      reverted, confirmed green again. The `agent_readability` 2026-07-10 reconciliation history (the
      six-signal drift correction, see below) now lives in `signalDefinitions.ts`'s header comment as
      the documented home of that decision, removed from `readabilityChecks.ts` itself. Header comment
      states plainly which pillar's numbers are validated against what: UCP weights were **never**
      externally spec'd as literal numbers (only weight *classes* per category) — "chosen proportional
      to impact" is a frozen original design choice, not a value confirmed against an outside
      authority; `agent_readability` weights **were** spec'd and did drift, reconciled 2026-07-10.
      Live-verified against skims.com: a fresh run post-refactor scored **identically** to the last
      pre-refactor run on the same site (`ucp` 82.69%, 15/22; `agent_readability` 96.77%, 9/10) —
      confirmed by a row-by-row DB diff of all 35 signals' status/weight/score_contribution/impact/
      effort/pillar/category between the two runs: zero mismatches.
- [x] **Second pillar: `agent_readability` (2026-07-11).** `pillar='agent_readability'` — "can a
      generic AI system access, parse, and correctly understand this store?", deliberately NOT a
      claim about AEO/GEO citation lift. `aeo_geo` is a third pillar value the schema has allowed
      since its very first migration, but it stays **intentionally empty** — no signals are scored
      into it — until credible evidence justifies claiming an effect on AI search visibility.
      Locked pillar boundary, enforced by construction (no signal_key exists in both): `ucp` =
      protocol compliance (manifest, capabilities, feed data, feed/page consistency, payment
      readiness); `agent_readability` = site legibility to ANY machine (crawler access, raw-HTML
      content, page-level schema markup, discovery surfaces).
      New `signal_evidence` table decouples fast-moving epistemic judgments from code deploys — a
      `basis` column (`specified` / `measured` / `documented` / `contested` / `no_evidence`) rated
      per signal, looked up fresh at report-build time (never snapshotted onto a `signals` row, so
      a later evidence correction is reflected on every re-render, not frozen at scan time), plus a
      `merchant_note` surfaced next to every failing/partial `agent_readability` signal in the
      report — the disclosure IS the product, not a footnote. Key correction made during a
      pre-build verification pass: the "AI crawlers don't execute JavaScript" finding is NOT from
      OpenAI's or Anthropic's own crawler docs (checked directly — neither mentions JS execution at
      all); it's Vercel + MERJ's independent network-level measurement of 569M+ real GPTBot fetches
      (Gemini and AppleBot are the documented exceptions). That gap — an empirically *measured*
      fact being asked to fit into a `documented` (vendor-self-disclosed) bucket — is why `basis`
      has five values, not four: `measured` is stronger than `documented` for behavioral claims,
      since docs can be stale or aspirational while an observation is what actually happened.
      `content_server_rendered` and `schema_in_raw_html` are rated `measured` on that citation.
      New `sites.ai_training_opt_out` attestation (third of the pattern, after
      `identity_linking_opt_out`/`checkout_handoff_opt_in`): blocking GPTBot/ClaudeBot to keep
      content out of AI training is a legitimate business decision, never inferred from robots.txt
      contents alone. `content_server_rendered`'s heuristic was corrected before building: FAIL
      fires from raw-HTML shell-pattern detection alone (no feed needed) — the store MOST likely to
      have the SPA problem is a custom store with no feed, and under the original design that store
      could never reach `fail`, only `partial`/`not_applicable`; only PASS needs feed grounding
      (confirming the page's visible text actually matches the feed's known title/price); a no-feed
      store now caps at `partial` instead of being silently exempted. `not_applicable` means
      literally zero product pages could be sampled by any means. `pageChecks.ts`'s
      `fetchProductPage`/`sampleAndCompare` were extended (not duplicated) to expose raw HTML +
      the deduped page-state map for reuse — `rawHtml` is in-memory only, asserted by a dedicated
      test to never reach `evidence_json` (only lengths/booleans/the threshold constant do). A
      golden fixture of the three UCP page-consistency signals' exact output was captured *before*
      that signature change and diffed *after* — **byte-identical**, confirming the refactor didn't
      alter UCP scoring by a single byte (`test_pageChecks_golden.ts`). No-feed stores get their own
      sitemap-driven fallback sampling (one-level index-sitemap follow, product-path-convention
      filtering) reusing the same `fetchProductPage`. Hand-rolled, zero-dependency robots.txt parser
      with per-token semantics — a `User-agent: ClaudeBot` block does NOT apply to
      `Claude-SearchBot`, each literal token gets its own lookup with wildcard fallback, and a tied
      Allow/Disallow rule length resolves to Allow (a real bug caught by the test suite: the first
      cut resolved same-length ties to whichever rule appeared first in the file, not to the
      documented least-restrictive-wins convention). `overallScore` stays a simple unweighted mean
      of whatever pillar scores are present (no scorer.ts change — it was already pillar-agnostic by
      design); `pillarCount` is surfaced alongside it everywhere it's displayed so a 1-pillar run and
      a 2-pillar run are never silently compared as equivalent numbers. Live-verified end-to-end
      against skims.com (an existing real-store test site, `is_test=true`): one run wrote exactly
      **10 `agent_readability` signals + 25 `ucp` signals + 2 `pillar_scores` rows** — the DB query
      confirms the 10/25 split precisely — scoring `ucp` 81.41% and `agent_readability` 97.14%
      (content_server_rendered and schema_in_raw_html both `pass` on skims.com's real, server-
      rendered product pages; the lone `fail` was `llms_txt_present`, expected since skims.com
      doesn't publish one). The exported report correctly renders two pillar sections
      ("UCP Protocol Compliance", "Agent Readability") with the failing signal's `basis` +
      `merchant_note` disclosed inline. Both migrations applied via Supabase MCP and verified live
      (`list_migrations` + column/constraint/trigger/RLS-policy/seed-row spot-checks via
      `execute_sql`, matching the rigor already established for `checkout_handoff_opt_in`/`is_test`).
- [x] Database schema (deployed to Supabase)
- [x] UCP compliance signal specs (v1)
- [x] Category 1 — Discovery & Manifest, all 4 signals (tested against mocks, live-verified)
- [x] Category 3 — Capabilities, all 6 signals (tested against mocks, live-verified)
- [x] Category 2 — Product Data Hygiene, all 7 signals: `feed_available`, `native_commerce_attribute`,
      `product_id_consistency`, `price_consistency_cross_surface`, `availability_consistency`,
      `title_description_consistency`, `discovery_attributes_enrichment`
      (Shopify `products.json` + Google Merchant XML parsing, JSON-LD page cross-referencing,
      OpenAI-backed semantic/enrichment checks; tested, live-verified — matched real
      SKUs/prices/availability across 15 live product pages, and got sensible real LLM verdicts
      on 5 real products with no false contradictions)
- [x] Category 5 — Policy & Post-Purchase Transparency, all 3 signals: `return_policy_present_consistent`,
      `shipping_info_present_consistent`, `support_contact_present` (best-effort known-path probing +
      schema.org Organization.contactPoint; tested, live-verified — found real policy pages at
      different URLs per store, correctly failed shipping-info absence on gymshark.com, correctly
      flagged its Organization schema as present-but-unstructured contact info)
- [x] Category 4 — Payment / AP2 Readiness, all 3 signals: `ap2_compatibility_declared`,
      `credential_security_posture`, `merchant_of_record_declared` (reads `ucp.payment_handlers`
      from the already-fetched manifest — no new network call; tested, live-verified against
      skims.com's real payment_handlers block — correctly partial on AP2 explicitness, correctly
      pass on tokenization_specification presence)
- [x] Category 6 — Merchant Center Eligibility, all 2 signals: `merchant_center_account_ready`,
      `ucp_early_access_status` — entirely self-attested onboarding columns on `sites`, weight `0`
      so scorer.ts excludes them from the score and signals_total/signals_passed (per spec: this
      category is a readiness checklist, not part of capability-quality scoring). Live-verified:
      unattested → both `not_applicable`; attested pass → both `pass` with the score unchanged
      (84.46% before and after, on skims.com).
- [x] Real HTTP fetcher + Supabase insert (unit-tested, live-verified against skims.com, gymshark.com)
- [x] Scorer → `pillar_scores` (unit-tested, live-verified)
- [x] First live end-to-end runs against real stores (skims.com, gymshark.com)
- [x] Artifact generation, artifact #1 (`ucp_manifest`): fixes the manifest-content signals in
      Category 1 + 3. Pure generator, preserves all valid existing config byte-for-byte (proven
      live on skims.com's real manifest — mcp transport, sub-capability catalog shape, all three
      payment handlers untouched), auto-fixes with real canonical values, obvious placeholder for
      the merchant-specific endpoint, flags (never guesses) unmappable authority URLs and
      merchant-preference signals (identity_linking, endpoint_reachability). Live-verified on
      gymshark.com (no manifest → full starter scaffold, 7 signals resolved) and skims.com
      (existing manifest → 0 changes needed structurally, 4 honest flags).
- [x] Artifact generation, artifact #2 (`feed_fix`): a Google Merchant supplemental feed adding
      `native_commerce=true` for products missing it. Never authors product data (titles/prices/
      availability) — references products by id only. Opts in every product currently missing the
      attribute but always flags a REVIEW-before-uploading warning (the identity_linking lesson
      applied again: a merchant-eligibility decision is never silently made for them). All other
      Category 2 signals (consistency checks, title/description, discovery attributes) are
      flag-only in this generator — reconciling a feed/page mismatch is a merchant decision, not
      an auto-fix. Live-verified on skims.com and gymshark.com: real 30-item feeds, real product
      IDs in the generated supplemental feed, `changelog_json` and `resolves_signal_ids`
      persisted correctly.
- [x] Artifact system generalized for more generator types: shared `ArtifactContext` (`{ manifest,
      feed, signals }`) so a third generator never requires changing `runArtifacts()`'s signature;
      shared `ArtifactType`/`ArtifactChangelog`/`ArtifactDraft` in `artifacts/types.ts`;
      `artifacts.changelog_json` persisted (was print-only before).
- [x] Artifact generation, artifact #3 (`content_rewrite`): the first async/impure generator —
      structures a merchant's EXISTING return-policy/shipping-info page and homepage contact
      details into schema.org JSON-LD (never authors new policy language or invents contact
      details/product facts). `title_description_consistency` and `discovery_attributes_enrichment`
      are flag-only, same as the other generators' merchant-decision guardrail. Two-layer
      anti-fabrication: prompt discipline plus a mechanical groundedness check that rejects the
      whole generation (never partially repairs) if any number in the output isn't traceable to
      the source page text. `@context`/`@type` are injected deterministically, never trusted to
      the model. `runArtifacts` is now async to accommodate it; the sync manifest/feed generators
      are unaffected. Live-verified on skims.com (all 3 STRUCTURE-eligible signals already `pass`
      — correctly untouched; 2 Category-2 signals `partial` — correctly flagged, not drafted) and
      gymshark.com (return policy `partial` — real LLM call, fetched the real page, produced
      grounded `merchantReturnDays: 30`/`returnPolicyCategory`/`returnMethod`/`applicableCountry`,
      all traceable to the source text, `deploy_status='draft'`, `resolves_signal_ids` populated
      correctly). Exported successfully alongside the other two artifact types.
- [x] Export & delivery (Track C): `exportRun.ts <run_id>` turns a completed run into a merchant-ready
      ZIP bundle + a self-contained shareable HTML report page, both uploaded to the private
      `merchant-exports` Storage bucket as signed 30-day URLs, with a row recorded in `exports`.
      Zero-dependency hand-rolled ZIP writer (STORED entries) — verified byte-for-byte via an
      independent reader in tests AND opened successfully by the real `unzip` utility. The report
      shows the honest no_manifest framing (never a punitive 0%), the prioritized fix plan sorted by
      `priority_score`, and every artifact's `must_complete`/`flagged` items front and center.
      Live-verified end-to-end on skims.com and gymshark.com: downloaded and inspected both the
      report page and the zip contents directly from Storage.
- [x] Artifact generation, artifact #4 (`mcp_scaffold`): a deployable WooCommerce MCP shopping-server
      scaffold (catalog search + cart building via WooCommerce's public Store API only — never the
      admin `/wc/v3/` API, never the Store API's own `/checkout` endpoint; `begin_checkout` returns
      the cart + the store's normal checkout URL for handoff, no payment processing). Platform-GATED
      on `sites.platform === 'woocommerce'` (an onboarding-declared fact — new migration
      `20260707000000_add_mcp_scaffold_artifact_type.sql`; onboarding UI to set it doesn't exist yet,
      so it's a manual column update), never platform-guessed, and only generated when
      checkout/cart/catalog capability signals aren't already all passing. Multi-file output via a
      tagged `ArtifactFileTree` in `content` (no new DB column) that `reportBuilder.ts` expands into
      a `mcp-server/` subfolder in the zip, keyed off content shape so future multi-file generators
      get this for free. `resolves_signal_keys` is always empty — never claimed resolved
      pre-deployment. Live-verified: real `null`-gating confirmed against skims.com and gymshark.com
      (both already have all three capabilities passing via their real manifests — correctly
      untouched); the positive generation path verified against a real, live 404 (`example.com`, a
      genuine no-manifest case) with `platform` set manually for the test. The exported zip's
      `mcp-server/` folder was downloaded, `npm install`'d, built with `tsc` (zero errors), and
      started for real — confirming the generated code isn't just plausible-looking text.
- [x] Artifact generation, artifact #4 continued — second platform (`sites.platform === 'wix'`): a
      deployable Wix MCP shopping-server scaffold, raw REST against Wix's eCommerce API (no Wix SDK
      dependency). Required generalizing `mcpScaffoldArtifact.ts` from a single WooCommerce-only file
      into a spine (platform dispatch, capability-signal gate, file-tree/changelog assembly) +
      per-platform provider modules under `artifacts/scaffold/` — proven non-regressive with a
      golden-fixture test capturing the pre-refactor WooCommerce output and diffing it against the
      refactored output byte-for-byte (two disclosed, necessary generalizations from genuinely
      sharing `loadEnv.ts` and one changelog line across platforms; every other file identical).
      Structurally different boundary problem than WooCommerce: WooCommerce's Store API cannot
      authorize payment, so the platform itself enforces the boundary; Wix's eCommerce API CAN create
      checkouts and orders, so the boundary here is enforced by the generated code's own discipline —
      an explicit "endpoints this file deliberately never calls" header comment in `wix.ts` plus a
      boundary regression test asserting no order-creation/payment-submission endpoint is ever
      referenced. Scope reality is disclosed prominently (a dedicated README section placed BEFORE
      the setup walkthrough, verified by a test asserting the ordering): Wix has no narrower
      grantable OAuth scope than the 4 scopes this server actually needs, so the deploy guide tells
      the merchant to treat the deployed server and its `WIX_CLIENT_ID` as sensitive. Wix's Catalog
      V1/V3 split (not backward-compatible; existing sites may be on either) is handled with a hard
      startup check — `assertCatalogV3()` calls the confirmed-cheap `GetCatalogVersion` endpoint and
      fails with a plain-English message ("this server requires Wix Catalog V3...") rather than
      letting a V1 site hit confusing runtime errors later; this scaffold is V3-only by design, not
      dual-version. Also discloses that the Wix OAuth token endpoint it depends on is currently marked
      Developer Preview by Wix and may change. Live-build-verified the same way as WooCommerce
      (`npm install && npm run build && npm start`) — this run caught two real bugs the mock-driven
      tests couldn't (see Open items below), both fixed and re-verified with the same live cycle
      before shipping.
- [x] Artifact generation, artifact #4 continued — MCP best-practice tool annotations + a third
      platform (`sites.platform === 'custom'`), plus a major honesty finding about UCP protocol
      conformance. Two MCP-SDK-verified additions applied identically across all three providers via
      the shared spine: (1) `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`
      annotations on every tool (verified directly against the `@modelcontextprotocol/sdk` v1.29.0
      source — `registerTool`'s config accepts `annotations` as a sibling of `title`/`description`/
      `inputSchema`), with the SDK's own caveat ("all properties in ToolAnnotations are hints...
      clients should never make tool use decisions based on ToolAnnotations received from untrusted
      servers") quoted verbatim in the generated comment, so annotations are never mistaken for a
      substitute for this codebase's actual payment-boundary discipline; (2) investigating whether to
      prefix/rename tools for MCP multi-server collision-safety surfaced instead that UCP's own MCP
      transport binding (`docs/specification/{cart,catalog,checkout}-mcp.md`,
      Universal-Commerce-Protocol/ucp, fetched and read directly, not guessed) prescribes canonical
      tool names (`create_cart`/`search_catalog`/`create_checkout`/etc.), a session-based replace-
      style cart model, required HTTP streaming transport, and a `complete_checkout` tool that
      literally accepts payment credentials and places the order — directly contradicting the
      payment-handoff boundary every provider in this codebase exists to enforce. Decision (see Open
      items below for the full reasoning): do NOT rename tools or chase literal UCP MCP-transport
      conformance this round — a partial rename would look conformant while being uncallable by a
      real UCP agent, which is worse than honest divergence. Instead, replaced an overstated line
      ("Its tools follow the same catalog/cart vocabulary your UCP manifest declares") in all three
      generated READMEs with an explicit disclosure of the three divergences, plus what IS actually
      true: deploying this server and pointing the manifest at it genuinely satisfies Adeptra's own
      capability-declaration and endpoint-reachability checks (verified directly against
      `capabilityChecks.ts` — those checks read manifest JSON and probe HTTP reachability; neither
      requires literal MCP protocol conformance), so the changelog's existing claim doesn't change.
      Proven non-regressive for WooCommerce and Wix with a golden-fixture diff for each, captured
      immediately before this round's changes: every file byte-identical except `server.ts` (which
      strips back to golden once the annotation fields are removed) and `README.md` (whose untouched
      suffix, from the section after the disclosure onward, is byte-identical to golden).
      The third platform, `custom.ts`, is a different kind of provider than WooCommerce/Wix: a
      bespoke store has no API to write a real client against, so it generates a REFERENCE
      IMPLEMENTATION instead of a working server — `src/server.ts` (complete, all seven MCP tools +
      the payment boundary) is generated in full, but `src/store.ts`'s seven `StoreAdapter` methods
      each throw a literal `"IMPLEMENT-THIS: ..."` error with a worked-example doc comment, for a
      developer (the merchant's, or Adeptra's own paid setup service) to implement. The boundary here
      is a CONTRACT, not a real API restriction: `src/types.ts`'s `StoreAdapter` interface has no
      payment/order/admin method at all — documented explicitly ("if you find yourself needing to add
      such a method, stop"), though unlike WooCommerce/Wix nothing at the type level can stop a
      developer from ignoring that. `server.ts` refuses to start while any method is still stubbed,
      detected by reading each method's own source text for the `IMPLEMENT-THIS` marker
      (`Function.prototype.toString()`) rather than invoking the adapter (rejected: risks false
      positives/side effects on a partially-done adapter) or a separate boolean flag (rejected: can
      drift out of sync with what's actually implemented) — live-verified end-to-end: `npm install &&
      npm run build` succeeds even with every method stubbed (compiles cleanly, fails only at
      runtime, by design); `npm start` prints one clean line naming all seven still-stubbed methods,
      no stack trace; implementing methods one at a time in the compiled output correctly narrows the
      failure message to only the remaining stubs (no false positives on finished methods); and the
      server starts cleanly once all seven are done.
- [x] Artifact generation, artifact #4 continued — the UCP catalog + cart CONFORMANCE profile
      (2026-07-09): all three `mcp_scaffold` providers now implement UCP's actual canonical
      catalog + cart tool surface (`search_catalog`/`lookup_catalog`/`get_product`/`create_cart`/
      `get_cart`/`update_cart`/`cancel_cart`) instead of the earlier bespoke, incremental tool set —
      reversing the prior "honest divergence" position once research established that UCP's own cart
      capability is explicitly usable without checkout ("basket building without the complexity of
      checkout"), that capabilities are independently adoptable, and that `continue_url` is UCP's own
      sanctioned cart-to-checkout handoff mechanism. Checkout remains permanently out of scope — the
      generated manifest declares catalog + cart only, and `capabilityChecks.ts`'s
      `capability_checkout_declared` now returns `not_applicable` ONLY on an explicit merchant
      attestation (`sites.checkout_handoff_opt_in`, migration `20260709000000_sites_checkout_handoff_
      opt_in.sql`, same shape/reasoning as `identity_linking_opt_out`) — never inferred from platform
      or from cart being declared, so the signal only goes N/A on merchant intent, never as a side
      effect of which artifact Adeptra generated. The bulk of the new logic lives once in
      `scaffold/shared.ts`'s `mcpToolsTs()`, generating a byte-identical `src/mcpTools.ts` for all
      three providers: a real session state machine (one platform cart, ever — `create_cart` errors
      rather than silently resetting an already-active cart; `cancel_cart` empties the real platform
      cart and marks the session gone; every cart tool returns `not_found`, as a JSON-RPC success
      business outcome matching UCP's own error shape, never thrown, once canceled) and a diff-and-
      reconcile shim for `update_cart`'s UCP-mandated full-replacement semantics (every platform's
      real API is incremental) — matching submitted line items to existing ones by id, treating
      id-less items as new adds, treating omitted current items as removals, issuing zero platform
      calls when nothing changed, and rejecting a submitted id that doesn't match any current line as
      an error rather than silently adding it. `quantity` has a hard schema minimum of 1 (verified
      directly against UCP's own `line_item.json` — zero is out-of-range, not a removal sentinel).
      Each provider supplies only primitives (`getCartRaw`/`addItem`/`setItemQty`/`removeItem`/
      `emptyCart`/`checkoutUrl`); Wix's `checkoutUrl()` creates a real Wix-side checkout object (not
      free), so `continue_url` is minted lazily and cached, invalidated only on an actual line-item
      change and skipped entirely for an empty cart. Custom's `StoreAdapter` contract gained an eighth
      method, `emptyCart`, for the same session guarantees — still with no payment/order/admin method.
      Verified two ways: static source-level checks in `test_artifacts.ts` (tool names, required
      `meta["ucp-agent"]`, `structuredContent`, annotations on the new surface, the disclosure
      section's exact three-point structure — catalog conformant; cart conformant on names/shapes/
      session but NOT transport, since `cart-mcp.md`'s own conformance section requires HTTP
      streaming and this server uses stdio; checkout deliberately absent — with a test asserting "UCP
      cart conformant" is never claimed unqualified), and a separate RUNTIME harness driving the
      actual compiled `registerUcpTools()` against fake in-memory primitives through 32 cases (add/
      remove/quantity-change, the same product as two distinct line items, remove+add together, zero
      calls when unchanged, quantity<1 rejected at the schema boundary, an invalid line id erroring
      not silently adding, and the full create→active-error→cancel→not_found→recreate lifecycle) —
      all 32 passed on the first run. Also fixed a real gate bug found while making this change:
      `mcpScaffoldArtifact.ts`'s "is there still work to do" check included checkout's status, which
      — now that checkout can never reach `pass` for a scaffold-platform store — would have meant the
      generator never stopped claiming work remained, even for a fully, correctly deployed store;
      fixed to gate on cart+catalog only, with a regression test. And a real latent bug found via live
      `npm start`: WooCommerce's `woocommerce.ts` threw at module load if `WOOCOMMERCE_STORE_URL` was
      unset — the exact ES-module import-order race already found and fixed for Wix in an earlier
      round (this file's own throw always won against `server.ts`'s friendlier check, since imports
      evaluate before the importing module's own body runs), just never re-tested with a truly empty
      `.env` after the original `loadEnv.ts` fix, so it shipped unnoticed until this round's live
      verification caught it. Fixed the same way as Wix: no module-level throw, a lazy assertion
      instead. All three scaffolds live-build-verified end to end (`npm install && npm run build &&
      npm start`): WooCommerce and Wix each print one clean line on a missing env var (no stack
      trace) and start/fail cleanly against a real (or realistically fake) endpoint; Custom correctly
      lists all eight still-stubbed methods, narrows the list correctly as methods are implemented one
      at a time, and starts cleanly once complete.
- [ ] Remaining artifact types: `jsonld`, `llms_txt`, `robots_patch`
      (structured as sibling modules under `artifacts/`, not yet built)
- [ ] Edge-served agent-readable layer
- [x] Callable pipeline + intake endpoint + thin form: `runAnalysis`/`runExport`/`ensureSiteFromIntake`
      extracted from `runLive.ts`/`exportRun.ts` into plain functions in `pipeline.ts` (no
      process.argv/exit/console.log) — the same engine now callable by a human (CLI), an HTTP form
      (`merchant/api/analyze.ts` + `public/index.html`), and later an agent. `ensureSiteFromIntake`
      writes real `clients`/`sites` rows (platform/feed_url/opt-out to the actual columns), not the
      `ensureDevSite` dev shortcut — verified live: a submission creates a new client+site, a repeat
      submission for the same URL updates that same row (confirmed via direct SQL — one row,
      `platform`/`feed_url` reflecting the latest submission, not a duplicate). The intake endpoint is
      a plain Node `http` handler (no `@vercel/node`, zero dependencies) so a later Vercel deployment
      is a config change, not a rewrite; `merchant/api/serve.ts` runs it locally today. Live-verified
      end-to-end through the actual HTTP endpoint (curl, matching exactly what the form's `fetch()`
      call sends): real client/site creation, real analysis, real export. (Its response originally
      returned raw signed Storage URLs for the report/bundle links — replaced by the report/bundle
      proxy routes below, since the report never actually rendered from a signed URL anyway.) One
      regression caught by the required live re-run of `runLive.ts`/`exportRun.ts` before this
      shipped: `exportRun.ts`'s CLI output referenced `result.runId`, but the extracted
      `ExportResult` type didn't carry it — fixed by adding `runId` to `ExportResult`, with a
      regression test added and the live re-run repeated to confirm.
- [x] Report/bundle delivery proxy routes + entitlement seam: `GET /api/report/<runId>` and
      `GET /api/bundle/<runId>` (`merchant/api/report/[runId].ts`, `merchant/api/bundle/[runId].ts` —
      Vercel's `[param].ts` dynamic-route convention) fetch straight from the `merchant-exports`
      Storage bucket server-side (service-role key, `pipeline.ts`'s `getReportHtml`/`getBundleBytes`)
      and re-serve the bytes themselves — no signed Storage URL is ever handed to a client for either
      artifact anymore, including the report page's OWN embedded "download the fix bundle" button
      (`uploadAndRecordExport` gained a `bundleLinkForReport` override for exactly this). Built
      because Supabase Storage deliberately forces `Content-Type: text/plain` plus a sandboxed CSP on
      any HTML object it serves directly — confirmed via Supabase's own GitHub discussions, no bypass
      via upload headers exists — so a signed `report.html` URL opened as raw source in a browser no
      matter what content-type was set at upload time; proxying it is the only fix. Live-verified: the
      report route now serves real HTML with `Content-Type: text/html; charset=utf-8` +
      `Content-Disposition: inline`, confirmed rendering with correct em-dashes (the mangled-UTF-8
      symptom from the missing charset is gone); the bundle route serves `Content-Type: application/zip`
      + `Content-Disposition: attachment`, opened successfully with the real `unzip` utility; grepped
      the full intake response and the rendered report page for `supabase.co` — zero occurrences.
      The bundle route checks `isEntitled(runId)` before fetching any bytes and returns `402` when
      false; `isEntitled` (`pipeline.ts`) is a clearly-marked STUB that always returns `true` — no
      payment/billing logic exists yet. Recommended entitlement home once billing lands: the existing
      `subscriptions` table (`client_id` + optional `site_id`, `tier`, `status`) — already scoped
      exactly right for "does this client/site have an active paid grant," so no new table or column
      is needed, just a real query against it. No migration added.
- [ ] Onboarding UI (feed URL, identity-linking opt-out, and Category 6 attestations are all plain
      DB columns today, set via SQL — no dashboard to set them yet; the intake form is a first step
      but isn't a full dashboard)
- [ ] Billing/entitlement: `isEntitled()` is a stub (always `true`) — see the recommendation above for
      where the real check should live (`subscriptions` table, no new schema needed)
- [x] **Removed the composite `overall_score`; report both pillars explicitly (2026-07-10).**
      `scorer.ts`'s `overallScore()` (mean of pillar scores) is deleted, not replaced — there is no
      composite anymore, by design. Live data proved the old number actively misleading: two runs of
      skims.com's real site a day apart went `{ucp: 86.36}` → `{ucp: 81.41, agent_readability: 97.14}`.
      UCP compliance genuinely fell (86.36% → 81.41%) while the averaged composite *rose* (86.36% →
      89.28%), purely because a second, unrelated pillar got averaged in. Diffing every signal between
      the two runs (before touching any code, per the "an unexplained score movement is a bug until
      proven otherwise" discipline) ruled out the obvious suspect — `capability_checkout_declared` was
      identical (`pass`) in both — and found the real cause: the two runs were against *different*
      `sites` rows that happen to share the domain "skims.com" (see the Open Items entry below). There
      is no principled basis for weighting `ucp` against `agent_readability` — they measure
      non-commensurable things ("can an agent transact with you" vs. "can an agent read you at all") —
      and inventing a weighting would violate the same "no credible basis, no claim" discipline that
      keeps `aeo_geo` empty. `pillar_scores` was already the source of truth; this build just stops
      hiding it behind an average.
      `AnalyzeResult`/the intake endpoint's JSON response/the form now carry `pillars: PillarScoreRow[]`
      instead of `overallScore`. The report (`reportBuilder.ts`) is retitled **"AI Commerce Readiness
      Report"** (was "UCP Readiness Report" — as stale a name as the composite it displayed) and shows
      two pillar score cards side by side, always in the same order (`agent_readability` first, as the
      "searchable" precondition to `ucp`'s "buyable" claim), each labeled with its exact claim sentence
      ("Can AI systems reach, read, and correctly understand your store?" / "Can an AI shopping agent
      actually transact with your store?") and explicitly tied to the searchable/buyable service tiers.
      The old global "no manifest" banner is now scoped to just the `ucp` card — `agent_readability`
      shows its real score regardless of manifest presence, since it's independently measurable; a
      no-manifest store now gets a genuine, actionable readability score instead of nothing.
      `analysis_runs.overall_score` is deprecated via a **comment-only migration**
      (`20260712000000_deprecate_overall_score.sql`, no `ALTER`, no backfill, no recompute — the 28
      historical values stay exactly as they were, correct for the world that produced them) — nothing
      writes to it anymore (confirmed by grepping the whole repo: only `completeRun` wrote it and only
      `fetchRunBundleData` read it; both are changed), so it stays at its column default (`NULL`, no
      `DEFAULT` clause) for every run going forward, complete or not. `status` remains the only
      authoritative outcome signal. A dedicated structural test
      (`test_pipeline.ts`, "no-composite guarantee") reads the actual shipped source of `pipeline.ts`,
      `reportBuilder.ts`, `analyze.ts`, `index.html`, and `runLive.ts` and asserts the literal strings
      `overallScore`/`overall_score` appear in none of them — enforced, not just asserted in prose.
      Both UCP and agent_readability golden-fixture signal outputs are unchanged (this build touches
      presentation and one derived value only, never signal computation). Live-verified against the
      real skims.com site (`52d663c9…`, no feed configured): the report/form/CLI all show two labeled
      pillar scores with no composite anywhere, seven Category-2 signals correctly `not_applicable`
      (no feed to check against), and `analysis_runs.overall_score` stayed `NULL` on the new row.
- [x] **agent_readability signal weight/impact/effort reconciliation (2026-07-10).** Found live:
      `robots_txt_valid` was scoring at weight `1.5`, not the `1.0` the original Build 1 spec table
      specified — two runs had already been scored under the wrong value. A full audit of all ten
      signals against the original spec table (pulled from the pre-compaction session transcript,
      since the running conversation's summary hadn't preserved the literal numbers) found five more
      with drift, seven signals affected in total — only `ai_crawler_access_training`,
      `content_server_rendered`, and `product_schema_present` matched spec exactly:

      | signal | weight: spec → was | impact: spec → was | effort: spec → was |
      |---|---|---|---|
      | `robots_txt_valid` | 1.0 → 1.5 | 3 (match) | 1 (match) |
      | `ai_crawler_access_retrieval` | 2.5 → 2.0 | 5 → 4 | 1 → 2 |
      | `schema_in_raw_html` | 2.0 → 2.5 | 4 → 5 | 3 (match) |
      | `offer_schema_complete` | 1.5 → 2.0 | 4 (match) | 2 (match) |
      | `organization_schema_present` | 1.0 → 1.5 | 3 (match) | 2 → 1 |
      | `sitemap_present` | 1.0 → 1.5 | 2 → 3 | 1 (match) |
      | `llms_txt_present` | 0.5 (match) | 1 → 2 | 1 (match) |

      Weight drift is score-distorting — it feeds `score_contribution` and therefore the pillar
      percentage directly. Impact/effort drift only distorts `priority_score` (a DB-generated column,
      `impact × weight ÷ effort`, used for "what to fix first" ordering) — real, but a different kind
      of wrong. Fixed in `readabilityChecks.ts`'s `W` table, going forward only, same discipline as
      the `overall_score` deprecation above: **no historical run is rewritten.** `analysis_runs` are
      immutable — every agent_readability score reported before 2026-07-10, including the skims.com
      figures cited in the composite-score-removal entry above, was correct for the code that existed
      when that run executed and stays exactly as reported. Do not compare a pre-2026-07-10
      agent_readability score against a post-2026-07-10 one; the weights underneath changed.
- [x] **agent_readability fix artifacts (Build 2, 2026-07-10): `robots_patch`, `llms_txt`, `jsonld`.**
      Three new generators, following the same honesty discipline `manifestArtifact.ts`/
      `contentRewriteArtifact.ts` already established, with two genuinely different honesty shapes:
      - `robots_patch` — a PATCH, never a wholesale rewrite (an existing robots.txt may have rules this
        codebase doesn't recognize — admin paths, crawl-delay). Missing file -> a complete minimal file
        (safe, nothing to preserve). Existing file -> plain-English, line-numbered REMOVE/ADD
        instructions written as `#` comments, so the content is valid (inert) robots.txt syntax even if
        a merchant panics and deploys it as-is — worst case is harmless comments, never a silently
        broken file. **Wildcard-safety**: when a retrieval bot is blocked via `User-agent: *` (shared
        with every other crawler), the generator never proposes removing that rule — it adds a
        bot-specific `Allow` override group instead, which takes precedence over the wildcard without
        touching a rule that governs unrelated crawlers too. **Merchant-intent rule, third application**
        (after `identity_linking_opt_out`/`checkout_handoff_opt_in`): GPTBot/ClaudeBot training-bot
        directives are NEVER added or removed — blocking them is a legitimate IP decision. Opted out ->
        say so, touch nothing; not opted out but blocked -> flag it, present both sides (blocking
        training doesn't affect citation eligibility, which the retrieval bots above govern
        separately), let the merchant decide.
      - `llms_txt` — generated only from data this codebase already knows is real: `<title>`/
        `og:site_name` and `og:description`/meta description extracted from the homepage's raw HTML
        (a new, additive `HomepageState.rawHtml` field, same in-memory-only discipline as
        `ProductPageState.rawHtml`), policy page URLs `policyChecks.ts` already found, the configured
        feed URL, the resolved UCP manifest URL. No description ever invented — an obvious placeholder
        plus a `must_complete` entry when none is extractable. The mandatory contested-basis honesty
        note is read from `signal_evidence.merchant_note` at generation time, not hardcoded, so a
        future evidence correction updates the artifact too.
      - `jsonld` — two sub-cases with deliberately different honesty properties in one draft.
        `organization_schema_present` is a complete, sitewide fix (one Organization block, real
        domain + extracted name). `product_schema_present`/`offer_schema_complete` are explicitly NOT a
        complete fix — Adeptra samples a handful of pages, a real catalog has many more — so the
        artifact is a field-mapping template plus ONE worked example from real feed data, resolving
        NEITHER signal. **Hard rule**: if the feed and live pages disagree
        (`price_consistency_cross_surface`/`availability_consistency`/`product_id_consistency` fail or
        partial), NO product/offer JSON-LD is generated at all — publishing feed-sourced markup would
        contradict the merchant's own pages; flagged instead, same reconcile-don't-guess discipline as
        `feedArtifact.ts`. Platform-specific injection guidance (Shopify/WooCommerce) is independently
        verified against primary sources before shipping as merchant-facing copy, not assumed: Shopify's
        official `| structured_data` Liquid filter already ships Product schema in most 2.0-era themes
        (Dawn included); WooCommerce core already emits basic Product/Offer JSON-LD by default via its
        `WC_Structured_Data` class — Rank Math's free tier extends it, Yoast SEO does NOT cover
        WooCommerce products without a separate paid add-on. The guidance tells merchants to check
        first rather than presuming nothing exists.
      - Three further agent_readability signals (`content_server_rendered`, `schema_in_raw_html`,
        `sitemap_present`) get no artifact at all — folded into the existing `content_rewrite`
        generator as flag-only entries (it already IS the "rich guidance, nothing auto-fixable"
        artifact type) rather than inventing a fourth new file. The first two: no AI crawler executes
        JavaScript, so moving to SSR/SSG/prerendering is an architectural change to the merchant's own
        site that Adeptra cannot generate — same honest posture as `endpoint_reachability`. The third:
        platform-keyed guidance (Shopify auto-generates and can't be fully disabled; Wix gates on its
        "Let search engines index your site" setting; WordPress core auto-generates a basic sitemap
        since 5.5 (2020), Yoast/Rank Math replace rather than being required), never a sitemap
        generated from Adeptra's own partial crawl — an incomplete sitemap would tell crawlers "these
        are all my pages" while omitting most of them, a false claim dressed as a fix.
      Architecture: `ArtifactContext` gained `robots`/`parsedRobots`/`homepage` (already-fetched by
      `readabilityChecks.ts`'s `runReadabilityChecks`, now exposed rather than discarded — same reuse
      discipline as `pageChecks.ts`'s `pageStates`) and `signalEvidence` (fetched once by `pipeline.ts`
      via a new standalone `fetchSignalEvidence()`, extracted from `fetchRunBundleData`'s existing
      inline query, and injected — keeps every new generator a pure function, never its own DB read).
      `RobotsRule` gained a `line` number (purely additive — no existing evidence_json serializes raw
      rule objects, so this is invisible to every persisted signal shape); `isUserAgentBlocked` now
      delegates to a new `findBlockingRule` that returns the winning rule, not just a boolean.
      Tested: 58 mock-driven assertions (`test_readabilityArtifacts.ts`) covering every honesty rule
      above, including the wildcard-safety and price-disagreement-hazard branches. Full existing suite
      and both golden fixtures (UCP page-consistency signals; the four pre-existing generators) stayed
      green and byte-identical throughout. Live-verified against skims.com and gymshark.com: both
      already pass 9/10 agent_readability signals for real (only `llms_txt_present` fails on either),
      so both live runs exercised the `llms_txt` generator specifically — the exported bundle's
      `llms.txt` correctly extracted skims.com's real `<title>` ("SKIMS | Solutions For Every Body")
      and real meta description, with real return/shipping-policy, feed, and manifest URLs, no invented
      content anywhere, and the contested-basis note rendered identically in both the signal's own
      report disclosure and the artifact's changelog (confirming it's sourced from the same
      `signal_evidence` row, not duplicated text). `robots_patch`/`jsonld`'s generation paths are
      covered by the mock suite's 58 assertions rather than a live run, since neither real store
      currently has a failing signal that path addresses.

### Open items / known shortcuts

- **A sitemap-builder SCRIPT for custom/no-platform stores** (deferred from the `robots_patch`/
  `llms_txt`/`jsonld` build, 2026-07-10). `sitemap_present` never gets a generated sitemap from
  Adeptra's own partial crawl — an incomplete one would misrepresent the site's real catalog (see the
  Status entry above). The honest alternative: a generator SCRIPT, following the same pattern as the
  Custom `mcp_scaffold` provider's `StoreAdapter` reference implementation — the merchant (or their
  developer) runs it against their OWN real catalog data, so its output is complete and re-runnable,
  not a one-time partial snapshot from a crawl. Not built yet.

- **A single domain can have multiple `sites` rows across clients — `domain` is
  NOT a stable identity for cross-run history (found 2026-07-10, while
  investigating an apparent UCP score regression on skims.com).** The
  `(client_id, root_url)` UNIQUE constraint permits this by design — nothing
  stops two different onboarding submissions for the same domain from
  creating two separate site rows with different configs. Concretely:
  `52d663c9…` (`is_test=false`, no feed configured, the real merchant site,
  1 run) and `140ee584…` (`is_test=true`, `feed_url` set, used for
  live-verifying the `agent_readability` build, 21 runs) are both
  "skims.com." A run against one isn't comparable to a run against the
  other — they scored 86.36% and 81.41% UCP respectively, purely because one
  has Category 2 (product feed) signals to score and the other doesn't, not
  because of any real compliance change. **Any future dashboard showing
  "score over time for a domain" must key on `site_id`, never `domain`, or it
  will silently merge different store configurations into one misleading
  trend line.** No code fix included in this build — flagging it as the real
  finding behind the composite-score removal above, not something this pass
  resolved.

- **If a single headline number is ever wanted again, it must be categorical,
  derived from signal gates — never an arithmetic mean of pillar scores.**
  E.g. "discoverable, not yet buyable" (agent_readability healthy, ucp not),
  computed from whether each pillar clears some threshold, not from averaging
  their percentages together. See the composite-score-removal Status entry
  above for why an averaged number doesn't have a defensible referent.

- ~~"No manifest" vs. "scored 0%" are currently indistinguishable.~~ **Fixed
  2026-07-06.** `analysis_runs.status` gained a distinct `no_manifest` value
  (migration `20260706000000_no_manifest_status_and_identity_linking_opt_out.sql`).
  `runLive.ts` now marks a run `no_manifest` with `overall_score = NULL` when the
  manifest is unreachable or 404s (`isManifestMissing` in `manifestChecks.ts`),
  instead of `complete` with a punitive `0.00`. Verified live against
  gymshark.com.

- ~~`identity_linking` absence is scored as `fail`, but the spec allows N/A.~~
  **Fixed 2026-07-06.** Added `sites.identity_linking_opt_out` (defaults
  `false`, same migration as above). `capability_identity_linking_declared`
  now returns `not_applicable` — dropped from the pillar denominator — when a
  merchant has opted out. Verified live against skims.com (score moved
  86.84% → 91.67% with the flag set, back to 86.84% on revert). **Remaining
  gap:** there's no onboarding UI yet for a merchant/operator to set this flag
  themselves — today it's a plain DB column, toggled only via SQL.

- **Category 5's policy-page discovery is a best-effort path probe, not a
  crawler.** `return_policy_present_consistent` / `shipping_info_present_consistent`
  try a short list of known URL conventions (Shopify's auto-generated
  `/policies/*`, plus common `/pages/*` custom-storefront slugs) rather than
  discovering arbitrary policy URLs. Grounded against real stores: skims.com
  and gymshark.com both 404 on Shopify's own `/policies/*` convention from
  their main domain (it only resolves on the `*.myshopify.com` backend or a
  checkout subdomain) and instead use their own `/pages/*` slugs — and those
  slugs differ between stores. A store using an unlisted convention will
  score `fail` even if the policy page exists. Also, "consistent with feed/
  Merchant Center" (the spec's pass condition) isn't checked at all — there's
  no reliable feed-side policy data to compare against yet — so
  `evidence_json.feed_match` is always `null`, not a fabricated `true`.

- ~~Artifact changelogs aren't persisted yet.~~ **Fixed 2026-07-06.** Added
  `artifacts.changelog_json` (migration `20260706030000_add_artifacts_changelog_json.sql`);
  `insertArtifacts` now writes each draft's `ArtifactChangelog` there instead of
  only printing it.

- **Found and fixed during live testing (2026-07-06):** the manifest artifact
  generator initially marked `ucp_namespace_authority_valid` as "resolved"
  (in `resolves_signal_keys`) any time the namespace-authority pass *ran* —
  even if every offending URL turned out to be unmappable and got flagged
  instead of corrected. Live-verified against skims.com's real
  `dev.shopify.catalog` vendor URLs (a different path entirely, not just a
  wrong host on a known path): both got flagged, zero got corrected, yet the
  signal was still claimed as resolved. Fixed to only mark it resolved when
  at least one URL was actually rewritten; added a regression test for the
  all-flagged/none-corrected case.

- **`feed_fix`'s native_commerce artifact opts in every missing product by
  default, not an empty template.** Deliberate: an empty per-product template
  for a 30-item feed is the same manual labor as not having the tool, whereas
  opt-in-with-review is a quick prune. `changelog.must_complete` always
  carries a REVIEW warning so this is never presented as silently done — the
  same guardrail as `identity_linking` in the manifest generator. Also: the
  generated artifact is always a Google Merchant-format supplemental feed
  regardless of whether the primary feed is Shopify JSON or Google XML
  (`native_commerce` is a Merchant Center attribute, not a primary-feed
  field) — for a Shopify-sourced feed, an extra changelog line notes the
  Merchant Center → Products → Feeds upload path specifically.

- **`exports.bundle_storage_path` is the only storage-path column, but an
  export now produces two objects (zip + report.html).** Rather than a
  migration, `report.html`'s path is derived by convention — same folder,
  `report.html` instead of `bundle.zip` — since every access already goes
  through the recorded path (never a folder listing), so this doesn't create
  a real lookup gap. Revisit with an explicit `report_storage_path` column if
  that convention ever stops being reliable (e.g. a future export type that
  doesn't co-locate the two files).

- **Export links are signed URLs, not real access control (MVP).** A 30-day
  signed URL grants access to anyone who has it, with no login and no
  per-viewer revocation — acceptable for a CLI-triggered, operator-shared
  deliverable today, but not a substitute for real auth if this becomes
  self-serve. The expiry is a named constant in `storageSink.ts`
  (`SIGNED_URL_EXPIRY_SECONDS`), easy to shorten/lengthen later.

- **Found and fixed during live testing (2026-07-06):** the first live
  `content_rewrite` STRUCTURE run (gymshark.com's real return-policy page)
  passed both the prompt instructions and the mechanical anti-fabrication
  gate while still producing low-quality output — the model dumped the raw
  policy HTML into a single non-standard `policyBody` string instead of
  decomposing it into real schema.org properties. This satisfied the
  (deliberately lenient) `hasStructuredData` detector in `policyChecks.ts`
  (any JSON-LD block flips the signal to `pass`) and the numeric-grounding
  check (no invented numbers), but defeated the actual point of the
  signal — an agent parsing the result gets an opaque blob, not
  `merchantReturnDays: 30` it can reason over. Fixed by (1) giving the LLM
  an explicit named-property field guide per schema type
  (`merchantReturnDays`, `returnPolicyCategory`, `returnFees`, etc. for
  `MerchantReturnPolicy`; `shippingRate`, `deliveryTime`,
  `shippingDestination` for `OfferShippingDetails`) with an explicit
  "no raw-text dump" instruction, and (2) injecting `@context`/`@type`
  deterministically after parsing rather than trusting the model to include
  them (a related regression the tightened prompt introduced — the model
  dropped the wrapper once told to focus only on named properties). Added a
  regression test (`test_artifacts.ts`, "@context/@type are set
  deterministically...") and re-verified live against gymshark.com: the
  regenerated artifact now contains genuinely decomposed, fully grounded
  fields with a guaranteed-valid JSON-LD wrapper.

- **Found and fixed during live testing (2026-07-07):** the first live
  `mcp_scaffold` insert failed with a Postgres check-constraint violation —
  `artifacts.artifact_type`'s `CHECK` constraint (from the original schema
  migration) didn't include `'mcp_scaffold'`. Fixed with migration
  `20260707000000_add_mcp_scaffold_artifact_type.sql` (drops and recreates the
  constraint with `mcp_scaffold` added). A reminder that this constraint needs
  a migration every time a genuinely new `artifact_type` ships — the
  TypeScript union in `artifacts/types.ts` alone doesn't cover it.

- **Found and fixed during live testing (2026-07-07):** a real
  `npm install && npm run build && npm start` of the exported `mcp-server/`
  scaffold threw `"Set WOOCOMMERCE_STORE_URL"` even with a populated `.env`.
  Cause: ES modules evaluate ALL of a file's static imports, in declaration
  order, before that file's own top-level code runs — so `server.ts`'s inline
  `process.loadEnvFile()` call (textually before its `woocommerce.ts` import)
  actually ran *after* `woocommerce.ts`'s module-level
  `WOOCOMMERCE_STORE_URL` check, which had already thrown. Fixed by moving
  the `.env`-loading logic into its own side-effect-only module
  (`src/loadEnv.ts`) imported as `server.ts`'s literal first import — sibling
  imports evaluate in declaration order, so this now genuinely runs first.
  Added a regression test asserting `loadEnv.js` is `server.ts`'s first
  import and that `loadEnv.ts` has no imports of its own. Re-verified with
  the same real install/build/start cycle: the server now starts cleanly.

- **Found and fixed during live testing (2026-07-07):** a real
  `npm start` of the exported Wix `mcp-server/` scaffold, with a fake OAuth
  client ID (so the startup catalog check would hit a real Wix error
  response instead of hanging), printed the correct clean error message —
  then crashed with a native `Assertion failed:
  !(handle->flags & UV_HANDLE_CLOSING)` from libuv. Cause: `process.exit()`
  called immediately inside `main().catch(...)`, right after an `await`ed
  `fetch()` had just settled — a known Node/undici/Windows interaction where
  a hard exit can race an in-flight handle teardown. Fixed by changing every
  exit call downstream of an `await`ed network call (Wix's
  `assertCatalogV3()`, and `server.ts`'s `main().catch()`) to throw a regular
  `Error`/set `process.exitCode` instead of calling `process.exit()` directly,
  letting the event loop drain naturally. `assertCatalogV3()` now throws
  rather than exiting itself, so it composes correctly with `main()`'s single
  catch handler. The synchronous, pre-fetch env-var check in `server.ts`
  (which never races anything) was left as a direct `process.exit(1)`.
  Re-verified live: both the "catalog check fails" and "missing env vars"
  failure paths now print one clean line and exit with no native crash.

- **Found and fixed during live testing (2026-07-07):** the same live run
  surfaced a second bug in the "missing env vars" path specifically: with no
  `.env` present at all, the server printed an ugly uncaught-exception stack
  trace instead of `server.ts`'s intended clean one-line message. Cause:
  `wix.ts` had its own redundant module-level `throw` checking
  `WIX_CLIENT_ID`/`WIX_SITE_URL`, and ES modules evaluate all of a file's
  static imports before that file's own top-level code runs — so `wix.ts`'s
  import-time throw always fired before `server.ts`'s own guard ever got a
  chance to run, the same class of import-order bug as the `loadEnv.ts` one
  above, just with a redundant check instead of a missing one. Fixed by
  removing the module-level throw and moving the check into `getAccessToken()`
  (the first function that actually needs the values) as defense-in-depth for
  anyone importing `wix.ts` directly, while `server.ts`'s synchronous
  top-level check remains the one that actually fires for the real server.
  Re-verified live: starting with no `.env` at all now prints exactly the
  intended one-line message, no stack trace.

- ~~True UCP MCP-transport binding conformance (tool names, session model)
  is a known, deliberate gap.~~ **Closed 2026-07-09 for tool names, argument
  shapes, and session semantics.** The follow-up build this entry originally
  flagged as "under consideration" shipped: all three `mcp_scaffold`
  providers now implement UCP's actual canonical catalog + cart tool surface
  and session model (see the Status entry above for the full build). The
  remaining, permanent conformance gap is narrower and precisely two things:
  **cart requires HTTP streaming transport (we use stdio); checkout
  capability is deliberately not implemented (payment stays with the
  merchant).** Catalog has no outstanding gap — its own conformance
  requirements don't include a transport requirement, and this scaffold
  meets them fully. Both remaining gaps are disclosed explicitly in every
  generated README's "About UCP protocol conformance" section, not left for
  a developer or agent to discover the hard way. Full literal UCP MCP-
  transport conformance (adding HTTP streaming) is closeable independently
  of checkout — a real but separate scope decision (a hosted HTTP service
  instead of "run npm start on a box you control") — and would still not
  include `complete_checkout`, since payment staying with the merchant is a
  settled policy, not an open question; that piece only becomes reachable at
  all if a payment layer is ever deliberately built, which is a product
  decision on its own, not a byproduct of closing the transport gap.

- **Custom provider's `npm start` failure path live-verified with real
  partial-implementation behavior, not just the fully-stubbed case
  (2026-07-09).** Beyond confirming the all-stubbed startup message (all
  seven `StoreAdapter` methods named, no stack trace), directly edited the
  compiled `dist/store.js` to implement one method at a time and re-ran
  `npm start` — confirmed the startup check's failure list correctly shrinks
  to only the methods still throwing `IMPLEMENT-THIS`, with zero false
  positives on the now-implemented one, and that the server starts cleanly
  ("Custom MCP shopping server running (stdio).") once all seven are done.
  This is the concrete evidence behind choosing a static source-text check
  (`Function.prototype.toString()`) over live-invoking each method (which
  would risk exactly this kind of false positive/side effect on a
  partially-done adapter) or a separate boolean flag (which can't be
  proven correct this way at all, since it doesn't derive from the code's
  actual current behavior).

- **Found and fixed while building the UCP catalog+cart conformance profile
  (2026-07-09): `mcpScaffoldArtifact.ts`'s "is there still work to do" gate
  included checkout's capability status.** Once checkout stopped being
  implemented at all, `capability_checkout_declared` could never reach
  `pass` for a scaffold-platform store — left as-is, the generator would
  have kept claiming there was still work to do forever, even for a store
  that had correctly, fully deployed the scaffold. Fixed by gating on
  cart+catalog only (checkout's status no longer participates in "is
  everything already passing"), with a regression test proving cart+catalog
  passing plus checkout failing still returns `null`. Caught by reasoning
  through the consequence of the design change, not by a live run — a
  reminder that "this signal can now never reach X" is worth checking
  against every place that assumed it could, not just the obvious ones.

- **Found and fixed via live `npm start` while building the UCP catalog+cart
  conformance profile (2026-07-09): WooCommerce's `woocommerce.ts` threw at
  module load if `WOOCOMMERCE_STORE_URL` was unset.** The exact ES-module
  import-order bug already found and fixed for Wix in an earlier round
  (imports evaluate before the importing module's own top-level code runs,
  so this file's own throw always won the race against `server.ts`'s
  friendlier `console.error`-based check) — just never re-tested for
  WooCommerce specifically with a genuinely empty `.env` after the original
  `loadEnv.ts` fix, since that fix solved a different ordering problem (which
  module loads `.env` first) and left this one (which module's *check* wins)
  undiscovered. Confirmed live: before the fix, `npm start` with no `.env`
  produced an uncaught-exception stack trace instead of the intended
  one-line message; after, it prints the clean message and exits normally.
  Fixed the same way as Wix: no module-level throw in the client module, a
  lazy assertion inside the function that actually needs the value instead.
  A reminder that "we fixed this bug for platform A" doesn't mean platform B
  (built on the same original single-file template) got the same fix unless
  it's explicitly re-verified live, not just assumed by analogy.
