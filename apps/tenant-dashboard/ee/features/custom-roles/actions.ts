"use server";
import "server-only";

/**
 * Custom-role CRUD — org-scoped `authorizedAction`s gated on `custom_role.*`
 * (owner/admin per the `12-rbac.sql` seed), mirroring the RLS policy on
 * `custom_role` that already enforces the same check. The service's own
 * writes are RLS-scoped; the admin authority it separately needs (membership
 * counting, fallback reassignment, audit rows, the entitlement gate) is
 * confined to `lib/system` (see `./service.ts`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import {
  createCustomRoleInputSchema,
  updateCustomRoleInputSchema,
  deleteCustomRoleInputSchema,
  getCustomRoleInputSchema,
  listCustomRolesInputSchema,
} from "./schemas";
import {
  listCustomRoles,
  getCustomRole,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
} from "./service";

/**
 * List / get are read-shaped `authorizedAction`s (the sanctioned dialog-lazy
 * read-action precedent) — the roles page seeds the initial list from its own
 * React Server Component (RSC);
 * these back the client-side refresh after a mutation and the detail dialog.
 */
export const listCustomRolesAction = authorizedAction({
  input: listCustomRolesInputSchema,
  permission: Permissions.CUSTOM_ROLE_READ,
  handler: (ctx) => listCustomRoles(ctx.db as SupabaseClient, ctx.tenantId),
});

export const getCustomRoleAction = authorizedAction({
  input: getCustomRoleInputSchema,
  permission: Permissions.CUSTOM_ROLE_READ,
  handler: (ctx, input) => getCustomRole(ctx.db as SupabaseClient, ctx.tenantId, input.roleId),
});

export const createCustomRoleAction = authorizedAction({
  input: createCustomRoleInputSchema,
  permission: Permissions.CUSTOM_ROLE_INSERT,
  handler: async (ctx, input) => {
    const result = await createCustomRole(ctx.db as SupabaseClient, ctx.tenantId, ctx.actor.userId, {
      name: input.name,
      description: input.description,
      permissions: input.permissions,
    });
    if (result.success) revalidatePath("/settings/roles");
    return result;
  },
});

export const updateCustomRoleAction = authorizedAction({
  input: updateCustomRoleInputSchema,
  permission: Permissions.CUSTOM_ROLE_UPDATE,
  handler: async (ctx, input) => {
    const result = await updateCustomRole(
      ctx.db as SupabaseClient,
      ctx.tenantId,
      ctx.actor.userId,
      input.roleId,
      { name: input.name, description: input.description, permissions: input.permissions },
    );
    if (result.success) revalidatePath("/settings/roles");
    return result;
  },
});

export const deleteCustomRoleAction = authorizedAction({
  input: deleteCustomRoleInputSchema,
  permission: Permissions.CUSTOM_ROLE_DELETE,
  handler: async (ctx, input) => {
    const result = await deleteCustomRole(
      ctx.db as SupabaseClient,
      ctx.tenantId,
      ctx.actor.userId,
      input.roleId,
      input.fallbackRole,
    );
    if (result.success) revalidatePath("/settings/roles");
    return result;
  },
});
