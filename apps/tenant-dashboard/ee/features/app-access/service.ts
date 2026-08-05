import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { listAppMemberRoles, listAppsForDropdown, getMembershipAppScoped } from "@/lib/system";
import { AppMemberRoleService } from "./app-member-role-service";
import type { AppMemberRole } from "@/types/app-member-role";

/**
 * `AppMemberRoleService` only ever runs under admin authority (it always
 * received `createSupabaseAdminClient()` pre-migration too) — a member
 * cannot read or write a peer's per-app role under RLS.
 */
function service(actorId: string): AppMemberRoleService {
  return new AppMemberRoleService({ db: getAdminDataClient() as SupabaseClient, actorId });
}

export async function assignAppRole(
  tenantId: string,
  actorId: string,
  membershipId: string,
  appId: string,
  role: AppMemberRole,
) {
  return service(actorId).assign(tenantId, { membershipId, appId, role });
}

export async function updateAppRole(tenantId: string, actorId: string, appMemberRoleId: string, role: AppMemberRole) {
  return service(actorId).updateRole(tenantId, appMemberRoleId, role);
}

export async function assignAppCustomRole(
  tenantId: string,
  actorId: string,
  membershipId: string,
  appId: string,
  customRoleId: string,
) {
  return service(actorId).assignCustomRole(tenantId, { membershipId, appId, role: "read", customRoleId });
}

export async function updateAppCustomRole(
  tenantId: string,
  actorId: string,
  appMemberRoleId: string,
  customRoleId: string,
) {
  return service(actorId).updateCustomRole(tenantId, appMemberRoleId, customRoleId);
}

export async function revokeAppRole(tenantId: string, actorId: string, appMemberRoleId: string) {
  return service(actorId).revoke(tenantId, appMemberRoleId);
}

export async function setAppScoped(tenantId: string, actorId: string, membershipId: string, isAppScoped: boolean) {
  return service(actorId).setAppScoped(tenantId, membershipId, isAppScoped);
}

export async function bulkAssignAppRoles(
  tenantId: string,
  actorId: string,
  membershipId: string,
  assignments: Array<{ appId: string; role: AppMemberRole }>,
) {
  return service(actorId).bulkAssign(tenantId, { membershipId, assignments });
}

export async function listAppRoles(tenantId: string, filters?: { membershipId?: string; appId?: string }) {
  return listAppMemberRoles(tenantId, filters);
}

export async function listApps(tenantId: string) {
  return listAppsForDropdown(tenantId);
}

export async function getAppScopedStatus(tenantId: string, membershipId: string) {
  return getMembershipAppScoped(tenantId, membershipId);
}
