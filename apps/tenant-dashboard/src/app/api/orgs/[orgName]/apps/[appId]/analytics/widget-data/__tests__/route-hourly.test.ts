/**
 * Tests: POST /api/analytics/widget-data — hourly granularity path
 *
 * When dateRange.start === dateRange.end (e.g. '24h' / 'today'), MetricsService
 * returns 24 hourly buckets keyed by (date, hour). The route must emit one ISO
 * datetime per point so the chart's datetime x-axis renders 24 distinct
 * positions instead of stacking everything onto midnight UTC of the same day.
 *
 * The companion file route.test.ts uses a multi-day mock and already asserts
 * plain-date x values (see "with realistic data" tests around line 535).
 * Together they pin both branches of buildTimeSeriesX.
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

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getMetrics: mockGetMetrics,
    getExtendedMetrics: mockGetExtendedMetrics,
    getPercentiles: vi.fn(),
    getModelStats: vi.fn(),
    getRankingData: vi.fn(),
  }),
  // Same-day range — mirrors what parseDateRange('24h') / parseDateRange('today')
  // produce. Triggers useHourlyGranularity in MetricsService.
  parseDateRange: (_preset: string) => ({ start: '2026-04-29', end: '2026-04-29' }),
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

describe('POST /api/analytics/widget-data — hourly granularity', () => {
  it('emits ISO datetime x for built-in metrics when dateRange is same-day', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 60, totalCost: 1.5 },
      timeSeries: [
        { date: '2026-04-29', hour: 0, requests: 5, successes: 5, errors: 0, cost: 0.1, tokens: 1000, inputTokens: 400, outputTokens: 600, avgLatencyMs: 200, uniqueUsers: 2 },
        { date: '2026-04-29', hour: 14, requests: 25, successes: 24, errors: 1, cost: 0.6, tokens: 5000, inputTokens: 2000, outputTokens: 3000, avgLatencyMs: 250, uniqueUsers: 8 },
        { date: '2026-04-29', hour: 23, requests: 30, successes: 30, errors: 0, cost: 0.8, tokens: 6000, inputTokens: 2500, outputTokens: 3500, avgLatencyMs: 220, uniqueUsers: 10 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'line',
      timeRange: { preset: '24h' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data).toEqual([
      { x: '2026-04-29T00:00:00Z', y: 5 },
      { x: '2026-04-29T14:00:00Z', y: 25 },
      { x: '2026-04-29T23:00:00Z', y: 30 },
    ]);
  });

  it('zero-pads single-digit hours so x is always 20 characters', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 30, totalCost: 0.6 },
      timeSeries: [
        { date: '2026-04-29', hour: 1, requests: 10, successes: 10, errors: 0, cost: 0.2, tokens: 2000, inputTokens: 800, outputTokens: 1200, avgLatencyMs: 200, uniqueUsers: 3 },
        { date: '2026-04-29', hour: 9, requests: 20, successes: 20, errors: 0, cost: 0.4, tokens: 4000, inputTokens: 1600, outputTokens: 2400, avgLatencyMs: 210, uniqueUsers: 5 },
      ],
    });

    const request = makeRequest({
      metric: 'request_count',
      visualization: 'line',
      timeRange: { preset: '24h' },
    });

    const data = await (await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) })).json();
    const xs = data.series[0].data.map((d: { x: string }) => d.x);
    expect(xs).toEqual(['2026-04-29T01:00:00Z', '2026-04-29T09:00:00Z']);
    // ISO datetime always 20 chars (YYYY-MM-DDTHH:MM:SSZ); date-only would be 10
    xs.forEach((x: string) => expect(x).toHaveLength(20));
  });

  it('emits ISO datetime x for derived metrics (success_rate)', async () => {
    mockGetExtendedMetrics.mockResolvedValue({
      summary: { totalRequests: 100, errorCount: 10 },
      timeSeries: [
        { date: '2026-04-29', hour: 8, requests: 20, successes: 18, errors: 2, cost: 0.4, tokens: 4000, inputTokens: 1500, outputTokens: 2500, avgLatencyMs: 200, uniqueUsers: 5 },
        { date: '2026-04-29', hour: 16, requests: 80, successes: 72, errors: 8, cost: 1.6, tokens: 16000, inputTokens: 6000, outputTokens: 10000, avgLatencyMs: 240, uniqueUsers: 20 },
      ],
    });

    const request = makeRequest({
      metric: 'success_rate',
      visualization: 'line',
      timeRange: { preset: '24h' },
    });

    const data = await (await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) })).json();
    expect(data.type).toBe('timeSeries');
    expect(data.series[0].data.map((d: { x: string }) => d.x)).toEqual([
      '2026-04-29T08:00:00Z',
      '2026-04-29T16:00:00Z',
    ]);
  });
});
