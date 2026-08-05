/**
 * buildFilterWhereClause unit tests.
 *
 * Direct tests for the SQL clause builder that converts AnalyticsFilter[]
 * into parameterized ClickHouse WHERE clauses.
 */

import { buildFilterWhereClause, buildSplitFilterWhereClause, buildScoresFilterWhereClause } from '../service';

describe('buildFilterWhereClause', () => {
  // ── Empty / no-op cases ───────────────────────────────────────────

  it('should return empty clause when no filters and no search', () => {
    const result = buildFilterWhereClause();
    expect(result.clause).toBe('');
    expect(result.params).toEqual({});
  });

  it('should return empty clause for undefined filters', () => {
    const result = buildFilterWhereClause(undefined);
    expect(result.clause).toBe('');
  });

  it('should return empty clause for empty filters array', () => {
    const result = buildFilterWhereClause([]);
    expect(result.clause).toBe('');
  });

  // ── String field operators ────────────────────────────────────────

  it('should handle equals operator for string fields', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
    ]);
    expect(result.clause).toContain('Model = {filter_0:String}');
    expect(result.params.filter_0).toBe('gpt-4');
  });

  it('should handle = shorthand operator', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: '=', value: 'gpt-4' },
    ]);
    expect(result.clause).toContain('Model = {filter_0:String}');
  });

  it('should handle notEquals operator', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'notEquals', value: 'gpt-3' },
    ]);
    expect(result.clause).toContain('Model != {filter_0:String}');
  });

  it('should handle not_equals operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'not_equals', value: 'gpt-3' },
    ]);
    expect(result.clause).toContain('Model != {filter_0:String}');
  });

  it('should handle != operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: '!=', value: 'gpt-3' },
    ]);
    expect(result.clause).toContain('Model != {filter_0:String}');
  });

  it('should handle contains operator with ILIKE', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'contains', value: 'gpt' },
    ]);
    expect(result.clause).toContain('Model ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%gpt%');
  });

  it('should handle like operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'like', value: 'gpt' },
    ]);
    expect(result.clause).toContain('Model ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%gpt%');
  });

  it('should handle startsWith operator', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'startsWith', value: 'gpt' },
    ]);
    expect(result.clause).toContain('Model ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('gpt%');
  });

  it('should handle starts_with operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'starts_with', value: 'gpt' },
    ]);
    expect(result.params.filter_0).toBe('gpt%');
  });

  it('should handle endsWith operator', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'endsWith', value: 'turbo' },
    ]);
    expect(result.clause).toContain('Model ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%turbo');
  });

  it('should handle notContains operator', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'notContains', value: 'legacy' },
    ]);
    expect(result.clause).toContain('Model NOT ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%legacy%');
  });

  it('should handle not_contains operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'not_contains', value: 'legacy' },
    ]);
    expect(result.clause).toContain('Model NOT ILIKE {filter_0:String}');
  });

  it('should default unknown operator to equals for string fields', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'UNKNOWN', value: 'gpt-4' },
    ]);
    expect(result.clause).toContain('Model = {filter_0:String}');
  });

  // ── Numeric field operators ───────────────────────────────────────

  it('should handle gt operator for numeric fields', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: 'gt', value: '100' },
    ]);
    expect(result.clause).toContain('Duration > {filter_0:Float64}');
    expect(result.params.filter_0).toBe(100);
  });

  it('should handle > operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: '>', value: '100' },
    ]);
    expect(result.clause).toContain('Duration > {filter_0:Float64}');
  });

  it('should handle gte operator', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: 'gte', value: '500' },
    ]);
    expect(result.clause).toContain('Duration >= {filter_0:Float64}');
  });

  it('should handle lt operator', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: 'lt', value: '200' },
    ]);
    expect(result.clause).toContain('Duration < {filter_0:Float64}');
  });

  it('should handle lte operator', () => {
    const result = buildFilterWhereClause([
      { field: 'cost', operator: 'lte', value: '0.5' },
    ]);
    expect(result.clause).toContain('Cost <= {filter_0:Float64}');
  });

  it('should handle equals for numeric fields', () => {
    const result = buildFilterWhereClause([
      { field: 'cost', operator: 'equals', value: '0.01' },
    ]);
    expect(result.clause).toContain('Cost = {filter_0:Float64}');
    expect(result.params.filter_0).toBe(0.01);
  });

  it('should handle notEquals for numeric fields', () => {
    const result = buildFilterWhereClause([
      { field: 'cost', operator: 'notEquals', value: '0' },
    ]);
    expect(result.clause).toContain('Cost != {filter_0:Float64}');
  });

  it('should default to 0 for non-numeric string values in numeric fields', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: 'gt', value: 'not-a-number' },
    ]);
    expect(result.params.filter_0).toBe(0);
  });

  it('should default unknown operator to equals for numeric fields', () => {
    const result = buildFilterWhereClause([
      { field: 'latency_ms', operator: 'UNKNOWN', value: '100' },
    ]);
    expect(result.clause).toContain('Duration = {filter_0:Float64}');
  });

  // ── Status field special handling ─────────────────────────────────

  it('should map ERROR status to StatusCode IN error set', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'ERROR' },
    ]);
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    // Status uses hardcoded values, no param
    expect(Object.keys(result.params)).toHaveLength(0);
  });

  it('should map FAIL status to StatusCode IN error set', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'FAIL' },
    ]);
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
  });

  it('should map OK status to a TraceId NOT IN (error trace IDs) subquery', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'OK' },
    ]);
    // OK = "no error spans" — proper inverse of the ERROR filter so the
    // displayed any-error status aggregate and the filter agree.
    expect(result.clause).toContain('TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
  });

  it('should map SUCCESS status to a TraceId NOT IN (error trace IDs) subquery', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'SUCCESS' },
    ]);
    expect(result.clause).toContain('TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
  });

  it('should be case-insensitive for status values', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'error' },
    ]);
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
  });

  it('should skip status filter for unrecognized status values', () => {
    const result = buildFilterWhereClause([
      { field: 'status', operator: 'equals', value: 'UNKNOWN_STATUS' },
    ]);
    expect(result.clause).toBe('');
  });

  // ── Field name mapping ────────────────────────────────────────────

  it('should map user_id to UserId column', () => {
    const result = buildFilterWhereClause([
      { field: 'user_id', operator: 'equals', value: 'user-123' },
    ]);
    expect(result.clause).toContain('UserId = {filter_0:String}');
  });

  it('should map user to UserId column', () => {
    const result = buildFilterWhereClause([
      { field: 'user', operator: 'equals', value: 'user-123' },
    ]);
    expect(result.clause).toContain('UserId = {filter_0:String}');
  });

  it('should map model_used to Model column', () => {
    const result = buildFilterWhereClause([
      { field: 'model_used', operator: 'equals', value: 'claude-3' },
    ]);
    expect(result.clause).toContain('Model = {filter_0:String}');
  });

  it('should map prompt_tokens to InputTokens column', () => {
    const result = buildFilterWhereClause([
      { field: 'prompt_tokens', operator: 'gt', value: '100' },
    ]);
    expect(result.clause).toContain('InputTokens > {filter_0:Float64}');
  });

  it('should map completion_tokens to OutputTokens column', () => {
    const result = buildFilterWhereClause([
      { field: 'completion_tokens', operator: 'lt', value: '500' },
    ]);
    expect(result.clause).toContain('OutputTokens < {filter_0:Float64}');
  });

  // ── Unknown fields ────────────────────────────────────────────────

  it('should skip unknown field names silently', () => {
    const result = buildFilterWhereClause([
      { field: 'nonexistent_field', operator: 'equals', value: 'test' },
    ]);
    expect(result.clause).toBe('');
    expect(result.params).toEqual({});
  });

  // ── Multiple filters ──────────────────────────────────────────────

  it('should combine multiple filters with AND', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
      { field: 'latency_ms', operator: 'gt', value: '100' },
    ]);
    expect(result.clause).toContain('AND');
    expect(result.clause).toContain('Model = {filter_0:String}');
    expect(result.clause).toContain('Duration > {filter_1:Float64}');
    expect(result.params.filter_0).toBe('gpt-4');
    expect(result.params.filter_1).toBe(100);
  });

  // ── metadata.* fields ─────────────────────────────────────────────

  it('should handle metadata equals operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.environment', operator: 'equals', value: 'production' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] = {filter_0:String}');
    expect(result.params.filter_key_1).toBe('environment');
    expect(result.params.filter_0).toBe('production');
  });

  it('should handle metadata contains operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'contains', value: 'test' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] LIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%test%');
  });

  it('should handle metadata exists operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'exists', value: '' },
    ]);
    expect(result.clause).toContain("Metadata[{filter_key_1:String}] != ''");
  });

  it('should handle metadata doesNotExist operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'doesNotExist', value: '' },
    ]);
    expect(result.clause).toContain("Metadata[{filter_key_1:String}] = ''");
  });

  it('should skip metadata with invalid key names', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.invalid-key-with-dashes', operator: 'equals', value: 'test' },
    ]);
    // Invalid metadata key pattern should be skipped
    expect(result.clause).toBe('');
  });

  it('should handle metadata notEquals operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.environment', operator: 'notEquals', value: 'staging' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] != {filter_0:String}');
    expect(result.params.filter_key_1).toBe('environment');
    expect(result.params.filter_0).toBe('staging');
  });

  it('should handle metadata startsWith operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'startsWith', value: 'prod' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] LIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('prod%');
  });

  it('should handle metadata endsWith operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'endsWith', value: '-v2' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] LIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%-v2');
  });

  it('should handle metadata notContains operator', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.tag', operator: 'notContains', value: 'test' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] NOT LIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%test%');
  });

  it('should default unknown metadata operator to equals', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.env', operator: 'UNKNOWN', value: 'prod' },
    ]);
    expect(result.clause).toContain('Metadata[{filter_key_1:String}] = {filter_0:String}');
    expect(result.params.filter_0).toBe('prod');
  });

  it('should skip metadata with too-long key names (>64 chars)', () => {
    const longKey = 'a'.repeat(65);
    const result = buildFilterWhereClause([
      { field: `metadata.${longKey}`, operator: 'equals', value: 'test' },
    ]);
    expect(result.clause).toBe('');
  });

  // ── score__* fields (IN subquery against scores table) ──────────────

  it('should generate IN subquery for score filter with AppId scoping', () => {
    const result = buildFilterWhereClause(
      [{ field: 'score__correctness', operator: 'gte', value: '0.8' }],
      'app-123',
    );
    expect(result.clause).toContain('SpanId IN');
    expect(result.clause).toContain('AppId = {score_appId:String}');
    expect(result.clause).toContain('Name = {score_name_0:String}');
    expect(result.clause).toContain('Score >= {score_value_0:Float64}');
    expect(result.params.score_appId).toBe('app-123');
    expect(result.params.score_name_0).toBe('correctness');
    expect(result.params.score_value_0).toBe(0.8);
  });

  it('should match both SpanId- and TraceId-keyed scores in score filter', () => {
    // Regression test for Bug S3 sibling (score-based trace filter).
    // CLI eval scores write ResourceId=TraceId; annotations write ResourceId=SpanId.
    // Filter must surface traces that match either keying convention.
    const result = buildFilterWhereClause(
      [{ field: 'score__correctness', operator: 'gte', value: '0.8' }],
      'app-123',
    );
    expect(result.clause).toContain('SpanId IN');
    expect(result.clause).toContain('TraceId IN');
    // Both branches must be wrapped in an OR, joined via parentheses.
    expect(result.clause).toMatch(/\(SpanId IN \([^)]+\) OR TraceId IN \([^)]+\)\)/);
  });

  it('should handle multiple score filters as separate IN subqueries', () => {
    const result = buildFilterWhereClause(
      [
        { field: 'score__correctness', operator: 'gte', value: '0.8' },
        { field: 'score__hallucination', operator: 'lte', value: '0.2' },
      ],
      'app-123',
    );
    expect(result.params.score_appId).toBe('app-123');
    expect(result.params.score_name_0).toBe('correctness');
    expect(result.params.score_value_0).toBe(0.8);
    expect(result.params.score_name_1).toBe('hallucination');
    expect(result.params.score_value_1).toBe(0.2);
  });

  it('should combine score filters with regular filters', () => {
    const result = buildFilterWhereClause(
      [
        { field: 'model', operator: 'equals', value: 'gpt-4' },
        { field: 'score__correctness', operator: 'gte', value: '0.8' },
        { field: 'latency_ms', operator: 'lt', value: '500' },
      ],
      'app-123',
    );
    expect(result.clause).toContain('Model =');
    expect(result.clause).toContain('SpanId IN');
    expect(result.clause).toContain('TraceId IN');
    expect(result.clause).toContain('Duration <');
  });

  it('should support all numeric operators for score filters', () => {
    const operatorMap: [string, string][] = [
      ['equals', '='],
      ['notEquals', '!='],
      ['lt', '<'],
      ['lte', '<='],
      ['gt', '>'],
      ['gte', '>='],
    ];
    for (const [operator, sqlOp] of operatorMap) {
      const result = buildFilterWhereClause(
        [{ field: 'score__quality', operator, value: '0.5' }],
        'app-123',
      );
      expect(result.clause).toContain(`Score ${sqlOp} {score_value_0:Float64}`);
    }
  });

  it('should skip score filter with empty name (score__)', () => {
    const result = buildFilterWhereClause(
      [{ field: 'score__', operator: 'gte', value: '0.8' }],
      'app-123',
    );
    expect(result.clause).toBe('');
  });

  it('should skip score filter with invalid name characters', () => {
    const result = buildFilterWhereClause(
      [{ field: 'score__na;me', operator: 'gte', value: '0.8' }],
      'app-123',
    );
    expect(result.clause).toBe('');
  });

  it('should skip score filter with non-numeric value', () => {
    const result = buildFilterWhereClause(
      [{ field: 'score__correctness', operator: 'gte', value: 'not-a-number' }],
      'app-123',
    );
    expect(result.clause).toBe('');
  });

  it('should skip score filters when appId is not provided', () => {
    const result = buildFilterWhereClause([
      { field: 'score__correctness', operator: 'gte', value: '0.8' },
    ]);
    expect(result.clause).toBe('');
  });

  // ── Input/Output field mapping ──────────────────────────────────────

  it('should map input field to Input column with ILIKE', () => {
    const result = buildFilterWhereClause([
      { field: 'input', operator: 'contains', value: 'hello world' },
    ]);
    expect(result.clause).toContain('Input ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%hello world%');
  });

  it('should map output field to Output column with ILIKE', () => {
    const result = buildFilterWhereClause([
      { field: 'output', operator: 'contains', value: 'response text' },
    ]);
    expect(result.clause).toContain('Output ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%response text%');
  });

  it('should map props field to Props column', () => {
    const result = buildFilterWhereClause([
      { field: 'props', operator: 'contains', value: 'template' },
    ]);
    expect(result.clause).toContain('Props ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%template%');
  });

  it('should map trace_id field to TraceId column', () => {
    const result = buildFilterWhereClause([
      { field: 'trace_id', operator: 'equals', value: 'abc-123' },
    ]);
    expect(result.clause).toContain('TraceId = {filter_0:String}');
    expect(result.params.filter_0).toBe('abc-123');
  });

  it('should map semantic_kind field to SpanKind column', () => {
    const result = buildFilterWhereClause([
      { field: 'semantic_kind', operator: 'equals', value: 'llm' },
    ]);
    expect(result.clause).toContain('SpanKind = {filter_0:String}');
    expect(result.params.filter_0).toBe('llm');
  });

  // ── Maximum filters combined ────────────────────────────────────────

  it('should handle 10 filters combined', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'equals', value: 'gpt-4' },
      { field: 'status', operator: 'equals', value: 'OK' },
      { field: 'latency_ms', operator: 'gt', value: '100' },
      { field: 'cost', operator: 'lt', value: '1.0' },
      { field: 'input', operator: 'contains', value: 'hello' },
      { field: 'output', operator: 'contains', value: 'world' },
      { field: 'user_id', operator: 'equals', value: 'user-1' },
      { field: 'prompt_tokens', operator: 'gte', value: '10' },
      { field: 'completion_tokens', operator: 'lte', value: '500' },
      { field: 'semantic_kind', operator: 'equals', value: 'llm' },
    ]);
    // Should produce AND-separated clauses for all 10 filters
    // Status doesn't use params, so expect 9 params
    expect(result.clause).toContain('AND');
    expect(result.clause).toContain('Model =');
    expect(result.clause).toContain('Input ILIKE');
    expect(result.clause).toContain('Output ILIKE');
    expect(result.clause).toContain('Duration >');
    expect(result.clause).toContain('Cost <');
  });

  // ── Mixed filter types ──────────────────────────────────────────────

  it('should handle mixed string, numeric, metadata, and status filters', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'contains', value: 'gpt' },
      { field: 'latency_ms', operator: 'gt', value: '500' },
      { field: 'status', operator: 'equals', value: 'ERROR' },
      { field: 'metadata.environment', operator: 'equals', value: 'production' },
    ]);
    expect(result.clause).toContain('Model ILIKE');
    expect(result.clause).toContain('Duration >');
    expect(result.clause).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    expect(result.clause).toContain('Metadata[');
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it('should handle value near 500-character limit', () => {
    const longValue = 'x'.repeat(499);
    const result = buildFilterWhereClause([
      { field: 'input', operator: 'contains', value: longValue },
    ]);
    expect(result.clause).toContain('Input ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe(`%${longValue}%`);
  });

  // ── session_id field ──────────────────────────────────────────────

  it('should handle session_id filter with equals operator', () => {
    const result = buildFilterWhereClause([
      { field: 'session_id', operator: 'equals', value: 'sess-abc-123' },
    ]);
    expect(result.clause).toContain('SessionId = {filter_0:String}');
    expect(result.params.filter_0).toBe('sess-abc-123');
  });

  it('should handle session_id filter with contains operator', () => {
    const result = buildFilterWhereClause([
      { field: 'session_id', operator: 'contains', value: 'abc' },
    ]);
    expect(result.clause).toContain('SessionId ILIKE {filter_0:String}');
    expect(result.params.filter_0).toBe('%abc%');
  });

  // ── tags field (Array lookups) ────────────────────────────────────

  it('should handle tags filter with equals operator using has()', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'equals', value: 'production' },
    ]);
    expect(result.clause).toContain('has(Tags, {filter_0:String})');
    expect(result.params.filter_0).toBe('production');
  });

  it('should handle tags filter with notEquals operator using NOT has()', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'notEquals', value: 'deprecated' },
    ]);
    expect(result.clause).toContain('NOT has(Tags, {filter_0:String})');
    expect(result.params.filter_0).toBe('deprecated');
  });

  it('should handle tags filter with contains operator using arrayExists', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'contains', value: 'prod' },
    ]);
    expect(result.clause).toContain('arrayExists(x -> x ILIKE {filter_0:String}, Tags)');
    expect(result.params.filter_0).toBe('%prod%');
  });

  it('should default unknown tags operator to has()', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'UNKNOWN', value: 'some-tag' },
    ]);
    expect(result.clause).toContain('has(Tags, {filter_0:String})');
    expect(result.params.filter_0).toBe('some-tag');
  });

  it('should handle tags filter with != operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: '!=', value: 'beta' },
    ]);
    expect(result.clause).toContain('NOT has(Tags, {filter_0:String})');
    expect(result.params.filter_0).toBe('beta');
  });

  it('should handle tags filter with like operator alias', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'like', value: 'env' },
    ]);
    expect(result.clause).toContain('arrayExists(x -> x ILIKE {filter_0:String}, Tags)');
    expect(result.params.filter_0).toBe('%env%');
  });

});

