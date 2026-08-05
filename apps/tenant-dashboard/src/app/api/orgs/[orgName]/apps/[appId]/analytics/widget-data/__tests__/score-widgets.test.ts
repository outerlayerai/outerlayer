/**
 * Tests: POST /api/analytics/widget-data (score widgets)
 *
 * Tests that widget data requests correctly handle score_* metrics
 * and return the correct response types.
 */

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
  dataRetentionDays: 90,
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

const mockGetCachedScoreAggregations = vi.fn();
const mockGetCachedScoreHistogram = vi.fn();
const mockGetCachedScoreTrend = vi.fn();
const mockGetCachedScoreComparison = vi.fn();
const mockGetCachedScoreScatter = vi.fn();

vi.mock('@/lib/analytics/cache', () => ({
  getCachedScoreAggregations: (...args: unknown[]) => mockGetCachedScoreAggregations(...args),
  getCachedScoreHistogram: (...args: unknown[]) => mockGetCachedScoreHistogram(...args),
  getCachedScoreTrend: (...args: unknown[]) => mockGetCachedScoreTrend(...args),
  getCachedScoreComparison: (...args: unknown[]) => mockGetCachedScoreComparison(...args),
  getCachedScoreScatter: (...args: unknown[]) => mockGetCachedScoreScatter(...args),
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
// Score Summary
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (score_summary)', () => {
  it('should return scoreSummary response type when metric is score_summary', async () => {
    const mockAggregations = {
      aggregations: [
        { name: 'accuracy', avgScore: 0.85, count: 100, minScore: 0.5, maxScore: 1.0 },
        { name: 'relevance', avgScore: 0.72, count: 80, minScore: 0.3, maxScore: 0.95 },
      ],
    };
    mockGetCachedScoreAggregations.mockResolvedValue(mockAggregations);

    const request = makeRequest({
      metric: 'score_summary',
      visualization: 'stat',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreSummary');
    expect(data.aggregations).toHaveLength(2);
    expect(data.aggregations[0].name).toBe('accuracy');
    expect(data.aggregations[0].avgScore).toBe(0.85);
  });

  it('should call getCachedScoreAggregations with correct params', async () => {
    mockGetCachedScoreAggregations.mockResolvedValue({ aggregations: [] });

    const request = makeRequest({
      metric: 'score_summary',
      timeRange: { preset: '7d' },
    });

    await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(mockGetCachedScoreAggregations).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456', dataRetentionDays: 90 }),
      '7d',
      undefined,
      undefined,
      undefined,
      undefined,
      // trailing arg: the multi-env override list (undefined for a non-override widget)
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Score Histogram
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (score_histogram)', () => {
  it('should return scoreHistogram response type when metric is score_histogram', async () => {
    const mockHistogram = {
      name: 'accuracy',
      type: 'numeric',
      buckets: [
        { bucket: 0.5, count: 10 },
        { bucket: 0.7, count: 30 },
        { bucket: 0.9, count: 50 },
      ],
      categories: [],
    };
    mockGetCachedScoreHistogram.mockResolvedValue(mockHistogram);

    const request = makeRequest({
      metric: 'score_histogram',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreHistogram');
    expect(data.data.name).toBe('accuracy');
    expect(data.data.buckets).toHaveLength(3);
  });

  it('should pass scoreName to getCachedScoreHistogram', async () => {
    mockGetCachedScoreHistogram.mockResolvedValue({
      name: 'accuracy',
      type: 'numeric',
      buckets: [],
      categories: [],
    });

    const request = makeRequest({
      metric: 'score_histogram',
      timeRange: { preset: '30d' },
      scoreName: 'accuracy',
    });

    await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(mockGetCachedScoreHistogram).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456', dataRetentionDays: 90 }),
      'accuracy',
      '30d',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // trailing arg: multi-env override list (undefined for a non-override widget)
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Score Trend
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (score_trend)', () => {
  it('should return scoreTrend response type when metric is score_trend', async () => {
    const mockTrend = {
      name: 'accuracy',
      interval: 'day',
      points: [
        { timestamp: '2026-01-28', avgScore: 0.82, count: 20 },
        { timestamp: '2026-01-29', avgScore: 0.85, count: 25 },
      ],
    };
    mockGetCachedScoreTrend.mockResolvedValue(mockTrend);

    const request = makeRequest({
      metric: 'score_trend',
      visualization: 'line',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreTrend');
    expect(data.data.name).toBe('accuracy');
    expect(data.data.points).toHaveLength(2);
  });

  it('should pass scoreName and interval to getCachedScoreTrend', async () => {
    mockGetCachedScoreTrend.mockResolvedValue({
      name: 'accuracy',
      interval: 'day',
      points: [],
    });

    const request = makeRequest({
      metric: 'score_trend',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
    });

    await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(mockGetCachedScoreTrend).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456', dataRetentionDays: 90 }),
      'accuracy',
      'day',
      '7d',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // trailing arg: multi-env override list (undefined for a non-override widget)
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Score Comparison
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data (score_comparison)', () => {
  it('should return scoreComparison with comparison data when both score names given', async () => {
    const mockComparison = {
      nameA: 'accuracy',
      nameB: 'relevance',
      type: 'categorical',
      matrix: [{ labelA: 'pass', labelB: 'pass', count: 50 }],
      totalMatched: 80,
      totalA: 100,
      totalB: 90,
    };
    mockGetCachedScoreComparison.mockResolvedValue(mockComparison);

    const request = makeRequest({
      metric: 'score_comparison',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreComparison');
    expect(data.comparison).toEqual(mockComparison);
  });

  it('should return scoreComparison with scatter data when comparison fails with numeric error', async () => {
    const typeMismatchError = new Error('Score type mismatch: cannot compare numeric scores in confusion matrix');
    (typeMismatchError as Error & { code: string }).code = 'SCORE_TYPE_MISMATCH';
    mockGetCachedScoreComparison.mockRejectedValue(typeMismatchError);
    const mockScatter = {
      nameA: 'accuracy',
      nameB: 'relevance',
      points: [{ scoreA: 0.8, scoreB: 0.7 }],
      totalMatched: 50,
      totalA: 100,
      totalB: 90,
    };
    mockGetCachedScoreScatter.mockResolvedValue(mockScatter);

    const request = makeRequest({
      metric: 'score_comparison',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreComparison');
    expect(data.scatter).toEqual(mockScatter);
  });

  it('should propagate non-type-mismatch errors instead of falling through to scatter', async () => {
    mockGetCachedScoreComparison.mockRejectedValue(new Error('ClickHouse timeout'));

    const request = makeRequest({
      metric: 'score_comparison',
      visualization: 'bar',
      timeRange: { preset: '7d' },
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(response.status).toBe(500);
    expect(mockGetCachedScoreScatter).not.toHaveBeenCalled();
  });

  it('should return empty scoreComparison when no score names provided', async () => {
    const request = makeRequest({
      metric: 'score_comparison',
      visualization: 'bar',
      timeRange: { preset: '7d' },
    });

    const response = await POST(request, { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe('scoreComparison');
    expect(data.comparison).toBeUndefined();
    expect(data.scatter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Env scoping — score widgets must honour a multi-env override list, not
// silently aggregate every env (the non-score widget path already did).
// ---------------------------------------------------------------------------

describe('POST /api/analytics/widget-data — score widget env scoping', () => {
  it('forwards a multi-env OVERRIDE list to the score query (not a single env)', async () => {
    mockGetCachedScoreHistogram.mockResolvedValue({
      name: 'accuracy',
      type: 'numeric',
      buckets: [],
      categories: [],
    });

    await POST(
      makeRequest({
        metric: 'score_histogram',
        timeRange: { preset: '7d' },
        scoreName: 'accuracy',
        // Override widget scoped to two envs → `Environment IN (...)`.
        environments: ['staging', 'prod'],
      })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    const call = mockGetCachedScoreHistogram.mock.calls[0]!;
    // Positional: ctx, name, range, start, end, source, envName, envIsDefault, environments
    expect(call[6]).toBeUndefined(); // no single envName for a multi-env list
    expect(call[8]).toEqual(['staging', 'prod']); // the override list reaches the query
  });

  it('forwards a single override env as a scalar name, not a list', async () => {
    mockGetCachedScoreHistogram.mockResolvedValue({
      name: 'accuracy',
      type: 'numeric',
      buckets: [],
      categories: [],
    });

    await POST(
      makeRequest({
        metric: 'score_histogram',
        timeRange: { preset: '7d' },
        scoreName: 'accuracy',
        environments: ['staging'],
        environmentIsDefault: false,
      })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    const call = mockGetCachedScoreHistogram.mock.calls[0]!;
    expect(call[6]).toBe('staging'); // single env → scalar name
    expect(call[8]).toBeUndefined(); // no multi-env list
  });
});
