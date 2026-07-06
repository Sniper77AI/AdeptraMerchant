# Adeptra Merchant — UCP Compliance Signal Specs (v1)

**Product:** Adeptra Merchant (UCP anchor product)
**Grounded against:** UCP spec version `2026-04-08` (ucp.dev), Google Merchant Center UCP guide, March 2026 update (cart + catalog).
**Purpose:** Defines the exact pass/partial/fail rule, evidence shape, and remediation artifact for every `signal_key` the analyzer writes into the `signals` table. Everything downstream (pillar score, prioritized plan, generated manifest/feed fixes) derives from these definitions.

---

## How to read this doc

Each signal is one row in the `signals` table (`pillar='ucp'`). Fields map directly:

- **signal_key** → `signals.signal_key` (stable machine key; never rename once shipped).
- **category** → `signals.category`.
- **[D] / [L]** → Detection method. **[D]** = deterministic (no LLM, cheap). **[L]** = LLM-scored. *Note how few are [L]* — this is the cost-control map. In the UCP product, only 2 signals need an LLM.
- **weight / impact / effort** → drive `priority_score` (auto-computed by the DB as `impact × weight ÷ effort`).
- **pass / partial / fail / N/A** → the exact rule is spelled out per signal.
- **evidence_json** → the shape of proof stored, so every score is auditable.
- **artifact** → what the Artifact Generator produces to fix a fail/partial.

**Scoring reminder:** `N/A` signals drop out of the denominator, so a non-eligible store isn't punished for capabilities it hasn't declared. A pillar score = weighted % of *achievable* points.

**External-gate rule:** Some signals depend on things Adeptra cannot do on the merchant's behalf (Merchant Center eligibility, live payment handler, Google approval). Those are scored as **readiness checks** (is the prerequisite in place, y/n) and clearly flagged `external_gate: true` in evidence. We never claim to automate past that line.

---

## Category 1 — Discovery & Manifest (weight class: 0.20 of UCP pillar)

The `/.well-known/ucp` manifest is the entry point. If it's missing or malformed, the agent disregards the site entirely — so these are high-impact, mostly low-effort (we generate the manifest).

### `ucp_manifest_present` — [D]
- **What:** Fetch `https://{domain}/.well-known/ucp`.
- **pass:** HTTP 200, `Content-Type` is JSON, body parses as valid JSON.
- **partial:** 200 but wrong content-type, or redirects (spec wants it directly at the well-known path), or requires auth (spec: **MUST be publicly accessible, no authentication**).
- **fail:** 404 / 5xx / non-JSON / unreachable.
- **impact:** 5 · **effort:** 2
- **evidence_json:** `{ url, http_status, content_type, is_valid_json, redirect_chain: [] }`
- **artifact:** `ucp_manifest` (generate a valid profile scaffold).

### `ucp_manifest_version_declared` — [D]
- **What:** Manifest declares a `ucp.version` field with a recognized version string (e.g. `2026-04-08`).
- **pass:** `ucp.version` present and matches a known UCP version.
- **partial:** version present but unknown/older-than-current (flag for upgrade); or `supported_versions` map present but current version missing.
- **fail:** no `version` field.
- **impact:** 4 · **effort:** 1
- **evidence_json:** `{ declared_version, is_current, supported_versions_map }`
- **artifact:** `ucp_manifest` (set/patch version).

### `ucp_services_declared` — [D]
- **What:** Manifest declares `ucp.services["dev.ucp.shopping"]` with at least one service entry containing `version`, `transport`, and `endpoint`.
- **pass:** shopping service present with a resolvable `endpoint` URL, valid `transport` (`rest`, `mcp`, or `a2a`), and a `schema` URL.
- **partial:** service present but missing `schema`, or `endpoint` present but unreachable on a HEAD check, or transport not in the allowed set.
- **fail:** no `dev.ucp.shopping` service.
- **impact:** 5 · **effort:** 3
- **evidence_json:** `{ services: [{ name, version, transport, endpoint, endpoint_reachable, schema_present }] }`
- **artifact:** `ucp_manifest` (scaffold service block; endpoint wiring is a guided step, not auto).

### `ucp_namespace_authority_valid` — [D]
- **What:** Spec requires capability/service `spec` URLs originate from matching namespace authorities (DNS-as-governance). Check that declared `spec`/`schema` URLs are on `ucp.dev` (or the correct authority) and not spoofed/self-hosted where the spec requires the canonical authority.
- **pass:** all `spec`/`schema` URLs point to legitimate authority domains.
- **partial:** mix of valid and non-canonical URLs.
- **fail:** spec URLs point to unrelated/invalid domains.
- **impact:** 3 · **effort:** 1
- **evidence_json:** `{ urls_checked: [{ url, authority_ok }] }`
- **artifact:** `ucp_manifest` (correct the URLs).

