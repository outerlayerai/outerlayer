import "server-only";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";
import type { AppMemberRole } from "@/types/app-member-role";

export interface AppMemberRoleRow {
  id: string;
  membershipId: string;
  appId: string;
  appName: string;
  role: AppMemberRole | null;
  memberName: string;
  memberEmail: string;
  createdAt: string;
  updatedAt: string | null;
}

function adminClient() {
  return createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Per-app role assignments for a tenant, optionally narrowed to one
 * membership or app. A member cannot read a peer's `profile` row (or,
 * app-scoped, another member's `membership` row) under RLS, so this is a
 * genuine admin need. PostgREST can't resolve a nested join this deep
 * (app_member_role → membership → profile), so — mirroring
 * `listTenantMembers` — the membership, app, and profile rows are fetched
 * flat and joined in TypeScript instead of embedded in the select.
 */
export async function listAppMemberRoles(
  tenantId: string,
  filters?: { membershipId?: string; appId?: string },
): Promise<{ data: AppMemberRoleRow[] } | { error: string }> {
  const admin = adminClient();

  let query = admin
    .from("app_member_role")
    .select("id, membership_id, app_id, role, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (filters?.membershipId) query = query.eq("membership_id", filters.membershipId);
  if (filters?.appId) query = query.eq("app_id", filters.appId);

  const { data, error } = await query;
  if (error) return { error: error.message };
  const rows = data ?? [];
  if (rows.length === 0) return { data: [] };

  const membershipIds = [...new Set(rows.map((r) => r.membership_id))];
  const { data: memberships } = await admin.from("membership").select("id, user_id").in("id", membershipIds);
  const membershipMap = new Map((memberships ?? []).map((m) => [m.id, m.user_id]));

  // Apps are fetched by tenant (not `.in('id', appIds)` — PostgREST's `in.()`
  // filter isn't the seam being exercised here) since every app_member_role
  // row already belongs to this tenant.
  const { data: apps } = await admin.from("app").select("id, name").eq("tenant_id", tenantId);
  const appNameMap = new Map((apps ?? []).map((a) => [a.id, a.name]));

  const userIds = [...new Set([...membershipMap.values()])];
  const profileMap = new Map<string, { name: string | null; email: string }>();
  if (userIds.length > 0) {
    const { data: profiles } = await admin.from("profile").select("id, name, email").in("id", userIds);
    for (const p of profiles ?? []) profileMap.set(p.id, { name: p.name, email: p.email });
  }

  return {
    data: rows.map((row) => {
      const userId = membershipMap.get(row.membership_id) ?? "";
      const profile = profileMap.get(userId);
      return {
        id: row.id,
        membershipId: row.membership_id,
        appId: row.app_id,
        appName: appNameMap.get(row.app_id) ?? "",
        // The column reuses the org-level `app_role` enum (owner/disabled
        // included); app-level assignment only ever writes read/write/admin.
        role: row.role as AppMemberRole | null,
        memberName: profile?.name ?? "",
        memberEmail: profile?.email ?? "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  };
}

/** Apps in a tenant, for the app-access assignment dropdown. */
export async function listAppsForDropdown(
  tenantId: string,
): Promise<{ data: Array<{ appId: string; name: string }> } | { error: string }> {
  const admin = adminClient();
  const { data, error } = await admin.from("app").select("id, name").eq("tenant_id", tenantId).order("name");
  if (error) return { error: error.message };
  return { data: (data ?? []).map((a) => ({ appId: a.id, name: a.name })) };
}

/** Whether a membership is restricted to explicitly-granted apps. */
export async function getMembershipAppScoped(
  tenantId: string,
  membershipId: string,
): Promise<{ data: { isAppScoped: boolean } } | { error: string }> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("membership")
    .select("is_app_scoped")
    .eq("id", membershipId)
    .eq("tenant_id", tenantId)
    .single();
  if (error) return { error: error.message };
  return { data: { isAppScoped: data?.is_app_scoped ?? false } };
}
