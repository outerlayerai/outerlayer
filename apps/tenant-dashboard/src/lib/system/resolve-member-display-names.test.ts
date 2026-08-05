/**
 * `resolveMemberDisplayNames` — the admin-client bridge from a tenant's
 * ClickHouse-stamped membership ids to developer display names. Real MSW
 * `membership`/`profile` tables (the service-role client the function
 * constructs targets the same `SUPABASE_API.url` these tests' MSW server
 * intercepts), not a hand-faked query chain — so the tenant filter, the
 * name/email fallback, and every degrade-to-empty branch are exercised for
 * real.
 */
import {
  seedMembershipMswState,
  seedSupabaseMswState,
  type MembershipMswRow,
} from '@/test-helpers/msw-handlers';

import { resolveMemberDisplayNames } from './resolve-member-display-names';

const TENANT_ID = 'tenant-1';

function membership(overrides: Partial<MembershipMswRow> & { id: string; user_id: string }): MembershipMswRow {
  return { tenant_id: TENANT_ID, role: 'write', status: 'active', ...overrides };
}

describe('resolveMemberDisplayNames', () => {
  it('returns {} immediately for an empty membershipIds list, without querying anything', async () => {
    const result = await resolveMemberDisplayNames(TENANT_ID, []);
    expect(result).toEqual({});
  });

  it('resolves a membership id to its user\'s name, scoped to the given tenant', async () => {
    seedMembershipMswState({ memberships: [membership({ id: 'mem-1', user_id: 'user-1' })] });
    seedSupabaseMswState({ profiles: [{ id: 'user-1', name: 'Ryan', email: 'ryan@example.com' }] });

    const result = await resolveMemberDisplayNames(TENANT_ID, ['mem-1']);

    expect(result).toEqual({ 'mem-1': 'Ryan' });
  });

  it('falls back to email when the profile has no name', async () => {
    seedMembershipMswState({ memberships: [membership({ id: 'mem-1', user_id: 'user-1' })] });
    seedSupabaseMswState({ profiles: [{ id: 'user-1', email: 'ryan@example.com' }] });

    const result = await resolveMemberDisplayNames(TENANT_ID, ['mem-1']);

    expect(result).toEqual({ 'mem-1': 'ryan@example.com' });
  });

  it('does not resolve a membership from a DIFFERENT tenant, even by exact id', async () => {
    seedMembershipMswState({ memberships: [membership({ id: 'mem-1', user_id: 'user-1', tenant_id: 'other-tenant' })] });
    seedSupabaseMswState({ profiles: [{ id: 'user-1', name: 'Ryan', email: 'ryan@example.com' }] });

    const result = await resolveMemberDisplayNames(TENANT_ID, ['mem-1']);

    expect(result).toEqual({});
  });

  it('returns {} when none of the requested membership ids exist (no profile lookup needed)', async () => {
    seedMembershipMswState({ memberships: [] });

    const result = await resolveMemberDisplayNames(TENANT_ID, ['mem-missing']);

    expect(result).toEqual({});
  });

  it('resolves multiple memberships, and omits a membership whose user has no profile row at all', async () => {
    seedMembershipMswState({
      memberships: [
        membership({ id: 'mem-1', user_id: 'user-1' }),
        membership({ id: 'mem-2', user_id: 'user-2' }),
      ],
    });
    seedSupabaseMswState({ profiles: [{ id: 'user-1', name: 'Ryan', email: 'ryan@example.com' }] });

    const result = await resolveMemberDisplayNames(TENANT_ID, ['mem-1', 'mem-2']);

    expect(result).toEqual({ 'mem-1': 'Ryan' });
  });

});

describe('resolveMemberDisplayNames — degrade on failure', () => {
  it('degrades to {} instead of throwing when the admin client itself cannot be constructed', async () => {
    vi.resetModules();
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => {
        throw new Error('connection refused');
      },
    }));
    const { resolveMemberDisplayNames: resolveWithBrokenClient } = await import('./resolve-member-display-names');

    const result = await resolveWithBrokenClient(TENANT_ID, ['mem-1']);

    expect(result).toEqual({});
    vi.doUnmock('@supabase/supabase-js');
    vi.resetModules();
  });
});
