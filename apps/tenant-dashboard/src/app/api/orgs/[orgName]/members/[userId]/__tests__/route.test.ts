/**
 * Tests: PATCH, DELETE /api/orgs/[orgName]/members/[userId]
 *
 * Runs the REAL `withApi` wrapper and route bodies; only `@/lib/adapters`
 * (context/permission resolution + the `MembershipService` crossing) is
 * mocked.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this._body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      return this._body;
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { error: vi.fn() },
}));

const { mockLoadCtx, mockCheckPerm, mockChangeRole, mockRemoveMember } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  mockChangeRole: vi.fn(),
  mockRemoveMember: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
  changeMemberRole: mockChangeRole,
  removeMember: mockRemoveMember,
}));

import { PATCH, DELETE } from '../route';

const ACTOR = { userId: 'user-1', role: 'admin' };
const CTX = { db: {}, tenantId: 'tenant-1', actor: ACTOR };
const routeCtx = { params: Promise.resolve({ orgName: 'acme', userId: 'user-2' }) };

function patchReq(body: unknown) {
  return new Request('http://localhost/api/orgs/acme/members/user-2', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
function deleteReq() {
  return new Request('http://localhost/api/orgs/acme/members/user-2', { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe('PATCH /api/orgs/[orgName]/members/[userId]', () => {
  it('gates on membership.update and forwards the path userId + body role to the adapter', async () => {
    mockChangeRole.mockResolvedValue({ success: true });

    const res = await PATCH(patchReq({ role: 'read', customRoleId: 'cr-1' }), routeCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.update');
    expect(mockChangeRole).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
      newRole: 'read',
      customRoleId: 'cr-1',
    });
  });

  it('returns 403 without calling the adapter when the actor lacks membership.update', async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await PATCH(patchReq({ role: 'read' }), routeCtx);

    expect(res.status).toBe(403);
    expect(mockChangeRole).not.toHaveBeenCalled();
  });

  it('maps the last-owner-protection business failure to 400', async () => {
    mockChangeRole.mockResolvedValue({
      success: false,
      error: 'Cannot demote the last owner. Transfer ownership first.',
    });

    const res = await PATCH(patchReq({ role: 'read' }), routeCtx);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Cannot demote the last owner. Transfer ownership first.');
  });

  it('maps a "not found" business failure to 404', async () => {
    mockChangeRole.mockResolvedValue({ success: false, error: 'User not found in organization' });

    const res = await PATCH(patchReq({ role: 'read' }), routeCtx);

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/orgs/[orgName]/members/[userId]', () => {
  it('gates on membership.delete and forwards the path userId to the adapter', async () => {
    mockRemoveMember.mockResolvedValue({ success: true });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.delete');
    expect(mockRemoveMember).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });
  });

  it('returns 403 without calling the adapter when the actor lacks membership.delete', async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(403);
    expect(mockRemoveMember).not.toHaveBeenCalled();
  });

  it('maps the last-owner-protection business failure to 400', async () => {
    mockRemoveMember.mockResolvedValue({
      success: false,
      error: 'Cannot remove the last owner from the organization',
    });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(400);
  });

  it('maps a "not found" business failure to 404', async () => {
    mockRemoveMember.mockResolvedValue({ success: false, error: 'User not found in organization' });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(404);
  });
});
