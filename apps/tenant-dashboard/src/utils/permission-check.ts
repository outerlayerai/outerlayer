"use server";

import { createSupabaseServerClient } from "../supabaseServerClient";
import { createSupabaseAdminClient } from "../supabaseAdminClient";
import { getRequestTenantId } from "../lib/tenant/request-tenant";
import { AuditLogService, isAuditedPermission } from "@/lib/system/audit-log";
import { ServerActionResponse } from "../types/server-action";
import { Permission } from "./permissions";

/** Records a denied mutation attempt in the audit trail (never throws). */
async function auditPermissionDenied(
  user: { id: string; email?: string },
  permission: Permission,
  details: Record<string, unknown>,
  tenantId: string | null
): Promise<void> {
  const auditLog = new AuditLogService({ db: createSupabaseAdminClient() });
  await auditLog.create({
    tenantId,
    actorId: user.id,
    // Denormalized display identity: survives actor profile deletion
    // (actor_id is a frozen, FK-less pointer).
    actorLabel: user.email ?? null,
    actionType: "permission_denied",
    targetType: "permission",
    targetIdentifier: String(permission),
    details,
  });
}

/**
 * Check if the current user has the specified permission
 * Returns an error response if user is not authenticated or doesn't have permission
 */
async function checkPermission(
  permission: Permission
): Promise<{ user: any; tenantId: string | null; error?: string }> {
  // The authorize RPC resolves the actor's role from membership for the
  // request tenant; an absent request tenant denies.
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);

  // Check user authentication
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      user: null,
      tenantId: null,
      error: authError?.message || "User not authenticated"
    };
  }

  const tenantId = requestTenantId ?? null;

  // Check permission using the database authorize function
  const { data: hasPermission, error: permissionError } = await supabase
    .rpc('authorize', {
      requested_permission: permission
    });

  if (permissionError) {
    return {
      user,
      tenantId,
      error: `Permission check failed: ${permissionError.message}`
    };
  }

  if (!hasPermission) {
    if (isAuditedPermission(permission)) {
      await auditPermissionDenied(user, permission, { scope: "tenant" }, tenantId);
    }
    return {
      user,
      tenantId,
      error: `Access denied. Required permission: ${permission}`
    };
  }

  return { user, tenantId };
}

/**
 * Wrapper for server actions that require permission checking. The callback
 * receives the resolved request `tenantId` (the same tenant the check ran
 * against) explicitly — callbacks scope their reads and writes by it and never
 * read the JWT claim, so the tenant a caller acts on always equals the one it
 * was authorized for.
 * Usage: return await withPermissionCheck(Permissions.API_KEY_INSERT, async (user, tenantId) => { ... })
 */
export async function withPermissionCheck<T>(
  permission: Permission,
  action: (_user: any, _tenantId: string) => Promise<ServerActionResponse<T> | void>
): Promise<ServerActionResponse<T> | void> {
  const { user, tenantId, error } = await checkPermission(permission);

  if (error) {
    return { error };
  }
  if (!tenantId) {
    return { error: "No tenant associated with request" };
  }

  return await action(user, tenantId);
}

/**
 * Check if the current user has the specified permission within an app context.
 * Uses the database app_authorize() function which:
 * 1. Checks per-app role if one exists for (membership, app)
 * 2. Falls back to org-level role if user is not app-scoped
 * 3. Denies if user is app-scoped but has no role for this app
 */
export async function checkAppPermission(
  permission: Permission,
  appId: string
): Promise<{ user: any; tenantId: string | null; error?: string }> {
  // app_authorize resolves the actor's per-app (or org-fallback) role from
  // membership for the request tenant; an absent request tenant denies.
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      user: null,
      tenantId: null,
      error: authError?.message || "User not authenticated",
    };
  }

  const tenantId = requestTenantId ?? null;

  const { data: hasPermission, error: permissionError } = await supabase
    .rpc('app_authorize', {
      requested_permission: permission,
      target_app_id: appId,
    });

  if (permissionError) {
    return {
      user,
      tenantId,
      error: `Permission check failed: ${permissionError.message}`,
    };
  }

  if (!hasPermission) {
    if (isAuditedPermission(permission)) {
      await auditPermissionDenied(user, permission, { scope: "app", app_id: appId }, tenantId);
    }
    return {
      user,
      tenantId,
      error: `Access denied. Required permission: ${permission}`,
    };
  }

  return { user, tenantId };
}

/**
 * Wrapper for server actions that operate within an app context. The callback
 * receives the resolved request `tenantId` explicitly (see withPermissionCheck)
 * so the app it acts on is scoped to the tenant it was authorized for.
 * Usage: return await withAppPermissionCheck(Permissions.SSO_CONFIG_UPDATE, appId, async (user, tenantId) => { ... })
 */
export async function withAppPermissionCheck<T>(
  permission: Permission,
  appId: string,
  action: (_user: any, _tenantId: string) => Promise<ServerActionResponse<T> | void>
): Promise<ServerActionResponse<T> | void> {
  const { user, tenantId, error } = await checkAppPermission(permission, appId);

  if (error) {
    return { error };
  }
  if (!tenantId) {
    return { error: "No tenant associated with request" };
  }

  return await action(user, tenantId);
}
