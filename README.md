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
    test.ts                # Mock-driven test harness for the manifest checks
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
- **Portable logic.** Signal checks are pure functions with an injectable fetcher, so they run in an
  n8n code node today and lift into a standalone worker later, unchanged.

## Running the manifest checks (mock)

Requires Node 22+ (native TypeScript type-stripping).

```bash
cd merchant/ucp
node --experimental-strip-types test.ts
```

This runs four mock scenarios (compliant / present-but-flawed / missing / auth-walled) and prints
each signal's status, priority score, and fix summary.

## Status

- [x] Database schema (deployed to Supabase)
- [x] UCP compliance signal specs (v1)
- [x] Category 1 — Discovery & Manifest checks (tested against mocks)
- [ ] Real HTTP fetcher + Supabase insert (make it live)
- [ ] Scorer → `pillar_scores`
- [ ] Category 2 (feed consistency, Google + Shopify adapters) & Category 3 (capabilities)
- [ ] Artifact generation (manifest, feed fixes)
- [ ] Edge-served agent-readable layer
