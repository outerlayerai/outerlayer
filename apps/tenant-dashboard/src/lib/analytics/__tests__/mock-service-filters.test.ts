/**
 * Mock Service Filter Tests
 *
 * Tests for applyFiltersToSpans in the mock analytics service.
 * Covers string operators, numeric operators, metadata, combined filters, and edge cases.
 */

import { applyFiltersToSpans } from '../mock-service';
import type { MockSpan } from '../mock-data';
import type { AnalyticsFilter } from '@repo/observability-service';

// ── Test Fixtures ─────────────────────────────────────────────────────

function makeSpan(overrides: Partial<MockSpan> = {}): MockSpan {
  return {
    id: 'span-001',
    traceId: 'trace-001',
    parentId: null,
    name: 'llm-call',
    type: 'GENERATION',
    status: 'OK',
    statusMessage: '',
    model: 'gpt-4o',
    inputTokens: 500,
    outputTokens: 200,
    tokens: 700,
    cost: 0.0035,
    durationMs: 1200,
    timestamp: new Date('2025-01-15T10:00:00Z'),
    input: 'Summarize this document about AI trends',
    output: 'The document discusses several key trends...',
    props: null,
    userId: 'user-alice',
    finishReason: 'stop',
    reasoningTokens: 0,
    spanKind: 'LLM',
    serviceName: 'my-app',
    metadata: { environment: 'production', tier: 'pro' },
    ...overrides,
  };
}

const SPANS: MockSpan[] = [
  makeSpan({ id: 's1', model: 'gpt-4o', userId: 'user-alice', status: 'OK', inputTokens: 500, outputTokens: 200, cost: 0.005, durationMs: 1200, input: 'Summarize this document', output: 'Summary result', traceId: 'trace-001', metadata: { environment: 'production', tier: 'pro' } }),
  makeSpan({ id: 's2', model: 'gpt-4o-mini', userId: 'user-bob', status: 'OK', inputTokens: 300, outputTokens: 100, cost: 0.001, durationMs: 600, input: 'Classify intent', output: 'billing_inquiry', traceId: 'trace-002', metadata: { environment: 'staging', tier: 'free' } }),
  makeSpan({ id: 's3', model: 'claude-sonnet-4-20250514', userId: 'user-alice', status: 'ERROR', inputTokens: 800, outputTokens: 0, cost: 0.0024, durationMs: 3500, input: 'Review this code', output: '', traceId: 'trace-003', metadata: { environment: 'production', tier: 'enterprise' } }),
  makeSpan({ id: 's4', model: 'gpt-4o', userId: 'user-charlie', status: 'OK', inputTokens: 1000, outputTokens: 500, cost: 0.0125, durationMs: 2000, input: 'Generate a response to billing', output: 'Thank you for reaching out', traceId: 'trace-004', metadata: { environment: 'development', tier: 'pro' } }),
  makeSpan({ id: 's5', model: null, userId: 'user-diana', status: 'OK', inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 50, input: '', output: '', traceId: 'trace-005', props: 'custom-prop', metadata: {} }),
];

// ── String Filter Tests ───────────────────────────────────────────────

