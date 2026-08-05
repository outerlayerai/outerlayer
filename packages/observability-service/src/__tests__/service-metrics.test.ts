/**
 * Service Metrics Tests
 *
 * Each test targets a specific bug class. No test relies on JavaScript
 * semantics — every assertion would fail under a plausible-looking
 * change to the production code.
 *
 * Coverage focus:
 *   - getRankingData and getAggregateRequests both have early-return
 *     paths for invalid dimensions (uncovered in the smoke-test suite).
 *   - getExtendedMetrics has divide-by-zero protection via `|| 1` —
 *     a refactor to `??` would silently produce NaN in production.
 *   - getMetrics normalizes full ISO datetimes via isoToClickHouseDate.
 *     The Schemathesis comment in metrics.ts records that this is a real
 *     bug class.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

const verifiedAppId = 'app-123' as VerifiedAppId;
const testCtx: TenantContext = {
  userId: 'test-user',
  tenantId: 'tenant-123',
  appId: verifiedAppId,
  dataRetentionDays: -1,
};

function rawSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_requests: '100',
    success_count: '95',
    error_count: '5',
    total_cost: '0.5',
    total_tokens: '50000',
    input_tokens: '30000',
    output_tokens: '20000',
    avg_latency_ms: '250',
    unique_users: '12',
    ...overrides,
  };
}

describe('AnalyticsService.getMetrics', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('normalizes full ISO datetime to YYYY-MM-DD via isoToClickHouseDate', async () => {
    // ClickHouse's Date type rejects full ISO datetimes
    // ("only 10 of 20 bytes was parsed"). This bug shipped once and was
    // caught by Schemathesis (see metrics.ts). Locking it in.
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([rawSummary()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    await service.getMetrics(testCtx, {
      start: '2024-01-15T00:00:00Z', // full ISO, with Z
      end: '2024-02-15T00:00:00.000+05:30', // offset timezone
    });

    const summaryCall = mockQuery.mock.calls[0]![0];
    // Both must be normalized to date-only (UTC).
    // The +05:30 endDate is 19:30 the prior day in UTC, but our test
    // input is 2024-02-15T00:00:00.000+05:30 → 2024-02-14T18:30:00Z → '2024-02-14'.
    expect(summaryCall.query_params.startDate).toBe('2024-01-15');
    expect(summaryCall.query_params.endDate).toBe('2024-02-14');
  });

  it('uses the hourly time-series query when start === end, daily otherwise', async () => {
    // Hourly path: same start/end.
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([rawSummary()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    await service.getMetrics(testCtx, { start: '2024-01-15', end: '2024-01-15' });
    const hourlyTimeSeriesCall = mockQuery.mock.calls[1]![0];
    expect(hourlyTimeSeriesCall.query).toContain('toHour(Timestamp) as hour');
    expect(hourlyTimeSeriesCall.query).toContain('GROUP BY date, hour');

    // Daily path: different start/end.
    vi.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([rawSummary()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    await service.getMetrics(testCtx, { start: '2024-01-15', end: '2024-01-22' });
    const dailyTimeSeriesCall = mockQuery.mock.calls[1]![0];
    expect(dailyTimeSeriesCall.query).toContain('0 as hour');
    expect(dailyTimeSeriesCall.query).not.toContain('toHour(Timestamp)');
    expect(dailyTimeSeriesCall.query).toMatch(/GROUP BY date\s*$/m);
  });

  it('propagates filter clause and bound params into BOTH summary and time-series queries', async () => {
    // Filters drive the entire dashboard's query behavior. If the
    // filter clause is embedded in one query but not the other, the
    // summary numbers won't match the time-series chart. If params
    // aren't bound, ClickHouse raises a runtime error.
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([rawSummary()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    await service.getMetrics(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      [
        { field: 'model', operator: 'equals', value: 'gpt-4o' },
        { field: 'latency_ms', operator: 'gt', value: '100' },
      ],
    );

    const summaryCall = mockQuery.mock.calls[0]![0];
    const timeSeriesCall = mockQuery.mock.calls[1]![0];

    // Same filter clauses must be embedded in BOTH queries.
    for (const call of [summaryCall, timeSeriesCall]) {
      expect(call.query).toContain('Model = {filter_0:String}');
      expect(call.query).toContain('Duration > {filter_1:Float64}');
      expect(call.query_params.filter_0).toBe('gpt-4o');
      expect(call.query_params.filter_1).toBe(100);
    }
  });

  it('applies transformTimeSeriesPoint and fillTimeSeriesGaps to the time-series result', async () => {
    // Single-day range → hourly mode → fillTimeSeriesGaps fills 24
    // points. Raw data covers only 2 hours. Verify:
    //   (a) the 2 supplied points are field-renamed (request_count →
    //       requests, total_cost → cost, etc.)
    //   (b) the 22 gap hours are filled with zero points (not dropped)
    //   (c) the hourly flag is wired correctly (24 points, not 1)
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([rawSummary()]) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            date: '2024-01-15',
            hour: '5',
            request_count: '12',
            success_count: '11',
            error_count: '1',
            total_cost: '0.12',
            total_tokens: '600',
            total_input_tokens: '400',
            total_output_tokens: '200',
            avg_latency_ms: '180',
            unique_users: '3',
          },
          {
            date: '2024-01-15',
            hour: '10',
            request_count: '8',
            success_count: '8',
            error_count: '0',
            total_cost: '0.08',
            total_tokens: '400',
            total_input_tokens: '250',
            total_output_tokens: '150',
            avg_latency_ms: '160',
            unique_users: '2',
          },
        ]),
      });

    const result = await service.getMetrics(testCtx, { start: '2024-01-15', end: '2024-01-15' });

    // Gap-filling produced 24 hourly slots for the single day.
    expect(result.timeSeries).toHaveLength(24);

    // Hour 5 carries the transformed values from the raw data.
    expect(result.timeSeries[5]).toEqual({
      date: '2024-01-15',
      hour: 5,
      requests: 12,
      successes: 11,
      errors: 1,
      cost: 0.12,
      tokens: 600,
      inputTokens: 400,
      outputTokens: 200,
      avgLatencyMs: 180,
      uniqueUsers: 3,
    });

    // A gap hour (hour 0) is zero-filled, not dropped or NaN.
    expect(result.timeSeries[0]).toEqual({
      date: '2024-01-15',
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
    });

    // Hour 10 is the other supplied hour — verify it landed in slot 10
    // (gap-filling must not reorder or shift the real data).
    expect(result.timeSeries[10]!.requests).toBe(8);
  });
});

describe('AnalyticsService.getModelStats', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('applies limit default of 10 and transforms model rows', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        {
          model: 'gpt-4o',
          total_requests: '500',
          cost: '1.25',
          tokens: '120000',
          input_tokens: '80000',
          output_tokens: '40000',
          avg_latency_ms: '320',
          success_rate: '99.4',
        },
      ]),
    });

    const result = await service.getModelStats(testCtx, { start: '2024-01-15', end: '2024-01-22' });

    expect(result.models).toEqual([
      {
        model: 'gpt-4o',
        requests: 500,
        cost: 1.25,
        tokens: 120000,
        inputTokens: 80000,
        outputTokens: 40000,
        avgLatencyMs: 320,
        successRate: 99.4,
      },
    ]);

    // Default limit applied. Catches drift from 10 → other values.
    const call = mockQuery.mock.calls[0]![0];
    expect(call.query_params.limit).toBe(10);
  });
});

describe('AnalyticsService.getRankingData', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('returns empty items[] and fires NO query when the dimension is invalid', async () => {
    // 'unknown_dimension' is not in RANKING_DIMENSION_TO_COLUMN and is
    // not 'metadata.xxx'. Must early-return before issuing a query —
    // protects against SQL injection via unvalidated column names.
    const result = await service.getRankingData(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      'unknown_dimension',
    );

    expect(result).toEqual({ items: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('routes dimension to the right column, transforms rows, and applies limit default of 10', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        {
          dimension_value: 'gpt-4o',
          total_requests: '400',
          cost: '0.8',
          tokens: '50000',
          input_tokens: '30000',
          output_tokens: '20000',
          avg_latency_ms: '210',
          success_rate: '98.5',
        },
      ]),
    });

    const result = await service.getRankingData(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      'model',
    );

    expect(result).toEqual({
      items: [
        {
          dimensionValue: 'gpt-4o',
          requests: 400,
          cost: 0.8,
          tokens: 50000,
          inputTokens: 30000,
          outputTokens: 20000,
          avgLatencyMs: 210,
          successRate: 98.5,
        },
      ],
    });

    const call = mockQuery.mock.calls[0]![0];
    // Catches: limit default drift, AND wrong groupBy column for 'model'.
    expect(call.query_params.limit).toBe(10);
    // 'model' must route to ClickHouse column `Model` — anything else is a
    // SQL injection risk (the column name is interpolated, not bound).
    expect(call.query).toMatch(/\bModel as dimension_value\b/);
  });

  it('routes metadata.xxx through regex validation: accepts safe keys, rejects unsafe ones (no query fires)', async () => {
    // The metadata.* path uses a DIFFERENT validation mechanism than the
    // lookup-table dimensions — it relies on a regex (`/^[a-zA-Z0-9_.-]+$/`)
    // to gate which characters are allowed in the interpolated column
    // expression `Metadata['<key>']`. If the regex weakens, this becomes
    // a SQL injection vector. This test fences that contract.

    // Safe metadata key: must route to `Metadata['region']`.
    mockQuery.mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });
    await service.getRankingData(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      'metadata.region',
    );
    const safeCall = mockQuery.mock.calls[0]![0];
    expect(safeCall.query).toContain("Metadata['region'] as dimension_value");

    // Unsafe key: contains characters disallowed by the regex (`;`, space).
    // Must early-return empty items[] without firing a query.
    vi.clearAllMocks();
    const result = await service.getRankingData(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      'metadata.x;DROP TABLE otel_traces',
    );
    expect(result).toEqual({ items: [] });
    expect(mockQuery).not.toHaveBeenCalled();

    // Edge: empty key after `metadata.` prefix — must also be rejected.
    vi.clearAllMocks();
    const emptyResult = await service.getRankingData(
      testCtx,
      { start: '2024-01-15', end: '2024-01-22' },
      'metadata.',
    );
    expect(emptyResult).toEqual({ items: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.getAggregateRequests', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('returns an empty paginated shape and fires NO query when the dimension is invalid', async () => {
    const result = await service.getAggregateRequests(testCtx, {
      dimension: 'definitely_not_valid',
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('falls back to ORDER BY total_requests when sortField is unknown; uses the mapped alias when known', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            dimension_value: 'gpt-4o',
            total_requests: '300',
            cost: '0.5',
            tokens: '40000',
            input_tokens: '25000',
            output_tokens: '15000',
            avg_latency_ms: '200',
            success_rate: '97.0',
          },
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) });

    // Unknown sortField — must fall back to 'total_requests'.
    await service.getAggregateRequests(testCtx, {
      dimension: 'model',
      sortField: 'bogus',
      sortOrder: 'asc',
      limit: 10,
      offset: 0,
    });
    const fallbackDataQuery = mockQuery.mock.calls[0]![0].query;
    expect(fallbackDataQuery).toContain('ORDER BY total_requests ASC');

    // Known sortField — must use the mapped alias.
    vi.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            dimension_value: 'gpt-4o',
            total_requests: '300',
            cost: '0.5',
            tokens: '40000',
            input_tokens: '25000',
            output_tokens: '15000',
            avg_latency_ms: '200',
            success_rate: '97.0',
          },
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) });

    const result = await service.getAggregateRequests(testCtx, {
      dimension: 'model',
      sortField: 'cost',
      sortOrder: 'desc',
      limit: 10,
      offset: 0,
    });
    const knownDataQuery = mockQuery.mock.calls[0]![0].query;
    expect(knownDataQuery).toContain('ORDER BY cost DESC');

    // Response transformation must integrate the count, not silently
    // drop or duplicate it.
    expect(result).toEqual({
      items: [
        {
          dimensionValue: 'gpt-4o',
          requests: 300,
          cost: 0.5,
          tokens: 40000,
          inputTokens: 25000,
          outputTokens: 15000,
          avgLatencyMs: 200,
          successRate: 97.0,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });
  });

  function mockAggregateQueryResults() {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '0' }]) });
  }

  // The resolved alias is interpolated into ORDER BY, so a caller-supplied name
  // the map does not own must fall through to the default. A plain-object
  // lookup answers these with an inherited member instead — `constructor`
  // yields a function whose stringification is not valid SQL.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to ORDER BY total_requests for the inherited sortField %s',
    async inherited => {
      mockAggregateQueryResults();

      await service.getAggregateRequests(testCtx, {
        dimension: 'model',
        sortField: inherited,
        sortOrder: 'desc',
        limit: 10,
        offset: 0,
      });

      const dataQuery = mockQuery.mock.calls[0]![0].query;
      expect(dataQuery).toContain('ORDER BY total_requests DESC');
      expect(dataQuery).not.toContain('function');
      expect(dataQuery).not.toContain('[object Object]');
    },
  );

  it('scopes BOTH data and count queries to the env, parameterized, when env is passed', async () => {
    mockAggregateQueryResults();

    await service.getAggregateRequests(testCtx, {
      dimension: 'model',
      limit: 10,
      offset: 0,
      env: { environment: { name: 'staging', isDefault: false } },
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const dataCall = mockQuery.mock.calls[0]![0];
    const countCall = mockQuery.mock.calls[1]![0];

    // Non-default env: exact-match clause, NO legacy '' carve-out.
    expect(dataCall.query).toContain('AND Environment = {envName:String}');
    expect(dataCall.query).not.toContain("Environment = ''");
    expect(countCall.query).toContain('AND Environment = {envName:String}');
    expect(countCall.query).not.toContain("Environment = ''");

    // Env name travels as a bound param, never interpolated into SQL.
    expect(dataCall.query_params.envName).toBe('staging');
    expect(countCall.query_params.envName).toBe('staging');
    expect(dataCall.query).not.toContain('staging');
  });

  it('includes legacy Environment="" rows ONLY for the default env', async () => {
    mockAggregateQueryResults();

    await service.getAggregateRequests(testCtx, {
      dimension: 'model',
      limit: 10,
      offset: 0,
      env: { environment: { name: 'dev', isDefault: true } },
    });

    const dataCall = mockQuery.mock.calls[0]![0];
    expect(dataCall.query).toContain(
      "AND (Environment = {envName:String} OR Environment = '')",
    );
    expect(dataCall.query_params.envName).toBe('dev');
  });

  it('applies no env clause when env is omitted (legacy caller contract)', async () => {
    mockAggregateQueryResults();

    await service.getAggregateRequests(testCtx, {
      dimension: 'model',
      limit: 10,
      offset: 0,
    });

    const dataCall = mockQuery.mock.calls[0]![0];
    expect(dataCall.query).not.toContain('Environment');
    expect(dataCall.query_params).not.toHaveProperty('envName');
  });
});

describe('AnalyticsService.getPercentiles', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('selects the right ClickHouse column for each metric: latency→Duration, *Tokens→matching column', async () => {
    const cases: Array<{ metric: 'latency' | 'totalTokens' | 'inputTokens' | 'outputTokens'; expectedColumn: string }> = [
      { metric: 'latency', expectedColumn: 'Duration' },
      { metric: 'totalTokens', expectedColumn: 'TotalTokens' },
      { metric: 'inputTokens', expectedColumn: 'InputTokens' },
      { metric: 'outputTokens', expectedColumn: 'OutputTokens' },
    ];

    for (const { metric, expectedColumn } of cases) {
      vi.clearAllMocks();
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([]),
      });

      await service.getPercentiles(testCtx, {
        range: 'custom',
        startDate: '2024-01-15',
        endDate: '2024-01-22',
        metric,
      });

      const call = mockQuery.mock.calls[0]![0];
      // All four percentile aggregations must wrap the expected column.
      // Catches: swapping latency↔tokens, sending OutputTokens when caller
      // asked for InputTokens, partial column substitution (only p75 was
      // updated, p90/p95/p99 left on the wrong column), etc.
      expect(call.query).toContain(`quantile(0.75)(${expectedColumn}) as p75`);
      expect(call.query).toContain(`quantile(0.90)(${expectedColumn}) as p90`);
      expect(call.query).toContain(`quantile(0.95)(${expectedColumn}) as p95`);
      expect(call.query).toContain(`quantile(0.99)(${expectedColumn}) as p99`);

      // No cross-contamination: a latency request must NOT bind a tokens
      // column anywhere in any quantile() aggregation.
      const otherColumns = ['Duration', 'TotalTokens', 'InputTokens', 'OutputTokens'].filter(
        (c) => c !== expectedColumn,
      );
      for (const other of otherColumns) {
        expect(call.query).not.toMatch(new RegExp(`quantile\\(\\d\\.\\d+\\)\\(${other}\\)`));
      }
    }
  });
});

describe('AnalyticsService.getExtendedMetrics', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('computes per-request averages, passes through base summary fields, and reports model count', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          rawSummary({
            total_requests: '100',
            success_count: '94',
            error_count: '6',
            total_cost: '2.5',
            input_tokens: '30000',
            output_tokens: '20000',
            total_tokens: '50000',
            avg_latency_ms: '210',
            unique_users: '8',
          }),
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ model_count: '4' }]) });

    const result = await service.getExtendedMetrics(testCtx, { start: '2024-01-15', end: '2024-01-22' });

    // Exact match on the full extended summary. Catches:
    //   - wrong field referenced for an average
    //   - swap of input/output
    //   - modelCount wired to wrong source / parseInt missing
    //   - base-summary fields hardcoded (e.g. successCount: 0) sneaking
    //     past via the `...baseSummary` spread
    //   - extra/missing fields
    expect(result.summary).toEqual({
      totalRequests: 100,
      successCount: 94,
      errorCount: 6,
      totalCost: 2.5,
      totalTokens: 50000,
      inputTokens: 30000,
      outputTokens: 20000,
      avgLatencyMs: 210,
      uniqueUsers: 8,
      avgCostPerRequest: 0.025,
      avgInputTokensPerRequest: 300,
      avgOutputTokensPerRequest: 200,
      avgTotalTokensPerRequest: 500,
      modelCount: 4,
    });
  });

  it('uses (totalRequests || 1) divide-by-zero guard: returns averages=0 when no requests, not NaN', async () => {
    // The `|| 1` guard distinguishes itself from `?? 1` — a refactor to
    // `??` produces NaN in production because `0 ?? 1 === 0` and
    // `anything / 0 === NaN/Infinity`.
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          rawSummary({
            total_requests: '0',
            total_cost: '0',
            input_tokens: '0',
            output_tokens: '0',
            total_tokens: '0',
          }),
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ model_count: '0' }]) });

    const result = await service.getExtendedMetrics(testCtx, { start: '2024-01-15', end: '2024-01-22' });

    // Each average must be a real 0, not NaN and not Infinity — both
    // would render as "NaN" / "∞" in the dashboard.
    expect(result.summary.avgCostPerRequest).toBe(0);
    expect(result.summary.avgInputTokensPerRequest).toBe(0);
    expect(result.summary.avgOutputTokensPerRequest).toBe(0);
    expect(result.summary.avgTotalTokensPerRequest).toBe(0);
    expect(Number.isFinite(result.summary.avgCostPerRequest)).toBe(true);
  });
});

describe('AnalyticsService.getSpanKindBreakdown', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('normalizes ISO datetimes to dates and transforms span-kind rows', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        { kind: 'GENERATION', count: '120', avg_latency_ms: '180.5', total_cost: '0.42', total_tokens: '50000' },
        { kind: 'TOOL', count: '40', avg_latency_ms: '15.2', total_cost: '0', total_tokens: '0' },
      ]),
    });

    const result = await service.getSpanKindBreakdown(testCtx, {
      startDate: '2024-01-15T08:00:00Z',
      endDate: '2024-01-22T23:59:59.999Z',
    });

    // Full toEqual catches field-mapping typos, broken parseInt/parseFloat
    // on count/latency/cost/tokens, missing rows, extra rows.
    expect(result).toEqual([
      { kind: 'GENERATION', count: 120, avgLatencyMs: 180.5, totalCost: 0.42, totalTokens: 50000 },
      { kind: 'TOOL', count: 40, avgLatencyMs: 15.2, totalCost: 0, totalTokens: 0 },
    ]);

    // ClickHouse Date binding — must be YYYY-MM-DD, not a full ISO.
    // Same Schemathesis bug class as getMetrics.
    const call = mockQuery.mock.calls[0]![0];
    expect(call.query_params.startDate).toBe('2024-01-15');
    expect(call.query_params.endDate).toBe('2024-01-22');
  });
});
