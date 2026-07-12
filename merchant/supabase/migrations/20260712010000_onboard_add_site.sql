-- =============================================================================
-- onboard_add_site(): the atomic dashboard-onboarding bootstrap function.
--
-- WHY THIS MUST BE SECURITY DEFINER (confirmed, not assumed): `clients` has NO
-- INSERT policy at all under RLS — no authenticated role can ever insert a
-- client row through normal RLS. `client_members`'s INSERT policy
-- (members_insert) requires the inserting user to ALREADY be an owner/admin
-- member of that client_id — impossible for a brand-new client's first-ever
-- membership row (nobody is a member yet). This is the exact "chicken-and-egg
-- self-insert hole" this schema's own original migration comment already
-- flagged next to members_select: "First owner is bootstrapped by the backend
-- via service role, avoiding the chicken-and-egg self-insert hole." This
-- function IS that bootstrap path — the only one that can exist, given the
-- policies above.
--
-- Mirrors user_client_ids()/user_site_ids()'s exact hardening: SECURITY
-- DEFINER + SET search_path = public (closes the search_path escalation
-- hole a SECURITY DEFINER function is otherwise vulnerable to). Reads
-- auth.uid() itself — the caller NEVER passes a user id, so membership can
-- never be spoofed to point at someone else's account.
--
-- Re-onboarding an existing (client_id, root_url) UPDATEs in place rather
-- than rejecting or duplicating — matches supabaseSink.ts's upsertIntakeSite
-- precedent (the existing real-intake path) exactly: a resubmission is a
-- real edit (changed platform/feed/opt-outs), not a no-op or an error.
--
-- One client per user for v1: looks up via client_members LIMIT 1. The
-- schema's UNIQUE(client_id, auth_user_id) technically permits a user to
-- belong to multiple clients, but onboarding only ever creates/uses one —
-- matches the spec's "returning users skip client creation" behavior.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.onboard_add_site(
    p_root_url text,
    p_platform text,
    p_feed_url text,
    p_identity_linking_opt_out boolean,
    p_checkout_handoff_opt_in boolean,
    p_ai_training_opt_out boolean,
    p_client_name text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid uuid;
    v_client_id uuid;
    v_domain text;
    v_site_id uuid;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'onboard_add_site: must be authenticated';
    END IF;

    IF p_root_url IS NULL OR btrim(p_root_url) = '' THEN
        RAISE EXCEPTION 'onboard_add_site: p_root_url is required';
    END IF;

    -- host[:port] portion of the URL, lowercased — same convention as the
    -- rest of sites.domain (e.g. "skims.com"). Callers are expected to pass
    -- an already-normalized root_url (scheme + host only, no trailing slash
    -- or path — the dashboard derives this via URL.origin before calling),
    -- but this derivation degrades gracefully (returns the input unchanged)
    -- rather than raising if that norm doesn't hold.
    v_domain := lower(regexp_replace(p_root_url, '^[a-zA-Z]+://([^/]+).*$', '\1'));

    -- This user's existing client, if any. No client_members INSERT policy
    -- permits a non-owner/admin to add themselves, so a brand-new user has
    -- no way to reach this function with a spoofed v_client_id — the lookup
    -- is keyed on v_uid, resolved from auth.uid() above, never from input.
    SELECT client_id INTO v_client_id
    FROM public.client_members
    WHERE auth_user_id = v_uid
    LIMIT 1;

    IF v_client_id IS NULL THEN
        INSERT INTO public.clients (name)
        VALUES (COALESCE(NULLIF(btrim(p_client_name), ''), v_domain))
        RETURNING id INTO v_client_id;

        INSERT INTO public.client_members (client_id, auth_user_id, role)
        VALUES (v_client_id, v_uid, 'owner');
    END IF;

    SELECT id INTO v_site_id
    FROM public.sites
    WHERE client_id = v_client_id AND root_url = p_root_url;

    IF v_site_id IS NULL THEN
        INSERT INTO public.sites (
            client_id, root_url, domain, platform, feed_url, is_ecommerce,
            identity_linking_opt_out, checkout_handoff_opt_in, ai_training_opt_out
        ) VALUES (
            v_client_id, p_root_url, v_domain, p_platform, NULLIF(btrim(p_feed_url), ''), true,
            COALESCE(p_identity_linking_opt_out, false),
            COALESCE(p_checkout_handoff_opt_in, false),
            COALESCE(p_ai_training_opt_out, false)
        )
        RETURNING id INTO v_site_id;
    ELSE
        UPDATE public.sites SET
            platform = p_platform,
            feed_url = NULLIF(btrim(p_feed_url), ''),
            identity_linking_opt_out = COALESCE(p_identity_linking_opt_out, false),
            checkout_handoff_opt_in = COALESCE(p_checkout_handoff_opt_in, false),
            ai_training_opt_out = COALESCE(p_ai_training_opt_out, false)
        WHERE id = v_site_id;
    END IF;

    RETURN v_site_id;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC by default on function creation — revoke
-- that and grant only to authenticated. anon must never be able to call a
-- privilege-escalating write function; only genuinely logged-in users may.
REVOKE ALL ON FUNCTION public.onboard_add_site(text, text, text, boolean, boolean, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.onboard_add_site(text, text, text, boolean, boolean, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.onboard_add_site IS
  'Atomic dashboard onboarding: bootstraps (client + owner membership) on a '
  'user''s first site, or reuses their existing client; upserts the site by '
  '(client_id, root_url). SECURITY DEFINER because clients has no INSERT '
  'policy and client_members INSERT requires pre-existing owner/admin '
  'membership — this is the only way to create a user''s first client.';
