/**
 * Tests: GET /api/orgs/{orgName}/apps/{appId}/onboarding/checklist
 *
 * The route is a thin wrapper — it gathers the onboarding signals, runs them
 * through the pure `interpretChecklistCounts`, and decorates the result with
 * the git provider. We mock the signal-gathering seam
 * (`@/features/onboarding/service`, an allowed seam) so this test pins the
 * wrapper's jobs: the mapped booleans are returned verbatim, the provider
 * passes through, and a `[appId]` path segment that disagrees with the
 * `?appId` query is rejected. The boolean maths is unit-tested in
 * `features/onboarding/checklist.test.ts`.
 *
 * `gatherOnboardingSignals` is the true seam here (a function with a stable
 * signature), not the Supabase HTTP boundary — so `vi.mock` is correct, and we
 * never hand-roll a Supabase client. Auth lives in `withApi`; the fixture stubs
 * it.
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

const mockGatherSignals = vi.fn();
vi.mock('@/features/onboarding/service', () => ({
  gatherOnboardingSignals: (...args: unknown[]) => mockGatherSignals(...args),
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as checklist } from '../route';
import { interpretChecklistCounts } from '@/features/onboarding/checklist';

const req = () =>
  new Request('http://localhost/api/orgs/org/apps/app-1/onboarding/checklist?appId=app-1');
/** Next route-context params for the `[orgName]`/`[appId]` segments. */
const routeCtx = (p: { orgName: string; appId: string } = { orgName: 'org', appId: 'app-1' }) => ({
  params: Promise.resolve(p),
});

/** Zeroed signal payload — spread and override per case. */
const NO_SIGNALS = {
  traceTotal: 0,
  apiKeyCount: 0,
  memberCount: 0,
  gitProvider: null,
  gitInstallationId: null,
  gitBranchCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/{orgName}/apps/{appId}/onboarding/checklist', () => {
  it('maps gathered counts to checklist booleans and passes the provider through', async () => {
    const signals = {
      traceTotal: 7,
      apiKeyCount: 1,
      memberCount: 2,
      gitProvider: 'github',
      gitInstallationId: 'inst-1',
      gitBranchCount: 1,
    };
    mockGatherSignals.mockResolvedValue(signals);

    const res = await checklist(req(), routeCtx());

    // Whatever the pure mapper produces for these counts is exactly what the
    // route must return — pinning the wrapper's contract end-to-end.
    expect(await res.json()).toEqual({
      ...interpretChecklistCounts(signals),
      provider: 'github',
    });
    expect(await res.json()).toEqual({
      hasApiKey: true,
      hasTrace: true,
      hasTeammate: true,
      hasGitConnection: true,
      hasRepoLinked: true,
      provider: 'github',
    });
  });

  it('reports nothing done for all-zero counts, and a lone member is not a teammate', async () => {
    mockGatherSignals.mockResolvedValue({ ...NO_SIGNALS, memberCount: 1 });

    const res = await checklist(req(), routeCtx());

    expect(await res.json()).toEqual({
      hasApiKey: false,
      hasTrace: false,
      hasTeammate: false,
      hasGitConnection: false,
      hasRepoLinked: false,
      provider: null,
    });
  });

  it('passes the verified tenant context through to the signal gatherer', async () => {
    mockGatherSignals.mockResolvedValue(NO_SIGNALS);

    await checklist(req(), routeCtx());

    expect(mockGatherSignals).toHaveBeenCalledWith(mockCtx);
  });

  it('rejects a [appId] path segment that disagrees with the ?appId query (400, no gather)', async () => {
    mockGatherSignals.mockResolvedValue(NO_SIGNALS);

    // Path names app-2, query names app-1 — the URL would claim a different app
    // than withApi authorized. Fail-closed before any signal read.
    const res = await checklist(req(), routeCtx({ orgName: 'org', appId: 'app-2' }));

    expect(res.status).toBe(400);
    expect(mockGatherSignals).not.toHaveBeenCalled();
  });

  it('registers the canonical OpenAPI contract (path, tags, request, responses)', async () => {
    const { capturedRouteSchemas } = await import('@/lib/api/__tests__/fixtures');
    const schema = capturedRouteSchemas.find(
      (s) => s.path === '/api/orgs/{orgName}/apps/{appId}/onboarding/checklist',
    );
    expect(schema).toMatchObject({
      method: 'get',
      path: '/api/orgs/{orgName}/apps/{appId}/onboarding/checklist',
      tags: ['Onboarding'],
      operationId: 'onboarding-checklist',
      responses: {
        200: {
          description:
            '`{ hasApiKey, hasTrace, hasTeammate, hasGitConnection, hasRepoLinked, provider }`.',
        },
        400: { description: 'Invalid query params.' },
        401: { description: 'Not authenticated.' },
      },
    });
    // The route validates BOTH the ?appId query and the path params.
    expect(schema!.request).toMatchObject({
      query: expect.anything(),
      params: expect.anything(),
    });
    expect(Object.keys(schema!.responses)).toEqual(['200', '400', '401']);
  });
});
