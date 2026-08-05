/**
 * Tests for temp-access-guard.ts — the read-only marker that ClickHouse-write
 * routes consult so a platform-admin temporary-access grant (read-only by
 * contract) cannot mutate a store RLS does not gate.
 *
 * Boundary: MSW seeds the `temp_access_grant` REST traffic the service-role
 * admin client issues (per apps/tenant-dashboard/CLAUDE.md — no hand-rolled
 * Supabase mock). The guard reads through the admin client, so no session seed
 * is needed; only the table rows matter.
 *
 * The bug classes pinned here:
 *   - active grant for (user, tenant) → blocks  (the reported vulnerability)
 *   - grant for a DIFFERENT tenant → does NOT block  (an admin who holds a
 *     grant elsewhere must stay free to write in their own org)
 *   - revoked / expired grant → does NOT block  (the active-only filters must
 *     be emulated, not dropped)
 *   - lookup error → does NOT block  (fail-open: one privileged edge must not
 *     become a write outage for every ordinary caller)
 */

import { describe, it, expect } from 'vitest';
import { seedSupabaseMswState } from '../../test-helpers/msw-handlers';
import { isTempAccessReadOnlySession } from './temp-access-guard';

const USER = 'admin-1';
const TENANT = 'tenant-1';

const activeGrant = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1',
  created_by: USER,
  tenant_id: TENANT,
  // Far-future expiry → active.
  expires_at: '2099-01-01T00:00:00.000Z',
  revoked_at: null,
  ...over,
});

describe('isTempAccessReadOnlySession', () => {
  it('returns true when the caller holds an active grant for the tenant', async () => {
    seedSupabaseMswState({ tempAccessGrants: [activeGrant()] });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(true);
  });

  it('returns false when the caller has no grant at all', async () => {
    seedSupabaseMswState({ tempAccessGrants: [] });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });

  it('returns false when the only grant is for a DIFFERENT tenant', async () => {
    // A platform admin who holds a temp grant on tenant-other must still be
    // able to write in tenant-1, where their access is a genuine membership.
    seedSupabaseMswState({
      tempAccessGrants: [activeGrant({ tenant_id: 'tenant-other' })],
    });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });

  it('returns false when the grant belongs to a different user', async () => {
    seedSupabaseMswState({
      tempAccessGrants: [activeGrant({ created_by: 'someone-else' })],
    });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });

  it('returns false when the grant has been revoked', async () => {
    seedSupabaseMswState({
      tempAccessGrants: [activeGrant({ revoked_at: '2026-01-01T00:00:00.000Z' })],
    });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });

  it('returns false when the grant has expired', async () => {
    seedSupabaseMswState({
      tempAccessGrants: [activeGrant({ expires_at: '2000-01-01T00:00:00.000Z' })],
    });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });

  it('fails open (returns false) when the grant lookup errors', async () => {
    seedSupabaseMswState({
      tempAccessGrants: [activeGrant()],
      tableErrors: { temp_access_grant_select: { message: 'db unavailable' } },
    });

    expect(await isTempAccessReadOnlySession(USER, TENANT)).toBe(false);
  });
});
