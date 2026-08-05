'use client';

import { useCallback, useMemo } from 'react';

import { useAuthContext } from './use-auth-context';
import { useOptionalAppPermissionsSnapshot } from '../context/app-permissions-context';
import type { Database } from '../../types/db';
import type { Permission } from '../../utils/permissions';

// ----------------------------------------------------------------------

type RolePermission = Database['public']['Tables']['role_permissions']['Row'];

interface UseAppPermissionsResult {
  permissions: RolePermission[];
  hasPermission: (permission: Permission) => boolean;
  isLoading: boolean;
}

/**
 * Hook that resolves the effective permissions for the current user within a
 * specific app.
 *
 * The `[appName]` layout resolves the permission set server-side via the
 * `get_current_user_app_permissions` RPC (the set-returning companion to
 * `app_authorize()`) and seeds it into `AppPermissionsProvider`; this hook
 * reads that snapshot synchronously and never fetches — every app-scoped
 * `useAppPermissions`/`PermissionGuard` consumer renders under `[appName]`,
 * where the snapshot is always mounted. The snapshot is only used when its
 * `appId` matches the requested one; a mismatched or absent snapshot resolves
 * to the fail-closed empty set (no permissions), never a client RPC — a
 * live re-fetch of per-app permissions is intentionally NOT provided here
 * (the seed is the only source), so a caller instantiating the hook outside
 * `[appName]` gets nothing rather than a stale/incorrect grant.
 *
 * When `appId` is null/undefined there is no app context, so we fall back to
 * the org-level permissions already resolved into AuthContext.
 */
export function useAppPermissions(appId: string | null | undefined): UseAppPermissionsResult {
  const { user } = useAuthContext();

  const snapshot = useOptionalAppPermissionsSnapshot();
  const serverGranted =
    appId && snapshot && snapshot.appId === appId ? snapshot.permissions : null;

  const effectivePermissions = useMemo(() => {
    // Server-resolved snapshot: already the effective set for this app.
    if (appId && serverGranted) {
      return serverGranted.map((permission) => ({
        id: `${appId}:${permission}`,
        role: 'read' as const,
        permission,
      }));
    }
    // App context present but no matching snapshot: fail-closed — never flash
    // actions the user may not have.
    if (appId) return [];
    // No app context: fall back to org-level permissions from AuthContext.
    return user?.permissions ?? [];
  }, [appId, serverGranted, user?.permissions]);

  const hasPermission = useCallback(
    (permission: Permission): boolean =>
      effectivePermissions.some((p) => p.permission === permission),
    [effectivePermissions]
  );

  return {
    permissions: effectivePermissions,
    hasPermission,
    // Resolution is always synchronous now (a seeded snapshot or the
    // fail-closed/org-level fallback) — there is no pending async state.
    isLoading: false,
  };
}
