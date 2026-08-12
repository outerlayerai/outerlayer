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
import { errorResponse } from '../_shared';
import type { SessionAccessPolicy } from '@repo/observability-service';
import { ListSessionsQuerySchema, SessionsListResponseSchema, SessionDetailResponseSchema } from '@repo/api-schemas';

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

import {
  ListSessions,
  GetSessionDetail,
  GetSessionDetailParamsSchema,
  buildPorts,
  sessionPolicy,
  blobTokenKeyId,
} from '../sessions';
import { verifyAgentBlobToken } from '../../../lib/agent-blob-token';

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
function buildBearerContext(userOver: Record<string, unknown> = {}): AppContext {
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
            ...userOver,
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

/** Same shape as `membershipSupabaseClient`, but captures the arguments the
 * FIRST `.eq()` call in the chain receives — proves `resolveMembershipId`'s
 * `user.gatewayUserId ?? ''` fallback actually reaches the query. */
function membershipSupabaseClientCapturingEq(callerMembershipId: string | null): {
  client: { from: () => unknown };
  firstEqCalls: unknown[][];
} {
  const firstEqCalls: unknown[][] = [];
  const afterFirstEq = {
    eq: () => ({ single: async () => ({ data: callerMembershipId ? { id: callerMembershipId } : null }) }),
    in: async () => ({ data: [] }),
  };
  const client = {
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => {
          firstEqCalls.push(args);
          return afterFirstEq;
        },
      }),
    }),
  };
  return { client, firstEqCalls };
}

/** Supabase double for `buildActorNameResolver`'s two-query chain:
 * `membership` (id, user_id) filtered by tenant+ids, then `profile`
 * (id, name, email) filtered by the resulting user ids. Throws if either
 * table is queried when the test expects it to be skipped. */
