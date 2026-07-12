import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * UI-ONLY entitlement read — mirrors the exact criteria documented in
 * merchant/ucp/pipeline.ts's isEntitled() docstring ("status IN
 * ('trialing','active'), or tier='one_time'"), but does NOT touch that
 * function or replace it as the real gate. isEntitled() is currently a
 * STUB that always returns true (its own comment: "Do not build that query
 * yet") — that instruction is about the SERVER's enforcement path; this is
 * a read-only query against subscriptions via the user's own RLS session
 * (subs_select: client_id IN user_client_ids()), used only to decide which
 * of two UI states to show. It has zero enforcement power — the bundle
 * proxy route's own isEntitled() call is the sole real gate (402 when
 * false), and this dashboard read must never be treated as bypassing it.
 *
 * "One source of truth": no subscriptions rows exist for any client today
 * (billing doesn't exist yet), so this always evaluates false right now —
 * "locked by default" falls out of real (currently empty) data, not a
 * hardcoded stub. When billing lands and isEntitled() itself is upgraded to
 * implement this same query server-side, both sides already derive from
 * identical criteria against the same table, so they can't drift.
 */
export async function checkEntitlementRLS(supabase: SupabaseClient, clientId: string, siteId: string): Promise<boolean> {
  const { data } = await supabase
    .from("subscriptions")
    .select("id, tier, status, site_id")
    .eq("client_id", clientId)
    .in("status", ["trialing", "active"])
    .returns<Array<{ id: string; tier: string; status: string; site_id: string | null }>>();

  if (!data || data.length === 0) return false;
  // A client-wide subscription (site_id IS NULL) covers every site; a
  // site-scoped one only covers that site.
  return data.some((row) => row.site_id === null || row.site_id === siteId);
}
