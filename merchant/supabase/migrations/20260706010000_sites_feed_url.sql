-- =============================================================================
-- Category 2 (Product Data Hygiene) onboarding input: the merchant's product
-- feed URL (Google Merchant XML or Shopify products.json). NULL by default —
-- no feed provided means feed_available and its dependent signals correctly
-- score not_applicable rather than fail (see signal-specs.md Category 2).
-- =============================================================================

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS feed_url TEXT;