describe('buildFilterWhereClause — OR groups', () => {
  it('compiles a two-member group into one parenthesized disjunction', () => {
    const result = buildFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'model', operator: 'equals', value: 'claude-sonnet-4-6' },
        ],
      },
    ]);
    expect(result.clause).toBe('AND (Model = {filter_0:String} OR Model = {filter_1:String})');
    expect(result.params).toEqual({ filter_0: 'gpt-4o', filter_1: 'claude-sonnet-4-6' });
  });

  it('ANDs a group with sibling leaf predicates, numbering params across both', () => {
    const result = buildFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'cost', operator: 'gt', value: '0.01' },
        ],
      },
      { field: 'user_id', operator: 'equals', value: 'u-1' },
    ]);
    expect(result.clause).toBe(
      'AND (Model = {filter_0:String} OR Cost > {filter_1:Float64}) AND UserId = {filter_2:String}',
    );
    expect(result.params).toEqual({ filter_0: 'gpt-4o', filter_1: 0.01, filter_2: 'u-1' });
  });

  it('unwraps a one-member group to a plain predicate (no parens)', () => {
    const result = buildFilterWhereClause([
      { or: [{ field: 'model', operator: 'equals', value: 'gpt-4o' }] },
    ]);
    expect(result.clause).toBe('AND Model = {filter_0:String}');
  });

  it('drops an empty group entirely', () => {
    const result = buildFilterWhereClause([{ or: [] }]);
    expect(result.clause).toBe('');
    expect(result.params).toEqual({});
  });

  it('drops an invalid member but keeps the rest of the group', () => {
    const result = buildFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'not_a_real_field', operator: 'equals', value: 'x' },
          { field: 'user_id', operator: 'equals', value: 'u-1' },
        ],
      },
    ]);
    expect(result.clause).toBe('AND (Model = {filter_0:String} OR UserId = {filter_1:String})');
  });

  it('keeps disjunction values parameterized (no literal interpolation)', () => {
    const hostile = `gpt'; DROP TABLE otel_traces; --`;
    const result = buildFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'equals', value: hostile },
          { field: 'status', operator: 'equals', value: 'ERROR' },
        ],
      },
    ]);
    expect(result.clause).not.toContain(hostile);
    expect(result.clause).not.toContain('DROP');
    expect(result.params.filter_0).toBe(hostile);
  });

  it('composes dynamic predicates (metadata + score) inside a group', () => {
    const result = buildFilterWhereClause(
      [
        {
          or: [
            { field: 'metadata.env', operator: 'equals', value: 'prod' },
            { field: 'score__correctness', operator: 'gte', value: '0.8' },
          ],
        },
      ],
      'app-1',
      'tenant-1',
    );
    expect(result.clause).toMatch(
      /^AND \(Metadata\[\{filter_key_1:String\}\] = \{filter_0:String\} OR \(SpanId IN \(.+\) OR TraceId IN \(.+\)\)\)$/,
    );
    expect(result.params.filter_key_1).toBe('env');
    expect(result.params.filter_0).toBe('prod');
    expect(result.params.score_name_0).toBe('correctness');
    expect(result.params.score_value_0).toBe(0.8);
  });
});

