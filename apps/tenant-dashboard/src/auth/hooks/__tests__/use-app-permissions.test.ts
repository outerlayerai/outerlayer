// @vitest-environment jsdom
/**
 * Unit tests for the useAppPermissions hook.
 *
 * The `[appName]` layout resolves the effective permission set server-side via
 * the `get_current_user_app_permissions` RPC (the set-returning companion to
 * `app_authorize()`) and seeds it into `AppPermissionsProvider`; every
 * app-scoped consumer renders under `[appName]`, where that snapshot is always
 * mounted. The hook itself never opens a Supabase client or fetches — a
 * mismatched or absent snapshot resolves to the fail-closed empty set, and
 * `appId === null` falls back to org-level permissions from AuthContext.
 */

import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { AppPermissionsProvider } from '../../context/app-permissions-context';
import { Permissions, type Permission } from '../../../utils/permissions';

const mockUserPermissions = vi.fn();

vi.mock('../use-auth-context', () => ({
  useAuthContext: () => ({
    user: {
      get permissions() { return mockUserPermissions(); },
    },
  }),
}));

import { useAppPermissions } from '../use-app-permissions';

const APP_ID = 'app-aaa-111';

const orgPermissions = [
  { id: 'org-1', role: 'admin' as const, permission: 'app.read' },
  { id: 'org-2', role: 'admin' as const, permission: 'env_var.read' },
  { id: 'org-3', role: 'admin' as const, permission: 'trace.read' },
];

/** Wrapper mounting the provider the `[appName]` server layout renders. */
function providerWrapper(appId: string | null, permissions: Permission[]) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AppPermissionsProvider, { appId, permissions }, children);
  Wrapper.displayName = 'AppPermissionsTestWrapper';
  return Wrapper;
}

describe('useAppPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserPermissions.mockReturnValue(orgPermissions);
  });

  it('falls back to org-level permissions and resolves synchronously when appId is null', () => {
    const { result } = renderHook(() => useAppPermissions(null));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.permissions).toEqual(orgPermissions);
    expect(result.current.hasPermission(Permissions.APP_READ)).toBe(true);
    expect(result.current.hasPermission(Permissions.TRACE_READ)).toBe(true);
  });

  it('resolves synchronously from the server snapshot (regression: tab-switch flicker)', () => {
    const { result } = renderHook(() => useAppPermissions(APP_ID), {
      wrapper: providerWrapper(APP_ID, ['app.read', 'env_var.read'] as Permission[]),
    });

    // FIRST render: already resolved — a loading frame here is the blank flash
    // PermissionGuard showed on every tab switch.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.permissions).toEqual([
      { id: `${APP_ID}:app.read`, role: 'read', permission: 'app.read' },
      { id: `${APP_ID}:env_var.read`, role: 'read', permission: 'env_var.read' },
    ]);
    expect(result.current.hasPermission(Permissions.APP_READ)).toBe(true);
    expect(result.current.hasPermission(Permissions.SSO_CONFIG_DELETE)).toBe(false);
  });

  it('fails closed with empty permissions when the snapshot is for a different app (no RPC fallback)', () => {
    const { result } = renderHook(() => useAppPermissions(APP_ID), {
      wrapper: providerWrapper('some-other-app', ['app.delete'] as Permission[]),
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.hasPermission(Permissions.APP_DELETE)).toBe(false);
    expect(result.current.hasPermission(Permissions.SSO_CONFIG_READ)).toBe(false);
  });

  it('fails closed with empty permissions when no provider is mounted at all', () => {
    const { result } = renderHook(() => useAppPermissions(APP_ID));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.hasPermission(Permissions.APP_READ)).toBe(false);
  });

  it('keeps the org-level fallback when appId is null, even inside a provider mounted for a different app', () => {
    const { result } = renderHook(() => useAppPermissions(null), {
      wrapper: providerWrapper(APP_ID, ['app.delete'] as Permission[]),
    });

    expect(result.current.permissions).toEqual(orgPermissions);
    expect(result.current.hasPermission(Permissions.APP_DELETE)).toBe(false);
  });

  it('keeps the org-level fallback under the org-level seed (appId: null snapshot)', () => {
    // The org layout mounts AppPermissionsProvider with appId=null (only the
    // appRoles half matters there) — an app-scoped permission request must
    // still fall through to the org-level path, not read the org seed's
    // (empty) `permissions` as if it matched.
    const { result } = renderHook(() => useAppPermissions(APP_ID), {
      wrapper: providerWrapper(null, []),
    });

    expect(result.current.permissions).toEqual([]);
    expect(result.current.hasPermission(Permissions.APP_READ)).toBe(false);
  });
});
