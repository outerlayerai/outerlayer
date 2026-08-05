/**
 * buildScoreComparisonQuery / buildScoreMatchedCountQuery / buildScoreScatterQuery unit tests.
 *
 * Regression coverage for the cross-source keying fix: scores written with
 * ResourceId = SpanId (annotations) must match scores written with
 * ResourceId = TraceId (CLI evals) when both describe the same trace. The
 * query builders normalize ResourceId to TraceId via LEFT JOIN against
 * otel_traces before joining.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScoreComparisonQuery,
  buildScoreMatchedCountQuery,
  buildScoreScatterQuery,
  type ScoreComparisonInput,
} from '../queries';

const INPUT: ScoreComparisonInput = {
  appId: 'app-test',
  tenantId: 'tenant-test',
  nameA: 'human_quality',
  nameB: 'auto_accuracy',
  startDate: '2026-04-01 00:00:00',
  endDate: '2026-04-17 23:59:59',
  retentionCutoff: '1970-01-01 00:00:00.000',
  retentionCutoffDate: '1970-01-01',
};

describe('buildScoreComparisonQuery', () => {
  it('normalizes ResourceId to TraceId via LEFT JOIN on otel_traces', () => {
    const { query, params } = buildScoreComparisonQuery(INPUT);

    // Must LEFT JOIN otel_traces to resolve SpanId -> TraceId
    expect(query).toContain('LEFT JOIN');
    expect(query).toContain('FROM otel_traces');
    expect(query).toContain('t.SpanId = s.ResourceId');

    // Must normalize so rows where ResourceId is already a TraceId fall
    // through when LEFT JOIN misses. ClickHouse LEFT JOIN returns '' (not
    // NULL) for unmatched columns, so coalesce() would keep the empty string
    // instead of falling back. Use if().
    expect(query).toContain("if(t.TraceId = '', s.ResourceId, t.TraceId)");
    expect(query).toContain('trace_key');

    // JOIN condition uses the normalized key, not raw ResourceId
    expect(query).toMatch(/ON a\.trace_key = b\.trace_key/);
    expect(query).not.toMatch(/ON a\.ResourceId = b\.ResourceId/);

    // otel_traces lookup must be tenant- and retention-scoped
    expect(query).toContain('AppId = {appId:String}');
    expect(query).toContain('TenantId = {tenantId:String}');
    expect(query).toContain('toDate(Timestamp) >= {retentionCutoffDate:Date}');

    // New retentionCutoffDate param derived from retentionCutoff
    expect(params.retentionCutoffDate).toBe('1970-01-01');
  });

  it('still includes the sourceClause when source is provided', () => {
    const { query, params } = buildScoreComparisonQuery({ ...INPUT, source: 'eval' });
    expect(query).toContain('AND Source = {source:String}');
    expect(params.source).toBe('eval');
  });

  it('omits sourceClause when source is not provided', () => {
    const { query, params } = buildScoreComparisonQuery(INPUT);
    expect(query).not.toContain('AND Source = {source:String}');
    expect(params.source).toBeUndefined();
  });
});

describe('buildScoreMatchedCountQuery', () => {
  it('normalizes ResourceId for totalMatched, totalA, and totalB', () => {
    const { query, params } = buildScoreMatchedCountQuery(INPUT);

    // Every CTE should use the same trace_key normalization
    expect(query).toContain("if(t.TraceId = '', s.ResourceId, t.TraceId)");
    expect(query).toContain('trace_key');

    // totalMatched uses normalized join
    expect(query).toContain('countDistinct(a.trace_key) AS totalMatched');
    expect(query).toMatch(/ON a\.trace_key = b\.trace_key/);

    // totalA and totalB count normalized keys so they remain consistent with
    // totalMatched (never totalMatched > totalA / totalB).
    expect(query).toContain('AS totalA');
    expect(query).toContain('AS totalB');
    expect(query).toMatch(/countDistinct\(trace_key\)/);

    expect(params.retentionCutoffDate).toBe('1970-01-01');
  });
});

describe('buildScoreScatterQuery', () => {
  it('normalizes ResourceId to TraceId for numeric scatter join', () => {
    const { query, params } = buildScoreScatterQuery(INPUT);

    expect(query).toContain('LEFT JOIN');
    expect(query).toContain('FROM otel_traces');
    expect(query).toContain("if(t.TraceId = '', s.ResourceId, t.TraceId)");
    expect(query).toContain('trace_key');
    expect(query).toMatch(/ON a\.trace_key = b\.trace_key/);
    expect(query).not.toMatch(/ON a\.ResourceId = b\.ResourceId/);

    expect(params.retentionCutoffDate).toBe('1970-01-01');
  });
});