describe('buildSplitFilterWhereClause — OR group grain routing', () => {
  it('routes an all-trace-grain group to the outer clause', () => {
    const result = buildSplitFilterWhereClause([
      {
        or: [
          { field: 'user_id', operator: 'equals', value: 'u-1' },
          { field: 'session_id', operator: 'equals', value: 's-1' },
        ],
      },
    ]);
    expect(result.outerClause).toBe(
      'AND (UserId = {filter_0:String} OR SessionId = {filter_1:String})',
    );
    expect(result.innerClause).toBe('');
  });

  it('routes a mixed-grain group to the inner (span) clause', () => {
    // Trace-grain fields are constant across every span of a trace, so a
    // span-grain evaluation of the disjunction selects exactly the traces
    // satisfying "user matches OR some span's model matches".
    const result = buildSplitFilterWhereClause([
      {
        or: [
          { field: 'user_id', operator: 'equals', value: 'u-1' },
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
        ],
      },
    ]);
    expect(result.innerClause).toBe(
      'AND (UserId = {filter_0:String} OR Model = {filter_1:String})',
    );
    expect(result.outerClause).toBe('');
  });

  it('routes an all-span-grain group to the inner clause', () => {
    const result = buildSplitFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'equals', value: 'gpt-4o' },
          { field: 'latency_ms', operator: 'gt', value: '5000' },
        ],
      },
    ]);
    expect(result.innerClause).toBe(
      'AND (Model = {filter_0:String} OR Duration > {filter_1:Float64})',
    );
    expect(result.outerClause).toBe('');
  });

  it('embeds the status=OK trace-level subquery inside a mixed group on the inner side', () => {
    const result = buildSplitFilterWhereClause(
      [
        {
          or: [
            { field: 'status', operator: 'equals', value: 'OK' },
            { field: 'model', operator: 'equals', value: 'gpt-4o' },
          ],
        },
      ],
      'app-1',
      'tenant-1',
    );
    expect(result.innerClause).toContain('(TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces');
    expect(result.innerClause).toContain('OR Model = {filter_0:String})');
    expect(result.outerClause).toBe('');
    expect(result.params.status_appId).toBe('app-1');
    expect(result.params.status_tenantId).toBe('tenant-1');
  });

  it('keeps a leaf-only filter list split exactly as before (regression)', () => {
    const result = buildSplitFilterWhereClause([
      { field: 'model', operator: 'equals', value: 'gpt-4o' },
      { field: 'user_id', operator: 'equals', value: 'u-1' },
    ]);
    expect(result.innerClause).toBe('AND Model = {filter_0:String}');
    expect(result.outerClause).toBe('AND UserId = {filter_1:String}');
    expect(result.params).toEqual({ filter_0: 'gpt-4o', filter_1: 'u-1' });
  });
});

