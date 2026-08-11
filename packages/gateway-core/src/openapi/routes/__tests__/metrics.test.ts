/**
 * Route-level tests for GET /v1/metrics/models, GET /v1/metrics/overview,
 * and GET /v1/metrics/compare.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../_shared';

const getModelStats = vi.fn();
const getAgentFleetOverview = vi.fn();
const getService = vi.fn(() => ({ getModelStats, getAgentFleetOverview }));
const resolveEnvScope = vi.fn();
vi.mock('../_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_shared')>();
  return {
    ...actual,
    getService: (...args: unknown[]) => getService(...(args as [])),
    resolveEnvScope: (...args: unknown[]) => resolveEnvScope(...(args as [])),
  };
});

const resolveTopicsScope = vi.fn();
vi.mock('../topics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../topics')>();
  return {
    ...actual,
    resolveTopicsScope: (...args: unknown[]) => resolveTopicsScope(...(args as [])),
  };
});

const getGatewayChClient = vi.fn();
vi.mock('../../analytics-factory', () => ({
  getGatewayChClient: (...args: unknown[]) => getGatewayChClient(...(args as [])),
}));

const getTopicMixDeltas = vi.fn();
vi.mock('@repo/observability-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/observability-service')>();
  return {
    ...actual,
    getTopicMixDeltas: (...args: unknown[]) => getTopicMixDeltas(...(args as [])),
  };
});

import { GetModelStats, GetFleetOverview, GetMetricsCompare } from '../metrics';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/metrics' },
    env: {},
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1' } : undefined)),
    json: vi.fn((body: unknown) => body),
  } as unknown as AppContext;
}

function routeWithValidatedData<T extends { validatedData: unknown }>(
  RouteClass: new (params: unknown) => T,
  query: Record<string, unknown>,
): T {
  const route = new RouteClass(MOCK_ROUTE_OPTIONS);
  route.validatedData = { query };
  return route;
}

const MODEL_STATS_FIXTURE = {
  models: [
    { model: 'claude-opus-5', requests: 100, cost: 12.5, tokens: 90000, inputTokens: 40000, outputTokens: 50000, avgLatencyMs: 820, successRate: 0.98 },
    { model: 'gpt-5', requests: 40, cost: 6.1, tokens: 30000, inputTokens: 12000, outputTokens: 18000, avgLatencyMs: 700, successRate: 0.95 },
  ],
};

describe('GetModelStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelStats.mockResolvedValue(MODEL_STATS_FIXTURE);
    resolveEnvScope.mockResolvedValue(undefined);
  });

  // proves AC-052-04
  it('returns exact per-model totals for the requested window', async () => {
    const route = routeWithValidatedData(GetModelStats, { from: '2026-08-01', to: '2026-08-07', limit: 10 });
    const c = buildContext();

    await route.handle(c);

    expect(c.json).toHaveBeenCalledWith({ data: MODEL_STATS_FIXTURE });
    expect(getModelStats).toHaveBeenCalledWith(
      { userId: '', tenantId: 'tenant-1', appId: 'app-1', dataRetentionDays: -1 },
      { start: '2026-08-01', end: '2026-08-07' },
      10,
      undefined,
      undefined,
    );
  });

  it('defaults to a trailing 7-day window when from/to are omitted', async () => {
    const route = routeWithValidatedData(GetModelStats, { limit: 10 });
    const c = buildContext();

    await route.handle(c);

    const [, dateRange] = getModelStats.mock.calls[0]!;
    const start = new Date(dateRange.start as string);
    const end = new Date(dateRange.end as string);
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect(spanDays).toBe(7);
  });
});

const FLEET_OVERVIEW_FIXTURE = {
  sessions: { current: 120, prior: 100 },
  toolErrorRate: { current: 0.02, prior: 0.03 },
  cleanSessionRate: { current: 0.9, prior: 0.85 },
  handsOnRate: { current: 0.12, prior: 0.15 },
  activeActors: { current: 8, prior: 7 },
  totalCost: { current: 342.5, prior: 290.1 },
  toolDenialRate: { current: 0.04, prior: 0.05 },
  autoApprovedRate: { current: 0.6, prior: 0.55 },
  modelMix: [{ model: 'claude-opus-5', sessions: 90 }],
};

describe('GetFleetOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentFleetOverview.mockResolvedValue(FLEET_OVERVIEW_FIXTURE);
  });

  it('returns the {current, prior} tile pairs for the requested window', async () => {
    const route = routeWithValidatedData(GetFleetOverview, { from: '2026-07-01', to: '2026-07-31' });
    const c = buildContext();

    await route.handle(c);

    expect(c.json).toHaveBeenCalledWith({ data: FLEET_OVERVIEW_FIXTURE });
    expect(getAgentFleetOverview).toHaveBeenCalledWith(
      { userId: '', tenantId: 'tenant-1', appId: 'app-1', dataRetentionDays: -1 },
      { start: '2026-07-01', end: '2026-07-31' },
    );
  });

  it('defaults to a trailing 30-day window when from/to are omitted', async () => {
    const route = routeWithValidatedData(GetFleetOverview, {});
    const c = buildContext();

    await route.handle(c);

    const [, dateRange] = getAgentFleetOverview.mock.calls[0]!;
    const start = new Date(dateRange.start as string);
    const end = new Date(dateRange.end as string);
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect(spanDays).toBe(30);
  });
});

describe('GetMetricsCompare', () => {
  const OVERVIEW_A = {
    sessions: { current: 100, prior: 90 },
    toolErrorRate: { current: 0.05, prior: 0.06 },
    cleanSessionRate: { current: 0.8, prior: 0.79 },
    handsOnRate: { current: 0.2, prior: 0.22 },
    activeActors: { current: 5, prior: 4 },
    totalCost: { current: 50, prior: 45 },
    toolDenialRate: { current: 0.03, prior: 0.04 },
    autoApprovedRate: { current: 0.5, prior: 0.48 },
    modelMix: [{ model: 'claude-opus-5', sessions: 80 }],
  };
  const OVERVIEW_B = {
    sessions: { current: 120, prior: 100 },
    toolErrorRate: { current: 0.02, prior: 0.05 },
    cleanSessionRate: { current: 0.9, prior: 0.8 },
    handsOnRate: { current: 0.1, prior: 0.2 },
    activeActors: { current: 6, prior: 5 },
    totalCost: { current: 55, prior: 50 },
    toolDenialRate: { current: 0.01, prior: 0.03 },
    autoApprovedRate: { current: 0.6, prior: 0.5 },
    modelMix: [{ model: 'claude-opus-5', sessions: 100 }],
  };
  const TOPIC_MIX = [{ topicId: 'topic-1', name: 'Auth issues', countA: 12, countB: 3 }];

  beforeEach(() => {
    vi.clearAllMocks();
    resolveTopicsScope.mockResolvedValue({
      tenantId: 'tenant-1',
      appId: 'app-1',
      environment: 'production',
      environmentIsDefault: true,
    });
    getGatewayChClient.mockReturnValue({ query: vi.fn() });
    getAgentFleetOverview.mockImplementation((_ctx: unknown, range: { start: string; end: string }) =>
      Promise.resolve(range.start === '2026-07-01' ? OVERVIEW_A : OVERVIEW_B),
    );
    getTopicMixDeltas.mockResolvedValue(TOPIC_MIX);
  });

  it('flattens both windows to {current} values and returns the topic-mix deltas', async () => {
    const route = routeWithValidatedData(GetMetricsCompare, {
      aFrom: '2026-07-01',
      aTo: '2026-07-07',
      bFrom: '2026-08-01',
      bTo: '2026-08-07',
      facet: 'issues',
      limit: 20,
    });
    const c = buildContext();

    await route.handle(c);

    expect(c.json).toHaveBeenCalledWith({
      data: {
        windowA: {
          from: '2026-07-01',
          to: '2026-07-07',
          metrics: {
            sessions: 100,
            toolErrorRate: 0.05,
            cleanSessionRate: 0.8,
            handsOnRate: 0.2,
            activeActors: 5,
            totalCost: 50,
            toolDenialRate: 0.03,
            autoApprovedRate: 0.5,
            modelMix: [{ model: 'claude-opus-5', sessions: 80 }],
          },
        },
        windowB: {
          from: '2026-08-01',
          to: '2026-08-07',
          metrics: {
            sessions: 120,
            toolErrorRate: 0.02,
            cleanSessionRate: 0.9,
            handsOnRate: 0.1,
            activeActors: 6,
            totalCost: 55,
            toolDenialRate: 0.01,
            autoApprovedRate: 0.6,
            modelMix: [{ model: 'claude-opus-5', sessions: 100 }],
          },
        },
        topicMix: TOPIC_MIX,
      },
    });

    expect(getTopicMixDeltas).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 'tenant-1', appId: 'app-1', environment: 'production', environmentIsDefault: true },
      'issues',
      { from: '2026-07-01', to: '2026-07-07' },
      { from: '2026-08-01', to: '2026-08-07' },
      20,
    );
  });

  it('returns 503 service_unavailable when ClickHouse is not configured', async () => {
    getGatewayChClient.mockReturnValue(null);

    const route = routeWithValidatedData(GetMetricsCompare, {
      aFrom: '2026-07-01',
      aTo: '2026-07-07',
      bFrom: '2026-08-01',
      bTo: '2026-08-07',
      facet: 'issues',
      limit: 20,
    });
    const c = buildContext();

    await route.handle(c);

    const [body, status] = c.json.mock.calls[0]! as [{ error: { code: string } }, number];
    expect(status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
  });
});