---

## Category 2 — Product Data Hygiene & Cross-Surface Consistency (weight class: 0.30 — highest)

This is where UCP eligibility actually lives. "An AI agent won't overlook a price mismatch." Highest weight in the pillar. Requires the merchant's feed (captured at onboarding); degrades gracefully to page-only if absent.

### `feed_available` — [D]
- **What:** A product feed is linked at onboarding (Merchant Center feed URL, or a discoverable product feed). Gate for the rest of this category.
- **pass:** feed URL provided and fetchable, parses as a recognized feed format.
- **partial:** feed reachable but partial/malformed.
- **fail / N/A:** no feed provided → this and dependent signals score `N/A` (not `fail`), and we flag onboarding to request the feed. (N/A so a store isn't penalized for a feed we simply don't have access to yet.)
- **impact:** 5 · **effort:** 2
- **evidence_json:** `{ feed_url, reachable, format, item_count }`
- **artifact:** none (onboarding action).

### `product_id_consistency` — [D]
- **What:** Each product's ID in the feed maps to the product ID the checkout API/site uses (spec: "Each product needs an ID that maps to the product ID your checkout API uses"). Sample N products, cross-reference feed ID ↔ on-page structured data ID.
- **pass:** sampled products have matching IDs across feed and page.
- **partial:** some mismatches (< 20% of sample).
- **fail:** systematic ID mismatch or missing IDs.
- **impact:** 5 · **effort:** 3
- **evidence_json:** `{ sampled: [{ product, feed_id, page_id, match }], mismatch_rate }`
- **artifact:** `feed_fix` (ID mapping correction guidance).

