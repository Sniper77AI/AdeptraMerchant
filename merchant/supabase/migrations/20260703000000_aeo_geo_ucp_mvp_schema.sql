-- =============================================================================
-- AEO / GEO / AGENT-READABILITY / UCP  —  MVP FOUNDATIONAL SCHEMA
-- PostgreSQL (Supabase) with membership-based Row-Level Security.
--
-- DESIGN PRINCIPLES (why this schema looks the way it does):
--   1. `signals` is the single source of truth. Every score, plan item, and
--      artifact is DERIVED from signals — we never store a computed score we
--      cannot explain back to the row that produced it.
--   2. `analysis_runs` are IMMUTABLE. Re-running an analysis creates a new run,
--      which is what gives us free score-over-time / trend history per site.
--   3. Multi-tenant isolation is done via a MEMBERSHIP table + SECURITY DEFINER
--      helper functions. This schema NEVER trusts JWT app_metadata/user_metadata
--      for authorization (that pattern is a known privilege-escalation footgun).
--      Backend pipeline workers (n8n) use the Supabase SERVICE ROLE, which
--      bypasses RLS; client-facing dashboard reads are membership-scoped.
--   4. Enumerations use TEXT + CHECK (not native ENUM) on purpose: the AEO/GEO/UCP
--      standards move monthly, and adding an allowed value to a CHECK is far
--      cheaper than altering an enum type.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- Shared helper: keep updated_at fresh
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- TENANCY
-- =============================================================================

-- A `client` is a tenant of the SaaS (an agency or business you serve).
CREATE TABLE IF NOT EXISTS public.clients (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Links Supabase auth users to clients. This is the ONLY basis for access.
CREATE TABLE IF NOT EXISTS public.client_members (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    auth_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, auth_user_id)
);
CREATE INDEX IF NOT EXISTS idx_client_members_user ON public.client_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_client_members_client ON public.client_members(client_id);

-- Billing/plan tier. Subscription is the default product; one_time is the
-- "audit, generate, install, export, you own it" snapshot tier. Per-site so a
-- client can mix (some sites subscribed, some one-time).
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    site_id             UUID,  -- FK added after sites table exists
    tier                TEXT NOT NULL DEFAULT 'subscription'
                          CHECK (tier IN ('subscription', 'one_time')),
    status              TEXT NOT NULL DEFAULT 'trialing'
                          CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
    started_at          TIMESTAMPTZ,
    current_period_end  TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_client ON public.subscriptions(client_id);


