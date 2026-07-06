-- =============================================================================
-- Clears two "known shortcuts" surfaced by the first live runs (skims.com,
-- gymshark.com) — see README "Open items / known shortcuts".
--
--   1. analysis_runs.status gains 'no_manifest': a store with no reachable
--      /.well-known/ucp is a distinct outcome from a store that scores a
--      genuine 0%. The pipeline now marks these runs 'no_manifest' with
--      overall_score left NULL, instead of 'complete' with overall_score 0.00.
--
--   2. sites.identity_linking_opt_out: the onboarding-level flag the
--      capability_identity_linking_declared signal needs to correctly return
--      not_applicable (dropped from the denominator) instead of fail when a
--      merchant opts out of account linking by design.
-- =============================================================================

ALTER TABLE public.analysis_runs DROP CONSTRAINT analysis_runs_status_check;
ALTER TABLE public.analysis_runs ADD CONSTRAINT analysis_runs_status_check
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'no_manifest'));

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS identity_linking_opt_out BOOLEAN NOT NULL DEFAULT false;
