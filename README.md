# Adeptra Merchant

The UCP (Universal Commerce Protocol) compliance product in the **Adeptra** platform — an AI-agentic system that makes ecommerce sites discoverable, parseable, trusted, and **buyable** by AI shopping agents (ChatGPT, Gemini, Perplexity, Google AI Mode).

Adeptra Merchant analyzes a store, scores its UCP readiness, generates the fixes (manifest, feed corrections, policy structuring), and — on the subscription tier — serves the agent-readable layer from the edge and keeps it current as UCP evolves.

> Adeptra Merchant is the first product under the Adeptra house brand. A second product (edge AI-readiness, working name *CrawlTrust*) follows once Merchant is shipped.

## What's here

```
merchant/
  supabase/
    migrations/
      20260703000000_aeo_geo_ucp_mvp_schema.sql   # DB spine: 16 tables, membership-based RLS,
                                                   # immutable runs, signals-as-source-of-truth
  ucp/
    signal-specs.md        # The core IP: exact pass/partial/fail rule + evidence + fix
                           # for every UCP compliance signal, grounded in UCP 2026-04-08
    manifestChecks.ts      # Category-1 (Discovery & Manifest) checks — portable, framework-agnostic
    httpFetcher.ts         # Production Fetcher: native fetch, shared 5s deadline, manual
                           # redirect tracking (chain in evidence), 401/403 → requiresAuth
    scorer.ts              # Pure rollup: SignalRow[] → pillar_scores rows + overall score
    supabaseSink.ts        # PostgREST via plain fetch (no supabase-js): run lifecycle,
                           # signal insert (run_id stamped; priority_score is DB-generated),
                           # pillar score insert, dev site bootstrap
    runLive.ts             # End-to-end CLI: domain → live fetch → signals → score → Postgres
    test.ts                # Mock-driven harness for the manifest checks
    test_live_pipeline.ts  # Tests for scorer math + httpFetcher (stubbed global fetch)
```

## Architecture in one paragraph

A merchant enters a store URL. A deterministic-first pipeline crawls a sampled set of pages, detects the platform, reads the `/.well-known/ucp` manifest and product feed, and writes one row per compliance **signal** into Postgres. Scores, the prioritized remediation plan, and the generated artifacts all *derive* from the `signals` table — nothing is a computed value we can't explain back to its evidence. ~90% of UCP checks are deterministic (no LLM), which is what keeps per-analysis cost low.

## Design principles

- **`signals` is the single source of truth.** Scores, plans, and artifacts derive from it.
- **`analysis_runs` are immutable.** Re-running creates a new run → free score-over-time history.
- **Multi-tenant isolation via membership + `SECURITY DEFINER` helpers** — never via JWT metadata.
- **Deterministic-first.** LLMs are used only where they add value (2 of ~23 UCP signals).
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
node --experimental-strip-types runLive.ts shop.example.com
```

If no `site_id` is passed, a dev client + site row are created/reused for the domain. A failed
pipeline marks the run `failed` with `error_detail` — no zombie `running` rows.

> Note: `signals.priority_score` is a `GENERATED ALWAYS` column — the DB computes
> `impact × weight ÷ effort` itself. The sink deliberately does not send it.

## Status

- [x] Database schema (deployed to Supabase)
- [x] UCP compliance signal specs (v1)
- [x] Category 1 — Discovery & Manifest checks (tested against mocks)
- [x] Real HTTP fetcher + Supabase insert (code complete, unit-tested; first live-store run pending)
- [x] Scorer → `pillar_scores` (code complete, unit-tested)
- [ ] First live end-to-end run against a real store (validation)
- [ ] Category 2 (feed consistency, Google + Shopify adapters) & Category 3 (capabilities)
- [ ] Artifact generation (manifest, feed fixes)
- [ ] Edge-served agent-readable layer

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
