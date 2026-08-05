/**
 * Tests: GET /api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}
 *
 * The route is a thin wrapper: resolve a single run through `evalsService.get`
 * (an internal service seam — mocked per the testing rules) on the request-
 * tenant client. We pin the wrapper's jobs: the run passes through on a hit,
 * the lookup is scoped to the tenant-verified appId from `withApi` (NOT
 * anything client-supplied) plus the runId, a miss becomes a 404 with the
 * resource-specific code, and a `[appId]` path segment disagreeing with the
 * `?appId` query is rejected before any read. The get's real-DB behaviour
 * (including the null-on-RLS-miss path) is proven in `features/evals/
 * service.test.ts`.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/config-global.server', () => ({
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  UNKEY_API_KEY: 'test-key',
}));

// The route builds a request-tenant (RLS) client; stub the cookie store so the
// real factory constructs inert. The `evalsService` seam below is what the
// assertions pin — the RLS scoping itself is proven in the acceptance test.
vi.mock('next/headers', () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}));

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

const mockGet = vi.fn();
vi.mock('@/features/evals/service', () => ({
  evalsService: { get: (...args: unknown[]) => mockGet(...args) },
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as runById } from '../route';

const req = () =>
  new Request('http://localhost/api/orgs/org/apps/app-1/evals/runs/run-1?appId=app-1');
const routeCtx = (
  p: { orgName: string; appId: string; runId: string } = {
    orgName: 'org',
    appId: 'app-1',
    runId: 'run-1',
  },
) => ({ params: Promise.resolve(p) });

const RUN = {
  id: 'run-1',
  status: 'succeeded' as const,
  card: { verdict: 'clear' },
  cost_usd: 1.5,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}', () => {
  it('returns the run, scoped to the tenant-verified appId + the runId', async () => {
    mockGet.mockResolvedValue(RUN);

    const res = await runById(req(), routeCtx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: RUN });
    // The lookup uses the tenant-verified appId (from withApi) and the path
    // runId, on a request-tenant service context (never a claim tenant).
    expect(mockGet).toHaveBeenCalledWith(
      expect.objectContaining({
        db: expect.anything(),
        tenantId: 'tenant-1',
        actor: { userId: 'user-1', role: '' },
      }),
      'app-1',
      'run-1',
    );
  });

  it('404s with the resource-specific code when the run does not resolve', async () => {
    mockGet.mockResolvedValue(null);

    const res = await runById(req(), routeCtx());

    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual(
      expect.objectContaining({ code: 'eval_run_not_found' }),
    );
  });

  it('rejects a [appId] path segment that disagrees with the ?appId query (400, no read)', async () => {
    const res = await runById(
      req(),
      routeCtx({ orgName: 'org', appId: 'app-2', runId: 'run-1' }),
    );

    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('registers the canonical OpenAPI contract (path, tags, request, responses)', async () => {
    const { capturedRouteSchemas } = await import('@/lib/api/__tests__/fixtures');
    const schema = capturedRouteSchemas.find(
      (s) => s.path === '/api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}',
    );
    expect(schema).toMatchObject({
      method: 'get',
      path: '/api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}',
      tags: ['Evals'],
      operationId: 'evals-run-get',
      remapNotFound: 'eval_run_not_found',
    });
    // The route validates BOTH the ?appId query and the path params.
    expect(schema!.request).toMatchObject({
      query: expect.anything(),
      params: expect.anything(),
    });
    expect(Object.keys(schema!.responses)).toEqual(['200', '400', '401', '404']);
  });
});
