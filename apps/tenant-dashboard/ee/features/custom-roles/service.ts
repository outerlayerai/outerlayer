import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { CustomRoleService } from "./custom-role-service";
import type {
  CreateCustomRoleInput,
  UpdateCustomRoleInput,
  CustomRoleWithPermissions,
  CustomRoleDetail,
} from "@/types/custom-role";

/**
 * Constructs `CustomRoleService` with the request's RLS-scoped `ctx.db` plus
 * the confined admin client from `lib/system` — the service's own writes
 * (`custom_role`/`custom_role_permission`) go through `db`, while membership
 * counting, fallback reassignment, the entitlement gate, and audit rows need
 * admin authority a member cannot hold under RLS.
 */
function service(db: SupabaseClient, actorId?: string): CustomRoleService {
  return new CustomRoleService({ db, adminDb: getAdminDataClient() as SupabaseClient, actorId });
}

export async function listCustomRoles(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ success: true; data: CustomRoleWithPermissions[] } | { success: false; error: string }> {
  return service(db).getAll(tenantId);
}

export async function getCustomRole(
  db: SupabaseClient,
  tenantId: string,
  roleId: string,
): Promise<{ success: true; data: CustomRoleDetail } | { success: false; error: string }> {
  return service(db).getById(tenantId, roleId);
}

export async function createCustomRole(
  db: SupabaseClient,
  tenantId: string,
  actorId: string,
  input: CreateCustomRoleInput,
) {
  return service(db, actorId).create(tenantId, input);
}

export async function updateCustomRole(
  db: SupabaseClient,
  tenantId: string,
  actorId: string,
  roleId: string,
  input: UpdateCustomRoleInput,
) {
  return service(db, actorId).update(tenantId, roleId, input);
}

export async function deleteCustomRole(
  db: SupabaseClient,
  tenantId: string,
  actorId: string,
  roleId: string,
  fallbackRole?: string,
) {
  return service(db, actorId).delete(tenantId, roleId, fallbackRole);
}
