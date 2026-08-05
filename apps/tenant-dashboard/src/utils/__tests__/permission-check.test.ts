/**
 * Tests for permission-check.ts — the wrapper every authenticated server
 * action funnels through. Targets the 42 NoCoverage mutants the 2026-05-29
 * Stryker nightly flagged at lines 22-47 (checkPermission) and 87-114
 * (checkAppPermission). The mutation classes those survivors represent:
 *
 *   - BooleanLiteral / LogicalOperator on `authError || !user` (L22, L87) —
 *     if the auth guard is flipped or its operator weakened, an unauthenticated
 *     request must NOT reach the action callback.
 *   - ConditionalExpression on `if (permissionError)` / `if (!hasPermission)` —
 *     when the RPC fails or denies, the action MUST NOT run.
 *   - The string content of the returned error messages — assert exact strings
 *     so a refactor that silently changes the user-facing copy fails the test.
 *
 * Boundary choice: MSW seeds against the underlying Supabase HTTP traffic
 * (per apps/tenant-dashboard/CLAUDE.md), not vi.mock on the server client.
 * The new permissions.ts handler intercepts the authorize / app_authorize
 * RPCs the file calls into; seedSupabaseAuth supplies the JWT the server
 * client reads from the cookie store via next/headers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

// The request tenant is the sole tenant source for the app-level `tenantId`
// this file threads through. Default to absent, and pin it per-test where
// the action under test needs to actually run.
const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { getSupabaseTestCookieStore } from '../../test-helpers/supabase-session';
import {
  seedSupabaseAuth,
  seedPermissionsMswState,
  getAuthorizeCalls,
  getAppAuthorizeCalls,
} from '../../test-helpers/msw-handlers';
import {
  withPermissionCheck,
  checkAppPermission,
  withAppPermissionCheck,
} from '../permission-check';
import type { Permission } from '../permissions';

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { role: 'owner' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

// Cast away the string-union narrowing on Permission — production uses
// string literals from the Permissions enum; tests just need a stable
// label that round-trips through the RPC capture.
const PERM = 'template.read' as Permission;
const APP_ID = 'app-1';

describe('withPermissionCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersGet.mockReturnValue(null);
  });

  it('runs the action with the user and returns its result when the permission is granted', async () => {
    headersGet.mockReturnValue('tenant-1');
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({ allowedPermissions: [PERM] });

    const action = vi.fn().mockResolvedValue({ data: { ok: true } });

    const result = await withPermissionCheck(PERM, action);

    expect(action).toHaveBeenCalledTimes(1);
    // The callback receives the resolved request tenant explicitly, so it
    // scopes writes by the checked tenant.
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', email: 'test@example.com' }),
      'tenant-1',
    );
    expect(result).toEqual({ data: { ok: true } });
    // The exact permission string was forwarded to the RPC — guards
    // against a refactor that passes a static permission or drops the arg.
    expect(getAuthorizeCalls()).toEqual([{ requested_permission: PERM }]);
  });

  it('returns the auth error message and does NOT run the action when the request is unauthenticated', async () => {
    // No seedSupabaseAuth call → no session → /auth/v1/user returns 401.
    seedPermissionsMswState({ allowedPermissions: [PERM] });

    const action = vi.fn();

    const result = await withPermissionCheck(PERM, action);

    expect(action).not.toHaveBeenCalled();
    // The error path returns { error } without the user field.
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/.+/);
    // Critically: the RPC should NOT have been called either — the guard
    // short-circuits before the permission check.
    expect(getAuthorizeCalls()).toEqual([]);
  });

  it('returns "Access denied" with the requested permission name when the RPC reports denial', async () => {
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({ allowedPermissions: [] }); // explicit empty → deny

    const action = vi.fn();

    const result = await withPermissionCheck(PERM, action);

    expect(action).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: `Access denied. Required permission: ${PERM}`,
    });
  });

  it('returns "Permission check failed: <msg>" when the RPC itself errors', async () => {
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      authorizeError: { message: 'rpc connection lost' },
    });

    const action = vi.fn();

    const result = await withPermissionCheck(PERM, action);

    expect(action).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'Permission check failed: rpc connection lost',
    });
  });
});

describe('checkAppPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersGet.mockReturnValue(null);
  });

  it('returns the user with no error when the per-app RPC grants the permission', async () => {
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      allowedAppPermissions: { [APP_ID]: [PERM] },
    });

    const result = await checkAppPermission(PERM, APP_ID);

    expect(result.error).toBeUndefined();
    expect(result.user).toEqual(
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  it('forwards permission and target_app_id to the app_authorize RPC', async () => {
    // The bug class this guards: a refactor that hardcodes target_app_id
    // or fails to thread the appId through — would let tenant A pass
    // tenant B's appId without app-scoped denial firing here.
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      allowedAppPermissions: { [APP_ID]: [PERM] },
    });

    await checkAppPermission(PERM, APP_ID);

    expect(getAppAuthorizeCalls()).toEqual([
      { requested_permission: PERM, target_app_id: APP_ID },
    ]);
  });

  it('returns { user: null, error } when the request is unauthenticated', async () => {
    // No seedSupabaseAuth — server client gets 401 from /auth/v1/user.
    const result = await checkAppPermission(PERM, APP_ID);

    expect(result.user).toBeNull();
    expect(result.error).toBe('Auth session missing!');
    expect(getAppAuthorizeCalls()).toEqual([]);
  });

  it('returns "Access denied" with the permission name when the per-app RPC denies', async () => {
    seedSupabaseAuth({ user: mockUser });
    // Empty allow-list → deny.
    seedPermissionsMswState({ allowedAppPermissions: {} });

    const result = await checkAppPermission(PERM, APP_ID);

    expect(result.user).toEqual(expect.objectContaining({ id: 'user-1' }));
    expect(result.error).toBe(`Access denied. Required permission: ${PERM}`);
  });

  it('returns "Permission check failed: <msg>" when the per-app RPC errors', async () => {
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      appAuthorizeError: { message: 'app_authorize: relation missing' },
    });

    const result = await checkAppPermission(PERM, APP_ID);

    expect(result.user).toEqual(expect.objectContaining({ id: 'user-1' }));
    expect(result.error).toBe(
      'Permission check failed: app_authorize: relation missing',
    );
  });

  it('denies when the permission is granted for a DIFFERENT appId', async () => {
    // Multi-tenant isolation at the app level: granting template.read on
    // app-other must not satisfy a check against app-1. Without this
    // assertion, a mutation that strips the target_app_id forwarding
    // would still pass the per-app RPC tests.
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      allowedAppPermissions: { 'app-other': [PERM] },
    });

    const result = await checkAppPermission(PERM, APP_ID);

    expect(result.error).toBe(`Access denied. Required permission: ${PERM}`);
  });
});

describe('withAppPermissionCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersGet.mockReturnValue(null);
  });

  it('runs the action with the user when the per-app permission is granted', async () => {
    headersGet.mockReturnValue('tenant-1');
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({
      allowedAppPermissions: { [APP_ID]: [PERM] },
    });

    const action = vi.fn().mockResolvedValue({ data: { ok: true } });

    const result = await withAppPermissionCheck(PERM, APP_ID, action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'tenant-1',
    );
    expect(result).toEqual({ data: { ok: true } });
  });

  it('returns the error and does NOT run the action when the per-app RPC denies', async () => {
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({ allowedAppPermissions: {} });

    const action = vi.fn();

    const result = await withAppPermissionCheck(PERM, APP_ID, action);

    expect(action).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: `Access denied. Required permission: ${PERM}`,
    });
  });

  it('returns the error and does NOT run the action when unauthenticated', async () => {
    const action = vi.fn();

    const result = await withAppPermissionCheck(PERM, APP_ID, action);

    expect(action).not.toHaveBeenCalled();
    expect(result).toHaveProperty('error');
  });
});
