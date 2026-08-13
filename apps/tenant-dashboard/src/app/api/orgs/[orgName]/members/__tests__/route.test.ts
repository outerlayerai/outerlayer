/**
 * Tests: GET /api/orgs/[orgName]/members
 *
 * Runs the REAL `withApi` wrapper (`authRequired: false` — org-scoped, no
 * `appId`) and the REAL `loadMembersForApi` read; only the seams beneath
 * (`@/lib/adapters` context/permission resolution, `@/features/members/service`)
 * are mocked.
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

const { mockLoadCtx, mockCheckPerm, mockListMembers } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  mockListMembers: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

vi.mock('@/features/members/service', () => ({
  listMembers: mockListMembers,
}));

import { GET } from '../route';

const ACTOR = { userId: 'user-1', role: 'admin' };
const CTX = { db: {}, tenantId: 'tenant-1', actor: ACTOR };
const routeCtx = { params: Promise.resolve({ orgName: 'acme' }) };
const req = () => new Request('http://localhost/api/orgs/acme/members');

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe('GET /api/orgs/[orgName]/members', () => {
  // proves AC-059-01
  it('gates on membership.read and returns the members list for the request tenant', async () => {
    mockListMembers.mockResolvedValue([{ id: 'u1', membershipStatus: 'active' }]);

    const res = await GET(req(), routeCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: [{ id: 'u1', membershipStatus: 'active' }] });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.read');
    expect(mockListMembers).toHaveBeenCalledWith('tenant-1');
  });

  // proves AC-059-02
  it('returns 403 without listing members when the actor lacks membership.read', async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await GET(req(), routeCtx);

    expect(res.status).toBe(403);
    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it('returns 401 without listing members when the session is not authenticated', async () => {
    mockLoadCtx.mockRejectedValue(new Error('Not authenticated'));

    const res = await GET(req(), routeCtx);

    expect(res.status).toBe(401);
    expect(mockListMembers).not.toHaveBeenCalled();
  });
});
