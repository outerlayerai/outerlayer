/**
 * Tests: POST /api/orgs/[orgName]/members/invites/[inviteId]/resend
 *
 * Runs the REAL `withApi` wrapper and route body; the seams beneath
 * (`@/lib/adapters`, `@/features/members/service`, `next/headers`) are mocked.
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

const headersGet = vi.fn<(name: string) => string | null>(() => 'https://acme.outerlayer.ai');
vi.mock('next/headers', () => ({ headers: () => ({ get: headersGet }) }));

const { mockLoadCtx, mockCheckPerm, mockResendInvite, mockListMembers } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  mockResendInvite: vi.fn(),
  mockListMembers: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
  resendMemberInvite: mockResendInvite,
}));

vi.mock('@/features/members/service', () => ({
  listMembers: mockListMembers,
}));

import { POST } from '../route';

const ACTOR = { userId: 'user-1', role: 'admin' };
const CTX = { db: {}, tenantId: 'tenant-1', actor: ACTOR };
const routeCtx = { params: Promise.resolve({ orgName: 'acme', inviteId: 'mem-1' }) };
const req = () =>
  new Request('http://localhost/api/orgs/acme/members/invites/mem-1/resend', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe('POST /api/orgs/[orgName]/members/invites/[inviteId]/resend', () => {
  it('gates on membership.insert, resolves the invite email from the membership id, and resends', async () => {
    mockListMembers.mockResolvedValue([
      { membershipId: 'mem-1', membershipStatus: 'pending', email: 'ryan@example.com' },
      { membershipId: 'mem-2', membershipStatus: 'active', email: 'other@example.com' },
    ]);
    mockResendInvite.mockResolvedValue({ success: true });

    const res = await POST(req(), routeCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.insert');
    expect(mockResendInvite).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      email: 'ryan@example.com',
      origin: 'https://acme.outerlayer.ai',
    });
  });

  it('returns 404 without calling resend when the id does not name a pending invite', async () => {
    mockListMembers.mockResolvedValue([
      { membershipId: 'mem-1', membershipStatus: 'active', email: 'ryan@example.com' },
    ]);

    const res = await POST(req(), routeCtx);

    expect(res.status).toBe(404);
    expect(mockResendInvite).not.toHaveBeenCalled();
  });

  it('returns 403 without listing members when the actor lacks membership.insert', async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await POST(req(), routeCtx);

    expect(res.status).toBe(403);
    expect(mockListMembers).not.toHaveBeenCalled();
    expect(mockResendInvite).not.toHaveBeenCalled();
  });

  it('maps a rate-limit business failure to 400', async () => {
    mockListMembers.mockResolvedValue([
      { membershipId: 'mem-1', membershipStatus: 'pending', email: 'ryan@example.com' },
    ]);
    mockResendInvite.mockResolvedValue({
      success: false,
      error: 'An email was just recently sent. Please wait longer before trying to send another email',
    });

    const res = await POST(req(), routeCtx);

    expect(res.status).toBe(400);
  });
});
