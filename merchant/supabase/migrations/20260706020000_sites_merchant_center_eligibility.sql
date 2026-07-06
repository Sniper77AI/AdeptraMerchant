-- =============================================================================
-- Category 6 (Merchant Center Eligibility) is entirely self-attested — there's
-- nothing to fetch or observe. These onboarding-level attestation fields feed
-- readinessChecks.ts. NULL means "not attested yet" -> not_applicable, not fail
-- (same convention as sites.identity_linking_opt_out).
-- =============================================================================

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS merchant_center_account_ready BOOLEAN, -- NULL = not attested yet
    ADD COLUMN IF NOT EXISTS merchant_center_feeds_configured BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ucp_early_access_status TEXT
        CHECK (ucp_early_access_status IN ('not_applied', 'pending', 'approved')); -- NULL = not attested yet
