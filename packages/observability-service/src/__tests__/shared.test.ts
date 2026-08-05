/**
 * Direct unit tests for src/shared.ts transformer helpers.
 *
 * shared.ts holds small pure helpers (parseMetadata, resolveDateRange,
 * toNumber, fillTimeSeriesGaps, etc.) that are only exercised indirectly
 * through the service-* test files. Exercising them directly here closes
 * the branch coverage gap that mutation testing surfaced: nightly Stryker
 * showed clusters of survivors in resolveDateRange and parseMetadata
 * where the integration tests pinned the happy path but never explored
 * the boundary conditions.
 */

import {
  parseMetadata,
  resolveDateRange,
  toNumber,
  fillTimeSeriesGaps,
  transformMetricsSummary,
  transformTimeSeriesPoint,
  transformModelStats,
  transformPercentilePoint,
  createEmptyTimeSeriesPoint,
  getTokenColumn,
  getRetentionCutoff,
  formatRetentionCutoff,
  formatRetentionCutoffDate,
  QUERY_TIMEOUT_SETTINGS,
} from '../shared';

describe('QUERY_TIMEOUT_SETTINGS', () => {
  it('enforces the server-side timeout and per-partition FINAL processing', () => {
    // do_not_merge_across_partitions_select_final makes every `FINAL` read
    // deduplicate per-partition (parallel, cheaper). Safe because rows FINAL
    // collapses share the full ORDER BY key and the partition key is derived
    // from a column in that key — removing it silently re-enables the
    // expensive cross-partition merge on every hot read path.
    expect(QUERY_TIMEOUT_SETTINGS).toEqual({
      max_execution_time: 30,
      do_not_merge_across_partitions_select_final: 1,
    });
  });
});

describe('parseMetadata', () => {
  it('returns {} for null', () => {
    expect(parseMetadata(null)).toEqual({});
  });

  it('returns {} for undefined', () => {
    expect(parseMetadata(undefined)).toEqual({});
  });

  it('returns {} for empty string', () => {
    expect(parseMetadata('')).toEqual({});
  });

  it('returns the raw object unchanged when raw is a plain object', () => {
    const input = { foo: 'bar', baz: 'qux' };
    // Critical: exact-equal proves the object isn't mutated/wrapped.
    // Kills `typeof raw === 'object' || raw !== null` and
    // `if (false)` mutants — both reroute non-objects/strings through
    // the object branch and would not preserve the original shape.
    expect(parseMetadata(input)).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('returns the same object reference (no cloning) for plain objects', () => {
    const input = { a: '1' };
    // Identity check pins the "return raw as Record" line: if a mutant
    // returns {} or any other value, the reference comparison fails.
    expect(parseMetadata(input)).toBe(input);
  });

  it('parses a JSON-encoded string into an object', () => {
    expect(parseMetadata('{"foo":"bar","n":"1"}')).toEqual({ foo: 'bar', n: '1' });
  });

  it('returns {} for malformed JSON string (no throw)', () => {
    expect(parseMetadata('{not-json')).toEqual({});
  });

  it('returns {} for non-string non-object primitives (number, boolean)', () => {
    // typeof 42 === 'number', typeof true === 'boolean' — neither
    // 'object' nor 'string'. Falls through to final `return {}`.
    expect(parseMetadata(42)).toEqual({});
    expect(parseMetadata(true)).toEqual({});
  });
});

describe('toNumber', () => {
  it('returns 0 for undefined', () => {
    expect(toNumber(undefined)).toBe(0);
  });

  it('returns 0 for null (treated as undefined)', () => {
    // Even though the signature is `string | number | undefined`, ClickHouse
    // can return null over the wire so the runtime guard matters.
    expect(toNumber(null as unknown as undefined)).toBe(0);
  });

  it('parses a numeric string into a number', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber('3.14')).toBe(3.14);
  });

  it('passes a number through unchanged', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-1.5)).toBe(-1.5);
  });

  it('returns 0 for non-numeric strings (NaN guard)', () => {
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('')).toBe(0);
  });

  it('returns 0 for explicit NaN', () => {
    expect(toNumber(NaN)).toBe(0);
  });
});

