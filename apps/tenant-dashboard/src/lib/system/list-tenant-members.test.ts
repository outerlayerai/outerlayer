/**
 * `listTenantMembers` — the members list read, confining the admin client the
 * legacy `users.tsx` React Server Component (RSC) constructed itself. Real MSW `membership`/`profile`/
 * admin-user tables, not a hand-faked query chain, so the tenant + status
 * filter, the custom-role join, and the confirmation-state read are exercised
 * for real.
 */
import {
  seedMembershipMswState,
  seedSupabaseAuth,
  seedSupabaseMswState,
  type MembershipMswRow,
} from '@/test-helpers/msw-handlers';

import { listTenantMembers } from './list-tenant-members';

const TENANT_ID = 'tenant-1';

function membership(overrides: Partial<MembershipMswRow> & { id: string; user_id: string }): MembershipMswRow {
  return { tenant_id: TENANT_ID, role: 'write', status: 'active', ...overrides };
}

describe('listTenantMembers', () => {
  it('returns [] when the tenant has no active or pending memberships', async () => {
    seedMembershipMswState({ memberships: [] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([]);
  });

  it('joins membership + profile + confirmation state for an active member', async () => {
    seedSupabaseAuth({
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'ryan@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } as never,
    });
    seedMembershipMswState({
      memberships: [membership({ id: 'mem-1', user_id: '11111111-1111-1111-1111-111111111111', role: 'admin' })],
    });
    seedSupabaseMswState({ profiles: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Ryan', email: 'ryan@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Ryan',
        email: 'ryan@example.com',
        role: 'admin',
        membershipId: 'mem-1',
        membershipStatus: 'active',
        customRoleId: undefined,
        customRoleName: undefined,
        isConfirmed: true,
      },
    ]);
  });

  it('reports isConfirmed=false for a member whose auth user has no email_confirmed_at (pending invite)', async () => {
    seedSupabaseAuth({ user: { id: '22222222-2222-2222-2222-222222222222', email: 'invited@example.com' } as never });
    seedMembershipMswState({
      memberships: [membership({ id: 'mem-2', user_id: '22222222-2222-2222-2222-222222222222', role: 'read', status: 'pending' })],
    });
    seedSupabaseMswState({ profiles: [{ id: '22222222-2222-2222-2222-222222222222', name: 'Invited', email: 'invited@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([
      {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Invited',
        email: 'invited@example.com',
        role: 'read',
        membershipId: 'mem-2',
        membershipStatus: 'pending',
        customRoleId: undefined,
        customRoleName: undefined,
        isConfirmed: false,
      },
    ]);
  });

  it('reports isConfirmed=false without throwing when the admin user lookup finds no auth user at all (no session seeded for that id)', async () => {
    // No seedSupabaseAuth call for this user id — the admin `getUserById`
    // mock 404s and resolves `{ user: null }`, not just a user with an unset
    // `email_confirmed_at`.
    seedMembershipMswState({
      memberships: [membership({ id: 'mem-5', user_id: '55555555-5555-5555-5555-555555555555', role: 'read' })],
    });
    seedSupabaseMswState({ profiles: [{ id: '55555555-5555-5555-5555-555555555555', name: 'Ghost', email: 'ghost@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([
      {
        id: '55555555-5555-5555-5555-555555555555',
        name: 'Ghost',
        email: 'ghost@example.com',
        role: 'read',
        membershipId: 'mem-5',
        membershipStatus: 'active',
        customRoleId: undefined,
        customRoleName: undefined,
        isConfirmed: false,
      },
    ]);
  });

  it('passes through a non-empty custom_role_id on the membership row', async () => {
    seedSupabaseAuth({ user: { id: '66666666-6666-6666-6666-666666666666', email: 'cr@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } as never });
    seedMembershipMswState({
      memberships: [
        membership({ id: 'mem-6', user_id: '66666666-6666-6666-6666-666666666666', role: 'read', custom_role_id: 'cr-1' }),
      ],
    });
    seedSupabaseMswState({ profiles: [{ id: '66666666-6666-6666-6666-666666666666', name: 'Custom', email: 'cr@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([
      expect.objectContaining({ id: '66666666-6666-6666-6666-666666666666', customRoleId: 'cr-1' }),
    ]);
  });

  it('does not include a member from a DIFFERENT tenant, even with a matching profile', async () => {
    seedSupabaseAuth({ user: { id: '33333333-3333-3333-3333-333333333333', email: 'x@example.com' } as never });
    seedMembershipMswState({
      memberships: [membership({ id: 'mem-3', user_id: '33333333-3333-3333-3333-333333333333', tenant_id: 'other-tenant' })],
    });
    seedSupabaseMswState({ profiles: [{ id: '33333333-3333-3333-3333-333333333333', name: 'X', email: 'x@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([]);
  });

  // proves AC-077-14
  it('excludes a disabled membership (only active/pending are listed)', async () => {
    seedSupabaseAuth({ user: { id: '44444444-4444-4444-4444-444444444444', email: 'disabled@example.com' } as never });
    seedMembershipMswState({
      memberships: [membership({ id: 'mem-4', user_id: '44444444-4444-4444-4444-444444444444', role: 'disabled', status: 'disabled' as never })],
    });
    seedSupabaseMswState({ profiles: [{ id: '44444444-4444-4444-4444-444444444444', name: 'X', email: 'disabled@example.com' }] });

    const result = await listTenantMembers(TENANT_ID);

    expect(result).toEqual([]);
  });
});
