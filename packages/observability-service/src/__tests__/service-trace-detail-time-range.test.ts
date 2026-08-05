/**
 * Trace detail TraceId→time-range narrowing tests
 *
 * The trace-detail path first resolves the trace's [min, max] Timestamp from
 * the small `otel_traces_trace_id_ts` lookup table and, when found, bounds
 * the main `otel_traces FINAL` scan with `Timestamp BETWEEN`. The lookup is
 * a pure optimization: an empty result or a lookup failure must degrade to
 * the original unbounded query, byte-for-byte identical API behavior.
 */

import { AnalyticsService } from '../service';
import { TRACE_ID_TIME_RANGE_QUERY } from '../queries';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService trace detail time-range narrowing', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  function makeRawSpan(overrides: Record<string, any> = {}) {
    return {
      id: 'span-1',
      trace_id: 'trace-1',
      parent_id: '',
      name: 'llm.call',
      status: '1',
      status_message: '',
      duration_ms: '1000',
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'GENERATION',
      model: 'gpt-4',
      input_tokens: '100',
      output_tokens: '50',
      tokens: '150',
      cost: '0.005',
      input: '',
      output: '',
      output_object: '',
      tool_calls: '',
      finish_reason: 'stop',
      settings: '',
      reasoning_tokens: '0',
      metadata: {},
      props: '',
      span_kind: 'CLIENT',
      service_name: 'test',
      trace_name: '',
      ...overrides,
    };
  }

  it('should issue the lookup query first with tenant-scoped params', async () => {
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });

    await service.getTraceDetail(testCtx, 'trace-1');

    expect(mockQuery.mock.calls[0]![0]).toEqual({
      query: TRACE_ID_TIME_RANGE_QUERY,
      query_params: {
        appId: 'app-123',
        tenantId: 'tenant-123',
        traceId: 'trace-1',
      },
      format: 'JSONEachRow',
      clickhouse_settings: {
        max_execution_time: 30,
        do_not_merge_across_partitions_select_final: 1,
      },
    });
  });

  it('should bound the detail query with the resolved time range', async () => {
    mockQuery
      // lookup hit
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { start: '2024-01-01 00:00:00.000000000', end: '2024-01-01 00:00:05.000000000' },
        ]),
      })
      // detail query
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([makeRawSpan()]) })
      // scores
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    const detailCall = mockQuery.mock.calls[1]![0];
    expect(detailCall.query).toContain('AND Timestamp >= {tsRangeStart:DateTime64(9)}');
    expect(detailCall.query).toContain('AND Timestamp <= {tsRangeEnd:DateTime64(9)}');
    // The bound must come BEFORE ORDER BY (still part of the WHERE clause)
    expect(detailCall.query.indexOf('{tsRangeEnd:DateTime64(9)}')).toBeLessThan(
      detailCall.query.indexOf('ORDER BY'),
    );
    expect(detailCall.query_params).toEqual(
      expect.objectContaining({
        tsRangeStart: '2024-01-01 00:00:00.000000000',
        tsRangeEnd: '2024-01-01 00:00:05.000000000',
        traceId: 'trace-1',
        appId: 'app-123',
        tenantId: 'tenant-123',
      }),
    );
    expect(result!.spans).toHaveLength(1);
  });

  it('should fall back to the unbounded query when the lookup is empty', async () => {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([makeRawSpan()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    const detailCall = mockQuery.mock.calls[1]![0];
    expect(detailCall.query).not.toContain('tsRangeStart');
    expect(detailCall.query_params).not.toHaveProperty('tsRangeStart');
    expect(result!.spans).toHaveLength(1);
  });

  it('should fall back to the unbounded query when the lookup fails (e.g. table missing)', async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("Table default.otel_traces_trace_id_ts doesn't exist"))
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([makeRawSpan()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    const detailCall = mockQuery.mock.calls[1]![0];
    expect(detailCall.query).not.toContain('tsRangeStart');
    expect(result!.spans).toHaveLength(1);
  });

  it('should apply narrowing to the lightweight detail query too', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { start: '2024-01-01 00:00:00.000000000', end: '2024-01-01 00:00:05.000000000' },
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([makeRawSpan()]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

    await service.getTraceDetailLightweight(testCtx, 'trace-1');

    const detailCall = mockQuery.mock.calls[1]![0];
    expect(detailCall.query).toContain("'' as input");
    expect(detailCall.query).toContain('AND Timestamp >= {tsRangeStart:DateTime64(9)}');
  });

  it('should still return null for a missing trace (lookup empty + no spans)', async () => {
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });

    const result = await service.getTraceDetail(testCtx, 'trace-missing');

    expect(result).toBeNull();
  });
});