describe('parseMetadata + toNumber boundary', () => {
  // Composite test pins both functions when a metadata payload contains
  // numeric strings — historically a regression source where toNumber
  // was called on undefined fields from parseMetadata output.
  it('round-trips through metadata containing numeric strings', () => {
    const md = parseMetadata('{"latency":"123.5","attempt":"3"}');
    expect(toNumber(md.latency)).toBe(123.5);
    expect(toNumber(md.attempt)).toBe(3);
  });
});

describe('resolveDateRange', () => {
  // Mutation testing surfaced 8+ survivors in the
  //   if (range === 'custom' && startDate && endDate)
  // guard. Each branch needs explicit coverage to kill mutants like
  // `range !== 'custom'`, `... || endDate`, and `if (true)`.

  const today = new Date().toISOString().split('T')[0]!;

  it("returns the explicit custom range when range='custom' and both dates are given", () => {
    expect(resolveDateRange('custom', '2024-01-01', '2024-01-31')).toEqual({
      start: '2024-01-01',
      end: '2024-01-31',
    });
  });

  it("falls back to default (today) when range='custom' but startDate is missing", () => {
    const result = resolveDateRange('custom', undefined, '2024-01-31');
    // Must not return the custom range — falls through the switch to default
    // (which is { start: today, end: today }).
    expect(result).toEqual({ start: today, end: today });
  });

  it("falls back to default (today) when range='custom' but endDate is missing", () => {
    const result = resolveDateRange('custom', '2024-01-01', undefined);
    expect(result).toEqual({ start: today, end: today });
  });

  it("falls back to default (today) when range='custom' and both dates are missing", () => {
    expect(resolveDateRange('custom')).toEqual({ start: today, end: today });
  });

  it("ignores supplied custom dates when range is not 'custom' — range wins", () => {
    // Kills `range === 'custom' || ...` and `range !== 'custom' && ...`
    // mutants: a non-custom range MUST return its own dates regardless of
    // whether startDate/endDate are populated.
    expect(resolveDateRange('today', '2024-01-01', '2024-01-31')).toEqual({
      start: today,
      end: today,
    });
  });

  it("returns today range for 'today'", () => {
    expect(resolveDateRange('today')).toEqual({ start: today, end: today });
  });

  it("returns yesterday range for 'yesterday'", () => {
    const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]!;
    expect(resolveDateRange('yesterday')).toEqual({
      start: yesterdayStr,
      end: yesterdayStr,
    });
  });

  it("returns a 7-day range ending today for '7d'", () => {
    const result = resolveDateRange('7d');
    expect(result.end).toBe(today);
    const startMs = new Date(result.start).getTime();
    const endMs = new Date(result.end).getTime();
    // 7 days = 7 * 86400000 ms; allow ±1 day for UTC midnight rounding.
    expect(endMs - startMs).toBeGreaterThanOrEqual(6 * 24 * 60 * 60 * 1000);
    expect(endMs - startMs).toBeLessThanOrEqual(8 * 24 * 60 * 60 * 1000);
  });

  it("returns a 30-day range ending today for '30d'", () => {
    const result = resolveDateRange('30d');
    expect(result.end).toBe(today);
    const startMs = new Date(result.start).getTime();
    const endMs = new Date(result.end).getTime();
    expect(endMs - startMs).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
    expect(endMs - startMs).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
  });

  it("returns a 90-day range ending today for '90d'", () => {
    const result = resolveDateRange('90d');
    expect(result.end).toBe(today);
    const startMs = new Date(result.start).getTime();
    const endMs = new Date(result.end).getTime();
    expect(endMs - startMs).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);
    expect(endMs - startMs).toBeLessThanOrEqual(91 * 24 * 60 * 60 * 1000);
  });

  it('returns today range for unknown range values (default case)', () => {
    expect(resolveDateRange('garbage')).toEqual({ start: today, end: today });
    expect(resolveDateRange('')).toEqual({ start: today, end: today });
  });
});