describe('applyFiltersToSpans - string filters', () => {
  it('should match model_used with equals operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model_used', operator: 'equals', value: 'gpt-4o' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('should treat model field as alias for model_used', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'equals', value: 'gpt-4o-mini' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s2');
  });

  it('should match model with = operator (alias for equals)', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: '=', value: 'gpt-4o' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('should match model with contains (case-insensitive)', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'contains', value: 'gpt' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's4']);
  });

  it('should return false for contains with empty target', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'contains', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should match model with startsWith', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'startsWith', value: 'claude' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match model with endsWith', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'endsWith', value: 'mini' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s2');
  });

  it('should match user_id with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'user_id', operator: 'equals', value: 'user-alice' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('should match status with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'status', operator: 'equals', value: 'ERROR' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match input with contains', () => {
    const filters: AnalyticsFilter[] = [{ field: 'input', operator: 'contains', value: 'billing' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s4');
  });

  it('should match output with contains', () => {
    const filters: AnalyticsFilter[] = [{ field: 'output', operator: 'contains', value: 'Thank you' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s4');
  });

  it('should match trace_id with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'trace_id', operator: 'equals', value: 'trace-003' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match null model with isEmpty', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'isEmpty', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s5');
  });

  it('should match non-null model with isNotEmpty', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'isNotEmpty', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('should exclude spans matching notContains', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'notContains', value: 'gpt' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // s3 (claude) and s5 (null coerced to empty string)
    expect(result.map((s) => s.id)).toEqual(['s3', 's5']);
  });

  it('should return true for notContains with empty target', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'notContains', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(SPANS.length);
  });

  it('should match not_equals for strings', () => {
    const filters: AnalyticsFilter[] = [{ field: 'status', operator: 'not_equals', value: 'OK' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match != operator for strings', () => {
    const filters: AnalyticsFilter[] = [{ field: 'status', operator: '!=', value: 'OK' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match notequals operator for strings', () => {
    const filters: AnalyticsFilter[] = [{ field: 'status', operator: 'notequals', value: 'OK' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match like operator as alias for contains', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'like', value: 'gpt' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's4']);
  });

  it('should return false for like with empty target', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'like', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should fall through to exact match for unrecognized string operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'some_future_op', value: 'gpt-4o' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });
});

// ── Numeric Filter Tests ──────────────────────────────────────────────

describe('applyFiltersToSpans - numeric filters', () => {
  it('should match prompt_tokens with = operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '=', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
  });

  it('should exclude prompt_tokens with != operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '!=', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's4', 's5']);
  });

  it('should match prompt_tokens with > operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '>', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s3', 's4']);
  });

  it('should match prompt_tokens with >= operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '>=', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3', 's4']);
  });

  it('should match prompt_tokens with < operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '<', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('should match prompt_tokens with <= operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '<=', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's5']);
  });

  it('should match completion_tokens with > operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'completion_tokens', operator: '>', value: '200' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s4');
  });

  it('should match completion_tokens with < operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'completion_tokens', operator: '<', value: '200' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // s2 (100), s3 (0), s5 (0)
    expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's5']);
  });

  it('should match cost with >= operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'cost', operator: '>=', value: '0.005' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('should match cost with <= operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'cost', operator: '<=', value: '0.001' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('should match latency_ms with > operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'latency_ms', operator: '>', value: '2000' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s3');
  });

  it('should match latency_ms with < operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'latency_ms', operator: '<', value: '1000' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // s2 (600), s5 (50)
    expect(result.map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('should match gt text alias for >', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'gt', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s3', 's4']);
  });

  it('should match gte text alias for >=', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'gte', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3', 's4']);
  });

  it('should match lt text alias for <', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'lt', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('should match lte text alias for <=', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'lte', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's5']);
  });

  it('should match equals text alias for numeric =', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'equals', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
  });

  it('should match not_equals text alias for numeric !=', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'not_equals', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's4', 's5']);
  });

  it('should match notequals text alias for numeric !=', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'notequals', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's4', 's5']);
  });

  it('should return no matches when target is not a number', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: '>', value: 'not-a-number' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should fall through to exact match for unrecognized numeric operator', () => {
    const filters: AnalyticsFilter[] = [{ field: 'prompt_tokens', operator: 'some_future_op', value: '500' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
  });
});

// ── Metadata Filter Tests ─────────────────────────────────────────────