describe('buildFilterWhereClause — membership and range operators (JSON-only)', () => {
  it('compiles in on a string column to a parameterized Array(String) IN', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'in', value: ['gpt-4o', 'o3'] },
    ]);
    expect(result.clause).toBe('AND Model IN {filter_0:Array(String)}');
    expect(result.params).toEqual({ filter_0: ['gpt-4o', 'o3'] });
  });

  it('compiles notIn on a numeric column to Array(Float64) NOT IN', () => {
    const result = buildFilterWhereClause([
      { field: 'prompt_tokens', operator: 'notIn', value: ['100', '200'] },
    ]);
    expect(result.clause).toBe('AND InputTokens NOT IN {filter_0:Array(Float64)}');
    expect(result.params).toEqual({ filter_0: [100, 200] });
  });

  it('compiles between on a numeric column to an inclusive BETWEEN with two params', () => {
    const result = buildFilterWhereClause([
      { field: 'cost', operator: 'between', value: ['0.01', '0.5'] },
    ]);
    expect(result.clause).toBe('AND Cost BETWEEN {filter_0:Float64} AND {filter_1:Float64}');
    expect(result.params).toEqual({ filter_0: 0.01, filter_1: 0.5 });
  });

  it('drops between on a string column (range needs an ordered type)', () => {
    const result = buildFilterWhereClause([
      { field: 'model', operator: 'between', value: ['a', 'z'] },
    ]);
    expect(result.clause).toBe('');
    expect(result.params).toEqual({});
  });

  it('drops in with an empty or non-array value', () => {
    expect(buildFilterWhereClause([{ field: 'model', operator: 'in', value: [] }]).clause).toBe('');
    expect(buildFilterWhereClause([{ field: 'model', operator: 'in', value: 'gpt-4o' }]).clause).toBe('');
  });

  it('drops a numeric in containing a non-numeric value (whole leaf, not just the value)', () => {
    const result = buildFilterWhereClause([
      { field: 'cost', operator: 'in', value: ['1', 'abc'] },
    ]);
    expect(result.clause).toBe('');
  });

  it('compiles tags in to hasAny (trace carries ANY listed tag)', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'in', value: ['prod', 'beta'] },
    ]);
    expect(result.clause).toBe('AND hasAny(Tags, {filter_0:Array(String)})');
    expect(result.params).toEqual({ filter_0: ['prod', 'beta'] });
  });

  it('compiles tags notIn to NOT hasAny', () => {
    const result = buildFilterWhereClause([
      { field: 'tags', operator: 'notIn', value: ['deprecated'] },
    ]);
    expect(result.clause).toBe('AND NOT hasAny(Tags, {filter_0:Array(String)})');
    expect(result.params).toEqual({ filter_0: ['deprecated'] });
  });

  it('compiles metadata in via the Map access (key param first)', () => {
    const result = buildFilterWhereClause([
      { field: 'metadata.env', operator: 'in', value: ['prod', 'staging'] },
    ]);
    expect(result.clause).toBe('AND Metadata[{filter_key_0:String}] IN {filter_1:Array(String)}');
    expect(result.params).toEqual({ filter_key_0: 'env', filter_1: ['prod', 'staging'] });
  });

  it('compiles score__ between inside the scores subquery', () => {
    const result = buildFilterWhereClause(
      [{ field: 'score__correctness', operator: 'between', value: ['0.5', '0.9'] }],
      'app-1',
      'tenant-1',
    );
    expect(result.clause).toContain(
      'Score BETWEEN {score_value_min_0:Float64} AND {score_value_max_0:Float64}',
    );
    expect(result.params.score_value_min_0).toBe(0.5);
    expect(result.params.score_value_max_0).toBe(0.9);
    expect(result.params.score_name_0).toBe('correctness');
  });

  it('composes in inside an OR group', () => {
    const result = buildFilterWhereClause([
      {
        or: [
          { field: 'model', operator: 'in', value: ['gpt-4o', 'o3'] },
          { field: 'status', operator: 'equals', value: 'ERROR' },
        ],
      },
    ]);
    expect(result.clause).toBe(
      "AND (Model IN {filter_0:Array(String)} OR StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error'))",
    );
    expect(result.params).toEqual({ filter_0: ['gpt-4o', 'o3'] });
  });
});