function actorNameSupabaseClient(
  memberships: Array<{ id: string; user_id: string | null }> | null,
  profiles: Array<{ id: string; name: string | null; email: string | null }> | null,
): { from: (table: string) => unknown } {
  return {
    from: (table: string) => {
      if (table === 'membership') {
        return { select: () => ({ eq: () => ({ in: async () => ({ data: memberships }) }) }) };
      }
      if (table === 'profile') {
        return { select: () => ({ in: async () => ({ data: profiles }) }) };
      }
      throw new Error(`unexpected table queried: ${table}`);
    },
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

  // pr filtering resolves a PR/MR number to confirmed-linked trace ids via a
  // Postgres pull_request_session read no gateway host has wired for list
  // reads (see ListSessionsConstraints in @repo/observability-service) — a
  // pr value is rejected outright, never silently ignored.
  it('rejects a pr filter with a 400, never reaching the shared service', async () => {
    const route = routeWithValidatedData(ListSessions, { query: { limit: 25, offset: 0, pr: 812 } });
    const c = buildContext(['session.read']);

    const result = (await route.handle(c)) as { body: { error?: { code?: string } }; status: number };

    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('validation_error');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('lists sessions normally when pr is absent', async () => {
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const route = routeWithValidatedData(ListSessions, { query: { limit: 25, offset: 0 } });
    const c = buildContext(['session.read']);

    const result = (await route.handle(c)) as { status: number };

    expect(result.status).toBe(200);
    expect(listSessions).toHaveBeenCalledOnce();
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

  it('returns the service result wrapped in { data } and passes the resolved tenant/app to the service lookup', async () => {
    const listResult = { sessions: [{ traceId: 't1' }], total: 1 };
    listSessions.mockResolvedValue(listResult);
    const query = { limit: 25, offset: 0 };
    const route = routeWithValidatedData(ListSessions, { query });
    const c = buildContext(['session.read']);

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.body).toEqual({ data: listResult });
    expect(getGatewaySessionsService).toHaveBeenCalledWith(c.env, { tenantId: 'tenant-1', appId: 'app-1' });
  });

  it('maps a null service (ClickHouse not configured) to a 503, not a crash or silent 200', async () => {
    getGatewaySessionsService.mockReturnValueOnce(null as unknown as { listSessions: typeof listSessions; getSessionDetail: typeof getSessionDetail });
    const route = routeWithValidatedData(ListSessions, { query: { limit: 25, offset: 0 } });
    const c = buildContext();

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.status).toBe(503);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('declares the exact OpenAPI schema — tags, summary, operationId, request/response contracts', () => {
    const route = new ListSessions(MOCK_ROUTE_OPTIONS);

    expect(route.schema).toEqual({
      tags: ['Sessions'],
      summary: 'List agent sessions',
      operationId: 'list-sessions',
      description:
        'Returns a filtered, paginated list of agent-coding sessions for one repo. Without `agents.sessions.team.read`, actor identities are anonymized and `actor` filters are rejected. ' +
        "When no repo or topic filter is given, results are scoped to the app's dominant repo (the repo with the highest total spend); pass `repo` to target another repo. " +
        '`pr` is dashboard-only for now — this surface has no Postgres reader wired to resolve a PR/MR number to its confirmed-linked sessions, so a `pr` value is rejected rather than silently ignored.',
      request: {
        query: ListSessionsQuerySchema,
      },
      responses: {
        200: {
          description: 'A page of agent sessions.',
          content: { 'application/json': { schema: SessionsListResponseSchema } },
        },
        400: errorResponse('This key cannot filter sessions by actor.'),
        401: errorResponse('Missing or invalid API key.'),
      },
    });
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

  it('maps a null service (ClickHouse not configured) to a 503, not a crash or silent 200', async () => {
    getGatewaySessionsService.mockReturnValueOnce(null as unknown as { listSessions: typeof listSessions; getSessionDetail: typeof getSessionDetail });
    const route = routeWithValidatedData(GetSessionDetail, { params: { traceId: 't1' } });
    const c = buildContext();

    const result = (await route.handle(c)) as { body: unknown; status: number };

    expect(result.status).toBe(503);
    expect(getSessionDetail).not.toHaveBeenCalled();
  });

  it('passes the resolved tenant/app to the service lookup', async () => {
    getSessionDetail.mockResolvedValue({ session: { traceId: 't1' }, spans: [], truncated: false, prOutcomes: [] });
    const route = routeWithValidatedData(GetSessionDetail, { params: { traceId: 't1' } });
    const c = buildContext();

    await route.handle(c);

    expect(getGatewaySessionsService).toHaveBeenCalledWith(c.env, { tenantId: 'tenant-1', appId: 'app-1' });
  });

  it('declares the exact OpenAPI schema — tags, summary, operationId, request/response contracts', () => {
    const route = new GetSessionDetail(MOCK_ROUTE_OPTIONS);

    expect(route.schema).toEqual({
      tags: ['Sessions'],
      summary: 'Get agent session detail',
      operationId: 'get-session-detail',
      description:
        'Returns the full span tree + rollup identity for one session. Span count is capped — `truncated: true` means only the FIRST spans (not necessarily the last) are included. ' +
        'A missing trace and a trace from another app return the identical 404 — there is no existence oracle for a transcript the caller cannot see.',
      request: {
        params: GetSessionDetailParamsSchema,
      },
      responses: {
        200: {
          description: 'Full session transcript.',
          content: { 'application/json': { schema: SessionDetailResponseSchema } },
        },
        401: errorResponse('Missing or invalid API key.'),
        404: errorResponse('Session not found.'),
      },
    });
  });
});

describe('resolveMembershipId (via sessionPolicy for a bearer caller)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries membership by the caller\'s gatewayUserId', async () => {
    const { client, firstEqCalls } = membershipSupabaseClientCapturingEq('membership-1');
    getScopedSupabase.mockResolvedValue(client);
    checkBearerPermission.mockResolvedValue(false);
    const c = buildBearerContext({ gatewayUserId: 'user-42' });

    const policy = await sessionPolicy(c);

    expect(firstEqCalls[0]).toEqual(['user_id', 'user-42']);
    expect(policy).toEqual({ kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: false });
  });

  it('falls back to an empty string, not undefined, when gatewayUserId is missing', async () => {
    const { client, firstEqCalls } = membershipSupabaseClientCapturingEq(null);
    getScopedSupabase.mockResolvedValue(client);
    checkBearerPermission.mockResolvedValue(false);
    const c = buildBearerContext({ gatewayUserId: undefined });

    await sessionPolicy(c);

    expect(firstEqCalls[0]).toEqual(['user_id', '']);
  });
});

describe('buildActorNameResolver (via buildPorts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves an empty actorId list to an empty map without querying anything', async () => {
    getScopedSupabase.mockResolvedValue(actorNameSupabaseClient(null, null));
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve([]);

    expect(names).toEqual({});
  });

  it('marks every key:* actorId as anonymous WITHOUT querying membership at all', async () => {
    const throwing = { from: () => { throw new Error('should not query membership for key: ids'); } };
    getScopedSupabase.mockResolvedValue(throwing);
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['key:abc', 'key:def']);

    expect(names).toEqual({ 'key:abc': 'anonymous', 'key:def': 'anonymous' });
  });

  it('resolves membership-uuid actorIds to profile names, preferring name over email', async () => {
    getScopedSupabase.mockResolvedValue(
      actorNameSupabaseClient(
        [
          { id: 'mem-1', user_id: 'user-1' },
          { id: 'mem-2', user_id: 'user-2' },
        ],
        [
          { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
          { id: 'user-2', name: null, email: 'bob@example.com' },
        ],
      ),
    );
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['mem-1', 'mem-2']);

    expect(names).toEqual({ 'mem-1': 'Alice', 'mem-2': 'bob@example.com' });
  });

  it('resolves a mix of key: and membership-uuid ids in one call', async () => {
    getScopedSupabase.mockResolvedValue(
      actorNameSupabaseClient([{ id: 'mem-1', user_id: 'user-1' }], [{ id: 'user-1', name: 'Alice', email: null }]),
    );
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['key:abc', 'mem-1']);

    expect(names).toEqual({ 'key:abc': 'anonymous', 'mem-1': 'Alice' });
  });

  it('omits a membership from the result entirely when it has no matching profile row', async () => {
    getScopedSupabase.mockResolvedValue(
      actorNameSupabaseClient(
        [
          { id: 'mem-1', user_id: 'user-1' },
          { id: 'mem-2', user_id: 'user-2' },
        ],
        [{ id: 'user-1', name: 'Alice', email: 'alice@example.com' }],
      ),
    );
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['mem-1', 'mem-2']);

    expect(names).toEqual({ 'mem-1': 'Alice' });
    expect(names).not.toHaveProperty('mem-2');
  });

  it('tolerates a null memberships read: falls back to [] and skips the profile query entirely', async () => {
    const client = {
      from: (table: string) => {
        if (table === 'membership') return { select: () => ({ eq: () => ({ in: async () => ({ data: null }) }) }) };
        throw new Error(`should not query ${table} when memberships is null`);
      },
    };
    getScopedSupabase.mockResolvedValue(client);
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['mem-1']);

    expect(names).toEqual({});
  });

  it('tolerates a null profiles read: falls back to [] so no membership resolves a name', async () => {
    getScopedSupabase.mockResolvedValue(actorNameSupabaseClient([{ id: 'mem-1', user_id: 'user-1' }], null));
    const c = buildContext();

    const ports = await buildPorts(c, { kind: 'machine-key', canSeeTeamActors: true });
    const names = await ports.actorNames.resolve(['mem-1']);

    expect(names).toEqual({});
  });
});

