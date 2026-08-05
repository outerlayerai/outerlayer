/**
 * SQL Query Tests
 * Feature: 007-analytics-architecture-evaluation
 *
 * Tests to validate SQL query structure and prevent common errors.
 */

import {
  METRICS_SUMMARY_QUERY,
  METRICS_TIME_SERIES_QUERY,
  TRACES_LIST_QUERY,
  TRACES_COUNT_QUERY,
  PERCENTILES_LATENCY_QUERY,
  PERCENTILES_TOKENS_QUERY,
  STATUS_ERROR_VALUES_SQL,
  TRACE_ID_TIME_RANGE_QUERY,
  dimensionToClickHouseColumn,
  buildRankingByDimensionQuery,
  buildFilteredMetricsSummaryQuery,
  buildFilteredModelStatsQuery,
} from '../queries';

describe('StatusCode canonical semantics', () => {
  // The converter writes OTLP numeric strings ('0'/'1'/'2'); legacy rows may
  // carry enum-name variants. Every aggregate must classify on the tolerant
  // error set — `!= '2'` alone counts 'STATUS_CODE_ERROR' rows as successes.
  it('error set covers numeric AND legacy string variants', () => {
    expect(STATUS_ERROR_VALUES_SQL).toBe(`('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')`);
  });

  it.each([
    ['METRICS_SUMMARY_QUERY', METRICS_SUMMARY_QUERY],
    ['METRICS_TIME_SERIES_QUERY', METRICS_TIME_SERIES_QUERY],
    ['buildFilteredMetricsSummaryQuery', buildFilteredMetricsSummaryQuery({
      appId: 'a', tenantId: 't', startDate: '2024-01-01', endDate: '2024-01-02',
      filterClause: '', retentionCutoff: '1970-01-01 00:00:00.000',
    }).query],
  ])('%s classifies success/error on the tolerant set', (_name, sql) => {
    expect(sql).toContain(
      `countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count`,
    );
    expect(sql).toContain(
      `countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count`,
    );
    // The old, broken predicate must not survive anywhere.
    expect(sql).not.toContain("countIf(StatusCode != '2')");
    expect(sql).not.toContain("countIf(StatusCode = '2')");
  });

  it('model stats success_rate uses the tolerant set', () => {
    const sql = buildFilteredModelStatsQuery({
      appId: 'a', tenantId: 't', startDate: '2024-01-01', endDate: '2024-01-02',
      filterClause: '', limit: 10, retentionCutoff: '1970-01-01 00:00:00.000',
    }).query;
    expect(sql).toContain(
      `countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) / count() * 100, 0) as success_rate`,
    );
  });

  it('trace list rolls up status as error when ANY span matches the error set', () => {
    expect(TRACES_LIST_QUERY).toContain(
      `if(countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) > 0, '2', '1') as status`,
    );
  });
});

describe('TRACE_ID_TIME_RANGE_QUERY', () => {
  it('reads the otel_traces_trace_id_ts lookup, tenant-scoped, parameterized', () => {
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('FROM otel_traces_trace_id_ts');
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('TraceId = {traceId:String}');
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('AppId = {appId:String}');
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('TenantId = {tenantId:String}');
    // min/max collapse unmerged AggregatingMergeTree parts
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('min(Start) as start');
    expect(TRACE_ID_TIME_RANGE_QUERY).toContain('max(End) as end');
  });
});

describe('METRICS_SUMMARY_QUERY', () => {
  it('should have required query parameters', () => {
    expect(METRICS_SUMMARY_QUERY).toContain('{appId:String}');
    expect(METRICS_SUMMARY_QUERY).toContain('{startDate:Date}');
    expect(METRICS_SUMMARY_QUERY).toContain('{endDate:Date}');
  });

  it('should query from otel_traces with projection optimization', () => {
    expect(METRICS_SUMMARY_QUERY).toContain('FROM otel_traces');
    expect(METRICS_SUMMARY_QUERY).toContain("Type = 'GENERATION'");
  });

  it('should calculate unique users with uniq', () => {
    expect(METRICS_SUMMARY_QUERY).toContain('uniq(UserId)');
  });
});

describe('TRACES_LIST_QUERY', () => {
  it('should use DateTime64 type for timestamp parameters', () => {
    // DateTime64 is required for millisecond precision timestamps
    expect(TRACES_LIST_QUERY).toContain('{startDate:DateTime64}');
    expect(TRACES_LIST_QUERY).toContain('{endDate:DateTime64}');
  });

  it('should support pagination', () => {
    expect(TRACES_LIST_QUERY).toContain('{limit:UInt32}');
    expect(TRACES_LIST_QUERY).toContain('{offset:UInt32}');
  });

  it('should calculate latency from Duration field, not EndTime', () => {
    // Duration is the measured span time in milliseconds
    // EndTime may not be populated, so we use Duration directly
    expect(TRACES_LIST_QUERY).toContain('max(Duration) as latency_ms');
    // Should NOT use dateDiff with EndTime
    expect(TRACES_LIST_QUERY).not.toContain('dateDiff');
  });
});

describe('PERCENTILES_LATENCY_QUERY', () => {
  it('should use DateTime64 for timestamps', () => {
    expect(PERCENTILES_LATENCY_QUERY).toContain('{startDate:DateTime64}');
    expect(PERCENTILES_LATENCY_QUERY).toContain('{endDate:DateTime64}');
  });

  it('should calculate p75, p90, p95, p99 percentiles', () => {
    expect(PERCENTILES_LATENCY_QUERY).toContain('quantile(0.75)');
    expect(PERCENTILES_LATENCY_QUERY).toContain('quantile(0.90)');
    expect(PERCENTILES_LATENCY_QUERY).toContain('quantile(0.95)');
    expect(PERCENTILES_LATENCY_QUERY).toContain('quantile(0.99)');
  });

  it('should filter for GENERATION type spans only', () => {
    expect(PERCENTILES_LATENCY_QUERY).toContain("Type = 'GENERATION'");
  });
});

