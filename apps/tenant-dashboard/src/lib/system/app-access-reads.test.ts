/**
 * `app-access-reads` — the three admin reads the app-access UI needs (a
 * member cannot read a peer's `membership`/`profile` row under RLS). Real
 * MSW `app_member_role`/`membership`/`app`/`profile` handlers, not a
 * hand-faked query chain, so the tenant/membership/app filters and the
 * TypeScript-side join are exercised for real.
 */
import { http, HttpResponse } from 'msw';

import {
  seedMembershipMswState,
  seedSupabaseMswState,
  type AppMemberRoleMswRow,
} from '@/test-helpers/msw-handlers';
import { server } from '@/test-helpers/msw-server';

import { listAppMemberRoles, listAppsForDropdown, getMembershipAppScoped } from './app-access-reads';

const SUPABASE_URL = 'http://localhost:54321';

const TENANT_ID = 'tenant-1';

function amr(overrides: Partial<AppMemberRoleMswRow> & { id: string; membership_id: string; app_id: string }): AppMemberRoleMswRow {
  return { tenant_id: TENANT_ID, role: 'read', created_at: '2026-01-01T00:00:00Z', updated_at: null, ...overrides };
}

describe('listAppMemberRoles', () => {
  it('returns [] when the tenant has no app_member_role rows', async () => {
    seedMembershipMswState({ appMemberRoles: [] });

    const result = await listAppMemberRoles(TENANT_ID);

    expect(result).toEqual({ data: [] });
  });

  it('joins membership (user_id), app (name), and profile (name/email) for each row', async () => {
    seedMembershipMswState({
      appMemberRoles: [amr({ id: 'amr-1', membership_id: 'mem-1', app_id: 'app-1', role: 'write' })],
      memberships: [{ id: 'mem-1', user_id: 'user-1', tenant_id: TENANT_ID, role: 'write', status: 'active' }],
    });
    seedSupabaseMswState({
      apps: [{ id: 'app-1', tenant_id: TENANT_ID, name: 'My App' }],
      profiles: [{ id: 'user-1', name: 'Ryan', email: 'ryan@example.com' }],
    });

    const result = await listAppMemberRoles(TENANT_ID);

    expect(result).toEqual({
      data: [
        {
          id: 'amr-1',
          membershipId: 'mem-1',
          appId: 'app-1',
          appName: 'My App',
          role: 'write',
          memberName: 'Ryan',
          memberEmail: 'ryan@example.com',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
      ],
    });
  });

  it('applies the membershipId filter', async () => {
    seedMembershipMswState({
      appMemberRoles: [
        amr({ id: 'amr-1', membership_id: 'mem-1', app_id: 'app-1' }),
        amr({ id: 'amr-2', membership_id: 'mem-2', app_id: 'app-2' }),
      ],
    });

    const result = await listAppMemberRoles(TENANT_ID, { membershipId: 'mem-1' });

    expect(result).toEqual({ data: expect.arrayContaining([expect.objectContaining({ id: 'amr-1' })]) });
    expect((result as { data: unknown[] }).data).toHaveLength(1);
  });

  it('applies the appId filter independently of membershipId', async () => {
    seedMembershipMswState({
      appMemberRoles: [
        amr({ id: 'amr-1', membership_id: 'mem-1', app_id: 'app-1' }),
        amr({ id: 'amr-2', membership_id: 'mem-2', app_id: 'app-2' }),
      ],
    });

    const result = await listAppMemberRoles(TENANT_ID, { appId: 'app-2' });

    expect((result as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['amr-2']);
  });

  it('orders rows newest-first by created_at', async () => {
    seedMembershipMswState({
      appMemberRoles: [
        amr({ id: 'amr-old', membership_id: 'mem-1', app_id: 'app-1', created_at: '2026-01-01T00:00:00Z' }),
        amr({ id: 'amr-new', membership_id: 'mem-1', app_id: 'app-1', created_at: '2026-06-01T00:00:00Z' }),
      ],
    });

    const result = await listAppMemberRoles(TENANT_ID);

    expect((result as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['amr-new', 'amr-old']);
  });

  it('surfaces the query error', async () => {
    seedMembershipMswState({ forceAppMemberRoleError: 'permission denied' });

    const result = await listAppMemberRoles(TENANT_ID);

    expect(result).toEqual({ error: 'permission denied' });
  });

  it('falls back to empty strings when a profile is missing for a row', async () => {
    seedMembershipMswState({
      appMemberRoles: [amr({ id: 'amr-2', membership_id: 'mem-2', app_id: 'app-2' })],
      memberships: [{ id: 'mem-2', user_id: 'user-x', tenant_id: TENANT_ID, role: 'read', status: 'active' }],
    });
    seedSupabaseMswState({
      apps: [{ id: 'app-2', tenant_id: TENANT_ID, name: 'Other' }],
      profiles: [],
    });

    const result = await listAppMemberRoles(TENANT_ID);

    expect(result).toEqual({
      data: [
        {
          id: 'amr-2',
          membershipId: 'mem-2',
          appId: 'app-2',
          appName: 'Other',
          role: 'read',
          memberName: '',
          memberEmail: '',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
      ],
    });
  });
});

describe('listAppsForDropdown', () => {
  it('returns the tenant apps sorted, mapped to {appId, name}', async () => {
    seedSupabaseMswState({
      apps: [
        { id: 'app-2', tenant_id: TENANT_ID, name: 'Zebra' },
        { id: 'app-1', tenant_id: TENANT_ID, name: 'Alpha' },
      ],
    });

    const result = await listAppsForDropdown(TENANT_ID);

    expect(result).toEqual({
      data: [
        { appId: 'app-1', name: 'Alpha' },
        { appId: 'app-2', name: 'Zebra' },
      ],
    });
  });

  it('surfaces the query error instead of returning data', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, () =>
        HttpResponse.json({ message: 'permission denied for table app' }, { status: 500 }),
      ),
    );

    const result = await listAppsForDropdown(TENANT_ID);

    expect(result).toEqual({ error: 'permission denied for table app' });
  });
});

describe('getMembershipAppScoped', () => {
  it('returns the membership is_app_scoped flag', async () => {
    seedMembershipMswState({
      memberships: [{ id: 'mem-1', user_id: 'user-1', tenant_id: TENANT_ID, role: 'read', status: 'active', is_app_scoped: true }],
    });

    const result = await getMembershipAppScoped(TENANT_ID, 'mem-1');

    expect(result).toEqual({ data: { isAppScoped: true } });
  });

  it('defaults to false when is_app_scoped is unset', async () => {
    seedMembershipMswState({
      memberships: [{ id: 'mem-1', user_id: 'user-1', tenant_id: TENANT_ID, role: 'read', status: 'active' }],
    });

    const result = await getMembershipAppScoped(TENANT_ID, 'mem-1');

    expect(result).toEqual({ data: { isAppScoped: false } });
  });

  it('surfaces the query error when the membership is not found', async () => {
    seedMembershipMswState({ memberships: [] });

    const result = await getMembershipAppScoped(TENANT_ID, 'mem-missing');

    expect(result).toEqual({ error: expect.any(String) });
  });
});
