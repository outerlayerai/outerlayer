"use server";
import "server-only";

/**
 * Per-app role assignment — org-scoped `authorizedAction`s gated on
 * `app_member_role.*`/`app.read` (unchanged from the pre-migration gate).
 * `appId` is payload here, not the authz scope: assigning/revoking access
 * TO an app is an org-level operation on the target membership, not an
 * app-scoped one.
 */

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import {
  assignAppRoleInputSchema,
  updateAppRoleInputSchema,
  updateAppCustomRoleInputSchema,
  revokeAppRoleInputSchema,
  setAppScopedInputSchema,
  getAppScopedStatusInputSchema,
  listAppRolesInputSchema,
  listAppsForDropdownInputSchema,
} from "./schemas";
import {
  assignAppRole,
  updateAppRole,
  updateAppCustomRole,
  revokeAppRole,
  setAppScoped,
  listAppRoles,
  listApps,
  getAppScopedStatus,
} from "./service";

export const assignAppRoleAction = authorizedAction({
  input: assignAppRoleInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_INSERT,
  handler: async (ctx, input) => {
    const result = await assignAppRole(ctx.tenantId, ctx.actor.userId, input.membershipId, input.appId, input.role);
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const updateAppRoleAction = authorizedAction({
  input: updateAppRoleInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_UPDATE,
  handler: async (ctx, input) => {
    const result = await updateAppRole(ctx.tenantId, ctx.actor.userId, input.appMemberRoleId, input.role);
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const updateAppCustomRoleAction = authorizedAction({
  input: updateAppCustomRoleInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_UPDATE,
  handler: async (ctx, input) => {
    const result = await updateAppCustomRole(ctx.tenantId, ctx.actor.userId, input.appMemberRoleId, input.customRoleId);
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const revokeAppRoleAction = authorizedAction({
  input: revokeAppRoleInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_DELETE,
  handler: async (ctx, input) => {
    const result = await revokeAppRole(ctx.tenantId, ctx.actor.userId, input.appMemberRoleId);
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const setAppScopedAction = authorizedAction({
  input: setAppScopedInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_UPDATE,
  handler: async (ctx, input) => {
    const result = await setAppScoped(ctx.tenantId, ctx.actor.userId, input.membershipId, input.isAppScoped);
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

/** Dialog-lazy reads (the sanctioned read-action precedent) — admin bodies confined to lib/system. */
export const listAppRolesAction = authorizedAction({
  input: listAppRolesInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_READ,
  handler: (ctx, input) => listAppRoles(ctx.tenantId, input),
});

export const listAppsForDropdownAction = authorizedAction({
  input: listAppsForDropdownInputSchema,
  permission: Permissions.APP_READ,
  handler: (ctx) => listApps(ctx.tenantId),
});

export const getAppScopedStatusAction = authorizedAction({
  input: getAppScopedStatusInputSchema,
  permission: Permissions.APP_MEMBER_ROLE_READ,
  handler: (ctx, input) => getAppScopedStatus(ctx.tenantId, input.membershipId),
});
