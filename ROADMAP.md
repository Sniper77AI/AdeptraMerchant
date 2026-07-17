# Adeptra — Roadmap

> **Purpose.** The banked "what's next," so it stops living in conversation and
> memory. Grouped by phase, roughly in build order. Each item notes enough context
> to pick it up cold, and links to the governing decision in `DECISIONS.md` where
> one exists.
>
> This is a living list. When something ships, move it to `README.md`'s Status
> section and check it off here (or delete it). When a new to-do appears, add it
> under the right phase. `DECISIONS.md` explains *why*; this explains *what's left*.

**Legend:** `[ ]` not started · `[~]` partially done / in progress · `[x]` done
(kept briefly for context, then pruned to README)

---

## Current state (one line)

Backend engine complete and live-verified (36 signals, 2 pillars, 7 artifact
generators, export/delivery). Dashboard Stages 1–3 shipped (auth, onboarding +
triggered analysis, My Stores + full store view). **Billing is designed but not
built.** No customers yet (by choice — see `DECISIONS.md` D-005).

---

## Phase 1 — Make it sellable (near-term productization)

The gap between "a merchant can use it" and "a merchant can pay us."

### [ ] Billing — Phase 1a: one-time bundle unlock  *(the small, safe first integration)*
The first payment path. Do this before monitoring — simpler surface, gets us paid.
- Get a Stripe account (test mode works before business verification — build the
  whole thing first).
- Stripe Checkout in **`payment` mode** — on success, record the one-time
  entitlement for that site.
- Split `isEntitled()` → `hasPaidForBundle(siteId)` (this phase) — see D-071. The
  one-time payment likely needs its own per-site record (small table or
  `paid_at`/`payment_id` column), since `subscriptions` is shaped for recurring.
- **Signature-verified, idempotent webhook** writes the entitlement — see D-073.
  Runs with no user — service-role key — highest-value target — signature
  verification non-negotiable.
- Delivery: proxy-routed download **link** to the **verified account email** +
  dashboard button — see D-072. Introduces transactional email (Resend/Postmark/
  Supabase hooks) as a new dependency.
- The dashboard's locked/unlocked bundle UI already reads entitlement (D-051,
  Stage 3) — this phase makes the gate *flip* for real.
- Ground against current Stripe Checkout + Supabase + Next.js docs before building
  (fast-moving area).

### [ ] Vercel deployment
Endpoints are already Vercel-shaped (D-081) — this is config, not a rewrite.
- Set the Vercel project root(s); deploy `dashboard/` and the `merchant/api/*`
  endpoints.
- DNS: point `adeptra.ai` (and subdomains) at Vercel via records pasted into
  **Squarespace** (D-084).
- Reconfigure Supabase Auth redirect URLs to the custom domain **at deploy time,
  not before** (D-084).
- Decide the subdomain scheme (e.g. `app.adeptra.ai` for the dashboard,
  `adeptra.ai` for marketing). Record the choice in `DECISIONS.md`.
- Once deployed, the strategic Claude instance can verify *deployed* pages
  (structure/content), closing the frontend-verification gap for the parts
  Playwright (local) doesn't cover.

### [ ] Onboarding UI for attestations & feed
Today `feed_url` and the three opt-out/opt-in attestations (D-029) plus the
Category 6 readiness attestations are plain DB columns set via SQL. The Stage 2
onboarding form writes some of them; a complete attestation UI (all three opt-outs
with plain-English labels, feed URL, Category 6) is still partial.
- `[~]` Stage 2 form writes url/platform/feed/opt-outs; verify full coverage and
  fill gaps.

### [ ] Scoped audit of the rest of v2026-04-08's UCP additions
The signing-keys signal and `embedded` transport (the two concrete coverage gaps
from the 2026-07-13 spec-delta patch — see README Status) are done. This is the
remainder of that same dig, deliberately kept as its own separate, larger pass
rather than folded in: first-class cart capability (already built via the
catalog+cart profile — verify), the `intent` context field, `available_instruments`
on payment handlers, multi-parent `extends`, first-class errors. Some of these may
already be handled incidentally; some may be real gaps. Needs its own read/verify
pass against the live spec before scoping signals.

### [ ] Human task — domain hardening (Squarespace)
Confirm **auto-renew** and **transfer-lock** are on for `adeptra.ai`. Five-minute
check in Squarespace; can't be done via connector (wrong registrar). See D-084.

---

## Phase 2 — Ongoing value & the automation substrate

Where the subscription earns its keep, and n8n gets its first real job.

### [ ] Billing — Phase 2: monitoring subscription  *(the bigger build)*
The recurring half of the two-part model (D-070). Pulls in real new capability,
not just a second Stripe mode.
- Stripe Checkout in **`subscription` mode** — grants monitoring; fits the existing
  `subscriptions` table.