-- =============================================================================
-- SITES & COMPETITORS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sites (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    root_url      TEXT NOT NULL,
    domain        TEXT,
    platform      TEXT,                          -- detected: shopify, woocommerce, webflow, custom, ...
    is_ecommerce  BOOLEAN NOT NULL DEFAULT false, -- drives whether UCP pillar applies
    edge_status   TEXT NOT NULL DEFAULT 'none'
                    CHECK (edge_status IN ('none', 'pending', 'active', 'error', 'disabled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, root_url)
);
CREATE INDEX IF NOT EXISTS idx_sites_client ON public.sites(client_id);

-- Now that sites exists, wire the subscriptions.site_id FK.
ALTER TABLE public.subscriptions
    ADD CONSTRAINT fk_subscriptions_site
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_subscriptions_site ON public.subscriptions(site_id);

-- Competitors captured at onboarding (3-5 per site) for share-of-voice tracking.
CREATE TABLE IF NOT EXISTS public.competitors (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id     UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    domain      TEXT,
    added_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitors_site ON public.competitors(site_id);


-- =============================================================================
-- ANALYSIS RUNS  (immutable)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analysis_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id             UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'complete', 'failed')),
    overall_score       NUMERIC(5,2),                 -- 0-100, null until scored
    is_ecommerce_at_run BOOLEAN NOT NULL DEFAULT false, -- snapshot: was UCP scored this run
    cost_cents          INTEGER NOT NULL DEFAULT 0,     -- LLM/infra cost accounting per run
    model_versions      JSONB,                          -- which models were used, for reproducibility
    error_detail        TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_site_created ON public.analysis_runs(site_id, created_at DESC);

-- Sampled pages fetched during a run (page-template sampling, not full crawl).
CREATE TABLE IF NOT EXISTS public.crawl_snapshots (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID NOT NULL REFERENCES public.analysis_runs(id) ON DELETE CASCADE,
    url                   TEXT NOT NULL,
    http_status           INTEGER,
    was_rendered          BOOLEAN NOT NULL DEFAULT false, -- true if headless-render fallback was used
    page_template         TEXT,                            -- detected template cluster (product, article, ...)
    content_storage_path  TEXT,                            -- raw HTML in Supabase Storage
    extracted_json        JSONB,                           -- parsed schema, meta, commerce data
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON public.crawl_snapshots(run_id);


-- =============================================================================
-- SIGNALS  (the heart — everything derives from here)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID NOT NULL REFERENCES public.analysis_runs(id) ON DELETE CASCADE,
    pillar              TEXT NOT NULL
                          CHECK (pillar IN ('aeo_geo', 'agent_readability', 'ucp')),
    category            TEXT NOT NULL,          -- e.g. 'crawl_access', 'structured_data', 'compared'
    signal_key          TEXT NOT NULL,          -- stable machine key, e.g. 'robots_allows_gptbot'
    status              TEXT NOT NULL
                          CHECK (status IN ('pass', 'partial', 'fail', 'not_applicable')),
    weight              NUMERIC(6,3) NOT NULL DEFAULT 1.0,  -- contribution weight within its pillar
    score_contribution  NUMERIC(6,3) NOT NULL DEFAULT 0,    -- points actually earned (pass/partial)
    impact              INTEGER NOT NULL DEFAULT 3 CHECK (impact BETWEEN 1 AND 5),
    effort              INTEGER NOT NULL DEFAULT 3 CHECK (effort BETWEEN 1 AND 5),
    -- ROI ordering falls out of the data; the plan is auto-prioritised, not hand-curated.
    priority_score      NUMERIC(8,3) GENERATED ALWAYS AS
                          ((impact * weight) / GREATEST(effort, 1)) STORED,
    evidence_json       JSONB,                  -- the actual proof: the robots line, missing property, URL
    fix_summary         TEXT,                   -- human-readable "what to do"
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_run ON public.signals(run_id);
CREATE INDEX IF NOT EXISTS idx_signals_run_pillar ON public.signals(run_id, pillar);
CREATE INDEX IF NOT EXISTS idx_signals_priority ON public.signals(run_id, priority_score DESC)
    WHERE status IN ('fail', 'partial');

-- Denormalised per-pillar rollups for fast dashboard reads.
CREATE TABLE IF NOT EXISTS public.pillar_scores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES public.analysis_runs(id) ON DELETE CASCADE,
    pillar          TEXT NOT NULL
                      CHECK (pillar IN ('aeo_geo', 'agent_readability', 'ucp')),
    score           NUMERIC(5,2) NOT NULL,      -- 0-100, N/A signals excluded from denominator
    signals_passed  INTEGER NOT NULL DEFAULT 0,
    signals_total   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, pillar)
);


-- =============================================================================
-- ARTIFACTS, DEPLOYMENTS, RE-CRAWL INVITATIONS
-- =============================================================================

-- Generated fixes. Each links back to the signal(s) it resolves (traceability).
CREATE TABLE IF NOT EXISTS public.artifacts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID NOT NULL REFERENCES public.analysis_runs(id) ON DELETE CASCADE,
    site_id               UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE, -- denormalised for export
    artifact_type         TEXT NOT NULL
                            CHECK (artifact_type IN
                              ('jsonld', 'llms_txt', 'ucp_manifest', 'feed_fix',
                               'content_rewrite', 'robots_patch')),
    target_url            TEXT,
    content               TEXT,                   -- inline artifact body (small)
    content_storage_path  TEXT,                   -- or a Storage ref (large)
    resolves_signal_ids   UUID[],                 -- which signals this fixes
    deploy_status         TEXT NOT NULL DEFAULT 'draft'
                            CHECK (deploy_status IN ('draft', 'ready', 'deployed', 'stale')),
    is_exportable         BOOLEAN NOT NULL DEFAULT true, -- "you're never locked in"
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON public.artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_site ON public.artifacts(site_id);

-- How each artifact went live.
CREATE TABLE IF NOT EXISTS public.deployments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id   UUID NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
    site_id       UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    method        TEXT NOT NULL
                    CHECK (method IN ('edge', 'snippet', 'plugin', 'manual', 'api')),
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'live', 'failed', 'rolled_back')),
    detail_json   JSONB,
    deployed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deployments_site ON public.deployments(site_id);

