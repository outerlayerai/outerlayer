// @vitest-environment jsdom
/**
 * Tests for useAppRoles hook.
 *
 * The org layout (user-global) and the `[appName]` layout (app-scoped, shadows
 * the org seed for anything rendered under an app) both resolve the current
 * user's per-app role assignments server-side and seed them into
 * `AppPermissionsProvider`. The hook itself never opens a Supabase client —
 * it reads whichever snapshot is mounted, and resolves fail-closed (scoped,
 * no granted apps) when none is.
 *
 * Key invariant: the server-side app_member_role read (`getAppRoleAssignments`,
 * `utils/get-app-permissions.ts`) is filtered by the current user's own
 * `membership_id` — an owner must never inherit a team member's restricted
 * role. That invariant lives in the server read; this file exercises the
 * hook's contract against whatever snapshot it's handed.
 */

import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { useAppRoles } from '../use-app-roles';
import { AppPermissionsProvider } from '../../context/app-permissions-context';
import type { AppMemberRoleRow } from '../../../types/app-member-role';

const APP_X_ID = 'app-x-id-000';
const APP_Y_ID = 'app-y-id-001';
const MEMBER_MEMBERSHIP_ID = 'member-membership-bbb';

function wrapperFor(appRoles: AppMemberRoleRow[], isAppScoped: boolean) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      AppPermissionsProvider,
      { appId: APP_X_ID, permissions: [], appRoles, isAppScoped },
      children,
    );
  Wrapper.displayName = 'AppRolesTestWrapper';
  return Wrapper;
}