describe('getTokenColumn', () => {
  it("maps 'inputTokens' to 'InputTokens'", () => {
    expect(getTokenColumn('inputTokens')).toBe('InputTokens');
  });

  it("maps 'outputTokens' to 'OutputTokens'", () => {
    expect(getTokenColumn('outputTokens')).toBe('OutputTokens');
  });

  it("maps 'totalTokens' to 'TotalTokens'", () => {
    expect(getTokenColumn('totalTokens')).toBe('TotalTokens');
  });
});

describe('transformMetricsSummary', () => {
  it('returns a zero-filled summary when raw is undefined', () => {
    // Pins the `if (!raw)` guard: a mutant `if (false)` would
    // try to read fields off undefined and throw.
    expect(transformMetricsSummary(undefined)).toEqual({
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgLatencyMs: 0,
      uniqueUsers: 0,
    });
  });

  it('converts every numeric string field via toNumber', () => {
    const raw = {
      total_requests: '10',
      success_count: '8',
      error_count: '2',
      total_cost: '1.25',
      total_tokens: '500',
      input_tokens: '300',
      output_tokens: '200',
      avg_latency_ms: '125.5',
      unique_users: '4',
    };
    expect(transformMetricsSummary(raw)).toEqual({
      totalRequests: 10,
      successCount: 8,
      errorCount: 2,
      totalCost: 1.25,
      totalTokens: 500,
      inputTokens: 300,
      outputTokens: 200,
      avgLatencyMs: 125.5,
      uniqueUsers: 4,
    });
  });
});

describe('transformTimeSeriesPoint', () => {
  it('maps every raw CH field to its camelCase MetricsTimeSeries shape', () => {
    expect(
      transformTimeSeriesPoint({
        date: '2024-01-15',
        hour: '13',
        request_count: '42',
        success_count: '40',
        error_count: '2',
        total_cost: '5.5',
        total_tokens: '1000',
        total_input_tokens: '600',
        total_output_tokens: '400',
        avg_latency_ms: '110',
        unique_users: '7',
      }),
    ).toEqual({
      date: '2024-01-15',
      hour: 13,
      requests: 42,
      successes: 40,
      errors: 2,
      cost: 5.5,
      tokens: 1000,
      inputTokens: 600,
      outputTokens: 400,
      avgLatencyMs: 110,
      uniqueUsers: 7,
    });
  });
});

describe('transformModelStats', () => {
  it('maps every raw CH field to its camelCase ModelStats shape', () => {
    expect(
      transformModelStats({
        model: 'gpt-4o',
        total_requests: '100',
        cost: '3.21',
        tokens: '50000',
        input_tokens: '30000',
        output_tokens: '20000',
        avg_latency_ms: '200',
        success_rate: '0.98',
      }),
    ).toEqual({
      model: 'gpt-4o',
      requests: 100,
      cost: 3.21,
      tokens: 50000,
      inputTokens: 30000,
      outputTokens: 20000,
      avgLatencyMs: 200,
      successRate: 0.98,
    });
  });
});

describe('transformPercentilePoint', () => {
  it('converts string percentile values and preserves timestamp', () => {
    expect(
      transformPercentilePoint({
        timestamp: '2024-01-15T00:00:00Z',
        p75: '100',
        p90: '200',
        p95: '300',
        p99: '500',
      }),
    ).toEqual({
      timestamp: '2024-01-15T00:00:00Z',
      p75: 100,
      p90: 200,
      p95: 300,
      p99: 500,
    });
  });
});