- Second entitlement gate: `hasActiveMonitoring(clientId)` (D-071).
- Handle **cancel-at-period-end** (don't cut off immediately; let them use what
  they paid for until the period ends).
- The capability *behind* the subscription is the real work — the re-analysis +
  alerting items below.

### [ ] Scheduled re-analysis + change detection + alerts
What a monitoring subscription actually *does*. This is the first paid job for the
automation layer.
- Scheduled re-runs of a subscribed store's analysis (immutable runs give free
  history — D-025).
- Diff a new run against the prior run for that `site_id` (D-033) — detect
  meaningful change (a protocol shift that newly affects them).
- Alert the merchant when a change matters (transactional email again).
- This is where **n8n** becomes the substrate — the pipeline is already portable
  into an n8n code node by design (D-083).

### [ ] Remaining artifact type — sitemap-builder SCRIPT for custom/no-platform stores
`sitemap_present` never auto-generates a sitemap from a partial crawl (D-062). The
honest fix: a script the merchant runs against their *own* full catalog, following
the Custom `mcp_scaffold` `StoreAdapter` reference-implementation pattern. Not
built.

### [ ] Duplicate-domain identity in any history/trend feature
When trends/history are ever built, key strictly on `site_id`, never `domain`
(D-033). Not a code change now — a hard constraint on the future feature.

---

## Phase 3 — Scaling & the agentic org

The longer-horizon vision: a company run by a small human core plus many agents.

### [ ] Multi-client-per-user (agencies / multi-brand)
Schema is already ready (D-032 — `client_members` is a join table). This is
un-gating the one-client-per-user rule in onboarding + adding the UI to switch/
manage clients. No migration expected.

### [ ] Full agentic-org layer
Agents for sales, marketing, onboarding outreach; the founder approves only; n8n
as the orchestration substrate. Deliberately later. The signup-first funnel (D-040)
and portable pipeline (D-083) were chosen partly to serve this.

### [ ] AEO/GEO pillar activation — ONLY if evidence emerges
The `aeo_geo` pillar stays empty until there's credible evidence that its signals
affect AI-search visibility/citation (D-020). This is a research-gated item, not a
scheduled build. Do not activate it to "look complete."

### [ ] HTTP-streaming transport for full UCP cart conformance
The MCP scaffolds are catalog+cart conformant on names/shapes/session but use
stdio, not UCP's required HTTP-streaming transport (D-010). Closing this is a real
but separate scope decision (a hosted HTTP service vs. "run it on a box you
control"). **It still never includes `complete_checkout`** — payment staying with
the merchant is settled policy (D-010), not something this unlocks.

---

## Known shortcuts / smaller debts (address opportunistically)

These are documented compromises, fine for now, worth revisiting when the relevant
area is next touched.

- **Category 5 policy discovery is a best-effort path probe, not a crawler.** A
  store using an unlisted URL convention scores `fail` even if the policy exists.
  "Consistent with feed/Merchant Center" isn't checked (no reliable feed-side
  policy data) — `feed_match` is honestly `null`, never fabricated `true`.
- **Export links are 30-day signed URLs where still used — no per-viewer
  revocation** (D-082 MVP caveat). Fine for operator-shared deliverables; not a
  substitute for real auth if a flow becomes self-serve. Expiry is a named
  constant.
- **`exports` has one storage-path column but an export writes two objects** (zip +
  report.html). `report.html`'s path is derived by convention (same folder). Add an
  explicit `report_storage_path` column only if a future export type stops
  co-locating them.
- **`artifact_type` CHECK constraint needs a migration for every genuinely new
  artifact type** — the TypeScript union alone doesn't cover it (bit us once with
  `mcp_scaffold`).
- **Migration filename timestamps don't match the applied Supabase version** — a
  pre-existing cosmetic quirk across all migrations; the DB tracks its own version,
  filenames are for human ordering only.

---

## Explicitly deferred (recorded so they're not mistaken for oversights)

- **No composite/headline score** unless categorical (D-021, D-022).
- **No score-over-time trend line** until cross-run comparability is solved and
  discontinuities are marked (D-055, D-025).
- **No operator/business analytics** in the merchant dashboard (founder tool —
  build when there's volume to analyze).
- **No `complete_checkout`, ever** (D-010).
- **No team roles UI yet** — `client_members.role` exists (`owner` set at
  onboarding), but invite/manage-teammates is future (the RLS already anticipates
  it: `client_members` INSERT requires an existing owner/admin).

---

*Append new to-dos under the right phase. When something ships, prune it here and
record it in `README.md`.*
