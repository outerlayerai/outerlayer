/**
 * Tests: GET /api/orgs/[orgName]/roles
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

const { mockLoadCtx } = vi.hoisted(() => ({ mockLoadCtx: vi.fn() }));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
}));

import { GET } from '../route';

const CTX = { db: {}, tenantId: 'tenant-1', actor: { userId: 'user-1', role: 'read' } };
const routeCtx = { params: Promise.resolve({ orgName: 'acme' }) };
const req = () => new Request('http://localhost/api/orgs/acme/roles');

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
});

describe('GET /api/orgs/[orgName]/roles', () => {
  it('returns the built-in role catalog for any authenticated org member (no permission gate)', async () => {
    const res = await GET(req(), routeCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roles: [
        { value: 'owner', label: 'Owner' },
        { value: 'admin', label: 'Admin' },
        { value: 'write', label: 'Write' },
        { value: 'read', label: 'Read' },
        { value: 'disabled', label: 'Disabled' },
      ],
    });
  });

  it('returns 401 without a body when the session is not authenticated', async () => {
    mockLoadCtx.mockRejectedValue(new Error('Not authenticated'));

    const res = await GET(req(), routeCtx);

    expect(res.status).toBe(401);
  });
});
