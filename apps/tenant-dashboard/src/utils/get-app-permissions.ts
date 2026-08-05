import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import type { AppMemberRoleRow } from "../types/app-member-role";
import type { Permission } from "./permissions";
import type { UserRole } from "@/auth/types";

/**
 * Server-side companion to the `useAppPermissions` client hook.
 *
 * Resolves the current user's effective permission SET for one app via the
 * `get_current_user_app_permissions` RPC — the set-returning sibling of
 * `app_authorize()` (same resolution order: owner bypass → per-app custom role
 * → per-app built-in role → app-scoped deny → org-level fallback).
 *
 * Server components use this to gate which settings tabs/sections render. One
 * round-trip returns every permission, so a page checking several permissions
 * (e.g. the settings layout: api_key/slack/webhook/env-var) calls this once and
 * does cheap `.has()` lookups instead of firing one `app_authorize` RPC per
 * permission.
 *
 * Wrapped in `React.cache` so every server component in one request shares a
 * single RPC: a layout and a page must EACH call this (a server layout cannot
 * pass data to its children, and pages fetching gated data must gate
 * themselves), but only the first call per request hits the database. The
 * cache never spans requests, so the set stays fresh per navigation.
 */
export const getAppPermissionSet = cache(
  async (appId: string | null | undefined): Promise<Set<Permission>> => {
    if (!appId) return new Set<Permission>();

    const supabase = await createSupabaseServerClient(await getRequestTenantId());
    const { data } = await supabase.rpc("get_current_user_app_permissions", {
      target_app_id: appId,
    });

    return new Set<Permission>((data ?? []) as Permission[]);
  }
);

/** The current user's per-app role assignments, seeded into the client cluster. */
interface AppRoleAssignments {
  /** The user's own app_member_role rows (their access-scoping, not other members'). */
  appRoles: AppMemberRoleRow[];
  /** membership.is_app_scoped — whether the user is restricted to explicit apps. */
  isAppScoped: boolean;
  /** The user's org-level role for the REQUEST tenant (never the JWT claim —
   *  a multi-org user's claim can name a different org than the one on
   *  screen). Seeds `useCurrentUser`'s `role`/`isOwner`. */
  role: UserRole;
}

/**
 * Server-side companion to the `useAppRoles` client hook: resolves the current
 * user's own per-app role assignments so the `[appName]` layout can seed them
 * once instead of every consumer self-fetching in the browser.
 *
 * Reads the user's own membership row and its app_member_role rows under the
 * request tenant (request-scoped like the permission set, falling back to the
 * JWT claim when no tenant header is present). The app_member_role read is
 * filtered by the user's own membership_id: RLS lets any tenant member read all
 * rows (for management UIs), so an unfiltered read would inherit another
 * member's restricted role.
 *
 * Returns null on any read error so the caller seeds nothing — `useAppRoles`
 * treats a missing seed as fail-closed (scoped, no granted apps), rather than
 * this read seeding a wrong-but-confident empty assignment set.
 *
 * Wrapped in `React.cache` so a layout and its pages share a single read per
 * request; the cache never spans requests.
 */
export const getAppRoleAssignments = cache(
  async (): Promise<AppRoleAssignments | null> => {
    const requestTenantId = await getRequestTenantId();
    const supabase = await createSupabaseServerClient(requestTenantId);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // Pinned to the request tenant and to active status — a multi-org user's
    // membership rows from every org are RLS-visible, so an unscoped read
    // could pick an arbitrary org's `is_app_scoped`/role set. No request
    // tenant means no assignments.
    const tenantId = requestTenantId;
    if (!tenantId) return null;

    const { data: membership, error: membershipError } = await supabase
      .from("membership")
      .select("id, is_app_scoped, role")
      .eq("user_id", user.id)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .limit(1)
      .single();

    if (membershipError || !membership) return null;

    const { data: roles, error: rolesError } = await supabase
      .from("app_member_role")
      .select("*")
      .eq("membership_id", membership.id)
      .order("created_at", { ascending: false });

    if (rolesError) return null;

    return {
      appRoles: (roles ?? []) as AppMemberRoleRow[],
      isAppScoped: membership.is_app_scoped ?? false,
      role: membership.role as UserRole,
    };
  }
);
