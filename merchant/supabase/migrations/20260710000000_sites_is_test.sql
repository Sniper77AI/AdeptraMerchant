ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.sites.is_test IS 'True for internal test/dev sites
(placeholder domains, platforms set to exercise code paths). Exclude from
dashboards, analytics, and customer-facing views. Real merchant sites are never
marked true.';
CREATE INDEX IF NOT EXISTS idx_sites_is_test ON public.sites(is_test) WHERE is_test = true;
