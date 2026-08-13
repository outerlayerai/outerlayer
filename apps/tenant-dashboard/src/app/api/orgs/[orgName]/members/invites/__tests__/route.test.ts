/**
 * Tests: POST /api/orgs/[orgName]/members/invites
 *
 * Runs the REAL `withApi` wrapper (`authRequired: false`) and route body;
 * only `@/lib/adapters` (context/permission resolution + the
 * `MembershipService` crossing) and `next/headers` are mocked.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => {
  // Extends the real `Response` (not a bare mock class) — this route
  // returns a `NextResponse.json(...)` directly from its handler for the
  // entitlement-denial path, and the real `withApi` wrapper's
  // `result instanceof Response` check needs it to actually be one.
  class MockNextResponse extends Response {
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { error: vi.fn() },
}));

const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({ headers: () => ({ get: headersGet }) }));

const { mockLoadCtx, mockCheckPerm, mockSendInvite } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  mockSendInvite: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
  sendMemberInvite: mockSendInvite,
}));

import { POST } from '../route';

const ACTOR = { userId: 'user-1', role: 'admin' };
const CTX = { db: {}, tenantId: 'tenant-1', actor: ACTOR };
const routeCtx = { params: Promise.resolve({ orgName: 'acme' }) };

function req(body: unknown, origin: string | null = 'https://acme.outerlayer.ai') {
  headersGet.mockReturnValue(origin);
  return new Request('http://localhost/api/orgs/acme/members/invites', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe('POST /api/orgs/[orgName]/members/invites', () => {
  // proves AC-059-03
  it('gates on membership.insert and forwards the parsed invite + origin to the adapter', async () => {
    mockSendInvite.mockResolvedValue({ success: true, membershipId: 'mem-1' });

    const res = await POST(
      req({ name: 'Ryan', email: 'ryan@example.com', role: 'write' }),
      routeCtx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membershipId: 'mem-1' });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.insert');
    expect(mockSendInvite).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      name: 'Ryan',
      email: 'ryan@example.com',
      role: 'write',
      origin: 'https://acme.outerlayer.ai',
      appRoles: undefined,
      customRoleId: undefined,
    });
  });

  it('returns 400 without touching the actor when the body fails validation', async () => {
    const res = await POST(req({ name: '', email: 'not-an-email', role: 'write' }), routeCtx);

    expect(res.status).toBe(400);
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  // proves AC-059-04
  it('returns 403 without calling the adapter when the actor lacks membership.insert', async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await POST(req({ name: 'Ryan', email: 'ryan@example.com', role: 'write' }), routeCtx);

    expect(res.status).toBe(403);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it('maps a business-rule denial (e.g. only owners can invite owners) to 400', async () => {
    mockSendInvite.mockResolvedValue({
      success: false,
      error: 'Only owners can invite users as owners',
    });

    const res = await POST(req({ name: 'Ryan', email: 'ryan@example.com', role: 'owner' }), routeCtx);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Only owners can invite users as owners');
  });

  // proves AC-059-12
  it('maps an entitlement denial to 403 with the entitlement_denied code and the deny-info payload', async () => {
    const entitlement = {
      featureKey: 'max_users',
      featureDisplayName: 'Team members',
      requiredTier: 'team',
      requiredTierDisplayName: 'Team',
      isSelfServe: true,
      pricing: '$20/seat',
      upgradeUrl: 'https://outerlayer.ai/upgrade',
      currentLimit: 5,
      requiredTierLimit: 20,
    };
    mockSendInvite.mockResolvedValue({ success: false, error: 'entitlement_denied', entitlement });

    const res = await POST(req({ name: 'Ryan', email: 'ryan@example.com', role: 'write' }), routeCtx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('entitlement_denied');
    expect(body.error.entitlement).toEqual(entitlement);
  });

  it('falls back to a 400 business-rule denial when the error is "entitlement_denied" but the service sent no deny-info payload', async () => {
    mockSendInvite.mockResolvedValue({ success: false, error: 'entitlement_denied' });

    const res = await POST(req({ name: 'Ryan', email: 'ryan@example.com', role: 'write' }), routeCtx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).not.toBe('entitlement_denied');
  });
});
