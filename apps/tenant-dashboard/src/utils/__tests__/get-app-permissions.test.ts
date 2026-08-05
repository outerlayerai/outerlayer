// @vitest-environment jsdom
/**
 * Unit tests for getAppPermissionSet — the server-side companion to the
 * useAppPermissions client hook.
 *
 * It resolves the current user's effective app permissions via the
 * `get_current_user_app_permissions` RPC (the set-returning sibling of
 * `app_authorize()`), so server-rendered settings pages gate sections in
 * agreement with RLS.
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md): the RPC is an HTTP boundary,
 * served by the shared MSW permissions handler (seedPermissionsMswState) — never
 * a Supabase client mock/spy.
 */

// The middleware forwards the URL-derived tenant as x-tenant-id — the sole
// tenant source. Default to absent, and override per-test to pin the request
// tenant. Keeps the cookie store from the global mock so the Supabase server
// client still authenticates.
const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { getSupabaseTestCookieStore } from '../../test-helpers/supabase-session';
import { getAppPermissionSet, getAppRoleAssignments } from '../get-app-permissions';
import {
  seedPermissionsMswState,
  seedSupabaseAuth,
  seedMembershipMswState,
} from '../../test-helpers/msw-handlers';

afterEach(() => {
  headersGet.mockReturnValue(null);
});

describe('getAppPermissionSet', () => {
  it('returns an empty set and issues no query when appId is null/undefined', async () => {
    expect(await getAppPermissionSet(null)).toEqual(new Set());
    expect(await getAppPermissionSet(undefined)).toEqual(new Set());
  });

  it('returns the granted permission set for the app from the RPC', async () => {
    seedPermissionsMswState({
      allowedAppPermissions: {
        'app-1': ['app.read', 'sso_config.read', 'dashboard.insert'],
      },
    });

    const result = await getAppPermissionSet('app-1');

    expect(result.has('app.read')).toBe(true);
    expect(result.has('sso_config.read')).toBe(true);
    expect(result.has('dashboard.insert')).toBe(true);
    // A permission the RPC did not return is absent.
    expect(result.has('env_var.read')).toBe(false);
  });

  it('returns an empty set for an app with no granted permissions', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'other-app': ['app.read'] } });

    const result = await getAppPermissionSet('app-1');

    expect(result.size).toBe(0);
  });

  it('fails closed with an empty set when the RPC errors', async () => {
    seedPermissionsMswState({ appPermissionsError: { message: 'permission denied' } });

    const result = await getAppPermissionSet('app-1');

    expect(result.size).toBe(0);
  });
});