describe('buildScoresFilterWhereClause', () => {
  it('compiles leaves against scores columns with sfilter_ params', () => {
    const result = buildScoresFilterWhereClause([
      { field: 'name', operator: 'equals', value: 'correctness' },
      { field: 'score', operator: 'gte', value: '0.8' },
    ]);
    expect(result.clause).toBe(
      ' AND Name = {sfilter_0:String} AND Score >= {sfilter_1:Float64}',
    );
    expect(result.params).toEqual({ sfilter_0: 'correctness', sfilter_1: 0.8 });
  });

  it('compiles created_at range with DateTime64 params', () => {
    const result = buildScoresFilterWhereClause([
      { field: 'created_at', operator: 'between', value: ['2026-06-01 00:00:00.000', '2026-06-10 00:00:00.000'] },
    ]);
    expect(result.clause).toBe(
      ' AND CreatedAt BETWEEN {sfilter_0:DateTime64} AND {sfilter_1:DateTime64}',
    );
    expect(result.params).toEqual({
      sfilter_0: '2026-06-01 00:00:00.000',
      sfilter_1: '2026-06-10 00:00:00.000',
    });
  });

  it('compiles source in and OR groups', () => {
    const result = buildScoresFilterWhereClause([
      {
        or: [
          { field: 'source', operator: 'in', value: ['eval', 'annotation'] },
          { field: 'user_id', operator: 'equals', value: 'u-1' },
        ],
      },
    ]);
    expect(result.clause).toBe(
      ' AND (Source IN {sfilter_0:Array(String)} OR UserId = {sfilter_1:String})',
    );
  });

  it('drops unknown fields and trace-side fields (no cross-surface leakage)', () => {
    const result = buildScoresFilterWhereClause([
      { field: 'model', operator: 'equals', value: 'gpt-4o' },
      { field: 'metadata.env', operator: 'equals', value: 'prod' },
    ]);
    expect(result.clause).toBe('');
    expect(result.params).toEqual({});
  });

  it('drops invalid numeric leaves instead of coercing to 0 (unlike trace columns)', () => {
    const result = buildScoresFilterWhereClause([
      { field: 'score', operator: 'gte', value: 'abc' },
    ]);
    expect(result.clause).toBe('');
  });

  it('returns empty for undefined or empty filters', () => {
    expect(buildScoresFilterWhereClause()).toEqual({ clause: '', params: {} });
    expect(buildScoresFilterWhereClause([])).toEqual({ clause: '', params: {} });
  });

  it('keeps values parameterized (no literal interpolation)', () => {
    const hostile = `eval'; DROP TABLE scores; --`;
    const result = buildScoresFilterWhereClause([
      { field: 'source', operator: 'equals', value: hostile },
    ]);
    expect(result.clause).not.toContain('DROP');
    expect(result.params.sfilter_0).toBe(hostile);
  });
});

// Field names arrive as plain strings from the request. The `return null`
// drops in the compilers are only real allowlist checks when the lookup
// cannot answer a key the table does not own.
describe('inherited Object members are not filter fields', () => {
  const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

  it.each(INHERITED)('drops the trace/span leaf %s instead of compiling it', inherited => {
    const leaf = [{ field: inherited, operator: 'equals', value: 'x' }] as never;
    expect(buildFilterWhereClause(leaf)).toEqual({ clause: '', params: {} });
    // The split builder shares the same compiler, so it must drop it too.
    expect(buildSplitFilterWhereClause(leaf)).toEqual({
      innerClause: '',
      outerClause: '',
      params: {},
    });
  });

  it.each(INHERITED)('drops the scores leaf %s instead of compiling it', inherited => {
    const result = buildScoresFilterWhereClause([
      { field: inherited, operator: 'equals', value: 'x' },
    ] as never);
    expect(result).toEqual({ clause: '', params: {} });
  });
});
