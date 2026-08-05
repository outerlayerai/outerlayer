/**
 * Service getSpanIO + getTraceDetailLightweight Tests
 *
 * Tests the lazy-loading span I/O service methods.
 */

import { AnalyticsService } from '../service';
import { TracesService } from '../services/traces';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService span I/O lazy loading', () => {
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

  describe('getSpanIO', () => {
    it('should return full I/O payload for a span', async () => {
      const rawRow = {
        input: '[{"role":"user","content":"Hello"}]',
        output: 'Hi there!',
        output_object: '{"greeting":"hi"}',
        tool_calls: '[{"name":"search"}]',
      };

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([rawRow]),
      });

      const result = await service.getSpanIO(testCtx, 'trace-1', 'span-1');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('[{"role":"user","content":"Hello"}]');
      expect(result!.output).toBe('Hi there!');
      expect(result!.outputObject).toBe('{"greeting":"hi"}');
      expect(result!.toolCalls).toBe('[{"name":"search"}]');
    });

    it('surfaces blobRefs when the row has offloaded fields', async () => {
      const blobRefs = '[{"field":"Output","blob_id":"t/a/tr/sp/Output","size":102753}]';
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([
          { input: 'in', output: 'preview…', output_object: '', tool_calls: '', blob_refs: blobRefs },
        ]),
      });

      const result = await service.getSpanIO(testCtx, 'trace-1', 'span-1');
      expect(result!.blobRefs).toBe(blobRefs);
    });

    it('leaves blobRefs undefined when nothing was offloaded (empty column)', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([
          { input: 'in', output: 'out', output_object: '', tool_calls: '', blob_refs: '' },
        ]),
      });

      const result = await service.getSpanIO(testCtx, 'trace-1', 'span-1');
      expect(result!.blobRefs).toBeUndefined();
    });

    it('should return null when span not found', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      });

      const result = await service.getSpanIO(testCtx, 'trace-1', 'nonexistent');

      expect(result).toBeNull();
    });

    it('should return null for empty output_object and tool_calls', async () => {
      const rawRow = {
        input: 'prompt text',
        output: 'response text',
        output_object: '',
        tool_calls: '',
      };

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([rawRow]),
      });

      const result = await service.getSpanIO(testCtx, 'trace-1', 'span-1');

      expect(result!.input).toBe('prompt text');
      expect(result!.output).toBe('response text');
      expect(result!.outputObject).toBeNull();
      expect(result!.toolCalls).toBeNull();
    });

    it('should pass correct query params', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ input: '', output: '', output_object: '', tool_calls: '' }]),
      });

      await service.getSpanIO(testCtx, 'trace-abc', 'span-xyz');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            appId: 'app-123',
            traceId: 'trace-abc',
            spanId: 'span-xyz',
          }),
        })
      );
    });

    it('should forward dataRetentionDays to retentionCutoff param', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ input: '', output: '', output_object: '', tool_calls: '' }]),
      });

      await service.getSpanIO(testCtx, 'trace-1', 'span-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            retentionCutoff: expect.any(String),
          }),
        })
      );
    });

    it('should propagate ClickHouse query errors', async () => {
      mockQuery.mockRejectedValue(new Error('ClickHouse connection failed'));

      await expect(
        service.getSpanIO(testCtx, 'trace-1', 'span-1')
      ).rejects.toThrow('ClickHouse connection failed');
    });

    it('should use SPAN_IO_QUERY constant', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      });

      await service.getSpanIO(testCtx, 'trace-1', 'span-1');

      const queryArg = mockQuery.mock.calls[0]![0];
      // Verify the query contains the SPAN_IO_QUERY markers
      expect(queryArg.query).toContain('Input as input');
      expect(queryArg.query).toContain('Output as output');
      expect(queryArg.query).toContain('{spanId:String}');
      expect(queryArg.query).toContain('LIMIT 1');
    });
  });

  describe('getTraceDetailLightweight', () => {
    it('should return trace detail with empty I/O fields', async () => {
      const rawSpans = [
        makeRawSpan({ id: 'span-1', input: '', output: '' }),
        makeRawSpan({ id: 'span-2', parent_id: 'span-1', input: '', output: '' }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetailLightweight(testCtx, 'trace-1');

      expect(result).not.toBeNull();
      expect(result!.spans).toHaveLength(2);
      // Lightweight query returns empty strings for IO
      expect(result!.spans[0]!.input).toBe('');
      expect(result!.spans[0]!.output).toBe('');
    });

    it('should return null when no spans found', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      });

      const result = await service.getTraceDetailLightweight(testCtx, 'trace-missing');

      expect(result).toBeNull();
    });

    it('should still fetch span scores in parallel', async () => {
      const rawSpans = [makeRawSpan({ id: 'span-1' })];
      const rawScores = [
        {
          id: 'score-1',
          resource_id: 'span-1',
          name: 'eval',
          score: '0.9',
          label: '',
          reason: '',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawScores) });

      const result = await service.getTraceDetailLightweight(testCtx, 'trace-1');

      expect(Object.keys(result!.spanScores!)).toEqual(['span-1']);
      expect(result!.spanScores!['span-1']).toHaveLength(1);
    });

    it('should set spanScoresError when scores fetch fails', async () => {
      const rawSpans = [makeRawSpan({ id: 'span-1' })];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockRejectedValueOnce(new Error('scores fetch failed'));

      const result = await service.getTraceDetailLightweight(testCtx, 'trace-1');

      expect(result!.spanScoresError).toBe(true);
      expect(result!.spanScores).toEqual({});
    });

    it('should use TRACE_DETAIL_LIGHTWEIGHT_QUERY constant', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      });

      await service.getTraceDetailLightweight(testCtx, 'trace-1');

      // calls[0] is the TraceId→time-range lookup; the detail query is calls[1]
      const queryArg = mockQuery.mock.calls[1]![0];
      // Lightweight query uses empty string literals instead of real column names
      expect(queryArg.query).toContain("'' as input");
      expect(queryArg.query).toContain("'' as output");
      expect(queryArg.query).not.toContain('Input as input');
    });

    it('should forward dataRetentionDays to retentionCutoff param', async () => {
      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      });

      await service.getTraceDetailLightweight(testCtx, 'trace-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            retentionCutoff: expect.any(String),
          }),
        })
      );
    });

    it('should propagate ClickHouse query errors', async () => {
      mockQuery.mockRejectedValue(new Error('ClickHouse timeout'));

      await expect(
        service.getTraceDetailLightweight(testCtx, 'trace-1')
      ).rejects.toThrow('ClickHouse timeout');
    });

    it('should transform raw spans into TraceDetail shape', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'span-1',
          trace_id: 'trace-1',
          name: 'root.operation',
          model: 'claude-sonnet-4-20250514',
          input_tokens: '200',
          output_tokens: '100',
        }),
      ];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getTraceDetailLightweight(testCtx, 'trace-1');

      expect(result!.id).toBe('trace-1');
      expect(result!.spans).toHaveLength(1);
      expect(result!.spans[0]!.name).toBe('root.operation');
      expect(result!.spans[0]!.model).toBe('claude-sonnet-4-20250514');
      expect(result!.spans[0]!.inputTokens).toBe(200);
      expect(result!.spans[0]!.outputTokens).toBe(100);
    });
  });

  describe('transformTraceDetail blobRefs mapping', () => {
    it('surfaces a non-empty BlobRefs column, and maps an empty one to undefined', () => {
      // The trace-detail span carries blobRefs so the drawer knows which fields
      // were offloaded. A present value must pass through verbatim; an empty
      // column must become `undefined` (not '') so `blobRefs ? …` render guards
      // and the rehydrator branch correctly.
      const refs = '[{"field":"Output","blob_id":"t/a/tr/sp/Output","size":102753}]';
      // transformTraceDetail is a pure mapping on TracesService (not exposed on
      // the AnalyticsService facade); scoresService is unused by it.
      const tracesService = new TracesService(mockClient, null as never);
      const detail = tracesService.transformTraceDetail('trace-1', [
        makeRawSpan({ id: 'span-blob', blob_refs: refs }),
        makeRawSpan({ id: 'span-plain', blob_refs: '' }),
      ]);

      expect(detail.spans.map((s) => s.blobRefs)).toEqual([refs, undefined]);
    });
  });
});
