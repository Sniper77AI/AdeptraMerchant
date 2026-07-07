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
      # Storage bucket "merchant-exports" (private) and exports table predate this — see Export & Delivery below
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
                           # ({ manifest, feed, signals, fetcher?, llm?, rootUrl? }) — adding a
                           # generator input never again requires changing runArtifacts()'s
                           # signature, just this one context shape. fetcher/llm/rootUrl are
                           # optional, used only by impure/async generators (content_rewrite today)
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
                           # trusted to the model) so the output is always valid standalone JSON-LD
      index.ts             # runArtifacts(ctx) orchestrator — now async (awaits each generator so
                           # the sync manifest/feed generators and the async content_rewrite
                           # generator share one call site); sibling modules (jsonld, llms_txt,
                           # robots_patch) get added here later, without touching this file's
                           # signature again
    supabaseSink.ts        # PostgREST via plain fetch (no supabase-js): run lifecycle, signal
                           # insert (returns inserted rows for signal_key→id mapping;
                           # priority_score is DB-generated), pillar score insert, artifact insert
                           # (resolves_signal_ids mapped from keys; changelog_json persisted),
                           # site config reads, dev site bootstrap
    runLive.ts             # End-to-end CLI: domain → live manifest + capability + feed + page
                           # cross-check + LLM checks + policy/contact probes + payment readiness +
                           # Merchant Center readiness checklist + artifact generation (ucp_manifest +
                           # feed_fix + content_rewrite, from a shared ArtifactContext carrying
                           # fetcher/llm/rootUrl) → signals → score → artifacts → Postgres
    test.ts                # Mock-driven demo harness for all signal groups
    test_live_pipeline.ts  # Automated assertions: scorer math, capability/feed/page/LLM/policy/
                           # payment/readiness signal logic (mock LlmClient), known-shortcut fixes,
                           # httpFetcher (stubbed fetch)
    test_artifacts.ts      # Manifest generator: no-manifest scaffold, partial-manifest preserve+
                           # correct (incl. byte-for-byte sub-capability preservation), closed-loop
                           # validation against the real signal functions, purity. Feed generator:
                           # full/partial supplemental feed, pass→null, no-feed defensive handling,
                           # purity, consistency-signal flag-only. Content-rewrite generator (mock
                           # Fetcher + mock LlmClient, no real I/O): STRUCTURE with grounded output,
                           # FLAG-on-fail (fetcher/LLM never called), FLAG for sparse attributes and
                           # title/description contradiction, the anti-fabrication gate rejecting a
                           # hallucinated value, ctx.llm null degrading gracefully, deterministic
                           # @context/@type injection even when the model omits it, determinism +
                           # async signature. Plus an orchestrator integration check that all three
                           # generators wire into the now-async runArtifacts(ctx) together
    export/
      reportBuilder.ts     # PURE: turns one run's fetched data into a BundlePlan — a markdown
                           # report, a standalone self-contained report.html (inline CSS, no
                           # external requests), and the file list to zip. Iterates over whatever
                           # artifacts exist generically by artifact_type (typeDisplayName() map,
                           # one line per new type, generic fallback for unknown ones — proven by
                           # a mock "mcp_scaffold" type in tests). All dynamic values HTML-escaped
      bundle.ts            # PURE: hand-rolled zero-dependency ZIP writer (STORED/uncompressed
                           # entries — real, spec-compliant, openable by any unzip tool; CRC32 +
                           # local/central-directory/EOCD records, no third-party lib)
      storageSink.ts       # IMPURE: uploads the zip + standalone report.html to the private
                           # "merchant-exports" Storage bucket via the Storage REST API (same
                           # fetch+service-role-key pattern as supabaseSink.ts), mints 30-day
                           # signed URLs, substitutes the report's download-link token, and
                           # records an `exports` row (via supabaseSink.insertExport)
    exportRun.ts           # CLI: node exportRun.ts <run_id> — fetches a run's data, builds the
                           # bundle, uploads it, prints the report page URL + zip download URL.
                           # Separate command from runLive.ts on purpose — export is a distinct
                           # "deliver this one" action, not part of every analysis
    test_export.ts         # reportBuilder purity/determinism, no_manifest framing (never a
                           # punitive 0%), prioritized-plan ordering, artifact coverage, the
                           # unknown-artifact-type future-proofing case, the download-link
                           # placeholder/offline-copy contract, bundle file list, and an
                           # independent ZIP-reader round-trip (verifies the hand-rolled format
                           # byte-for-byte, confirmed separately by the real `unzip` utility)
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

Requires Node 22+ (native TypeScript type-stripping).

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
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
OPENAI_API_KEY=...  # optional — enables title_description_consistency + discovery_attributes_enrichment \
node --experimental-strip-types runLive.ts shop.example.com
```

If no `site_id` is passed, a dev client + site row are created/reused for the domain. A failed
pipeline marks the run `failed` with `error_detail` — no zombie `running` rows. On success, if any
artifacts were generated, it prints the `exportRun.ts` command to deliver them.

**Export a completed run** (merchant-ready ZIP bundle + a shareable report page, both uploaded to
Supabase Storage as signed, 30-day URLs):

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
node --experimental-strip-types exportRun.ts <run_id>
```

Prints `report page: <url>` and `download zip: <url>`. The report page has a working "Download the
fix bundle" button linking to the zip; the zip also contains an offline copy of the same report
(`report.html`), the markdown version (`report.md`), a `README.txt`, and one file per generated
artifact. Fails loudly if the run doesn't exist or has no artifacts.

```bash
node --experimental-strip-types test_export.ts
```

> Note: `signals.priority_score` is a `GENERATED ALWAYS` column — the DB computes
> `impact × weight ÷ effort` itself. The sink deliberately does not send it.

> Note: Category 2 (Product Data Hygiene) only scores if `sites.feed_url` is set — there's no
> onboarding UI for it yet, so it's set directly on the `sites` row (Shopify `products.json` or
> a Google Merchant XML/RSS feed URL). Unset, `feed_available` and its dependents score
> `not_applicable` rather than `fail`. The 2 LLM-scored signals additionally need `OPENAI_API_KEY`;
> unset, they score `not_applicable` too, rather than failing the whole run.

## Status

**All 25 UCP signals across all 6 categories in `signal-specs.md` are implemented, tested, and
live-verified against two real stores (skims.com, gymshark.com).**

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
- [ ] Remaining artifact types: `jsonld`, `llms_txt`, `robots_patch`
      (structured as sibling modules under `artifacts/`, not yet built)
- [ ] Edge-served agent-readable layer
- [ ] Onboarding UI (feed URL, identity-linking opt-out, and Category 6 attestations are all plain
      DB columns today, set via SQL — no dashboard to set them yet)

### Open items / known shortcuts

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
