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

const checkBearerPermission = vi.fn();
vi.mock('../../../lib/verify-bearer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/verify-bearer')>();
  return {
    ...actual,
    checkBearerPermission: (...args: unknown[]) => checkBearerPermission(...(args as [])),
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
      key === 'user'
        ? { authMode: 'apikey', tenantId: 'tenant-1', appId: 'app-1', permissions, apiKeyId: 'key-1' }
        : undefined,
    ),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

/** A bearer (dashboard/OAuth) caller — a seat, not a machine key. */
function buildBearerContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/sessions' },
    env: { CLICKHOUSE_HOST: 'http://ch.local', OAUTH_STATE_SECRET: 'a'.repeat(32) },
    get: vi.fn((key: string) =>
      key === 'user'
        ? {
            authMode: 'bearer',
            tenantId: 'tenant-1',
            appId: 'app-1',
            gatewayUserId: 'user-1',
            userJwt: 'jwt-1',
            permissions: [],
          }
        : undefined,
    ),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

/** A membership-table stub servicing both `resolveMembershipId`'s
 * `.eq(user_id).eq(tenant_id).single()` chain and the actor-name resolver's
 * `.eq(tenant_id).in(ids)` chain off the same `.from().select().eq()` root. */
function membershipSupabaseClient(callerMembershipId: string | null) {
  const afterFirstEq = {
    eq: () => ({ single: async () => ({ data: callerMembershipId ? { id: callerMembershipId } : null }) }),
    in: async () => ({ data: [] }),
  };
  return {
    from: () => ({ select: () => ({ eq: () => afterFirstEq }) }),
  };
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

  // A bearer caller without agents.sessions.team.read must be confined to
  // their own seat — `session.read` alone (granted to every role) must never
  // widen a bearer read to the team-wide machine-key policy.
  it('builds a self-scoped dashboard-member policy for a bearer caller without team.read', async () => {
    checkBearerPermission.mockResolvedValue(false);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildBearerContext();

    await route.handle(c);

    expect(checkBearerPermission).toHaveBeenCalledWith({
      env: c.env,
      userJwt: 'jwt-1',
      permission: 'agents.sessions.team.read',
      appId: 'app-1',
      requestTenantId: 'tenant-1',
    });
    expect(listSessions).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      query,
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: false },
      expect.any(Object),
    );
  });

  it('builds a team-wide dashboard-member policy for a bearer caller with team.read', async () => {
    checkBearerPermission.mockResolvedValue(true);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildBearerContext();

    await route.handle(c);

    expect(listSessions).toHaveBeenCalledWith(
      expect.any(Object),
      query,
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: true },
      expect.any(Object),
    );
  });

  it('fails closed to an unmatchable membershipId when the caller has no membership row', async () => {
    checkBearerPermission.mockResolvedValue(false);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient(null));
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildBearerContext();

    await route.handle(c);

    const policy = listSessions.mock.calls[0]![2] as { kind: string; membershipId: string; canSeeTeam: boolean };
    expect(policy.kind).toBe('dashboard-member');
    expect(policy.canSeeTeam).toBe(false);
    expect(policy.membershipId).not.toBe('membership-1');
    expect(policy.membershipId.length).toBeGreaterThan(0);
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

  // proves the SEC-2 fix: a bearer caller without agents.sessions.team.read
  // gets the same 404 for a teammate's traceId as for one that doesn't
  // exist — the caller-scoped policy reaches the service either way, and
  // the service (proven separately in agent-sessions.test.ts) 404s a
  // transcript pinned to another actor.
  it('passes a self-scoped dashboard-member policy for a bearer caller reading another traceId', async () => {
    checkBearerPermission.mockResolvedValue(false);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    getSessionDetail.mockResolvedValue(null);
    const route = routeWithValidatedData(GetSessionDetail, { params: { traceId: 'teammates-trace' } });
    const c = buildBearerContext();

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(getSessionDetail).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      'teammates-trace',
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: false },
      expect.any(Object),
    );
    expect(result.status).toBe(404);
  });
});
