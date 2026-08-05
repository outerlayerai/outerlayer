/**
 * Tests: POST /api/analytics/widget-data — Repo Activity + Agent Execution
 * Health metrics (agent_cost_by_branch, agent_sessions_by_branch,
 * agent_tool_error_rate_by_branch, agent_cost_by_agent_type,
 * agent_sessions_by_agent_type, agent_cost_anomalies_by_branch,
 * cost_per_session_trend, agent_session_duration_trend,
 * agent_turn_count_trend).
 *
 * Dimension metrics (including the tool-error-rate-by-branch quality
 * signal) read `getAgentFleetDimensionBreakdown` — one query per dimension,
 * shared by every metric keyed off that dimension. Cost-anomaly reads
 * `getAgentFleetCostAnomalies` (SQL-only trailing-baseline heuristic).
 * Trend metrics read `getAgentFleetPercentileTrend` — one query backs all
 * three, each metric picking which series to surface from the same daily
 * rows, because a blended percentile snapshot for the date range hides
 * exactly what percentiles exist to catch. Separate file from
 * `agent-fleet-metrics.test.ts` (the Overview tiles) since these hit
 * different service methods entirely.
 */

// @vitest-environment node

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockTenantContext = Object.freeze({
  userId: 'user-123',
  tenantId: 'tenant-456',
  appId: 'app-789',
});

vi.mock('@/app/api/analytics/with-auth', () => ({
  withAnalyticsAuthParams: (handler: any) => async (
    request: Request,
    ctx?: { params: Promise<{ orgName: string; appId: string }> },
  ) => {
    const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
    return handler(request, mockTenantContext, params);
  },
}));

const mockGetAgentFleetDimensionBreakdown = vi.fn();
const mockGetAgentFleetCostAnomalies = vi.fn();
const mockGetAgentFleetPercentileTrend = vi.fn();

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentFleetDimensionBreakdown: mockGetAgentFleetDimensionBreakdown,
    getAgentFleetCostAnomalies: mockGetAgentFleetCostAnomalies,
    getAgentFleetPercentileTrend: mockGetAgentFleetPercentileTrend,
  }),
  parseDateRange: (_preset: string) => ({ start: '2026-01-28', end: '2026-02-04' }),
}));

vi.mock('@/lib/analytics/errors', () => ({
  toErrorResponse: (err: any) => ({ error: err.message }),
  getErrorStatusCode: () => 500,
  mapClickHouseError: (err: any) => err,
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
    }
  },
}));

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { query: vi.fn(), error: vi.fn() },
  createTimer: () => ({ elapsed: () => 100 }),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/analytics/widget-data?appId=app-789', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DIMENSION_ITEMS = {
  items: [
    { dimensionValue: 'main', sessions: 8, costUsd: 12.5, toolErrorRate: 0.125 },
    { dimensionValue: 'feature/x', sessions: 3, costUsd: 4.25, toolErrorRate: 0 },
  ],
};

const COST_ANOMALIES = {
  items: [
    { dimensionValue: 'feature/runaway', recentCostUsd: 40, baselineMeanUsd: 10, deltaUsd: 30 },
    { dimensionValue: 'feature/y', recentCostUsd: 12, baselineMeanUsd: 8, deltaUsd: 4 },
  ],
};