### `price_consistency_cross_surface` — [D]
- **What:** For sampled products, compare price on: (a) product page (structured data / visible), (b) feed. Optionally (c) a third-party surface if provided. "Make sure prices match across your site, Merchant Center feed, and third-party sites."
- **pass:** prices match across all available surfaces (within currency/rounding tolerance).
- **partial:** minor mismatch on a subset (< 20%).
- **fail:** material price mismatches.
- **impact:** 5 · **effort:** 2
- **evidence_json:** `{ sampled: [{ product, page_price, feed_price, thirdparty_price, consistent }], mismatch_rate }`
- **artifact:** `feed_fix` (flag divergent records; the *source of truth* decision is the merchant's).

### `availability_consistency` — [D]
- **What:** Stock/availability status consistent between page and feed for sampled products.
- **pass:** availability matches.
- **partial:** subset mismatch.
- **fail:** systematic mismatch (e.g., feed says in-stock, page sold-out).
- **impact:** 4 · **effort:** 2
- **evidence_json:** `{ sampled: [{ product, page_availability, feed_availability, match }] }`
- **artifact:** `feed_fix`.

### `title_description_consistency` — [D + L]
- **What:** Titles/descriptions consistent and non-contradictory across page and feed. [D] catches exact/near-exact divergence; **[L]** judges *semantic* contradiction (e.g., page says "waterproof," feed says "water-resistant") for a small sample only.
- **pass:** consistent across surfaces.
- **partial:** cosmetic differences only.
- **fail:** contradictory claims that would mislead an agent.
- **impact:** 3 · **effort:** 3
- **evidence_json:** `{ sampled: [{ product, page_title, feed_title, semantic_conflict, note }] }`
- **artifact:** `feed_fix` / `content_rewrite`.

### `native_commerce_attribute` — [D]
- **What:** The `native_commerce` attribute is present on products the merchant wants eligible for UCP-powered checkout (Merchant Center product-level setting). Detect presence in feed / supplemental feed.
- **pass:** attribute present on intended products.
- **partial:** present on some but not all catalog the merchant flagged.
- **fail:** absent entirely (no products checkout-eligible).
- **impact:** 5 · **effort:** 2 — *external_gate: partial* (requires Merchant Center; we detect + instruct).
- **evidence_json:** `{ products_with_attr, products_total, external_gate: true }`
- **artifact:** `feed_fix` (supplemental feed snippet adding `native_commerce`).

### `discovery_attributes_enrichment` — [L]
- **What:** March-2026+ discovery attributes that help agents compare/answer (Q&A, compatible accessories, substitutes, richer structured attributes). LLM assesses coverage vs. category norms on a sample.
- **pass:** rich attribute coverage.
- **partial:** basic attributes only.
- **fail:** sparse (title + price only).
- **impact:** 3 · **effort:** 3
- **evidence_json:** `{ coverage_score, missing_attribute_types: [] }`
- **artifact:** `feed_fix` (suggested attribute additions).

---

## Category 3 — Capabilities (weight class: 0.25)

Which UCP capabilities the manifest declares AND appears to implement. Names are the real UCP capability identifiers.

### `capability_checkout_declared` — [D]
- **What:** Manifest declares `dev.ucp.shopping.checkout` with version + schema.
- **pass:** declared with valid version/schema.
- **partial:** declared but schema missing/version stale.
- **fail:** not declared.
- **impact:** 5 · **effort:** 3
- **evidence_json:** `{ declared, version, schema_present }`
- **artifact:** `ucp_manifest`.

### `capability_cart_declared` — [D]
- **What:** Cart support (added in the March 2026 update — multi-item carts). Detect the cart capability entry.
- **pass:** cart capability declared.
- **partial / fail / N/A:** partial if declared without full config; N/A if merchant is single-item-only by design.
- **impact:** 4 · **effort:** 3
- **evidence_json:** `{ declared, config }`
- **artifact:** `ucp_manifest`.

### `capability_catalog_declared` — [D]
- **What:** Product catalog access capability (March 2026 update).
- **pass:** declared.
- **partial/fail:** as above.
- **impact:** 4 · **effort:** 3
- **evidence_json:** `{ declared }`
- **artifact:** `ucp_manifest`.

### `capability_fulfillment_declared` — [D]
- **What:** `dev.ucp.shopping.fulfillment` declared (shipping expectations, method types).
- **pass:** declared with schema.
- **partial/fail:** as above.
- **impact:** 3 · **effort:** 3
- **evidence_json:** `{ declared, version, schema_present }`
- **artifact:** `ucp_manifest`.

### `capability_identity_linking_declared` — [D]
- **What:** `dev.ucp.common.identity_linking` with scopes config (e.g. `dev.ucp.shopping.order:read`, `:manage`). Enables account-linked/order-management experiences.
- **pass:** declared with scopes.
- **partial:** declared, scopes incomplete.
- **fail / N/A:** N/A if merchant opts out of account linking.
- **impact:** 2 · **effort:** 3
- **evidence_json:** `{ declared, scopes: [] }`
- **artifact:** `ucp_manifest`.

### `endpoint_reachability` — [D]
- **What:** The declared service `endpoint` responds correctly to an unauthenticated discovery/HEAD probe (without executing a transaction).
- **pass:** endpoint reachable, sane response.
- **partial:** reachable but errors on discovery.
- **fail:** unreachable.
- **impact:** 4 · **effort:** 3 — *implementation, not just manifest.*
- **evidence_json:** `{ endpoint, http_status, notes }`
- **artifact:** none (flag as engineering task in plan).

---

## Category 4 — Payment / AP2 Readiness (weight class: 0.15) — mostly external gates

Adeptra checks *readiness*; it does not wire live payments. All flagged `external_gate`.

### `ap2_compatibility_declared` — [D]
- **What:** Manifest/payment config indicates AP2 (Agent Payments Protocol) compatibility and payment handler(s) declared.
- **pass:** payment handler(s) + AP2 support declared.
- **partial:** payment handler declared, AP2 unclear.
- **fail:** no payment handler.
- **impact:** 4 · **effort:** 4 — *external_gate: true*
- **evidence_json:** `{ payment_handlers: [], ap2_declared, external_gate: true }`
- **artifact:** none (guided instruction; requires payment provider).

### `credential_security_posture` — [D]
- **What:** Where detectable, checks that payment credential handling follows spec guidance (tokenization referenced, credentials not usable directly by platforms, reasonable expiry). Limited to what's observable in config/manifest — we do NOT probe live payment flows.
- **pass:** manifest/config references tokenization + scoped credentials.
- **partial:** partial signals.
- **fail / N/A:** N/A if not observable (don't guess).
- **impact:** 3 · **effort:** 4 — *external_gate: true*
- **evidence_json:** `{ tokenization_referenced, external_gate: true, observable }`
- **artifact:** none.

### `merchant_of_record_declared` — [D]
- **What:** Merchant remains Merchant of Record (UCP model). Check policy/manifest signals that MoR + data ownership are correctly represented.
- **pass:** MoR posture clear.
- **partial/N/A:** as observable.
- **impact:** 2 · **effort:** 2
- **evidence_json:** `{ mor_signal }`
- **artifact:** none.

---

## Category 5 — Policy & Post-Purchase Transparency (weight class: 0.10)

Required for Merchant Center UCP eligibility; agents need post-purchase confidence.

### `return_policy_present_consistent` — [D]
- **What:** Return policy is clearly defined and machine-readable, and consistent between site and feed/Merchant Center. (Merchant Center UCP eligibility requirement.)
- **pass:** present, structured, consistent.
- **partial:** present but not machine-readable, or minor inconsistency.
- **fail:** absent.
- **impact:** 4 · **effort:** 2
- **evidence_json:** `{ found_on_site, structured, feed_match }`
- **artifact:** `content_rewrite` / `feed_fix`.

### `shipping_info_present_consistent` — [D]
- **What:** Shipping info/zones present and consistent across site and feed (country codes, ranges).
- **pass:** present + consistent.
- **partial:** present, inconsistent.
- **fail:** absent.
- **impact:** 3 · **effort:** 2
- **evidence_json:** `{ found, zones, feed_match }`
- **artifact:** `feed_fix`.

### `support_contact_present` — [D]
- **What:** Customer support contact details present (Merchant Center UCP requirement — "AI agent needs confidence the shopper will be cared for post-purchase").
- **pass:** support contact present + machine-readable.
- **partial:** present, not structured.
- **fail:** absent.
- **impact:** 3 · **effort:** 1
- **evidence_json:** `{ found, machine_readable, method }`
- **artifact:** `content_rewrite` (structured support block / schema).

---

## Category 6 — Merchant Center Eligibility (readiness gate — cross-cutting)

Not scored into capability quality; scored as a **readiness checklist** because these are external gates that determine whether *any* of the above can go live on Google surfaces.

### `merchant_center_account_ready` — [D, readiness]
- **What:** Merchant confirms an active Merchant Center account with configured shipping, returns, product feeds. (Self-attested at onboarding + any detectable signals.)
- **pass/partial/fail:** based on onboarding attestation + checks.
- **impact:** 5 · **effort:** 2 — *external_gate: true*
- **evidence_json:** `{ attested, feeds_configured, external_gate: true }`
- **artifact:** none (guided checklist).

### `ucp_early_access_status` — [D, readiness]
- **What:** UCP checkout is US-eligible-merchant + early-access/approval gated (rolling out through 2026). Track the merchant's access status.
- **pass:** approved / in program.
- **partial:** applied, pending.
- **fail:** not applied.
- **impact:** 4 · **effort:** 1 — *external_gate: true*
- **evidence_json:** `{ status, region_eligible, external_gate: true }`
- **artifact:** none (link to interest form / guidance).

---

## Summary: cost profile

| Detection | # signals | Notes |
|---|---|---|
| **[D] deterministic** | ~21 | Zero LLM. Crawl + parse + compare. This is ~90% of the UCP analyzer. |
| **[L] LLM-scored** | 2 | `discovery_attributes_enrichment`, and the semantic half of `title_description_consistency`. Cheap-tier model, small samples only. |

The UCP product is almost entirely deterministic — which is exactly why it's the right anchor to build first: it's the cheapest pillar to run per analysis, and the checks are unambiguous enough to build directly against the `signals` schema.

## What derives from this (no extra design needed)

- **UCP pillar score** = weighted % of achievable (non-N/A) points from these signals.
- **Prioritized remediation plan** = `SELECT ... FROM signals WHERE pillar='ucp' AND status IN ('fail','partial') ORDER BY priority_score DESC`.
- **Generated artifacts** = union of the `artifact` column for all failing signals (mostly one `ucp_manifest` + one or more `feed_fix`).
- **Honesty boundary** = every `external_gate: true` signal is shown to the merchant as "prerequisite you must complete," never as "done for you."

---

## Open items to confirm before building the crawler against this

1. **Manifest fetch**: confirm we respect the "no auth, public" rule and follow at most one redirect before flagging `partial`.
2. **Sampling size (N)** for the cross-surface consistency checks — proposed default 15 products, config not hardcode.
3. **Feed formats to support at MVP**: Google Merchant feed (XML/TSV) + Shopify product feed first; others later.
4. **Third-party surface** (Amazon etc.) consistency: MVP = optional, only if merchant provides the URL; not auto-discovered.
5. **Version drift**: `ucp_manifest_version_declared` needs a maintained list of known UCP versions — where does that list live and how is it updated as UCP ships new versions? (Suggest: a small `ucp_versions` reference table or config, updated centrally — this is part of the "we keep you current" subscription value.)