describe('applyFiltersToSpans - metadata filters', () => {
  it('should match metadata.environment with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.environment', operator: 'equals', value: 'production' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('should match metadata.tier with contains', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.tier', operator: 'contains', value: 'pro' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // 'pro' in s1 and s4
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('should return no matches for nonexistent metadata key with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.nonexistent', operator: 'equals', value: 'anything' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should match nonexistent metadata key with isEmpty', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.nonexistent', operator: 'isEmpty', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // null ?? null coerced to '' by matchString, so isEmpty returns true for all
    expect(result).toHaveLength(SPANS.length);
  });

  it('should return no matches for nonexistent metadata key with isNotEmpty', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.nonexistent', operator: 'isNotEmpty', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should apply multiple metadata filters as AND', () => {
    const filters: AnalyticsFilter[] = [
      { field: 'metadata.environment', operator: 'equals', value: 'production' },
      { field: 'metadata.tier', operator: 'equals', value: 'pro' },
    ];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
  });

  it('should handle empty metadata object gracefully', () => {
    const filters: AnalyticsFilter[] = [{ field: 'metadata.tier', operator: 'equals', value: 'pro' }];
    // s5 has metadata: {} — tier is undefined, coerced to '' by matchString
    const result = applyFiltersToSpans([SPANS[4]!], filters);
    expect(result).toHaveLength(0);
  });
});

// ── Combined Filter Tests ─────────────────────────────────────────────

describe('applyFiltersToSpans - combined filters', () => {
  it('should apply string + numeric filters as AND', () => {
    const filters: AnalyticsFilter[] = [
      { field: 'model', operator: 'equals', value: 'gpt-4o' },
      { field: 'prompt_tokens', operator: '>', value: '600' },
    ];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s4');
  });

  it('should support range query with two filters on the same field', () => {
    const filters: AnalyticsFilter[] = [
      { field: 'prompt_tokens', operator: '>=', value: '300' },
      { field: 'prompt_tokens', operator: '<=', value: '800' },
    ];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('should return empty when contradictory filters are combined', () => {
    const filters: AnalyticsFilter[] = [
      { field: 'model', operator: 'equals', value: 'gpt-4o' },
      { field: 'status', operator: 'equals', value: 'ERROR' },
    ];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(0);
  });

  it('should apply string + metadata + numeric filters as AND', () => {
    const filters: AnalyticsFilter[] = [
      { field: 'metadata.environment', operator: 'equals', value: 'production' },
      { field: 'status', operator: 'equals', value: 'OK' },
      { field: 'prompt_tokens', operator: '>=', value: '400' },
    ];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
  });

  it('should pass through unknown fields for forward compatibility', () => {
    const filters: AnalyticsFilter[] = [{ field: 'unknown_future_field', operator: 'equals', value: 'x' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(SPANS.length);
  });
});

// ── Edge Cases ────────────────────────────────────────────────────────

describe('applyFiltersToSpans - edge cases', () => {
  it('should return all spans for empty filter array', () => {
    const result = applyFiltersToSpans(SPANS, []);
    expect(result).toHaveLength(SPANS.length);
  });

  it('should return all spans for undefined filters', () => {
    const result = applyFiltersToSpans(SPANS, undefined);
    expect(result).toHaveLength(SPANS.length);
  });

  it('should return empty spans list unchanged', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'equals', value: 'gpt-4o' }];
    const result = applyFiltersToSpans([], filters);
    expect(result).toHaveLength(0);
  });

  it('should match empty output with equals empty string', () => {
    const filters: AnalyticsFilter[] = [{ field: 'output', operator: 'equals', value: '' }];
    const result = applyFiltersToSpans(SPANS, filters);
    // s3 has empty output, s5 has empty output
    expect(result.map((s) => s.id)).toEqual(['s3', 's5']);
  });

  it('should use first element when filter value is an array', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'equals', value: ['gpt-4o', 'ignored'] }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('should coerce null filter value to empty string', () => {
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'equals', value: null as unknown as string }];
    const result = applyFiltersToSpans(SPANS, filters);
    // null coerced to '', matches s5 where model is null (coerced to '')
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s5');
  });

  it('should match props field with equals', () => {
    const filters: AnalyticsFilter[] = [{ field: 'props', operator: 'equals', value: 'custom-prop' }];
    const result = applyFiltersToSpans(SPANS, filters);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s5');
  });

  it('should not mutate the original spans array', () => {
    const original = [...SPANS];
    const filters: AnalyticsFilter[] = [{ field: 'model', operator: 'equals', value: 'gpt-4o' }];
    applyFiltersToSpans(SPANS, filters);
    expect(SPANS).toEqual(original);
  });
});
