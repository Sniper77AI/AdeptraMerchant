-- =============================================================================
-- sites.ai_training_opt_out: the onboarding-level attestation that lets
-- agent_readability's crawler-access signals correctly return not_applicable
-- (dropped from the denominator) instead of fail, when a merchant has
-- deliberately blocked GPTBot/ClaudeBot (and similar training-purpose
-- crawlers) from their site to keep content out of AI model training.
--
-- Same shape and same reasoning as identity_linking_opt_out and
-- checkout_handoff_opt_in: robots.txt alone can't distinguish "deliberately
-- opted out of AI training" from "misconfigured and blocking everything by
-- accident" — that's merchant intent, not something derivable from the
-- robots.txt rules themselves. Requiring an explicit attestation keeps the
-- signal's not_applicable status tied to a merchant decision, never inferred.
-- =============================================================================

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS ai_training_opt_out BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sites.ai_training_opt_out IS
  'Merchant attestation: true when the merchant has deliberately blocked '
  'AI-training-purpose crawlers (GPTBot, ClaudeBot, etc.) via robots.txt to '
  'keep their content out of AI model training. This is a legitimate business '
  'decision, never inferred from robots.txt contents alone — when true, '
  'ai_crawler_access_training returns not_applicable instead of fail.';
