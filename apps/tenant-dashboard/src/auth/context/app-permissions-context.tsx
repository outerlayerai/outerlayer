'use client';

import { createContext, useContext, useMemo } from 'react';

import type { AppMemberRoleRow } from '../../types/app-member-role';
import type { Permission } from '../../utils/permissions';
import type { UserRole } from '../types';

// ----------------------------------------------------------------------

interface AppPermissionsSnapshot {
  /**
   * The app the snapshot was resolved for, or `null` for the org-level seed
   * (mounted at the org layout, above any specific app) — it carries only the
   * user-global `appRoles` half; `useAppPermissions` never matches a real
   * `appId` against a `null` snapshot appId, so it correctly falls through
   * instead of leaking an org-level mount's (empty) `permissions`.
   */
  appId: string | null;
  /** The user's effective app-scoped permission set, resolved server-side. */
  permissions: Permission[];
  /**
   * The user's per-app role assignments, resolved server-side alongside the
   * permission set. User-global (not keyed by `appId`), so `useAppRoles` reads
   * them wherever this provider is mounted. Absent when the layout could not
   * resolve them, in which case `useAppRoles` resolves fail-closed (scoped, no
   * granted apps) rather than fetching.
   */
  appRoles?: AppMemberRoleRow[];
  /** membership.is_app_scoped, seeded with `appRoles`. */
  isAppScoped?: boolean;
  /**
   * The user's org-level role for the REQUEST tenant, seeded alongside
   * `appRoles` — never the JWT claim, which can name a different org for a
   * multi-org user. Absent under the same conditions `appRoles` is.
   */
  role?: UserRole;
}

/** The app-role half of the seed, once it is known to be present. */
interface AppRolesSnapshot {
  appRoles: AppMemberRoleRow[];
  isAppScoped: boolean;
}

const AppPermissionsContext = createContext<AppPermissionsSnapshot | null>(null);

type Props = AppPermissionsSnapshot & {
  children?: React.ReactNode;
};

/**
 * Carries the SERVER-resolved app permission set (see
 * `utils/get-app-permissions.ts`) down to client consumers.
 *
 * Mounted by the `[appName]` layout, which persists across tab navigations
 * inside an app — so `useAppPermissions(appId)` resolves synchronously from
 * this snapshot instead of firing the `get_current_user_app_permissions` RPC
 * on every `PermissionGuard` mount. Without it, each tab switch rendered a
 * blank frame while the per-mount RPC was in flight.
 *
 * The snapshot is keyed by `appId`: consumers asking about a DIFFERENT app
 * (or rendering outside the provider) resolve fail-closed (no permissions) in
 * `useAppPermissions` — there is no client-side RPC fallback.
 */
export function AppPermissionsProvider({
  appId,
  permissions,
  appRoles,
  isAppScoped,
  role,
  children,
}: Props) {
  const value = useMemo(
    () => ({ appId, permissions, appRoles, isAppScoped, role }),
    [appId, permissions, appRoles, isAppScoped, role],
  );

  return (
    <AppPermissionsContext.Provider value={value}>
      {children}
    </AppPermissionsContext.Provider>
  );
}

/**
 * The server-resolved snapshot, or null when no provider is mounted (org-level
 * routes, loading fallbacks). Optional by design — `useAppPermissions` treats
 * absence as fail-closed (no permissions), never a client-side fetch.
 */
export function useOptionalAppPermissionsSnapshot(): AppPermissionsSnapshot | null {
  return useContext(AppPermissionsContext);
}

/**
 * The server-resolved app-role assignments, or null when no provider is mounted
 * OR the layout could not seed them. Null is the signal for `useAppRoles` to
 * resolve fail-closed (scoped, no granted apps) instead — so a seed that is
 * merely absent never masquerades as an empty (fail-open) assignment set, and
 * never triggers a client-side fetch.
 */
export function useOptionalAppRolesSnapshot(): AppRolesSnapshot | null {
  const snapshot = useContext(AppPermissionsContext);
  if (!snapshot || snapshot.appRoles === undefined) return null;
  return { appRoles: snapshot.appRoles, isAppScoped: snapshot.isAppScoped ?? false };
}

/**
 * The user's org-level role for the REQUEST tenant, or `undefined` when no
 * provider is mounted or the layout could not resolve it. `useCurrentUser`
 * prefers this over the JWT claim — the claim can name a different org than
 * the one on screen for a multi-org user.
 */
export function useOptionalCurrentUserRole(): UserRole | undefined {
  return useContext(AppPermissionsContext)?.role;
}
