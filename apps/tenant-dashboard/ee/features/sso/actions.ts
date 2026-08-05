"use server";
import "server-only";

/**
 * SAML SSO configuration — org-scoped `authorizedAction`s gated on
 * `sso_config.*` (owner/admin per the `12-rbac.sql` seed, delete owner-only),
 * mirroring the RLS policy on `sso_config` that already enforces the same
 * check.
 *
 * The service's writes persist through the service-role client (GoTrue's SSO
 * admin API, `sso_config`, `sso_audit_log`), which bypasses the owner/admin
 * RLS those tables define — so this permission gate is the actual
 * authorization, not a redundant check.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import {
  emptyInputSchema,
  saveSSOConfigInputSchema,
  toggleSSOActiveInputSchema,
  toggleSSOEnforcementInputSchema,
} from "./schemas";
import {
  getSSOConfig,
  saveSSOConfig,
  toggleSSOActive,
  toggleSSOEnforcement,
  testSSOConnection,
  deleteSSOConfig,
  getSSOMembers,
} from "./service";

export const getSSOConfigAction = authorizedAction({
  input: emptyInputSchema,
  permission: Permissions.SSO_CONFIG_READ,
  handler: (ctx) => getSSOConfig(ctx.db as SupabaseClient, ctx.tenantId),
});

export const testSSOConnectionAction = authorizedAction({
  input: emptyInputSchema,
  permission: Permissions.SSO_CONFIG_READ,
  handler: (ctx) => testSSOConnection(ctx.db as SupabaseClient, ctx.tenantId),
});

export const getSSOMembersAction = authorizedAction({
  input: emptyInputSchema,
  permission: Permissions.SSO_CONFIG_READ,
  handler: (ctx) => getSSOMembers(ctx.db as SupabaseClient, ctx.tenantId),
});

export const saveSSOConfigAction = authorizedAction({
  input: saveSSOConfigInputSchema,
  permission: Permissions.SSO_CONFIG_UPDATE,
  handler: (ctx, input) => saveSSOConfig(ctx.db as SupabaseClient, ctx.tenantId, input),
});

export const toggleSSOActiveAction = authorizedAction({
  input: toggleSSOActiveInputSchema,
  permission: Permissions.SSO_CONFIG_UPDATE,
  handler: (ctx, input) =>
    toggleSSOActive(ctx.db as SupabaseClient, ctx.tenantId, input.active),
});

export const toggleSSOEnforcementAction = authorizedAction({
  input: toggleSSOEnforcementInputSchema,
  permission: Permissions.SSO_CONFIG_UPDATE,
  handler: (ctx, input) =>
    toggleSSOEnforcement(ctx.db as SupabaseClient, ctx.tenantId, input.enforced),
});

// Deletion is owner-only in schemas/65-sso.sql (admin gets read/insert/update
// but not delete), so this gates on sso_config.delete specifically.
export const deleteSSOConfigAction = authorizedAction({
  input: emptyInputSchema,
  permission: Permissions.SSO_CONFIG_DELETE,
  handler: (ctx) => deleteSSOConfig(ctx.db as SupabaseClient, ctx.tenantId),
});
