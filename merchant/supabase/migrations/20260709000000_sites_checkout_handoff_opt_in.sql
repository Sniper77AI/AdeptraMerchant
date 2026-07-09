-- =============================================================================
-- sites.checkout_handoff_opt_in: the onboarding-level attestation
-- capability_checkout_declared needs to correctly return not_applicable
-- (dropped from the denominator) instead of fail, when a merchant has
-- deliberately adopted the UCP-sanctioned catalog+cart-only profile —
-- payment handled via continue_url handoff to the merchant's own checkout,
-- never declaring or implementing the UCP checkout capability.
--
-- Same shape and same reasoning as identity_linking_opt_out
-- (20260706000000_no_manifest_status_and_identity_linking_opt_out.sql):
-- the manifest alone can't distinguish "deliberately chose the handoff
-- profile" from "hasn't declared checkout yet" — that's merchant intent,
-- not something derivable from the manifest's shape. Requiring an explicit
-- attestation (rather than inferring it from ctx.platform or from the
-- presence of a cart capability) keeps the signal's not_applicable status
-- tied to a merchant decision, never to which artifact Adeptra generated.
-- =============================================================================

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS checkout_handoff_opt_in BOOLEAN NOT NULL DEFAULT false;
