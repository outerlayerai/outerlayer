/**
 * Tests: POST /api/analytics/widget-data
 *
 * Tests that widget data requests correctly handle filters, groupBy,
 * and timeGranularity parameters.
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

const mockGetMetrics = vi.fn();
const mockGetExtendedMetrics = vi.fn();
const mockGetPercentiles = vi.fn();
const mockGetModelStats = vi.fn();
const mockGetRankingData = vi.fn();

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getMetrics: mockGetMetrics,
    getExtendedMetrics: mockGetExtendedMetrics,
    getPercentiles: mockGetPercentiles,
    getModelStats: mockGetModelStats,
    getRankingData: mockGetRankingData,
  }),
  parseDateRange: (_preset: string) => ({
    start: '2026-01-28',
    end: '2026-02-04',
  }),
}));

// `ValidationError`/`getErrorStatusCode` stay REAL (not stubbed) — the
// appId-pin test below asserts the real HTTP status a ValidationError maps
// to (400), not a hardcoded mock value that would pass regardless of what
// the route actually throws. `toErrorResponse`/`mapClickHouseError` stay
// simplified since the rest of this file's assertions key off their flat
// mocked shape.
vi.mock('@/lib/analytics/errors', async () => {
  const actual = await vi.importActual<typeof import('@/lib/analytics/errors')>('@/lib/analytics/errors');
  return {
    ...actual,
    toErrorResponse: (err: any) => ({ error: err.message, field: err.field }),
    mapClickHouseError: (err: any) => err,
  };
});

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { query: vi.fn(), error: vi.fn() },
  createTimer: () => ({ elapsed: () => 100 }),
}));

import { POST } from '../route';
import { METRIC_LABELS } from '@/features/dashboards/types';

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/analytics/widget-data?appId=app-789', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// appId path/query pin
// ---------------------------------------------------------------------------

describe('POST /api/orgs/{orgName}/apps/{appId}/analytics/widget-data (appId pin)', () => {
  it('rejects a request whose [appId] path segment does not match the ?appId query the auth wrapper verified', async () => {
    const res = await POST(makeRequest({ metric: 'request_count', timeRange: { preset: '7d' } }), {
      params: Promise.resolve({ orgName: 'test-org', appId: 'a-different-app' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('appId path segment and query must match');
    expect(mockGetMetrics).not.toHaveBeenCalled();
    expect(mockGetExtendedMetrics).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, for a saved dashboard naming a metric this build no longer serves', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_cost_per_resolved_task', timeRange: { preset: '7d' } }),
      { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid metric type');
    expect(body.field).toBe('metric');
    expect(mockGetMetrics).not.toHaveBeenCalled();
    expect(mockGetExtendedMetrics).not.toHaveBeenCalled();
  });

  it('serves the widget payload when the path segment matches the verified query appId', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 42, totalCost: 0 },
      timeSeries: [],
    });

    const res = await POST(makeRequest({ metric: 'request_count', timeRange: { preset: '7d' } }), {
      params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      type: 'timeSeries',
      series: [{ name: 'request_count', data: [] }],
      summary: { total: 42, average: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (filters)', () => {
  it('should pass filters to getMetrics when filters are provided', async () => {
    mockGetMetrics.mockResolvedValue({
      summary: { totalRequests: 100, totalCost: 50 },
      timeSeries: [],
    });

    const request = makeRequest({
      metric: 'request_count',
      timeRange: { preset: '7d' },
      filters: [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
    });

    await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(mockGetMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
      // `env` arg; undefined when the request carries no env.
      undefined,
    );
    expect(mockGetExtendedMetrics).not.toHaveBeenCalled();
  });

  it('should use getExtendedMetrics when no filters are provided', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 100, totalCost: 50 },
      timeSeries: [],
    });

    const request = makeRequest({
      metric: 'request_count',
      timeRange: { preset: '7d' },
    });

    await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(mockGetExtendedMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
    );
    expect(mockGetMetrics).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GroupBy
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (groupBy)', () => {
  it('should return model-grouped ranking data when groupBy is model', async () => {
    mockGetRankingData.mockResolvedValue({
      items: [
        { dimensionValue: 'gpt-4', requests: 80, cost: 40, tokens: 5000, inputTokens: 2000, outputTokens: 3000, avgLatencyMs: 200, successRate: 95 },
        { dimensionValue: 'gpt-3.5', requests: 120, cost: 10, tokens: 3000, inputTokens: 1000, outputTokens: 2000, avgLatencyMs: 100, successRate: 98 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      groupBy: 'model',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('ranking');
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe('gpt-4');
    expect(data.items[1].name).toBe('gpt-3.5');
    expect(mockGetRankingData).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      'model',
      10,
      undefined,
      undefined,
    );
  });

  it('should return user-grouped ranking data when groupBy is user_id', async () => {
    mockGetRankingData.mockResolvedValue({
      items: [
        { dimensionValue: 'user-alice', requests: 50, cost: 25, tokens: 10000, inputTokens: 4000, outputTokens: 6000, avgLatencyMs: 200, successRate: 95 },
        { dimensionValue: 'user-bob', requests: 30, cost: 15, tokens: 6000, inputTokens: 2000, outputTokens: 4000, avgLatencyMs: 150, successRate: 98 },
      ],
    });

    const request = makeRequest({
      metric: 'total_cost',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      groupBy: 'user_id',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('ranking');
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe('user-alice');
    expect(data.items[0].value).toBe(25);
    expect(data.items[1].name).toBe('user-bob');
    expect(data.items[1].value).toBe(15);
    // Should call getRankingData with 'user_id' dimension, NOT getModelStats
    expect(mockGetRankingData).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      'user_id',
      10,
      undefined,
      undefined,
    );
    expect(mockGetModelStats).not.toHaveBeenCalled();
  });

  it('should return metadata-grouped ranking data when groupBy is metadata field', async () => {
    mockGetRankingData.mockResolvedValue({
      items: [
        { dimensionValue: 'chatbot', requests: 100, cost: 50, tokens: 20000, inputTokens: 8000, outputTokens: 12000, avgLatencyMs: 250, successRate: 96 },
        { dimensionValue: 'search', requests: 60, cost: 30, tokens: 12000, inputTokens: 5000, outputTokens: 7000, avgLatencyMs: 180, successRate: 99 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      groupBy: 'metadata.feature',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('ranking');
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe('chatbot');
    expect(data.items[0].value).toBe(100);
    expect(mockGetRankingData).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      'metadata.feature',
      10,
      undefined,
      undefined,
    );
  });

  it('should return ranking even when visualization is stat with groupBy', async () => {
    mockGetRankingData.mockResolvedValue({
      items: [
        { dimensionValue: 'gpt-4', requests: 80, cost: 40, tokens: 5000, inputTokens: 2000, outputTokens: 3000, avgLatencyMs: 200, successRate: 95 },
      ],
    });

    const request = makeRequest({
      metric: 'total_cost',
      visualization: 'stat',
      timeRange: { preset: '7d' },
      groupBy: 'model',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    // Stat with groupBy still returns ranking (more useful than a single number)
    expect(data.type).toBe('ranking');
  });

  it('should pass filters to getRankingData when groupBy has filters', async () => {
    mockGetRankingData.mockResolvedValue({
      items: [
        { dimensionValue: 'gpt-4', requests: 80, cost: 40, tokens: 5000, inputTokens: 2000, outputTokens: 3000, avgLatencyMs: 200, successRate: 95 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      groupBy: 'model',
      filters: [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(response.status).toBe(200);
    expect(mockGetRankingData).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      'model',
      10,
      [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
      undefined,
    );
  });

  it('should fall through to normal metric handling when groupBy is time_period', async () => {
    // time_period groupBy means "show as time series" — no ranking needed
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 100, totalCost: 50 },
      timeSeries: [
        { date: '2026-01-28', hour: 0, requests: 100, successes: 95, errors: 5, cost: 50, tokens: 50000, inputTokens: 20000, outputTokens: 30000, avgLatencyMs: 320, uniqueUsers: 15 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'line',
      timeRange: { preset: '7d' },
      groupBy: 'time_period',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    // Should NOT call getRankingData for time_period — it's handled as time series
    expect(mockGetRankingData).not.toHaveBeenCalled();
    expect(mockGetModelStats).not.toHaveBeenCalled();
  });

  it('should fall through to normal metric handling when groupBy is empty', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 200, totalCost: 100 },
      timeSeries: [],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'stat',
      timeRange: { preset: '7d' },
      groupBy: '',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    expect(data.value).toBe(200);
    expect(mockGetRankingData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TimeGranularity
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (timeGranularity)', () => {
  it('should accept timeGranularity parameter when provided in request', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 100, totalCost: 50 },
      timeSeries: [{ date: '2026-02-01', hour: 0, requests: 10, cost: 5, tokens: 1000, uniqueUsers: 2, errors: 0, successes: 10, inputTokens: 400, outputTokens: 600, avgLatencyMs: 200 }],
    });

    const request = makeRequest({
      metric: 'request_count',
      timeRange: { preset: '7d' },
      timeGranularity: 'day',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Metric Correctness — All Widget Types
// ---------------------------------------------------------------------------
//
// Uses mock data matching the ACTUAL interface contracts:
//   MetricsSummary: totalRequests, totalCost, totalTokens, errorCount, ...
//   TimeSeriesPoint: requests, cost, tokens, errors, uniqueUsers, avgLatencyMs, date, hour
//
// These fields differ — the route must map between them correctly.
// ---------------------------------------------------------------------------

const realisticSummary = {
  totalRequests: 5000,
  successCount: 4800,
  errorCount: 200,
  totalCost: 125.50,
  totalTokens: 2500000,
  inputTokens: 1000000,
  outputTokens: 1500000,
  avgLatencyMs: 342.5,
  uniqueUsers: 87,
};

const realisticTimeSeries = [
  {
    date: '2026-01-28',
    hour: 0,
    requests: 100,
    successes: 95,
    errors: 5,
    cost: 2.50,
    tokens: 50000,
    inputTokens: 20000,
    outputTokens: 30000,
    avgLatencyMs: 320,
    uniqueUsers: 15,
  },
  {
    date: '2026-01-29',
    hour: 0,
    requests: 200,
    successes: 190,
    errors: 10,
    cost: 5.00,
    tokens: 100000,
    inputTokens: 40000,
    outputTokens: 60000,
    avgLatencyMs: 280,
    uniqueUsers: 22,
  },
];

function setupMetricsMock() {
  mockGetExtendedMetrics.mockResolvedValue({
    summary: realisticSummary,
    timeSeries: realisticTimeSeries,
  });
}

// ---------------------------------------------------------------------------
// Stat Widgets
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (stat metrics)', () => {
  beforeEach(setupMetricsMock);

  it.each([
    ['request_count', 5000],
    ['total_cost', 125.5],
    ['total_tokens', 2500000],
    ['unique_users', 87],
    ['error_count', 200],
    ['avg_latency', 342.5],
  ])('should return correct stat value for %s', async (metric, expected) => {
    const request = makeRequest({
      metric,
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    expect(data.value).toBe(expected);
    expect(data.label).toBe(METRIC_LABELS[metric as string] ?? metric);
  });

  it('should compute avg_cost stat when visualization is stat', async () => {
    const request = makeRequest({
      metric: 'avg_cost',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    // 125.50 / 5000 = 0.0251
    expect(data.type).toBe('stat');
    expect(data.value).toBe(0.0251);
  });

  it('should compute avg_tokens stat when visualization is stat', async () => {
    const request = makeRequest({
      metric: 'avg_tokens',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    // 2500000 / 5000 = 500
    expect(data.type).toBe('stat');
    expect(data.value).toBe(500);
  });

  it('should compute error_rate stat when visualization is stat', async () => {
    const request = makeRequest({
      metric: 'error_rate',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    // (200 / 5000) * 100 = 4
    expect(data.type).toBe('stat');
    expect(data.value).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// TimeSeries Widgets — Direct Field Mapping
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (timeSeries metrics)', () => {
  beforeEach(setupMetricsMock);

  it.each([
    ['request_count', [100, 200]],
    ['total_cost', [2.5, 5]],
    ['total_tokens', [50000, 100000]],
    ['unique_users', [15, 22]],
    ['error_count', [5, 10]],
    ['avg_latency', [320, 280]],
  ])('should return correct timeSeries y-values for %s', async (metric, expectedY) => {
    const request = makeRequest({
      metric,
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe(metric);
    expect(data.series[0].data).toHaveLength(2);
    expect(data.series[0].data[0].y).toBe(expectedY[0]);
    expect(data.series[0].data[1].y).toBe(expectedY[1]);
  });

  it('should use date field for x-axis values when timeSeries is returned', async () => {
    const request = makeRequest({
      metric: 'request_count',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.series[0].data[0].x).toBe('2026-01-28');
    expect(data.series[0].data[1].x).toBe('2026-01-29');
  });

  it('should include summary with total and average when timeSeries is returned', async () => {
    const request = makeRequest({
      metric: 'request_count',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.summary).toEqual({
      total: 5000, // totalRequests from MetricsSummary
      average: 150, // (100 + 200) / 2
    });
  });
});

// ---------------------------------------------------------------------------
// TimeSeries Widgets — Computed Metrics (error_rate, avg_cost, avg_tokens)
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (computed timeSeries metrics)', () => {
  beforeEach(setupMetricsMock);

  it('should compute error_rate per bucket when visualization is line', async () => {
    const request = makeRequest({
      metric: 'error_rate',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data).toHaveLength(2);
    // Point 1: (5 / 100) * 100 = 5.0
    expect(data.series[0].data[0].y).toBe(5);
    // Point 2: (10 / 200) * 100 = 5.0
    expect(data.series[0].data[1].y).toBe(5);
  });

  it('should compute avg_cost per bucket when visualization is line', async () => {
    const request = makeRequest({
      metric: 'avg_cost',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data).toHaveLength(2);
    // Point 1: 2.50 / 100 = 0.025
    expect(data.series[0].data[0].y).toBe(0.025);
    // Point 2: 5.00 / 200 = 0.025
    expect(data.series[0].data[1].y).toBe(0.025);
  });

  it('should compute avg_tokens per bucket when visualization is line', async () => {
    const request = makeRequest({
      metric: 'avg_tokens',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data).toHaveLength(2);
    // Point 1: 50000 / 100 = 500
    expect(data.series[0].data[0].y).toBe(500);
    // Point 2: 100000 / 200 = 500
    expect(data.series[0].data[1].y).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Percentile Widgets
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (percentile metrics)', () => {
  const mockPercentileData = {
    data: [
      { timestamp: '2026-01-28', p50: 150, p75: 250, p90: 400, p95: 500, p99: 800 },
      { timestamp: '2026-01-29', p50: 160, p75: 260, p90: 420, p95: 520, p99: 850 },
    ],
  };

  beforeEach(() => {
    mockGetPercentiles.mockResolvedValue(mockPercentileData);
  });

  it('should return p95 timeSeries with correct data points when metric is p95_latency', async () => {
    const request = makeRequest({
      metric: 'p95_latency',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.type).toBe('timeSeries');
    expect(data.series[0].name).toBe('P95 Latency');
    expect(data.series[0].data).toEqual([
      { x: '2026-01-28', y: 500 },
      { x: '2026-01-29', y: 520 },
    ]);
  });

  it('should return p95 stat as average of percentile values when visualization is stat', async () => {
    const request = makeRequest({
      metric: 'p95_latency',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.type).toBe('stat');
    expect(data.value).toBe(510); // (500 + 520) / 2
    expect(data.label).toBe('P95 Latency (ms)');
  });

  it('should return p50 timeSeries correctly when metric is p50_latency', async () => {
    const request = makeRequest({
      metric: 'p50_latency',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.series[0].name).toBe('P50 Latency');
    expect(data.series[0].data[0].y).toBe(150);
    expect(data.series[0].data[1].y).toBe(160);
  });

  it('should return p99 timeSeries correctly when metric is p99_latency', async () => {
    const request = makeRequest({
      metric: 'p99_latency',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(data.series[0].name).toBe('P99 Latency');
    expect(data.series[0].data[0].y).toBe(800);
    expect(data.series[0].data[1].y).toBe(850);
  });
});

// ---------------------------------------------------------------------------
// Top Models (Ranking)
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (top_models)', () => {
  it('should return ranking with model names and request counts when metric is top_models', async () => {
    mockGetModelStats.mockResolvedValue({
      models: [
        { model: 'gpt-4o', requests: 300, cost: 15, tokens: 100000, inputTokens: 40000, outputTokens: 60000, avgLatencyMs: 350, successRate: 0.96 },
        { model: 'claude-sonnet-4', requests: 200, cost: 10, tokens: 80000, inputTokens: 30000, outputTokens: 50000, avgLatencyMs: 280, successRate: 0.98 },
      ],
    });

    const request = makeRequest({
      metric: 'top_models',
      visualization: 'bar',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('ranking');
    expect(data.items).toEqual([
      { name: 'gpt-4o', value: 300 },
      { name: 'claude-sonnet-4', value: 200 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Derived Metrics (cost_per_request, tokens_per_request, success_rate)
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (derived metrics)', () => {
  beforeEach(setupMetricsMock);

  it('should return stat with computed ratio when metric is cost_per_request', async () => {
    const request = makeRequest({
      metric: 'cost_per_request',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    // totalCost(125.50) / totalRequests(5000) = 0.0251
    expect(data.value).toBe(0.0251);
    expect(data.label).toBe(METRIC_LABELS['cost_per_request'] ?? 'cost_per_request');
  });

  it('should return stat with computed ratio when metric is tokens_per_request', async () => {
    const request = makeRequest({
      metric: 'tokens_per_request',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    // totalTokens(2500000) / totalRequests(5000) = 500
    expect(data.value).toBe(500);
    expect(data.label).toBe(METRIC_LABELS['tokens_per_request'] ?? 'tokens_per_request');
  });

  it('should return stat with computed success_rate when metric is success_rate', async () => {
    const request = makeRequest({
      metric: 'success_rate',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    // (5000 - 200) / 5000 * 100 = 96
    expect(data.value).toBe(96);
    expect(data.label).toBe(METRIC_LABELS['success_rate'] ?? 'success_rate');
  });

  it('should return timeSeries with per-bucket ratio when metric is cost_per_request', async () => {
    const request = makeRequest({
      metric: 'cost_per_request',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe('cost_per_request');
    expect(data.series[0].data).toHaveLength(2);
    // Point 0: cost(2.50) / requests(100) = 0.025
    expect(data.series[0].data[0].x).toBe('2026-01-28');
    expect(data.series[0].data[0].y).toBe(0.025);
    // Point 1: cost(5.00) / requests(200) = 0.025
    expect(data.series[0].data[1].x).toBe('2026-01-29');
    expect(data.series[0].data[1].y).toBe(0.025);
  });

  it('should return timeSeries with per-bucket success_rate when metric is success_rate', async () => {
    const request = makeRequest({
      metric: 'success_rate',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe('success_rate');
    expect(data.series[0].data).toHaveLength(2);
    // Point 0: (100 - 5) / 100 * 100 = 95
    expect(data.series[0].data[0].x).toBe('2026-01-28');
    expect(data.series[0].data[0].y).toBe(95);
    // Point 1: (200 - 10) / 200 * 100 = 95
    expect(data.series[0].data[1].x).toBe('2026-01-29');
    expect(data.series[0].data[1].y).toBe(95);
  });

  it('should handle zero denominator gracefully when stat denominator is zero', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: {
        totalRequests: 0,
        successCount: 0,
        errorCount: 0,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        avgLatencyMs: 0,
        uniqueUsers: 0,
      },
      timeSeries: [],
    });

    const request = makeRequest({
      metric: 'cost_per_request',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('stat');
    expect(data.value).toBe(0);
  });

  it('should handle zero denominator gracefully when timeSeries denominator is zero', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: realisticSummary,
      timeSeries: [
        {
          date: '2026-01-28',
          hour: 0,
          requests: 0,
          successes: 0,
          errors: 0,
          cost: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          avgLatencyMs: 0,
          uniqueUsers: 0,
        },
      ],
    });

    const request = makeRequest({
      metric: 'cost_per_request',
      visualization: 'line',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data).toHaveLength(1);
    expect(data.series[0].data[0].y).toBe(0);
  });
});