const PERCENTILE_TREND = {
  points: [
    { date: '2026-01-28', costP50: 0.5, costP95: 3.2, durationP50Ms: 45000, durationP95Ms: 180000, durationP99Ms: 400000, turnCountP95: 22 },
    { date: '2026-01-29', costP50: 0.6, costP95: 3.5, durationP50Ms: 47000, durationP95Ms: 190000, durationP99Ms: 410000, turnCountP95: 24 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentFleetDimensionBreakdown.mockResolvedValue(DIMENSION_ITEMS);
  mockGetAgentFleetCostAnomalies.mockResolvedValue(COST_ANOMALIES);
  mockGetAgentFleetPercentileTrend.mockResolvedValue(PERCENTILE_TREND);
});

describe('POST /api/analytics/widget-data (Repo Activity — dimension breakdown)', () => {
  it('returns agent_cost_by_branch as a ranking keyed by branch, using the costUsd field', async () => {
    const res = await POST(makeRequest({ metric: 'agent_cost_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'main', value: 12.5 },
        { name: 'feature/x', value: 4.25 },
      ],
    });
    expect(mockGetAgentFleetDimensionBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      'branch',
      undefined,
    );
  });

  it('returns agent_sessions_by_branch as a ranking using the sessions field, from the SAME underlying rows', async () => {
    const res = await POST(makeRequest({ metric: 'agent_sessions_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'main', value: 8 },
        { name: 'feature/x', value: 3 },
      ],
    });
  });

  it('returns agent_tool_error_rate_by_branch as a ranking using the toolErrorRate field, scaled to percentage points', async () => {
    const res = await POST(makeRequest({ metric: 'agent_tool_error_rate_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 0.125 fraction -> 12.5 percentage points; 0 stays 0.
    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'main', value: 12.5 },
        { name: 'feature/x', value: 0 },
      ],
    });
    expect(mockGetAgentFleetDimensionBreakdown).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), 'branch', undefined);
  });

  it('resolves agent_cost_by_agent_type / agent_sessions_by_agent_type to the "agent_type" dimension', async () => {
    await POST(makeRequest({ metric: 'agent_cost_by_agent_type', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(mockGetAgentFleetDimensionBreakdown).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), 'agent_type', undefined);

    vi.clearAllMocks();
    mockGetAgentFleetDimensionBreakdown.mockResolvedValue(DIMENSION_ITEMS);
    await POST(makeRequest({ metric: 'agent_sessions_by_agent_type', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(mockGetAgentFleetDimensionBreakdown).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), 'agent_type', undefined);
  });

  it('errors clearly when the service does not implement getAgentFleetDimensionBreakdown', async () => {
    vi.resetModules();
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/server', () => ({
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
      },
    }));
    vi.doMock('@/app/api/analytics/with-auth', () => ({
      withAnalyticsAuthParams: (handler: any) => async (
        request: Request,
        ctx?: { params: Promise<{ orgName: string; appId: string }> },
      ) => {
        const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
        return handler(request, mockTenantContext, params);
      },
    }));
    vi.doMock('@/lib/analytics', () => ({
      getAnalyticsService: () => ({}),
      parseDateRange: () => ({ start: '2026-01-28', end: '2026-02-04' }),
    }));
    vi.doMock('@/lib/analytics/errors', () => ({
      toErrorResponse: (err: any) => ({ error: err.message }),
      getErrorStatusCode: () => 400,
      mapClickHouseError: (err: any) => err,
      ValidationError: class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      },
    }));
    vi.doMock('@/lib/analytics/logger', () => ({
      analyticsLogger: { query: vi.fn(), error: vi.fn() },
      createTimer: () => ({ elapsed: () => 100 }),
    }));

    const { POST: isolatedPost } = await import('../route');
    const res = await isolatedPost(makeRequest({ metric: 'agent_cost_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Agent fleet metrics are not available');
  });
});

