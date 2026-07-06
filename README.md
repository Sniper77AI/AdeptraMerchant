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
                           # ({ manifest, feed, signals }) — adding a generator input never again
                           # requires changing runArtifacts()'s signature, just this one context shape
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
      index.ts             # runArtifacts(ctx) orchestrator — calls the manifest + feed generators;
                           # sibling modules (jsonld, llms_txt, robots_patch, content_rewrite) get
                           # added here later, without touching this file's signature again
    supabaseSink.ts        # PostgREST via plain fetch (no supabase-js): run lifecycle, signal
                           # insert (returns inserted rows for signal_key→id mapping;
                           # priority_score is DB-generated), pillar score insert, artifact insert
                           # (resolves_signal_ids mapped from keys; changelog_json persisted),
                           # site config reads, dev site bootstrap
    runLive.ts             # End-to-end CLI: domain → live manifest + capability + feed + page
                           # cross-check + LLM checks + policy/contact probes + payment readiness +
                           # Merchant Center readiness checklist + artifact generation (manifest +
                           # feed_fix, from a shared ArtifactContext) → signals → score → artifacts
                           # → Postgres
    test.ts                # Mock-driven demo harness for all signal groups
    test_live_pipeline.ts  # Automated assertions: scorer math, capability/feed/page/LLM/policy/
                           # payment/readiness signal logic (mock LlmClient), known-shortcut fixes,
                           # httpFetcher (stubbed fetch)
    test_artifacts.ts      # Manifest generator: no-manifest scaffold, partial-manifest preserve+
                           # correct (incl. byte-for-byte sub-capability preservation), closed-loop
                           # validation against the real signal functions, purity. Feed generator:
                           # full/partial supplemental feed, pass→null, no-feed defensive handling,
                           # purity, consistency-signal flag-only. Plus an orchestrator integration
                           # check that both generators wire into runArtifacts(ctx) together
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
pipeline marks the run `failed` with `error_detail` — no zombie `running` rows.

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
- [ ] Remaining artifact types: `jsonld`, `llms_txt`, `robots_patch`, `content_rewrite`
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
