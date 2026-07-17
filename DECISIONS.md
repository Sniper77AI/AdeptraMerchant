# Adeptra — Decision Record

> **Purpose.** This is the durable record of *why* Adeptra is built the way it is.
> Each entry states **what** was decided, **why**, and **what was rejected**. The
> rejected-alternatives are the point: they stop a future contributor — human or
> agent — from "helpfully" re-introducing something we deliberately killed.
>
> This is not a changelog. Build history lives in `README.md`. This file answers
> one question: *"Can I change X?"* — and tells you what breaks if you do.
>
> **How to use it.** Before reversing anything here, read the entry. If you still
> think it should change, add a new entry that supersedes the old one (don't
> delete history — mark it superseded, with the date and the reason). Append new
> decisions as they're made.

---

## Index

- [Product & Positioning](#product--positioning)
- [Payment & Money Boundary](#payment--money-boundary)
- [Scoring & Signals](#scoring--signals)
- [Data Model & Multi-Tenancy](#data-model--multi-tenancy)
- [Onboarding & Funnel](#onboarding--funnel)
- [Dashboard & Frontend](#dashboard--frontend)
- [Artifacts & Honesty Rules](#artifacts--honesty-rules)
- [Billing (designed, not built)](#billing-designed-not-built)
- [Infrastructure & Ops](#infrastructure--ops)

---

## Product & Positioning

### D-001 — Adeptra makes stores buyable by AI agents; it is not an SEO/AEO tool
**Decided.** The product's job is to make an ecommerce store discoverable,
parseable, trusted, and **buyable** by AI shopping agents (ChatGPT, Gemini,
Perplexity, Google AI Mode) — via UCP (Universal Commerce Protocol) compliance
plus general agent-readability.
**Why.** This is a concrete, checkable capability ("can an agent transact with
this store?"), not a visibility-lift claim we can't substantiate.
**Rejected.** Positioning as an AEO/GEO "get cited by AI" product — see D-020,
the `aeo_geo` pillar stays empty precisely because that effect isn't
evidence-backed.

### D-002 — Target the off-Shopify long tail; Shopify is audit-only
**Decided.** The build target is stores on WooCommerce, Wix, and custom
platforms. Shopify stores get UCP/MCP support natively from the platform, so for
them Adeptra is at most an audit, not a fix-provider.
**Why.** Shopify will equip its own merchants for free (confirmed pattern —
Shopify silently shipped `llms.txt`/`agents.md` to all stores ~May 2026). The
defensible market is merchants whose platform *won't* do this for them.
**Rejected.** Competing with Shopify's native tooling on Shopify's own turf.

### D-003 — "CrawlTrust" is not a separate product; it folded into the agent-readability pillar
**Decided.** The second-product idea (edge AI-readiness, working name
*CrawlTrust*) is not built as a standalone product. Its concept lives on as the
`agent_readability` pillar / service tier.
**Why.** The schema/sitemap/LLM-markup trick is being commoditized; the
defensible part (knowing *what* to fix, via audit) already lives in Adeptra.
There's no separate product to build — it's a service tier.
**Rejected.** Building CrawlTrust as its own product with its own surface area.

### D-004 — Service tiers map to the two pillars: searchable / buyable / both
**Decided.** The productized offering is three tiers — *searchable*
(`agent_readability`), *buyable* (`ucp`), or *both*.
**Why.** The two pillars measure genuinely different, sequential capabilities
(an agent must be able to *read* you before it can *transact* with you), which
maps cleanly onto tiers a merchant can choose between.
**Rejected.** A single undifferentiated "compliance" product; a single blended
score that hides which capability a merchant is paying to gain (see D-010).

### D-005 — Build the complete product before acquiring customers (founder's call, risk flagged)
**Decided.** Adeptra is being built to a complete, sellable state before pursuing
customers.
**Why.** Founder's deliberate choice.
**Rejected / flagged.** The alternative (get a customer first, build against real
demand) was raised repeatedly as the lower-risk path. Recorded here so the risk
is *known and owned*, not forgotten: there are zero customers, and every feature
built now is a bet placed before the market has spoken.

---

## Payment & Money Boundary

### D-010 — Never implement `complete_checkout`; payment always stays with the merchant
**Decided.** No artifact, scaffold, or endpoint Adeptra generates will ever
accept payment credentials or place a final order. The MCP scaffolds implement
UCP's **catalog + cart** surface only; the cart-to-checkout step is a handoff via
UCP's own `continue_url` to the merchant's normal checkout.
**Why.** This is a permanent policy, not a phase-1 limitation. Adeptra never
touches money, so it never carries payment liability, PCI scope, or merchant-of-
record risk. This is a settled safety and legal boundary.
**Rejected.** Full UCP MCP conformance including `complete_checkout` (UCP's cart
binding *does* specify a payment-carrying `complete_checkout` tool). This means
full transport-conformance and "never touch money" are permanently incompatible,
and we choose the boundary. The divergence is disclosed honestly in every
generated scaffold's README, never hidden behind a "conformant" claim.
**Consequence.** The MCP scaffolds are catalog+cart conformant on tool
names/shapes/session semantics but (a) use stdio not HTTP-streaming transport,
and (b) deliberately omit checkout. Both gaps are disclosed, not concealed.

### D-011 — Payment boundary is enforced structurally where possible, by discipline where not
**Decided.** WooCommerce scaffolds use only the public Store API (which
*cannot* authorize payment) — the platform enforces the boundary. Wix's API
*can* create orders, so the boundary is enforced by explicit "endpoints we never
call" discipline plus a boundary regression test. Custom's `StoreAdapter`
contract has no payment/order/admin method at all — the absence *is* the
boundary.
**Why.** Structural enforcement is stronger than discipline; use it wherever the
platform allows, and make the boundary explicit and tested wherever it doesn't.
**Rejected.** Relying on prompt/comment discipline alone where a structural
guarantee was available.

---

## Scoring & Signals

### D-020 — Two scored pillars (`ucp`, `agent_readability`); `aeo_geo` stays intentionally empty
**Decided.** Two pillars are scored: `ucp` (protocol compliance) and
`agent_readability` (can any machine access/parse/understand the store). A third
pillar value, `aeo_geo`, exists in the schema but **no signals are scored into
it**.
**Why.** `aeo_geo` would claim an effect on AI-search *visibility/citation*.
Research (Ahrefs, SE Ranking, Google's own June 2026 docs) shows schema markup
and `llms.txt` have no demonstrated AI-citation effect — they're
agent-readability infrastructure, not visibility levers. No credible evidence,
no claim.
**Rejected.** Scoring an AEO/GEO pillar to look more complete. `aeo_geo` stays
empty until credible evidence justifies it.

### D-021 — No composite score; report both pillars separately, never averaged
**Decided.** There is no overall/composite score. `overallScore()` was **deleted**
(not replaced). Reports show two pillar cards side by side; `analysis_runs.
overall_score` is deprecated (comment-only migration, historical values
preserved).
**Why.** The two pillars measure non-commensurable things ("can an agent read
you" vs. "can an agent transact with you"); there is no principled weighting
between them. Live data proved an average actively misleading: UCP *fell*
86.36%→81.41% while the averaged composite *rose*, purely because a second
unrelated pillar got averaged in.
**Rejected.** Any arithmetic mean of pillar scores. **If** a single headline is
ever wanted, it must be *categorical / gate-derived* (e.g. "discoverable, not yet
buyable"), never an average — see D-022.

### D-022 — Any future headline number must be categorical, not arithmetic
**Decided.** Should a single summary indicator ever be reintroduced, it is
computed from whether each pillar clears a threshold (a category like "searchable
but not buyable"), never by averaging percentages.
**Why.** An averaged number has no defensible referent (D-021). A categorical one
does.
**Rejected.** Reviving an averaged composite under a new name.

### D-023 — `signals` is the single source of truth; scores/plans/artifacts derive from it
**Decided.** Every score, remediation plan, and artifact derives from the
`signals` table. Nothing is a computed value we can't explain back to its
evidence.
**Why.** Explainability and auditability — the product's entire value is "a score
you can trust," which requires every number to trace to a signal row.
**Rejected.** Storing derived scores as independent sources of truth that could
drift from the signals underneath.

### D-024 — Signal weight/impact/effort/pillar/category live in ONE canonical source
**Decided.** All 35 signals' definitions live in `signalDefinitions.ts`, read via
`getDef()`. No check module declares its own weights. A permanent guardrail
(`test_signal_definitions.ts`) asserts emitted signals match declared definitions
both ways, and that the zero-weight set is exactly
`{merchant_center_account_ready, ucp_early_access_status}`.
**Why.** Weights were previously scattered across nine local `W` objects; seven
signals had silently drifted (e.g. `robots_txt_valid` 1.0→1.5). One canonical
source makes drift impossible-by-construction: a weight can't change in a check
function (it comes from `getDef()`) or in the canonical source (the guardrail
catches it in review).
**Rejected.** Per-module weight tables. Never reintroduce a local weight literal.
**Note on provenance.** UCP weights were never externally spec'd as numbers
("proportional to impact" — a frozen design choice). `agent_readability` weights
*were* spec'd and reconciled 2026-07-10. The canonical file's header documents
which is which — don't treat UCP's numbers as externally validated.

### D-025 — `analysis_runs` are immutable; never rewrite history
**Decided.** Re-running an analysis creates a *new* run. No past run's scores are
ever recomputed or rewritten — not for weight fixes, not for the composite
removal, not for methodology changes.
**Why.** Immutability gives free, honest score-over-time history and means every
reported score stays correct *for the code that produced it*.
**Rejected.** Backfilling/recomputing historical runs when methodology changes.
**Consequence.** Scores are **not comparable across methodology changes.** Do not
compare a pre-2026-07-10 `agent_readability` score to a later one (weights
changed), and do not compare runs across the composite removal.

### D-026 — External gates are scored as readiness checklists, never as "done for you"
**Decided.** Things Adeptra cannot actually complete for a merchant (Merchant
Center eligibility, live payment-handler approval, Google approval, moving a site
to SSR) are scored as *readiness* items — "a prerequisite you must complete" —
and carry weight 0 where they're pure external gates, excluding them from the
score.
**Why.** Honest boundaries. Never imply Adeptra did something it structurally
cannot do.
**Rejected.** Scoring external gates as capability quality, or auto-claiming them
resolved.

### D-027 — Deterministic-first; LLMs only where they add value
**Decided.** ~90% of checks are deterministic (no LLM). LLMs are used for exactly
2 of 25 UCP signals (`title_description_consistency`, `discovery_attributes_
enrichment`), and degrade to `not_applicable` when no API key is set.
**Why.** Keeps per-analysis cost low and results reproducible; LLMs earn their
place only where determinism can't do the job.
**Rejected.** LLM-first checking.

### D-028 — Signal evidence is DATA, not code (`signal_evidence` table)
**Decided.** Each signal's evidentiary basis (`specified` / `measured` /
`documented` / `contested` / `no_evidence`) plus a merchant-facing note live in
the `signal_evidence` table, looked up fresh at report-build time.
**Why.** Epistemic judgments move faster than deploys; a correction should
reflect on every re-render, not be frozen at scan time. The disclosure *is* the
product, not a footnote.
**Rejected.** Hardcoding basis strings in check modules, or snapshotting them onto
`signals` rows. **Note:** `measured` exists as distinct from `documented` because
the "AI crawlers don't run JS" fact is an *observed measurement* (Vercel/MERJ,
569M fetches), not vendor self-disclosure — a measured behavioral fact is
stronger than a documented one.

### D-029 — Merchant intent is ATTESTED, never inferred (the opt-out/opt-in pattern)
**Decided.** Three boolean attestation columns on `sites`
(`identity_linking_opt_out`, `checkout_handoff_opt_in`, `ai_training_opt_out`),
all `NOT NULL DEFAULT false`. When true, the corresponding signal scores
`not_applicable` instead of `fail`.
**Why.** Whether a merchant *wants* identity-linking, a catalog-only cart profile,
or to block AI-training crawlers is a business decision only they can make. Never
infer intent from platform or from robots.txt contents.
**Rejected.** Inferring these from platform defaults or file contents. Same
guardrail applies to artifacts: never silently make a merchant-preference decision
for them (feed_fix always flags REVIEW; robots_patch never auto-toggles
GPTBot/ClaudeBot).

---

## Data Model & Multi-Tenancy

### D-030 — Multi-tenant isolation via membership + `SECURITY DEFINER` helpers, never JWT metadata
**Decided.** RLS scopes every tenant table through `user_client_ids()` /
`user_site_ids()` — `SECURITY DEFINER` functions keyed on `auth.uid()` via
`client_members`, hardened with `SET search_path = public`.
**Why.** Membership is the real ownership model; JWT metadata can be stale or
spoofable. The `SECURITY DEFINER` + `search_path` hardening closes the
privilege-escalation hole.
**Rejected.** Scoping by JWT claims/metadata.

### D-031 — Client + membership + site creation must be atomic (`onboard_add_site`)
**Decided.** The first client, its owner `client_members` row, and the site are
created atomically by a single `SECURITY DEFINER` function.
**Why.** This is the **only possible bootstrap**: `clients` has zero INSERT policy
under RLS, and `client_members`'s INSERT policy requires the inserter to *already*
be an owner/admin — impossible for a brand-new client's first membership. A
non-atomic path could also strand a user with an orphan client they can't see
(RLS filters through the missing membership).
**Rejected.** Client-side sequential inserts (would deadlock on RLS and risk
partial writes).
**Watch-out.** Supabase's default privileges grant `anon` EXECUTE on new
functions even after `REVOKE ALL FROM PUBLIC` (granted per-role, not via PUBLIC).
Always verify and revoke explicitly — this bit us once, caught live.

### D-032 — One client per user for now; schema already supports multi-client
**Decided.** Onboarding writes exactly one client per user. The `client_members`
join table already supports many-to-many (agencies, multi-brand) — we just don't
write extra rows yet.
**Why.** Simplest correct choice now; zero schema cost to scale later because the
structure is already plural (`user_client_ids()` returns a *set*).
**Rejected.** Building multi-client UI now (premature); hardcoding a one-client
assumption into the schema (unnecessary — the join table is already general).

### D-033 — `domain` is NOT stable identity; cross-run history must key on `site_id`
**Decided.** Any feature showing history/trends keys on `site_id`, never `domain`.
**Why.** One domain can have multiple `sites` rows across clients (the
`(client_id, root_url)` unique constraint permits it). Concretely, "skims.com"
exists as two site rows with different configs and non-comparable scores. Keying a
trend on `domain` would silently merge different store configurations into one
misleading line.
**Rejected.** Domain-keyed trends/identity.

---

## Onboarding & Funnel

### D-040 — Signup-first: everything is gated behind an account
**Decided.** A merchant signs up and verifies *before* seeing anything. Onboarding
(URL, platform, feed, opt-outs) happens as an authenticated user; the free report
is shown post-signup.
**Why.** Fits the intended agentic-outbound acquisition (the report is what an
agent presents to a specific merchant it's already contacting). Critically, it
**dissolves the orphan-intake problem**: all data is created by a known,
authenticated user, so the `client_members` link is written at creation — no
anonymous clients to reconcile later.
**Rejected.** Anonymous-report-then-gate-fixes (keeps a public lead magnet but
reintroduces the orphan-intake reconciliation). This is a coherent alternative
*if* acquisition ever shifts to inbound/cold discovery — recorded so the tradeoff
is known. The public intake form (`merchant/api/analyze.ts`) is now a dev/operator
tool, not the customer path.

### D-041 — One smart onboarding form that branches on whether the user has a client
**Decided.** A single `/onboarding` form. First time (no client) → create client +
membership + site. Returning (has client) → add a site.
**Why.** Less UI, handles the returning user naturally.
**Rejected.** Two separate flows (first-time-setup vs. add-a-store).

### D-042 — Save the store instantly; run analysis after (don't block the merchant on the run)
**Decided.** Clicking "Analyze My Store" saves the store instantly and routes to
the store view showing "analysis in progress." The analysis runs after and
results appear when ready.
**Why.** A form that hangs 30–60s on a full analysis feels broken. Decoupling
"store saved" (instant, atomic) from "analysis done" (slow, I/O-heavy) is the
honest split — and it's the same shape a future queued/n8n trigger will formalize.
**Rejected.** A blocking form that waits for the whole run.

### D-043 — In-progress state is an explicit `running` status, never inferred from absence
**Decided.** A run starts at `status='running'` the moment analysis is triggered
and transitions to a terminal status (`complete` / `no_manifest` / `failed`). The
store view reads the latest run's status.
**Why.** Inferring "in progress" from "no finished run yet" can't distinguish
"running" from "silently died." An explicit `running` makes a killed/hung analysis
a *detectable* `running`-forever row, and a real failure shows `failed` (honest
retry) instead of an eternal spinner.
**Rejected.** Inferring progress from the absence of a completed run.
**Note.** `running`/`queued` were already in the status CHECK constraint from the
first schema migration — no new migration was needed.

### D-044 — Deferred post-response work uses Next.js `after()`, not fire-and-forget
**Decided.** The analysis is triggered inside the onboarding Server Action via
Next.js `after()` (stable since 15.1.0).
**Why.** A bare un-awaited promise in a Server Action has **no completion
guarantee on Vercel serverless** — it can be killed once the response is sent
(works in dev, dies in prod). `after()` (built on `waitUntil`) is the sanctioned
way to extend the invocation, avoiding a second deployed endpoint.
**Rejected.** Bare fire-and-forget background work.

---

## Dashboard & Frontend

### D-050 — Next.js, scaffolded from Supabase's official `with-supabase` template
**Decided.** The dashboard is a separate top-level Next.js app (`dashboard/`),
scaffolded from `create-next-app -e with-supabase` (Next.js 16.2.10,
`@supabase/ssr` 0.12.0, pinned).
**Why.** It's the documented Vercel+Supabase path and hands us auth, sessions,
protected routes, and the Stripe billing path for free — the "don't build the pipe
the platform gives you" principle. Chosen specifically so the workflow stays as
autonomous as possible.
**Rejected.** Building the Next.js app from scratch; a lighter React SPA (would
hand-roll what the template provides); the deprecated `@supabase/auth-helpers`
(superseded by `@supabase/ssr`).
**Note.** The template renames `middleware.ts`→`proxy.ts` and
`ANON_KEY`→`PUBLISHABLE_KEY` (Next 16 / current Supabase naming) — use the real
names, not older ones.

### D-051 — Dashboard reads directly via RLS with the anon key; never the service key
**Decided.** Dashboard reads go direct to Supabase through RLS using the anon
(publishable) key + the logged-in user's JWT. The service-role key never appears
in any browser-reachable surface (`NEXT_PUBLIC_*` or the client bundle).
**Why.** RLS enforces tenant isolation only when it can see *which user* is asking
(via the JWT). A service key in the browser would bypass all RLS — reopening the
multi-tenant breach. Verified safe: policies are user-scoped through the
`SECURITY DEFINER` helpers.
**Rejected.** A separate API layer for reads (unnecessary — RLS makes direct reads
safe); any service-key use in client-reachable code. The service key is confined
to server-only paths (the pipeline write path, the report/bundle proxy routes).

### D-052 — Server-side auth checks use verified token checks (`getClaims()`), never cookie trust
**Decided.** Server-side auth uses `getClaims()`, which cryptographically verifies
the JWT against the project's asymmetric ES256 JWKS (local, non-spoofable).
**Why.** Reading the session from the cookie can be spoofed. `getClaims()` (current
Supabase recommendation) satisfies the hard rule "never trust an unverified
token." (The spec originally said `getUser()`; `getClaims()` meets the same intent
via local signature verification and was kept after verifying the project signs
with ES256.)
**Rejected.** `getSession()` / raw cookie reads for auth decisions.

### D-053 — Dashboard and export share ONE pure report model (`reportModel.ts`)
**Decided.** The pure logic that turns a run's signals into a grouped, prioritized,
framed report (`buildModel`/`buildSections`, pillar display constants) lives in
`reportModel.ts`, imported by both the export (`reportBuilder.ts`, renders HTML/MD)
and the dashboard (renders React).
**Why.** One source of truth for *how signals become a readable report* means the
dashboard and the downloadable report can never diverge in grouping, sort order,
or framing — the same anti-drift principle as D-024, applied to presentation.
**Rejected.** The dashboard re-implementing its own view model from RLS queries
(would reintroduce presentation-layer drift).

### D-054 — Not-found and not-owned are indistinguishable (no existence leak)
**Decided.** Requesting a `siteId` the user doesn't own returns the exact same
"not found" as a `siteId` that doesn't exist — verified empirically by diffing the
rendered output of a real other-owner site vs. a fabricated UUID (byte-identical).
**Why.** A "you don't have permission" message confirms the resource *exists*,
letting someone probe for other tenants' IDs. A plain not-found leaks nothing.
**Rejected.** Any distinct "forbidden" vs "not found" response for owned-but-
inaccessible resources.

### D-055 — Merchant analytics: current scores + fixes + run-history LIST, no trend line
**Decided.** The store view shows the two current pillar scores, fixes
completed/outstanding, and a run-history *list* (date, status, scores). No
score-over-time trend line.
**Why.** A trend line would draw across runs scored under different methodologies
(D-025) and possibly different site rows for one domain (D-033) — a dishonest
"improvement/decline" that's really methodology changing underneath. The list is
honest history without a false trend claim.
**Rejected.** A score-over-time chart (until the cross-run comparability problem is
solved and discontinuities are explicitly marked). Also rejected for v1:
operator/business analytics (a founder tool, not a merchant feature).

---

## Artifacts & Honesty Rules

### D-060 — Artifacts patch, never wholesale-rewrite; never fabricate; never claim un-earned resolution
**Decided.** Generators follow strict honesty rules: `robots_patch` emits
line-numbered patch instructions (valid inert syntax even if deployed as-is),
never a full rewrite; `manifestArtifact` preserves valid existing config
byte-for-byte; `content_rewrite` structures only the merchant's *stated* facts
(a mechanical gate rejects the whole output if any number isn't traceable to
source); `feed_fix` references products by id only, never authoring
titles/prices; `jsonld` generates no product markup at all if feed and pages
disagree. `resolves_signal_keys` is only set when a signal was *actually* fixed.
**Why.** The product's credibility depends on never claiming to have done
something it didn't. A pre-deployment scaffold never claims to resolve a signal;
a sampled-page template never claims to be a complete catalog fix.
**Rejected.** Auto-filling merchant-specific values, wholesale rewrites that
discard unknown existing config, or marking signals resolved when only some URLs
were corrected.

### D-061 — Custom-store artifacts are reference implementations that refuse to run until completed
**Decided.** For custom platforms (no standard API), the MCP scaffold generates a
reference implementation: `server.ts` is complete, but each `StoreAdapter` method
throws `IMPLEMENT-THIS` until a developer fills it in, and the server refuses to
start while any stub remains (detected by reading each method's own source text,
not by invoking it).
**Why.** Honest about what it is — an ~80%-complete starting point, not a working
server. Source-text detection avoids false positives/side effects from invoking a
half-done adapter, and can't drift like a separate boolean flag.
**Rejected.** Shipping a fake "working" custom server; a boolean "is-implemented"
flag.

### D-062 — Never generate a sitemap from Adeptra's own partial crawl
**Decided.** `sitemap_present` never produces a sitemap built from Adeptra's
sampled crawl. The honest fix is a *script* the merchant runs against their own
full catalog (deferred, not built), or platform-keyed guidance.
**Why.** A sitemap from a partial crawl would tell crawlers "these are all my
pages" while omitting most — a false claim dressed as a fix.
**Rejected.** Generating a partial sitemap.

---

## Billing (designed, not built)

> Full design captured; **not implemented** — waiting on a Stripe account. Build
> Phase 1 first (simpler, gets us paid), then Phase 2. See `ROADMAP.md`.

### D-070 — Two-part model: one-time payment for the fix, subscription for ongoing monitoring
**Decided.** (1) A **one-time payment** (Stripe Checkout `payment` mode) unlocks
the fix *bundle* per store — a product the merchant owns. (2) A **recurring
subscription** (Stripe Checkout `subscription` mode) grants ongoing
*monitoring/re-analysis* as UCP/A2A/crawler standards drift.
**Why.** The fix is a concrete deliverable — one-time is the honest match. But a
store's compliance *decays* as standards move (we watched them move across this
project), so monitoring is real ongoing value, not rent. The subscription is also
where n8n + the agentic-org layer earn their keep (scheduled re-runs, change
detection, alerts).
**Rejected.** Pure one-time (leaves recurring value/revenue on the table as
standards drift); pure subscription for the fix (a fix you own shouldn't
evaporate when you stop paying).

### D-071 — `isEntitled()` splits into two gates
**Decided.** Entitlement becomes `hasPaidForBundle(siteId)` (one-time, permanent,
per-site) and `hasActiveMonitoring(clientId)` (recurring, time-bounded,
per-client). The bundle download checks the first; monitoring/re-analysis features
check the second.
**Why.** Two distinct entitlements with different data and lifetimes (D-070).
**Rejected.** Stretching one gate to cover both. The one-time fix payment likely
needs its own per-site record (a small table or a `paid_at`/`payment_id`), while
`subscriptions` fits the recurring half naturally.

### D-072 — Delivery is a secure download LINK to the verified account email, never a raw file or separate address
**Decided.** On payment, the fix bundle is delivered as a proxy-routed, revocable,
account-tied download **link** (dashboard button + emailed), sent to the
merchant's **verified signup email**. Onboarding does not collect a separate
delivery email.
**Why.** A link routes through the entitlement-checked proxy (stays revocable,
account-tied); a raw attachment escapes control and gets flagged/stripped. Locking
delivery to the verified account email closes a fraud vector (can't have a paid
artifact sent to an arbitrary address).
**Rejected.** Emailing the raw bundle file; a separate onboarding-captured delivery
address (add later only if a real need appears).

### D-073 — Webhooks must be signature-verified and idempotent; the webhook is the highest-value target
**Decided.** The Stripe webhook handler must verify the Stripe signature against
the signing secret using the *raw* request body, and be idempotent (safe to
process the same event more than once).
**Why.** An unverified webhook endpoint is a "mark myself as paid" button. Stripe
delivers events at least once (sometimes more), so a non-idempotent handler could
double-grant. The handler runs with **no logged-in user**, so it needs the
service-role key — making it the highest-value target in the app, which is exactly
why signature verification is non-negotiable.
**Rejected.** Trusting unverified webhook calls; non-idempotent grant logic.
**Note.** Transactional email (Resend/Postmark/Supabase hooks) is a new dependency
introduced *with* billing, since delivery fires on "payment cleared."

---

## Infrastructure & Ops

### D-080 — Secrets only in `.env`/`.env.local` (gitignored); service key never in a browser surface
**Decided.** Real secrets live only in gitignored env files; `.env.example`
(committed) holds placeholders. The service-role key never appears in any
`NEXT_PUBLIC_*` var or client bundle — verified by scanning the built bundle for
both the literal value and the bare var name.
**Why.** The service key bypasses RLS; in a browser it's a total breach.
**Rejected.** Committing real secrets; reusing `NEXT_PUBLIC_*` vars for the service
key path.

### D-081 — Endpoints are Vercel-shaped now; deploy is a config flip, not a rewrite
**Decided.** `merchant/api/*` are plain Node `http` handlers (no `@vercel/node`),
using Vercel's `[param].ts` dynamic-route convention. `serve.ts` runs them locally
today.
**Why.** A later `vercel deploy` (project root set appropriately) is configuration,
not a rewrite.
**Rejected.** Vercel-specific imports that would couple local dev to the platform.

### D-082 — Report/bundle always served through proxy routes, never a raw signed Storage URL
**Decided.** `GET /api/report/<runId>` and `GET /api/bundle/<runId>` fetch from
private Storage server-side (service-role key) and re-serve the bytes. No signed
Storage URL is ever handed to a client — including the report's own embedded
download button.
**Why.** Supabase Storage forces `text/plain` + a sandboxed CSP on HTML it serves
directly (anti-phishing, no header bypass), so a signed `report.html` URL renders
as raw source. Proxying is the only fix, and it also keeps the bundle behind the
entitlement gate.
**Rejected.** Handing out raw signed URLs (breaks HTML rendering, and — for the
bundle — bypasses entitlement). **MVP caveat:** signed URLs where still used are
30-day, no per-viewer revocation — acceptable for operator-shared deliverables,
not for self-serve auth.

### D-083 — Portable logic: pure functions + injectable fetcher + raw PostgREST (no SDK)
**Decided.** Signal checks are pure functions with an injectable fetcher; the
Supabase sink talks raw PostgREST over `fetch` (no `supabase-js`).
**Why.** Everything runs in an n8n code node today and lifts into a standalone
worker later, unchanged — directly serving the agentic-org / n8n roadmap.
**Rejected.** Coupling core logic to an SDK or a specific runtime.

### D-084 — `adeptra.ai` owned via Squarespace; DNS/redirects are deploy-time tasks
**Decided.** The domain is registered through Squarespace. At deploy time, DNS is
pointed at Vercel (records pasted into Squarespace), and Supabase Auth redirect
URLs are reconfigured to the custom domain then — **not before**.
**Why.** Reconfiguring auth redirects before deployment only creates a broken-link
surface.
**Rejected.** Managing the domain via the GoDaddy connector (wrong registrar);
reconfiguring auth redirects early. **To do (human):** confirm auto-renew +
transfer-lock in Squarespace.

---

*Append new decisions below this line. Supersede — don't delete — when reversing
an earlier call.*