describe('createEmptyTimeSeriesPoint', () => {
  it("returns a zero row with the provided date and hour stringified", () => {
    expect(createEmptyTimeSeriesPoint('2024-06-01', 7)).toEqual({
      date: '2024-06-01',
      hour: '7',
      request_count: '0',
      success_count: '0',
      error_count: '0',
      total_cost: '0',
      total_tokens: '0',
      total_input_tokens: '0',
      total_output_tokens: '0',
      avg_latency_ms: '0',
      unique_users: '0',
    });
  });
});

describe('fillTimeSeriesGaps', () => {
  // Mutation survivors at line 776 (`if (hourly)`) and line 788
  // (`if (existing)`) need direct coverage with both branches forced.

  it('produces one row per day across the range when hourly=false', () => {
    const result = fillTimeSeriesGaps(
      [],
      { start: '2024-01-01', end: '2024-01-03' },
      false,
    );
    // Kills `if (true)` mutant on `if (hourly)`: would generate 24×N
    // hourly entries instead of N daily entries.
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.date)).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
    expect(result.every((r) => r.hour === '0')).toBe(true);
  });

  it('produces 24 rows per day across the range when hourly=true', () => {
    const result = fillTimeSeriesGaps(
      [],
      { start: '2024-01-01', end: '2024-01-02' },
      true,
    );
    // 2 days × 24 hours = 48 entries.
    expect(result).toHaveLength(48);
    // Each day has the full 0-23 hour range.
    const day1Hours = result
      .filter((r) => r.date === '2024-01-01')
      .map((r) => Number(r.hour));
    expect(day1Hours).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23,
    ]);
  });

  it('preserves existing daily rows verbatim (not overwritten with zeros)', () => {
    const existing = {
      date: '2024-01-02',
      hour: '0',
      request_count: '42',
      success_count: '40',
      error_count: '2',
      total_cost: '5.5',
      total_tokens: '1000',
      total_input_tokens: '600',
      total_output_tokens: '400',
      avg_latency_ms: '110',
      unique_users: '7',
    };
    const result = fillTimeSeriesGaps(
      [existing],
      { start: '2024-01-01', end: '2024-01-03' },
      false,
    );
    // Kills `if (false)` mutant on `if (existing)`: would push an empty
    // zero point for every day, including 01-02, dropping the real row.
    const mid = result.find((r) => r.date === '2024-01-02');
    expect(mid).toEqual(existing);
    // Boundary days should be zero-filled.
    expect(result.find((r) => r.date === '2024-01-01')?.request_count).toBe('0');
    expect(result.find((r) => r.date === '2024-01-03')?.request_count).toBe('0');
  });

  it('preserves existing hourly rows verbatim when hourly=true', () => {
    const existing = {
      date: '2024-01-01',
      hour: '5',
      request_count: '99',
      success_count: '90',
      error_count: '9',
      total_cost: '1.0',
      total_tokens: '100',
      total_input_tokens: '60',
      total_output_tokens: '40',
      avg_latency_ms: '50',
      unique_users: '1',
    };
    const result = fillTimeSeriesGaps(
      [existing],
      { start: '2024-01-01', end: '2024-01-01' },
      true,
    );
    expect(result).toHaveLength(24);
    expect(result.find((r) => r.hour === '5')).toEqual(existing);
    // Other hours are zero-filled.
    expect(result.find((r) => r.hour === '0')?.request_count).toBe('0');
  });
});

describe('getRetentionCutoff family', () => {
  it('returns epoch when retention is -1 (unlimited)', () => {
    expect(getRetentionCutoff(-1).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns a date N days before now for positive retention', () => {
    const before = Date.now();
    const result = getRetentionCutoff(7).getTime();
    const after = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(result).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
  });

  it('formatRetentionCutoff produces ClickHouse DateTime64 format (no T, no Z)', () => {
    expect(formatRetentionCutoff(-1)).toBe('1970-01-01 00:00:00.000');
    const result = formatRetentionCutoff(7);
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('formatRetentionCutoffDate returns just the YYYY-MM-DD prefix', () => {
    expect(formatRetentionCutoffDate(-1)).toBe('1970-01-01');
    const result = formatRetentionCutoffDate(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
