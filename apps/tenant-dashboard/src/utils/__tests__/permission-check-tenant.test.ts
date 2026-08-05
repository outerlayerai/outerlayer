/**
 * Tests: the permission gatekeepers resolve their tenant solely from the
 * URL-derived request header, so a denied-mutation audit row is attributed
 * to the URL tenant, or to no tenant at all.
 *
 * The org/app authorize RPCs are tenant-scoped at the DB (public.tenant_id()),
 * which MSW cannot emulate — that behavior is proven in the acceptance layer.
 * What is unit-observable is the audit tenant the gatekeeper records, which the
 * audit-log handler captures. Boundary: MSW over the Supabase HTTP traffic; the
 * middleware-derived header controlled through next/headers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { getSupabaseTestCookieStore } from '../../test-helpers/supabase-session';

vi.mock('server-only', () => ({}));

const headersGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { checkAppPermission, withPermissionCheck } from '../permission-check';
import {
  seedSupabaseAuth,
  seedPermissionsMswState,
  getInsertedAuditLogRows,
} from '../../test-helpers/msw-handlers';
import type { Permission } from '../permissions';

const CLAIM_TENANT = 'tenant-claim';
const URL_TENANT = 'tenant-url';
const APP_ID = 'app-1';
// An audited verb (`update`) so a denial writes an audit row.
const AUDITED_PERM = 'app_policy.update' as Permission;

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: CLAIM_TENANT },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

describe('permission gatekeepers — audit tenant follows the URL, not the claim', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
    seedPermissionsMswState({ allowedPermissions: [], allowedAppPermissions: {} }); // deny
  });

  it('attributes an org-permission denial to the URL tenant', async () => {
    headersGet.mockReturnValue(URL_TENANT);

    await withPermissionCheck(AUDITED_PERM, vi.fn());

    const rows = getInsertedAuditLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(URL_TENANT);
  });

  it('attributes an app-permission denial to the URL tenant', async () => {
    headersGet.mockReturnValue(URL_TENANT);

    await checkAppPermission(AUDITED_PERM, APP_ID);

    const rows = getInsertedAuditLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(URL_TENANT);
  });

  it('attributes the audit row to no tenant when no header is present, never the claim', async () => {
    headersGet.mockReturnValue(null);

    await withPermissionCheck(AUDITED_PERM, vi.fn());

    const rows = getInsertedAuditLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBeNull();
  });
});

describe('withPermissionCheck — the callback acts on the checked tenant, not the claim', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser }); // claim tenant = CLAIM_TENANT (org B)
  });

  it('hands the URL tenant to the callback when the claim names a different org', async () => {
    headersGet.mockReturnValue(URL_TENANT); // middleware-derived header = org A
    seedPermissionsMswState({ allowedPermissions: ['app.read' as Permission] }); // grant so the body runs

    let actedTenant: string | undefined;
    await withPermissionCheck('app.read' as Permission, async (_user, tenantId) => {
      actedTenant = tenantId;
      return {};
    });

    // The tenant the body scopes its writes by is the one it was authorized in
    // (org A, from the URL), never the JWT claim (org B) — check == act.
    expect(actedTenant).toBe(URL_TENANT);
  });
});
