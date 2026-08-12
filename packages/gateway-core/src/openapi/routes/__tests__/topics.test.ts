/**
 * Route-level tests for GET /v1/topics.
 *
 * The clustering/counting math is proven at the package level
 * (`observability-service/src/services/__tests__/topics.test.ts`); this
 * suite pins the REST contract layered on top of it: query defaults, the
 * `{ data }` envelope, and which environment scope a request resolves to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../_shared';
import { errorResponse, entitlementRequiredResponse } from '../_shared';
import type { TopicsList } from '@repo/api-schemas';
import { TopicsQuerySchema, TopicsResponseSchema } from '@repo/api-schemas';

const listTopics = vi.fn();
const getGatewayTopicsService = vi.fn(() => ({ listTopics }));
vi.mock('../../analytics-factory', () => ({
  getGatewayTopicsService: (...args: unknown[]) => getGatewayTopicsService(...(args as [])),
}));

const resolveEnvScope = vi.fn();
const getScopedSupabase = vi.fn();
vi.mock('../_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_shared')>();
  return {
    ...actual,
    resolveEnvScope: (...args: unknown[]) => resolveEnvScope(...(args as [])),
    getScopedSupabase: (...args: unknown[]) => getScopedSupabase(...(args as [])),
  };
});

import { GetTopics } from '../topics';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/topics' },
    env: { CLICKHOUSE_HOST: 'http://ch.local' },
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1' } : undefined)),
    json: vi.fn((body: unknown) => body),
  } as unknown as AppContext;
}

function routeWithValidatedData(query: Record<string, unknown>): GetTopics {
  const route = new GetTopics(MOCK_ROUTE_OPTIONS) as GetTopics & { validatedData: unknown };
  route.validatedData = { query };
  return route;
}

const FIXTURE: TopicsList = {
  facet: 'issues',
  mapVersion: 4,
  generatedAt: '2026-08-01T00:00:00.000Z',
  topics: [
    { topicId: 't1', name: 'Flaky CI', description: '', sessionCount: 42, share: 0.5, avgLatencyMs: 100, avgCostUsd: 1.2, errorRate: 0.1, trend: [1, 2] },
    { topicId: 't2', name: 'Auth bugs', description: '', sessionCount: 20, share: 0.24, avgLatencyMs: 90, avgCostUsd: 0.9, errorRate: 0.05, trend: [1, 1] },
    { topicId: 't3', name: 'Deploy failures', description: '', sessionCount: 12, share: 0.14, avgLatencyMs: 80, avgCostUsd: 0.5, errorRate: 0.02, trend: [0, 1] },
  ],
  noMatchCount: 9,
  samplableCount: 83,
  required: 100,
  trendDays: ['2026-08-01 00:00:00'],
  noMatchTrend: [3],
  trendBucket: 'day',
};

describe('GetTopics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTopics.mockResolvedValue(FIXTURE);
    resolveEnvScope.mockResolvedValue({ environment: { name: 'prod', isDefault: true } });
  });

  // proves AC-052-01
  it('returns the top-N issue topics with name, session count, and share', async () => {
    const query = { facet: 'issues', limit: 3 };
    const route = routeWithValidatedData(query);
    const c = buildContext();

    await route.handle(c);

    expect(c.json).toHaveBeenCalledWith({ data: FIXTURE });
    expect(listTopics).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1', environment: 'prod', environmentIsDefault: true },
      'issues',
      3,
    );
  });

  it('scopes the ClickHouse client to the caller tenant + app', async () => {
    const query = { facet: 'issues', limit: 3 };
    const route = routeWithValidatedData(query);
    const c = buildContext();

    await route.handle(c);

    expect(getGatewayTopicsService).toHaveBeenCalledWith(
      c.env,
      { tenantId: 'tenant-1', appId: 'app-1' },
    );
  });

  /** Chainable Supabase stand-in that records the exact args each `.eq()`
   * call in the resolveTopicsScope fallback chain receives. */
  function fallbackSupabaseStub(result: { data: { name: string } | null; error: { message: string } | null }) {
    const eqCalls: [string, unknown][] = [];
    const eq = (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return { eq, maybeSingle: async () => result };
    };
    return { client: { from: () => ({ select: () => ({ eq }) }) }, eqCalls };
  }

  it('falls back to the app default environment when the key carries no env binding', async () => {
    resolveEnvScope.mockResolvedValue(undefined);
    const { client } = fallbackSupabaseStub({ data: { name: 'dev' }, error: null });
    getScopedSupabase.mockResolvedValue(client);

    const query = { facet: 'issues', limit: 3 };
    const route = routeWithValidatedData(query);
    const c = buildContext();

    await route.handle(c);

    expect(listTopics).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1', environment: 'dev', environmentIsDefault: true },
      'issues',
      3,
    );
  });

  it('filters the default-environment lookup on is_default = true, not false', async () => {
    resolveEnvScope.mockResolvedValue(undefined);
    const { client, eqCalls } = fallbackSupabaseStub({ data: { name: 'dev' }, error: null });
    getScopedSupabase.mockResolvedValue(client);

    const route = routeWithValidatedData({ facet: 'issues', limit: 3 });
    await route.handle(buildContext());

    expect(eqCalls).toContainEqual(['is_default', true]);
  });

  it('resolves an empty-string environment, not a crash, when the default-env lookup finds no row', async () => {
    resolveEnvScope.mockResolvedValue(undefined);
    const { client } = fallbackSupabaseStub({ data: null, error: null });
    getScopedSupabase.mockResolvedValue(client);

    const route = routeWithValidatedData({ facet: 'issues', limit: 3 });
    await route.handle(buildContext());

    expect(listTopics).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1', environment: '', environmentIsDefault: true },
      'issues',
      3,
    );
  });

  it('propagates a genuine Supabase error from the default-env lookup as a 500, not a silent empty scope', async () => {
    resolveEnvScope.mockResolvedValue(undefined);
    const { client } = fallbackSupabaseStub({ data: null, error: { message: 'connection reset' } });
    getScopedSupabase.mockResolvedValue(client);

    const route = routeWithValidatedData({ facet: 'issues', limit: 3 });
    const c = buildContext();
    await route.handle(c);

    expect(listTopics).not.toHaveBeenCalled();
    const body = (c.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      error: { code: string };
    };
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 503 when no ClickHouse client resolves for the tenant/app', async () => {
    getGatewayTopicsService.mockReturnValue(null);
    const route = routeWithValidatedData({ facet: 'issues', limit: 3 });
    const c = buildContext();

    await route.handle(c);

    expect(listTopics).not.toHaveBeenCalled();
    const call = (c.json as unknown as { mock: { calls: [unknown, number?][] } }).mock.calls[0]!;
    expect(call[1]).toBe(503);
  });

  it('declares the exact OpenAPI schema — tags, summary, operationId, request/response contracts', () => {
    const route = new GetTopics(MOCK_ROUTE_OPTIONS);

    expect(route.schema).toEqual({
      tags: ['Topics'],
      summary: 'Get topics',
      operationId: 'get-topics',
      description:
        'Returns the active topic map for one facet (task, issues, or steering) — clusters of agent sessions sized by session count.\n\n' +
        '`sessionCount`, `share`, and `trend` are LIVE — they include sessions the enrichment cron classified after the map was generated. ' +
        '`avgLatencyMs`, `avgCostUsd`, and `errorRate` are snapshots computed at generation time (as of `generatedAt`) over the sampled member traces — they do not move as new sessions are classified.\n\n' +
        '`trendDays` buckets are UTC.',
      request: {
        query: TopicsQuerySchema,
      },
      responses: {
        200: {
          description: 'The active topic map for the requested facet.',
          content: {
            'application/json': {
              schema: TopicsResponseSchema,
            },
          },
        },
        401: errorResponse('Missing or invalid API key.'),
        402: entitlementRequiredResponse(
          "Tenant tier does not include the 'topics_enabled' feature.",
        ),
      },
    });
  });
});
