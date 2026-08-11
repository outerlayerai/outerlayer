/**
 * Route-level tests for GET /v1/sessions and GET /v1/sessions/{traceId}.
 *
 * Anonymization, actorId rejection, and span-cap truncation are proven at
 * the package level (`observability-service/src/__tests__/agent-sessions.test.ts`);
 * this suite pins the REST contract: the machine-key policy the route
 * constructs, and the 404 mapping for a null service result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../_shared';

const listSessions = vi.fn();
const getSessionDetail = vi.fn();
const getGatewaySessionsService = vi.fn(() => ({ listSessions, getSessionDetail }));
const getGatewayChQuery = vi.fn(() => null);
vi.mock('../../analytics-factory', () => ({
  getGatewaySessionsService: (...args: unknown[]) => getGatewaySessionsService(...(args as [])),
  getGatewayChQuery: (...args: unknown[]) => getGatewayChQuery(...(args as [])),
}));

const getScopedSupabase = vi.fn();
vi.mock('../_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_shared')>();
  return {
    ...actual,
    getScopedSupabase: (...args: unknown[]) => getScopedSupabase(...(args as [])),
  };
});

import { ListSessions, GetSessionDetail } from '../sessions';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(permissions: string[] = ['session.read']): AppContext {
  return {
    req: { method: 'GET', path: '/v1/sessions' },
    env: { CLICKHOUSE_HOST: 'http://ch.local', OAUTH_STATE_SECRET: 'a'.repeat(32) },
    get: vi.fn((key: string) =>
      key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1', permissions, apiKeyId: 'key-1' } : undefined,
    ),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

function routeWithValidatedData<T extends { validatedData: unknown }>(
  RouteClass: new (params: unknown) => T,
  data: Record<string, unknown>,
): T {
  const route = new RouteClass(MOCK_ROUTE_OPTIONS);
  route.validatedData = data;
  return route;
}

describe('ListSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScopedSupabase.mockResolvedValue({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }) }) }),
    });
  });

  it('builds a machine-key policy with team-actor visibility off by default', async () => {
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildContext(['session.read']);

    await route.handle(c);

    expect(listSessions).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      query,
      { kind: 'machine-key', canSeeTeamActors: false },
      expect.any(Object),
    );
  });

  it('flips canSeeTeamActors on when the key carries agents.sessions.team.read', async () => {
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildContext(['session.read', 'agents.sessions.team.read']);

    await route.handle(c);

    expect(listSessions).toHaveBeenCalledWith(
      expect.any(Object),
      query,
      { kind: 'machine-key', canSeeTeamActors: true },
      expect.any(Object),
    );
  });

  it('maps a rejected actor filter to a 400', async () => {
    const { ValidationError } = await import('@repo/observability-service');
    listSessions.mockRejectedValue(new ValidationError('cannot filter by actor', 'actor'));
    const route = routeWithValidatedData(ListSessions, { query: { limit: 25, offset: 0, actor: 'membership-a' } });
    const c = buildContext(['session.read']);

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.status).toBe(400);
  });
});

describe('GetSessionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScopedSupabase.mockResolvedValue({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }) }) }),
    });
  });

  it('returns the session on a hit', async () => {
    const detail = { session: { traceId: 't1' }, spans: [], truncated: false, prOutcomes: [] };
    getSessionDetail.mockResolvedValue(detail);
    const route = routeWithValidatedData(GetSessionDetail, { params: { traceId: 't1' } });
    const c = buildContext();

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.body).toEqual({ data: detail });
  });

  // proves AC-052-03
  it('returns the identical 404 body for a missing trace and a cross-app trace', async () => {
    getSessionDetail.mockResolvedValue(null);
    const missingRoute = routeWithValidatedData(GetSessionDetail, { params: { traceId: 'missing' } });
    const crossAppRoute = routeWithValidatedData(GetSessionDetail, { params: { traceId: 'other-apps-trace' } });
    const c1 = buildContext();
    const c2 = buildContext();

    const missing = (await missingRoute.handle(c1)) as { body: unknown; status: number };
    const crossApp = (await crossAppRoute.handle(c2)) as { body: unknown; status: number };

    expect(missing.status).toBe(404);
    expect(crossApp.status).toBe(404);
    expect(missing.body).toEqual(crossApp.body);
  });
});
