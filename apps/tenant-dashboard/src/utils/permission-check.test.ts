import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSupabaseTestCookieStore } from '../test-helpers/supabase-session';

// The request tenant is the sole tenant source here. Default to absent;
// tests that need the check to actually run pin it.
const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { withPermissionCheck, withAppPermissionCheck } from './permission-check';
import { Permissions } from './permissions';
import {
  seedSupabaseAuth,
  seedPermissionsMswState,
  getInsertedAuditLogRows,
} from '../test-helpers/msw-handlers';

const mockUser = {
  id: 'user-1',
  email: 'member@example.com',
  app_metadata: { role: 'read' },
} as never;

describe('permission gates audit denied mutations', () => {
  beforeEach(() => {
    headersGet.mockImplementation((name) => (name === 'x-tenant-id' ? 'tenant-1' : null));
    seedSupabaseAuth({ user: mockUser });
  });

  it('records a permission_denied row when a WRITE permission is denied', async () => {
    seedPermissionsMswState({ allowedPermissions: [] });
    const action = vi.fn();

    const result = await withPermissionCheck(Permissions.SSO_CONFIG_DELETE, action);

    expect(result).toEqual({
      error: `Access denied. Required permission: ${Permissions.SSO_CONFIG_DELETE}`,
    });
    expect(action).not.toHaveBeenCalled();
    expect(getInsertedAuditLogRows()).toEqual([
      {
        tenant_id: 'tenant-1',
        actor_id: 'user-1',
        actor_type: 'human',
        // Denormalized display identity — survives actor profile deletion.
        actor_label: 'member@example.com',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_id: null,
        target_identifier: Permissions.SSO_CONFIG_DELETE,
        before_state: null,
        after_state: null,
        details: { scope: 'tenant' },
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('does NOT record denied READ permissions (UI noise, not audit signal)', async () => {
    seedPermissionsMswState({ allowedPermissions: [] });

    await withPermissionCheck(Permissions.APP_READ, vi.fn());

    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  it('does NOT record granted permissions', async () => {
    seedPermissionsMswState({ allowedPermissions: [Permissions.SSO_CONFIG_DELETE] });
    const action = vi.fn().mockResolvedValue({ data: 'ok' });

    const result = await withPermissionCheck(Permissions.SSO_CONFIG_DELETE, action);

    expect(result).toEqual({ data: 'ok' });
    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  it('does NOT record authorize() transport errors (not a denial)', async () => {
    seedPermissionsMswState({ authorizeError: { message: 'db down' } });

    const result = await withPermissionCheck(Permissions.SSO_CONFIG_DELETE, vi.fn());

    expect(result).toEqual({ error: 'Permission check failed: db down' });
    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  it('records app-scoped denials with the app id', async () => {
    seedPermissionsMswState({ allowedPermissions: [], allowedAppPermissions: {} });

    await withAppPermissionCheck(Permissions.SSO_CONFIG_UPDATE, 'app-9', vi.fn());

    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        action_type: 'permission_denied',
        target_identifier: Permissions.SSO_CONFIG_UPDATE,
        details: { scope: 'app', app_id: 'app-9' },
      }),
    ]);
  });
});