describe('getAppRoleAssignments', () => {
  const roleRow = {
    id: 'amr-1',
    membership_id: 'mem-1',
    app_id: 'app-1',
    tenant_id: 'tenant-1',
    role: 'read' as const,
    custom_role_id: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('M-g1-6: pins the request tenant, never an arbitrary org — a user with memberships in A and B resolves A under A\'s request tenant, never B\'s row', async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-a' : null));
    // The claim names the OTHER org (B); the request tenant must win.
    seedSupabaseAuth({ user: { id: 'user-1', app_metadata: { tenant_id: 'tenant-b' } } as never });
    const roleInA = { ...roleRow, id: 'amr-a', app_id: 'app-a', tenant_id: 'tenant-a', membership_id: 'mem-a' };
    const roleInB = { ...roleRow, id: 'amr-b', app_id: 'app-b', tenant_id: 'tenant-b', membership_id: 'mem-b' };
    seedMembershipMswState({
      memberships: [
        { id: 'mem-a', user_id: 'user-1', tenant_id: 'tenant-a', role: 'write', status: 'active', is_app_scoped: true },
        { id: 'mem-b', user_id: 'user-1', tenant_id: 'tenant-b', role: 'owner', status: 'active', is_app_scoped: false },
      ],
      appMemberRoles: [roleInA, roleInB],
    });

    const result = await getAppRoleAssignments();

    // Role also resolves from A's membership row (write), never B's (owner).
    expect(result).toEqual({ appRoles: [roleInA], isAppScoped: true, role: 'write' });
  });

  it('M-g1-6: a pending (non-active) membership row in the request tenant is ignored, same as any other tenant', async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-a' : null));
    seedSupabaseAuth({ user: { id: 'user-1', app_metadata: { tenant_id: 'tenant-a' } } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-a', user_id: 'user-1', tenant_id: 'tenant-a', role: 'write', status: 'pending', is_app_scoped: true },
      ],
      appMemberRoles: [],
    });

    const result = await getAppRoleAssignments();

    expect(result).toBeNull();
  });

  it("resolves the user's own app-role rows and is_app_scoped from the membership", async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-1' : null));
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-1', user_id: 'user-1', tenant_id: 'tenant-1', role: 'read', status: 'active', is_app_scoped: true },
      ],
      appMemberRoles: [roleRow],
    });

    const result = await getAppRoleAssignments();

    expect(result).toEqual({ appRoles: [roleRow], isAppScoped: true, role: 'read' });
  });

  it('returns the role rows newest-first (created_at descending)', async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-1' : null));
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    const older = { ...roleRow, id: 'amr-old', app_id: 'app-old', created_at: '2026-01-01T00:00:00Z' };
    const newer = { ...roleRow, id: 'amr-new', app_id: 'app-new', created_at: '2026-06-01T00:00:00Z' };
    seedMembershipMswState({
      memberships: [
        { id: 'mem-1', user_id: 'user-1', tenant_id: 'tenant-1', role: 'read', status: 'active', is_app_scoped: true },
      ],
      // Seeded oldest-first on purpose; the read must reorder to newest-first.
      appMemberRoles: [older, newer],
    });

    const result = await getAppRoleAssignments();

    expect(result?.appRoles.map((r) => r.id)).toEqual(['amr-new', 'amr-old']);
  });

  it('defaults is_app_scoped to false when the membership row does not set it', async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-1' : null));
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-1', user_id: 'user-1', tenant_id: 'tenant-1', role: 'read', status: 'active' },
      ],
      appMemberRoles: [],
    });

    const result = await getAppRoleAssignments();

    expect(result).toEqual({ appRoles: [], isAppScoped: false, role: 'read' });
  });

  it('reads is_app_scoped=false and an empty role set for an unrestricted member', async () => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-1' : null));
    seedSupabaseAuth({ user: { id: 'owner-1' } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-owner', user_id: 'owner-1', tenant_id: 'tenant-1', role: 'admin', status: 'active', is_app_scoped: false },
      ],
      appMemberRoles: [],
    });

    const result = await getAppRoleAssignments();

    expect(result).toEqual({ appRoles: [], isAppScoped: false, role: 'admin' });
  });

  it('returns null when there is no authenticated user (seeds nothing)', async () => {
    const result = await getAppRoleAssignments();

    expect(result).toBeNull();
  });

  it('returns null without matching any membership when neither the request-tenant header nor the token claim carries a tenant id', async () => {
    // No x-tenant-id header (default mock) and no app_metadata.tenant_id on the
    // user — tenantId resolves to undefined, which the Postgrest client
    // serializes as the literal query value `eq.undefined`. A membership row
    // is seeded with tenant_id "undefined" (matching that literal) plus every
    // other filter (user_id + active status) — if the tenantId guard were
    // skipped, the query would find this row; the guard must short-circuit
    // before the membership read runs at all.
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-x', user_id: 'user-1', tenant_id: 'undefined', role: 'admin', status: 'active', is_app_scoped: false },
      ],
    });

    const result = await getAppRoleAssignments();

    expect(result).toBeNull();
  });

  it('returns null when the membership read misses, so the caller falls back', async () => {
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    // No membership seeded → the single() read is a fail-closed miss.

    const result = await getAppRoleAssignments();

    expect(result).toBeNull();
  });

  it('returns null when the app_member_role read errors', async () => {
    seedSupabaseAuth({ user: { id: 'user-1' } as never });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-1', user_id: 'user-1', tenant_id: 'tenant-1', role: 'read', status: 'active', is_app_scoped: true },
      ],
      forceAppMemberRoleError: 'boom',
    });

    const result = await getAppRoleAssignments();

    expect(result).toBeNull();
  });
});
