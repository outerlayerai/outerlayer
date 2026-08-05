/**
 * Tests: GET /api/orgs/[orgName]/has-traces
 *
 * Covers the onboarding existence check, including the `?fresh=1` bypass that
 * skips the trace cache so the "waiting for your first trace" poll advances
 * within a poll interval. Auth lives in the wrapper; the fixture stubs it.
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

const { mockCtx } = vi.hoisted(() => ({
  mockCtx: Object.freeze({
    userId: 'user-1',
    tenantId: 'tenant-1',
    appId: 'app-1',
    dataRetentionDays: -1,
  }),
}));

vi.mock('@/lib/api/with-api', async () => {
  const { buildWithApiMock } = await import('@/lib/api/__tests__/fixtures');
  return buildWithApiMock(mockCtx);
});

const mockGetCachedTraces = vi.fn();
const mockGetAnalyticsService = vi.fn();

vi.mock('@/lib/analytics/cache', () => ({
  getCachedTraces: (...args: unknown[]) => mockGetCachedTraces(...args),
}));
vi.mock('@/lib/analytics/service', () => ({
  getAnalyticsService: () => mockGetAnalyticsService(),
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as hasTraces } from '../route';

const req = (qs: string) => new Request(`http://localhost/api/orgs/acme/has-traces${qs}`);
// The URL org segment Next passes to the handler; the wrapper validates it.
const routeCtx = { params: Promise.resolve({ orgName: 'acme' }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/[orgName]/has-traces', () => {
  it('uses the cached path when fresh is not set, and maps total>0 → hasTraces', async () => {
    mockGetCachedTraces.mockResolvedValue({ total: 3 });

    const res = await hasTraces(req('?appId=app-1'), routeCtx);

    expect(await res.json()).toEqual({ hasTraces: true });
    expect(mockGetCachedTraces).toHaveBeenCalledWith(mockCtx, 1, 0);
    expect(mockGetAnalyticsService).not.toHaveBeenCalled();
  });

  it('reports no traces when the cached total is 0', async () => {
    mockGetCachedTraces.mockResolvedValue({ total: 0 });
    expect(await (await hasTraces(req('?appId=app-1'), routeCtx)).json()).toEqual({ hasTraces: false });
  });

  it('fresh=1 bypasses the cache and queries the live service directly', async () => {
    const getTraces = vi.fn().mockResolvedValue({ total: 2 });
    mockGetAnalyticsService.mockReturnValue({ getTraces });

    const res = await hasTraces(req('?appId=app-1&fresh=1'), routeCtx);

    expect(await res.json()).toEqual({ hasTraces: true });
    expect(getTraces).toHaveBeenCalledWith(mockCtx, { limit: 1, offset: 0 });
    expect(mockGetCachedTraces).not.toHaveBeenCalled();
  });

  it('fresh path reports false when the live service returns no traces', async () => {
    mockGetAnalyticsService.mockReturnValue({
      getTraces: vi.fn().mockResolvedValue({ total: 0 }),
    });
    expect(await (await hasTraces(req('?appId=app-1&fresh=1'), routeCtx)).json()).toEqual({
      hasTraces: false,
    });
  });

  it('fresh path degrades to false (no 500) when no analytics backend is configured', async () => {
    mockGetAnalyticsService.mockReturnValue(null);
    expect(await (await hasTraces(req('?appId=app-1&fresh=1'), routeCtx)).json()).toEqual({
      hasTraces: false,
    });
  });
});
