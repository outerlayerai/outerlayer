/**
 * `loadMembersForApi` — the API-route counterpart of the RSC settings page's
 * direct `listMembers` call, gated behind `requireMembershipContext` instead
 * of the page's own access control.
 *
 * `findPendingInviteByMembershipId` — the lookup the resend route uses to
 * bridge its id-addressed URL to `MembershipService.resendInviteLink`'s
 * email-keyed contract; pinned against both a match and the "wrong status"
 * case (an id that names an active, not pending, membership).
 */

const { mockRequireMembershipContext, mockListMembers } = vi.hoisted(() => ({
  mockRequireMembershipContext: vi.fn(),
  mockListMembers: vi.fn(),
}));

vi.mock('./request-context', () => ({
  requireMembershipContext: mockRequireMembershipContext,
}));

vi.mock('./service', () => ({
  listMembers: mockListMembers,
}));

import { loadMembersForApi, findPendingInviteByMembershipId } from './read';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadMembersForApi', () => {
  it('gates on membership.read and lists members for the resolved tenant', async () => {
    mockRequireMembershipContext.mockResolvedValue({
      db: {},
      tenantId: 'tenant-1',
      actor: { userId: 'user-1', role: 'admin' },
    });
    const rows = [{ id: 'u1' }] as never;
    mockListMembers.mockResolvedValue(rows);

    const result = await loadMembersForApi('acme');

    expect(result).toBe(rows);
    expect(mockRequireMembershipContext).toHaveBeenCalledWith('membership.read', 'acme');
    expect(mockListMembers).toHaveBeenCalledWith('tenant-1');
  });
});

describe('findPendingInviteByMembershipId', () => {
  const members = [
    { membershipId: 'mem-1', membershipStatus: 'pending', email: 'ryan@example.com' },
    { membershipId: 'mem-2', membershipStatus: 'active', email: 'other@example.com' },
  ] as never;

  it('returns the matching pending member', async () => {
    mockListMembers.mockResolvedValue(members);

    const result = await findPendingInviteByMembershipId('tenant-1', 'mem-1');

    expect(result).toEqual({
      membershipId: 'mem-1',
      membershipStatus: 'pending',
      email: 'ryan@example.com',
    });
  });

  it('returns undefined when the id names an active (not pending) membership', async () => {
    mockListMembers.mockResolvedValue(members);

    const result = await findPendingInviteByMembershipId('tenant-1', 'mem-2');

    expect(result).toBeUndefined();
  });

  it('returns undefined when no membership matches the id', async () => {
    mockListMembers.mockResolvedValue(members);

    const result = await findPendingInviteByMembershipId('tenant-1', 'mem-does-not-exist');

    expect(result).toBeUndefined();
  });
});