-- Re-crawl invitations: the maximal automation of the crawl-lag stage.
-- We can invite (IndexNow, sitemap ping, engine submit) but cannot force indexing.
CREATE TABLE IF NOT EXISTS public.recrawl_invitations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    engine        TEXT NOT NULL
                    CHECK (engine IN ('indexnow', 'google', 'bing', 'sitemap_ping', 'generic')),
    endpoint      TEXT,
    status        TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted', 'accepted', 'failed')),
    response_json JSONB,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recrawl_site ON public.recrawl_invitations(site_id);


-- =============================================================================
-- EDGE LAYER
-- =============================================================================

-- Drives what the edge runtime (Cloudflare Worker) serves for each site.
-- HARD RULE (enforced in edge code, documented here): the edge serves ENRICHED
-- versions of the SAME content — never divergent claims. Augmentation, not cloaking.
CREATE TABLE IF NOT EXISTS public.edge_configs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id            UUID NOT NULL UNIQUE REFERENCES public.sites(id) ON DELETE CASCADE,
    edge_hostname      TEXT,
    delegation_method  TEXT
                         CHECK (delegation_method IN ('cname', 'subdomain', 'proxy', 'worker')),
    bot_rules_json     JSONB,     -- which bots get which treatment
    serve_rules_json   JSONB,     -- which paths (/llms.txt, /.well-known/*, ...) map to which artifacts
    status             TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'active', 'error', 'disabled')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================================================
-- VISIBILITY / COMPETITOR SHARE-OF-VOICE
-- =============================================================================

-- Raw probes. We probe each query N times per engine because results are
-- PROBABILISTIC — we report frequency, not a single snapshot. cited_brands_json
-- stores the FULL set of brands named, so competitors can be added later and
-- history recomputed without re-probing.
CREATE TABLE IF NOT EXISTS public.visibility_probes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id               UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    engine                TEXT NOT NULL
                            CHECK (engine IN ('chatgpt', 'gemini', 'perplexity', 'google_ai_mode', 'claude')),
    query                 TEXT NOT NULL,
    probe_index           INTEGER NOT NULL DEFAULT 0,   -- which of the N repeats
    client_cited          BOOLEAN,
    cited_brands_json     JSONB,                         -- full set of brands the engine named
    response_storage_path TEXT,
    run_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_probes_site_engine ON public.visibility_probes(site_id, engine, run_at DESC);

-- Computed share-of-voice per period. SoV = client mentions / (client + tracked
-- competitor mentions); rank orders client among tracked competitors.
CREATE TABLE IF NOT EXISTS public.visibility_scores (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id                  UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    period_start             DATE NOT NULL,
    period_end               DATE NOT NULL,
    engine                   TEXT NOT NULL DEFAULT 'aggregate', -- per-engine or 'aggregate'
    share_of_voice           NUMERIC(5,2),        -- 0-100
    rank                     INTEGER,             -- client's rank among tracked set (1 = most cited)
    competitor_breakdown_json JSONB,              -- per-brand mention counts
    probes_count             INTEGER NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (site_id, period_start, engine)
);


-- =============================================================================
-- EXPORTS  ("you're never locked in")
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.exports (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id              UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    bundle_storage_path  TEXT,                    -- zipped artifacts in Storage
    reason               TEXT NOT NULL DEFAULT 'client_request'
                           CHECK (reason IN ('client_request', 'cancellation', 'periodic')),
    artifact_count       INTEGER NOT NULL DEFAULT 0,
    created_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exports_site ON public.exports(site_id);


-- =============================================================================
-- updated_at TRIGGERS
-- =============================================================================
CREATE TRIGGER trg_clients_updated       BEFORE UPDATE ON public.clients        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON public.subscriptions  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_sites_updated         BEFORE UPDATE ON public.sites          FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_artifacts_updated     BEFORE UPDATE ON public.artifacts      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_edge_configs_updated  BEFORE UPDATE ON public.edge_configs   FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- ACCESS HELPERS  (SECURITY DEFINER — never trust JWT metadata for authz)
-- =============================================================================

-- Client IDs the current auth user belongs to.
CREATE OR REPLACE FUNCTION public.user_client_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT client_id FROM public.client_members WHERE auth_user_id = auth.uid();
$$;

-- Site IDs the current auth user can see (via client membership).
CREATE OR REPLACE FUNCTION public.user_site_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM public.sites WHERE client_id IN (SELECT public.user_client_ids());
$$;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
ALTER TABLE public.clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crawl_snapshots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pillar_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recrawl_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_configs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visibility_probes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visibility_scores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exports             ENABLE ROW LEVEL SECURITY;

-- NOTE ON WRITES: the n8n pipeline uses the SERVICE ROLE, which bypasses RLS.
-- The policies below govern the client-facing (authenticated) app only.
-- Immutability of analysis_runs/signals/etc. for clients is enforced by simply
-- granting no UPDATE/DELETE policy to authenticated users on those tables.

-- clients: members can read their clients. Creation/rename via backend (service role).
CREATE POLICY clients_select ON public.clients FOR SELECT
    USING (id IN (SELECT public.user_client_ids()));

-- client_members: members read the roster; only existing owner/admin can add members.
-- (First owner is bootstrapped by the backend via service role, avoiding the
--  chicken-and-egg self-insert hole.)
CREATE POLICY members_select ON public.client_members FOR SELECT
    USING (client_id IN (SELECT public.user_client_ids()));
CREATE POLICY members_insert ON public.client_members FOR INSERT
    WITH CHECK (client_id IN (
        SELECT client_id FROM public.client_members
        WHERE auth_user_id = auth.uid() AND role IN ('owner', 'admin')
    ));

-- subscriptions: read-only for clients; billing writes via service role.
CREATE POLICY subs_select ON public.subscriptions FOR SELECT
    USING (client_id IN (SELECT public.user_client_ids()));

-- sites: members read/create/update/delete sites in their clients.
CREATE POLICY sites_select ON public.sites FOR SELECT
    USING (client_id IN (SELECT public.user_client_ids()));
CREATE POLICY sites_insert ON public.sites FOR INSERT
    WITH CHECK (client_id IN (SELECT public.user_client_ids()));
CREATE POLICY sites_update ON public.sites FOR UPDATE
    USING (client_id IN (SELECT public.user_client_ids()))
    WITH CHECK (client_id IN (SELECT public.user_client_ids()));
CREATE POLICY sites_delete ON public.sites FOR DELETE
    USING (client_id IN (SELECT public.user_client_ids()));

-- competitors: members manage them.
CREATE POLICY competitors_select ON public.competitors FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY competitors_insert ON public.competitors FOR INSERT
    WITH CHECK (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY competitors_update ON public.competitors FOR UPDATE
    USING (site_id IN (SELECT public.user_site_ids()))
    WITH CHECK (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY competitors_delete ON public.competitors FOR DELETE
    USING (site_id IN (SELECT public.user_site_ids()));

-- analysis_runs: members read; may create (trigger an analysis). No update/delete
-- policy => immutable from the client side.
CREATE POLICY runs_select ON public.analysis_runs FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY runs_insert ON public.analysis_runs FOR INSERT
    WITH CHECK (site_id IN (SELECT public.user_site_ids()));

-- Read-only derived data (written by service role only).
CREATE POLICY snapshots_select ON public.crawl_snapshots FOR SELECT
    USING (run_id IN (SELECT id FROM public.analysis_runs WHERE site_id IN (SELECT public.user_site_ids())));
CREATE POLICY signals_select ON public.signals FOR SELECT
    USING (run_id IN (SELECT id FROM public.analysis_runs WHERE site_id IN (SELECT public.user_site_ids())));
CREATE POLICY pillar_scores_select ON public.pillar_scores FOR SELECT
    USING (run_id IN (SELECT id FROM public.analysis_runs WHERE site_id IN (SELECT public.user_site_ids())));

-- artifacts / deployments / recrawl: members read; deploy actions go through backend.
CREATE POLICY artifacts_select ON public.artifacts FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY deployments_select ON public.deployments FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY recrawl_select ON public.recrawl_invitations FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));

-- edge_configs: members read + update (edit serve/bot rules); create via backend.
CREATE POLICY edge_select ON public.edge_configs FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY edge_update ON public.edge_configs FOR UPDATE
    USING (site_id IN (SELECT public.user_site_ids()))
    WITH CHECK (site_id IN (SELECT public.user_site_ids()));

-- visibility: read-only for clients (probing/scoring is service role).
CREATE POLICY probes_select ON public.visibility_probes FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY vscores_select ON public.visibility_scores FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));

-- exports: members read + request.
CREATE POLICY exports_select ON public.exports FOR SELECT
    USING (site_id IN (SELECT public.user_site_ids()));
CREATE POLICY exports_insert ON public.exports FOR INSERT
    WITH CHECK (site_id IN (SELECT public.user_site_ids()));

-- =============================================================================
-- END
-- =============================================================================
