'use client';

import { useCallback } from 'react';
import { useTranslate } from '@outerlayer/locales';

import type { AppMemberRoleRow, AppMemberRole } from '../../types/app-member-role';
import { useOptionalAppRolesSnapshot } from '../context/app-permissions-context';

// ----------------------------------------------------------------------

interface UseAppRolesResult {
  appRoles: AppMemberRoleRow[];
  isAppScoped: boolean;
  isLoading: boolean;
  error: string | null;
  hasAccessToApp: (appId: string) => boolean;
  getAppRole: (appId: string) => AppMemberRole | null;
  getAppCustomRoleId: (appId: string) => string | null;
}

/**
 * Hook for the current user's per-app role assignments.
 *
 * - `isAppScoped` is read from `membership.is_app_scoped` (explicit flag),
 *    NOT derived from app_member_role row count.
 * - `hasAccessToApp` returns true if the user has an explicit role for that app,
 *    or if the user is unrestricted (is_app_scoped = false).
 * - `getAppRole` returns the specific role for an app, or null.
 *
 * The org layout (user-global) and the `[appName]` layout (app-scoped, shadows
 * the org seed for anything under an app) both resolve the assignments
 * server-side and seed them into `AppPermissionsProvider` — this hook reads
 * that snapshot synchronously and never fetches. A render with no snapshot
 * mounted above it (should not happen once both layouts seed) resolves
 * fail-closed: scoped with no granted apps, the same posture a resolution
 * failure would produce, never the fail-open "unrestricted" default.
 */
export function useAppRoles(): UseAppRolesResult {
  const snapshot = useOptionalAppRolesSnapshot();
  const hasSnapshot = snapshot !== null;
  const { t } = useTranslate();

  const appRoles = snapshot?.appRoles ?? [];
  const isAppScoped = snapshot?.isAppScoped ?? false;
  const effectiveError = hasSnapshot
    ? null
    : t('dashboard.settings.inviteUsersAppRoles.failedLoadPermissions');
  // Resolution is always synchronous now — a mounted snapshot, or the
  // fail-closed default when none is mounted.
  const effectiveLoading = false;

  const hasAccessToApp = useCallback(
    (appId: string): boolean => {
      // Deny access when roles failed to load (fail-closed, not fail-open)
      if (effectiveError) return false;
      if (!isAppScoped) return true; // Unrestricted user
      return appRoles.some((r) => r.app_id === appId);
    },
    [appRoles, isAppScoped, effectiveError]
  );

  const getAppRole = useCallback(
    (appId: string): AppMemberRole | null => {
      const row = appRoles.find((r) => r.app_id === appId);
      return row ? row.role : null;
    },
    [appRoles]
  );

  const getAppCustomRoleId = useCallback(
    (appId: string): string | null => {
      const row = appRoles.find((r) => r.app_id === appId);
      return row ? row.custom_role_id : null;
    },
    [appRoles]
  );

  return {
    appRoles,
    isAppScoped,
    isLoading: effectiveLoading,
    error: effectiveError,
    hasAccessToApp,
    getAppRole,
    getAppCustomRoleId,
  };
}