describe('POST /api/analytics/widget-data (Repo Activity — cost anomalies)', () => {
  it('returns agent_cost_anomalies_by_branch as a ranking keyed by branch, using the rounded deltaUsd field', async () => {
    const res = await POST(makeRequest({ metric: 'agent_cost_anomalies_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'feature/runaway', value: 30 },
        { name: 'feature/y', value: 4 },
      ],
    });
    expect(mockGetAgentFleetCostAnomalies).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      undefined,
    );
  });

  it('errors clearly when the service does not implement getAgentFleetCostAnomalies', async () => {
    vi.resetModules();
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/server', () => ({
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
      },
    }));
    vi.doMock('@/app/api/analytics/with-auth', () => ({
      withAnalyticsAuthParams: (handler: any) => async (
        request: Request,
        ctx?: { params: Promise<{ orgName: string; appId: string }> },
      ) => {
        const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
        return handler(request, mockTenantContext, params);
      },
    }));
    vi.doMock('@/lib/analytics', () => ({
      getAnalyticsService: () => ({}),
      parseDateRange: () => ({ start: '2026-01-28', end: '2026-02-04' }),
    }));
    vi.doMock('@/lib/analytics/errors', () => ({
      toErrorResponse: (err: any) => ({ error: err.message }),
      getErrorStatusCode: () => 400,
      mapClickHouseError: (err: any) => err,
      ValidationError: class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      },
    }));
    vi.doMock('@/lib/analytics/logger', () => ({
      analyticsLogger: { query: vi.fn(), error: vi.fn() },
      createTimer: () => ({ elapsed: () => 100 }),
    }));

    const { POST: isolatedPost } = await import('../route');
    const res = await isolatedPost(makeRequest({ metric: 'agent_cost_anomalies_by_branch', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Agent fleet metrics are not available');
  });
});

describe('POST /api/analytics/widget-data (Agent Execution Health — percentile trends)', () => {
  it('returns cost_per_session_trend as a two-series (P50/P95) time series from the daily cost fields', async () => {
    const res = await POST(makeRequest({ metric: 'cost_per_session_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'P50', data: [{ x: '2026-01-28', y: 0.5 }, { x: '2026-01-29', y: 0.6 }] },
        { name: 'P95', data: [{ x: '2026-01-28', y: 3.2 }, { x: '2026-01-29', y: 3.5 }] },
      ],
    });
  });

  it('returns agent_session_duration_trend as a three-series (P50/P95/P99) time series from the daily duration fields', async () => {
    const res = await POST(makeRequest({ metric: 'agent_session_duration_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'P50', data: [{ x: '2026-01-28', y: 45000 }, { x: '2026-01-29', y: 47000 }] },
        { name: 'P95', data: [{ x: '2026-01-28', y: 180000 }, { x: '2026-01-29', y: 190000 }] },
        { name: 'P99', data: [{ x: '2026-01-28', y: 400000 }, { x: '2026-01-29', y: 410000 }] },
      ],
    });
  });

  it('returns agent_turn_count_trend as a single-series (P95) time series from the daily turn-count field', async () => {
    const res = await POST(makeRequest({ metric: 'agent_turn_count_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'P95', data: [{ x: '2026-01-28', y: 22 }, { x: '2026-01-29', y: 24 }] },
      ],
    });
  });

  it('calls getAgentFleetPercentileTrend exactly once even though the route is asked for one specific trend metric', async () => {
    await POST(makeRequest({ metric: 'cost_per_session_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(mockGetAgentFleetPercentileTrend).toHaveBeenCalledTimes(1);
  });

  it('errors clearly when the service does not implement getAgentFleetPercentileTrend', async () => {
    vi.resetModules();
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/server', () => ({
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
      },
    }));
    vi.doMock('@/app/api/analytics/with-auth', () => ({
      withAnalyticsAuthParams: (handler: any) => async (
        request: Request,
        ctx?: { params: Promise<{ orgName: string; appId: string }> },
      ) => {
        const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
        return handler(request, mockTenantContext, params);
      },
    }));
    vi.doMock('@/lib/analytics', () => ({
      getAnalyticsService: () => ({}),
      parseDateRange: () => ({ start: '2026-01-28', end: '2026-02-04' }),
    }));
    vi.doMock('@/lib/analytics/errors', () => ({
      toErrorResponse: (err: any) => ({ error: err.message }),
      getErrorStatusCode: () => 400,
      mapClickHouseError: (err: any) => err,
      ValidationError: class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      },
    }));
    vi.doMock('@/lib/analytics/logger', () => ({
      analyticsLogger: { query: vi.fn(), error: vi.fn() },
      createTimer: () => ({ elapsed: () => 100 }),
    }));

    const { POST: isolatedPost } = await import('../route');
    const res = await isolatedPost(makeRequest({ metric: 'agent_turn_count_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Agent fleet metrics are not available');
  });
});