describe('useAppRoles', () => {
  describe('unrestricted user (is_app_scoped = false, no app role rows)', () => {
    // proves AC-074-06
    it('should have access to all apps and no app roles', () => {
      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor([], false),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.isAppScoped).toBe(false);
      expect(result.current.appRoles).toEqual([]);
      expect(result.current.hasAccessToApp(APP_X_ID)).toBe(true);
      expect(result.current.getAppRole(APP_X_ID)).toBeNull();
    });
  });

  describe('restricted member gets their own app roles', () => {
    const memberAppRoles: AppMemberRoleRow[] = [
      {
        id: 'role-row-1',
        membership_id: MEMBER_MEMBERSHIP_ID,
        app_id: APP_X_ID,
        tenant_id: 'tenant-123',
        role: 'read',
        custom_role_id: null,
        created_at: '2026-01-01T00:00:00Z',
        created_by: null,
        updated_at: null,
        updated_by: null,
      },
    ];

    it('should return the seeded app roles', () => {
      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(memberAppRoles, true),
      });

      expect(result.current.isAppScoped).toBe(true);
      expect(result.current.appRoles).toHaveLength(1);
      expect(result.current.appRoles.at(0)!.role).toBe('read');
    });

    it('should return "read" role for App X', () => {
      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(memberAppRoles, true),
      });

      expect(result.current.getAppRole(APP_X_ID)).toBe('read');
    });

    // proves AC-074-05
    it('should deny access to App Y (no role assigned)', () => {
      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(memberAppRoles, true),
      });

      expect(result.current.hasAccessToApp(APP_Y_ID)).toBe(false);
      expect(result.current.getAppRole(APP_Y_ID)).toBeNull();
    });
  });

  describe('getAppCustomRoleId()', () => {
    it('should return custom_role_id when the row has one set', () => {
      const customRoleId = 'custom-role-999';
      const roles: AppMemberRoleRow[] = [
        {
          id: 'role-row-cr',
          membership_id: MEMBER_MEMBERSHIP_ID,
          app_id: APP_X_ID,
          tenant_id: 'tenant-123',
          role: "read",
          custom_role_id: customRoleId,
          created_at: '2026-01-01T00:00:00Z',
          created_by: null,
          updated_at: null,
          updated_by: null,
        },
      ];

      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(roles, true),
      });

      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBe(customRoleId);
    });

    it('should return null when no row exists for the app', () => {
      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor([], true),
      });

      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBeNull();
    });

    it('should return null when the row has custom_role_id as null (built-in role)', () => {
      const roles: AppMemberRoleRow[] = [
        {
          id: 'role-row-bi',
          membership_id: MEMBER_MEMBERSHIP_ID,
          app_id: APP_X_ID,
          tenant_id: 'tenant-123',
          role: 'read',
          custom_role_id: null,
          created_at: '2026-01-01T00:00:00Z',
          created_by: null,
          updated_at: null,
          updated_by: null,
        },
      ];

      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(roles, true),
      });

      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBeNull();
    });

    it('should return the correct custom_role_id per app when multiple rows exist', () => {
      const roles: AppMemberRoleRow[] = [
        {
          id: 'role-row-cr-1',
          membership_id: MEMBER_MEMBERSHIP_ID,
          app_id: APP_X_ID,
          tenant_id: 'tenant-123',
          role: "read",
          custom_role_id: 'cr-111',
          created_at: '2026-01-01T00:00:00Z',
          created_by: null,
          updated_at: null,
          updated_by: null,
        },
        {
          id: 'role-row-cr-2',
          membership_id: MEMBER_MEMBERSHIP_ID,
          app_id: 'app-yyy',
          tenant_id: 'tenant-123',
          role: "read",
          custom_role_id: 'cr-222',
          created_at: '2026-01-01T00:00:00Z',
          created_by: null,
          updated_at: null,
          updated_by: null,
        },
      ];

      const { result } = renderHook(() => useAppRoles(), {
        wrapper: wrapperFor(roles, true),
      });

      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBe('cr-111');
      expect(result.current.getAppCustomRoleId('app-yyy')).toBe('cr-222');
    });
  });

  describe('no snapshot mounted (fail-closed, not a fetch)', () => {
    it('denies all app access and surfaces an error, without fetching anything', () => {
      const { result } = renderHook(() => useAppRoles());

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBe(
        'dashboard.settings.inviteUsersAppRoles.failedLoadPermissions',
      );
      expect(result.current.appRoles).toEqual([]);
      expect(result.current.isAppScoped).toBe(false);
      // Fail-closed: no snapshot must not read as "unrestricted" (isAppScoped
      // is not what gates this — the error does, checked first).
      expect(result.current.hasAccessToApp(APP_X_ID)).toBe(false);
      expect(result.current.getAppRole(APP_X_ID)).toBeNull();
      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBeNull();
    });
  });

  describe('server-seeded snapshot (layout provider mounted)', () => {
    const seededRoles: AppMemberRoleRow[] = [
      {
        id: 'seed-role-1',
        membership_id: MEMBER_MEMBERSHIP_ID,
        app_id: APP_X_ID,
        tenant_id: 'tenant-123',
        role: 'read',
        custom_role_id: 'seed-custom-1',
        created_at: '2026-01-01T00:00:00Z',
        created_by: null,
        updated_at: null,
        updated_by: null,
      },
    ];

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        AppPermissionsProvider,
        { appId: APP_X_ID, permissions: [], appRoles: seededRoles, isAppScoped: true },
        children,
      );

    it('reads the seed synchronously', () => {
      const { result } = renderHook(() => useAppRoles(), { wrapper });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.appRoles).toEqual(seededRoles);
      expect(result.current.isAppScoped).toBe(true);
    });

    it('derives access + roles from the seed exactly as from a fetch', () => {
      const { result } = renderHook(() => useAppRoles(), { wrapper });

      expect(result.current.hasAccessToApp(APP_X_ID)).toBe(true);
      expect(result.current.hasAccessToApp(APP_Y_ID)).toBe(false);
      expect(result.current.getAppRole(APP_X_ID)).toBe('read');
      expect(result.current.getAppRole(APP_Y_ID)).toBeNull();
      expect(result.current.getAppCustomRoleId(APP_X_ID)).toBe('seed-custom-1');
    });

    it('reads the org-level seed (appId: null) too — appRoles is user-global', () => {
      const orgWrapper = ({ children }: { children: ReactNode }) =>
        createElement(
          AppPermissionsProvider,
          { appId: null, permissions: [], appRoles: seededRoles, isAppScoped: true },
          children,
        );

      const { result } = renderHook(() => useAppRoles(), { wrapper: orgWrapper });

      expect(result.current.appRoles).toEqual(seededRoles);
      expect(result.current.hasAccessToApp(APP_X_ID)).toBe(true);
    });
  });
});
