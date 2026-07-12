-- =============================================================================
-- onboard_add_site() still had EXECUTE granted to `anon`, despite the prior
-- migration's REVOKE ALL ... FROM PUBLIC. Root cause (confirmed via
-- pg_default_acl, not assumed): Supabase's platform-level ALTER DEFAULT
-- PRIVILEGES grants EXECUTE directly to anon/authenticated/service_role on
-- every new function created in the public schema — a grant to each role
-- individually, not routed through the PUBLIC pseudo-role, so REVOKE ... FROM
-- PUBLIC never touched it. anon must never be able to call a privilege-
-- escalating write function (the function's own auth.uid() IS NULL check
-- would still reject an anon call at runtime, but the grant-level boundary
-- should match that intent directly, not rely solely on the runtime check).
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.onboard_add_site(text, text, text, boolean, boolean, boolean, text) FROM anon;
