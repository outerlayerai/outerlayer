/**
 * SQL Query Tests — Large Payload Handling
 *
 * Tests for TRACE_DETAIL_LIGHTWEIGHT_QUERY and SPAN_IO_QUERY.
 */

import {
  TRACE_DETAIL_QUERY,
  TRACE_DETAIL_LIGHTWEIGHT_QUERY,
  SPAN_IO_QUERY,
} from '../queries';

describe('TRACE_DETAIL_LIGHTWEIGHT_QUERY', () => {
  it('should have the same WHERE/ORDER clause as the full query', () => {
    const extractWhere = (q: string) => q.slice(q.indexOf('WHERE'));
    expect(extractWhere(TRACE_DETAIL_LIGHTWEIGHT_QUERY))
      .toBe(extractWhere(TRACE_DETAIL_QUERY));
  });

  it('should replace I/O columns with empty strings', () => {
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain("'' as input");
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain("'' as output");
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain("'' as output_object");
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain("'' as tool_calls");
  });

  it('should NOT select actual Input/Output columns', () => {
    // Ensure we're not selecting the real columns (case-sensitive ClickHouse columns)
    // The lightweight query should use literal empty strings instead.
    // We check by looking at the SELECT clause only (before WHERE)
    const selectClause = TRACE_DETAIL_LIGHTWEIGHT_QUERY.slice(0, TRACE_DETAIL_LIGHTWEIGHT_QUERY.indexOf('WHERE'));
    expect(selectClause).not.toMatch(/\bInput\b\s+as\s+input/);
    expect(selectClause).not.toMatch(/\bOutput\b\s+as\s+output/);
    expect(selectClause).not.toMatch(/\bOutputObject\b\s+as\s+output_object/);
    expect(selectClause).not.toMatch(/\bToolCalls\b\s+as\s+tool_calls/);
  });

  it('should still select all non-I/O columns', () => {
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('SpanId as id');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('TraceId as trace_id');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('SpanName as name');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('Model as model');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('InputTokens as input_tokens');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('OutputTokens as output_tokens');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('Cost as cost');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('Props as props');
  });

  it('should have required query parameters', () => {
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('{traceId:String}');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('{appId:String}');
    expect(TRACE_DETAIL_LIGHTWEIGHT_QUERY).toContain('{retentionCutoff:DateTime64(3)}');
  });
});

describe('SPAN_IO_QUERY', () => {
  it('should select only I/O columns', () => {
    expect(SPAN_IO_QUERY).toContain('Input as input');
    expect(SPAN_IO_QUERY).toContain('Output as output');
    expect(SPAN_IO_QUERY).toContain('OutputObject as output_object');
    expect(SPAN_IO_QUERY).toContain('ToolCalls as tool_calls');
  });

  it('should NOT select non-I/O columns', () => {
    expect(SPAN_IO_QUERY).not.toContain('SpanName');
    expect(SPAN_IO_QUERY).not.toContain('Model');
    expect(SPAN_IO_QUERY).not.toContain('InputTokens');
    expect(SPAN_IO_QUERY).not.toContain('Duration');
  });

  it('should filter by spanId, traceId, and appId', () => {
    expect(SPAN_IO_QUERY).toContain('{spanId:String}');
    expect(SPAN_IO_QUERY).toContain('{traceId:String}');
    expect(SPAN_IO_QUERY).toContain('{appId:String}');
  });

  it('should apply retention cutoff', () => {
    expect(SPAN_IO_QUERY).toContain('{retentionCutoff:DateTime64(3)}');
  });

  it('should limit to 1 row', () => {
    expect(SPAN_IO_QUERY).toContain('LIMIT 1');
  });
});
