import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { listTenantMembers, type TenantMember } from "@/lib/system";

/** The members list read for one tenant — active + pending only. */
export async function listMembers(tenantId: string): Promise<TenantMember[]> {
  return listTenantMembers(tenantId);
}

interface AppOption {
  id: string;
  name: string;
}

/**
 * The tenant's apps, for the invite modal's per-app role assignment picker.
 * RLS `app.read`-scoped (the request-tenant client `db` already carries) —
 * no admin authority needed, unlike the members list itself.
 */
export async function listAppsForInvite(db: SupabaseClient): Promise<AppOption[]> {
  const { data } = await db.from("app").select("id, name").order("name");
  return (data ?? []) as AppOption[];
}
