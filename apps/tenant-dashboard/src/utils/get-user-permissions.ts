"use server";

import { createSupabaseAdminClient } from "../supabaseAdminClient";
import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "../lib/tenant/request-tenant";

/**
 * Get permissions for the user's role in their active tenant.
 * Reads the role from the membership table and resolves the tenant from the
 * request (the URL org the middleware derived). No request tenant means no
 * permissions.
 */
export async function getCurrentUserPermissions() {
  const requestTenantId = await getRequestTenantId();
  const supabaseServer = await createSupabaseServerClient(requestTenantId);
  const {
    data: { user },
  } = await supabaseServer.auth.getUser();

  if (!user) return [];

  const activeTenantId = requestTenantId;
  if (!activeTenantId) return [];

  const supabase = createSupabaseAdminClient();

  // Read role + custom_role_id from membership (always current source of truth)
  const { data: membership } = await supabase
    .from("membership")
    .select("role, custom_role_id")
    .eq("user_id", user.id)
    .eq("tenant_id", activeTenantId)
    .eq("status", "active")
    .single();

  if (!membership) return [];

  // Custom role: load permissions from custom_role_permission
  if (membership.custom_role_id) {
    const { data: customPerms } = await supabase
      .from("custom_role_permission")
      .select("custom_role_id, permission")
      .eq("custom_role_id", membership.custom_role_id);

    return (customPerms || []).map((p) => ({
      id: p.custom_role_id,
      role: membership.role,
      permission: p.permission,
    }));
  }

  // Built-in role: load from role_permissions
  const { data } = await supabase
    .from("role_permissions")
    .select("*")
    .match({ role: membership.role });

  return data || [];
}