describe('blobTokenKeyId — image blob-token binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('machine-key policy keys off the caller\'s own apiKeyId, unchanged from before', () => {
    const key = blobTokenKeyId({ tenantId: 'tenant-1', apiKeyId: 'key-1' }, { kind: 'machine-key', canSeeTeamActors: true });
    expect(key).toBe('key-1');
  });

  it('a bearer caller\'s token binds to their resolved membership id, not the shared tenant id', () => {
    const key = blobTokenKeyId(
      { tenantId: 'tenant-1' },
      { kind: 'dashboard-member', membershipId: 'membership-A', canSeeTeam: false },
    );
    expect(key).toBe('membership-A');
    expect(key).not.toBe('tenant-1');
  });

  it('two bearer members in the same tenant+app resolve to different binding keys', () => {
    const keyA = blobTokenKeyId(
      { tenantId: 'tenant-1' },
      { kind: 'dashboard-member', membershipId: 'membership-A', canSeeTeam: false },
    );
    const keyB = blobTokenKeyId(
      { tenantId: 'tenant-1' },
      { kind: 'dashboard-member', membershipId: 'membership-B', canSeeTeam: false },
    );
    expect(keyA).not.toBe(keyB);
  });

  it('mints an image token bound to the bearer caller\'s own membership id (via buildPorts)', async () => {
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-A'));
    checkBearerPermission.mockResolvedValue(false);
    const c = buildBearerContext();
    const policy = await sessionPolicy(c);
    const ports = await buildPorts(c, policy);

    const [ref] = await ports.images.sign([{ sha256: 'f'.repeat(64), mediaType: 'image/png' }]);
    const verified = await verifyAgentBlobToken({ secret: c.env.OAUTH_STATE_SECRET as string, token: ref!.token });

    expect(verified.ok && verified.claims.keyId).toBe('membership-A');
  });

  // proves the SEC-3 fix: a token minted for one bearer member's request no
  // longer matches another member's own derived keyId — GetAgentBlobByToken
  // compares verified.claims.keyId against blobTokenKeyId(user, THIS
  // request's policy), so member B's request can never accept member A's URL.
  it('a token minted for member A does not match member B\'s own derived keyId', async () => {
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-A'));
    checkBearerPermission.mockResolvedValue(false);
    const callerA = buildBearerContext();
    const policyA = await sessionPolicy(callerA);
    const portsA = await buildPorts(callerA, policyA);
    const [ref] = await portsA.images.sign([{ sha256: 'f'.repeat(64), mediaType: 'image/png' }]);
    const verified = await verifyAgentBlobToken({ secret: callerA.env.OAUTH_STATE_SECRET as string, token: ref!.token });
    expect(verified.ok).toBe(true);

    const policyB: SessionAccessPolicy = { kind: 'dashboard-member', membershipId: 'membership-B', canSeeTeam: false };
    const memberBExpectedKeyId = blobTokenKeyId({ tenantId: 'tenant-1' }, policyB);

    expect(verified.ok && verified.claims.keyId).not.toBe(memberBExpectedKeyId);
  });
});