describe('All queries should use parameterized syntax', () => {
  const queries = [
    { name: 'METRICS_SUMMARY_QUERY', query: METRICS_SUMMARY_QUERY },
    { name: 'METRICS_TIME_SERIES_QUERY', query: METRICS_TIME_SERIES_QUERY },
    { name: 'TRACES_LIST_QUERY', query: TRACES_LIST_QUERY },
    { name: 'TRACES_COUNT_QUERY', query: TRACES_COUNT_QUERY },
    { name: 'PERCENTILES_LATENCY_QUERY', query: PERCENTILES_LATENCY_QUERY },
    { name: 'PERCENTILES_TOKENS_QUERY', query: PERCENTILES_TOKENS_QUERY },
  ];

  test.each(queries)('$name should use ClickHouse parameterized syntax', ({ query }) => {
    // All queries should have at least appId parameter
    expect(query).toContain('{appId:String}');

    // Should not have SQL injection vulnerable patterns
    expect(query).not.toContain('${');
    expect(query).not.toMatch(/'\s*\+/); // No string concatenation
  });
});

// ============================================================================
// dimensionToClickHouseColumn
// ============================================================================

describe('dimensionToClickHouseColumn', () => {
  // The truthiness check on the map lookup IS the validity check, and the
  // result is interpolated into GROUP BY, so only owned keys may resolve.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'returns null for the inherited member %s',
    inherited => {
      expect(dimensionToClickHouseColumn(inherited)).toBeNull();
    },
  );

  it('should map model to Model column', () => {
    expect(dimensionToClickHouseColumn('model')).toBe('Model');
  });

  it('should map user_id to UserId column', () => {
    expect(dimensionToClickHouseColumn('user_id')).toBe('UserId');
  });

  it('should map metadata.feature to Metadata[\'feature\'] expression', () => {
    expect(dimensionToClickHouseColumn('metadata.feature')).toBe("Metadata['feature']");
  });

  it('should map metadata.env_name to Metadata[\'env_name\'] expression', () => {
    expect(dimensionToClickHouseColumn('metadata.env_name')).toBe("Metadata['env_name']");
  });

  it('should return null for unknown dimensions', () => {
    expect(dimensionToClickHouseColumn('unknown')).toBeNull();
    expect(dimensionToClickHouseColumn('time_period')).toBeNull();
    expect(dimensionToClickHouseColumn('')).toBeNull();
  });

  it('should reject metadata keys with unsafe characters', () => {
    expect(dimensionToClickHouseColumn("metadata.'; DROP TABLE--")).toBeNull();
    expect(dimensionToClickHouseColumn('metadata.key with spaces')).toBeNull();
    expect(dimensionToClickHouseColumn('metadata.')).toBeNull();
  });

  it('should accept metadata keys with dots, hyphens, and underscores', () => {
    expect(dimensionToClickHouseColumn('metadata.my-key')).toBe("Metadata['my-key']");
    expect(dimensionToClickHouseColumn('metadata.my.key')).toBe("Metadata['my.key']");
    expect(dimensionToClickHouseColumn('metadata.my_key')).toBe("Metadata['my_key']");
  });
});

// ============================================================================
// buildRankingByDimensionQuery
// ============================================================================

describe('buildRankingByDimensionQuery', () => {
  const baseInput = {
    appId: 'app-123',
    tenantId: 'test-tenant',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    filterClause: '',
    limit: 10,
    groupByColumn: 'Model',
    retentionCutoff: '1970-01-01 00:00:00.000',
  };

  it('should use the provided groupByColumn in SELECT and GROUP BY', () => {
    const result = buildRankingByDimensionQuery(baseInput);
    expect(result.query).toContain('Model as dimension_value');
    expect(result.query).toContain('GROUP BY Model');
  });

  it('should filter out empty dimension values', () => {
    const result = buildRankingByDimensionQuery(baseInput);
    expect(result.query).toContain("Model != ''");
  });

  it('should use parameterized appId, dates, and limit', () => {
    const result = buildRankingByDimensionQuery(baseInput);
    expect(result.query).toContain('{appId:String}');
    expect(result.query).toContain('{startDate:Date}');
    expect(result.query).toContain('{endDate:Date}');
    expect(result.query).toContain('{limit:UInt32}');
    expect(result.params).toEqual({
      appId: 'app-123',
      tenantId: 'test-tenant',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      limit: 10,
      retentionCutoff: '1970-01-01 00:00:00.000',
    });
  });

  it('should work with UserId column', () => {
    const result = buildRankingByDimensionQuery({ ...baseInput, groupByColumn: 'UserId' });
    expect(result.query).toContain('UserId as dimension_value');
    expect(result.query).toContain('GROUP BY UserId');
    expect(result.query).toContain("UserId != ''");
  });

  it('should work with Metadata column expression', () => {
    const result = buildRankingByDimensionQuery({ ...baseInput, groupByColumn: "Metadata['feature']" });
    expect(result.query).toContain("Metadata['feature'] as dimension_value");
    expect(result.query).toContain("GROUP BY Metadata['feature']");
  });

  it('should include filter clause when provided', () => {
    const result = buildRankingByDimensionQuery({
      ...baseInput,
      filterClause: 'AND Model = {filter_model:String}',
    });
    expect(result.query).toContain('AND Model = {filter_model:String}');
  });
});
