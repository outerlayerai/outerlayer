/**
 * Service Trace Aggregation Regression Tests
 * Feature: 007-analytics-architecture-evaluation
 *
 * Regression tests ensuring that trace-level token/cost aggregation
 * only sums GENERATION type spans, not SPAN types which store
 * duplicated values from their children.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService trace token/cost aggregation', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  describe('getTraceDetail', () => {
    it('should only sum tokens/cost from GENERATION spans, not SPAN types', async () => {
      // Simulates a trace with a parent SPAN that has duplicated token values
      // from its children GENERATION spans
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-1',
          parent_id: '',
          name: 'ai.generateText',
          status: '1',
          status_message: '',
          duration_ms: '3900',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '233',
          output_tokens: '24',
          tokens: '257', // duplicated from children
          cost: '0.0008225', // duplicated from children
          input: '',
          output: '',
        },
        {
          id: 'span-2',
          trace_id: 'trace-1',
          parent_id: 'span-1',
          name: 'ai.generateText.doGenerate',
          status: '1',
          status_message: '',
          duration_ms: '2100',
          timestamp: '2024-01-01T00:00:01.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: '147',
          output_tokens: '18',
          tokens: '165',
          cost: '0.0005475',
          input: 'prompt text',
          output: 'response text',
        },
        {
          id: 'span-3',
          trace_id: 'trace-1',
          parent_id: 'span-1',
          name: 'search_knowledgebase',
          status: '1',
          status_message: '',
          duration_ms: '510',
          timestamp: '2024-01-01T00:00:02.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '0',
          output_tokens: '0',
          tokens: '0',
          cost: '0',
          input: '',
          output: '',
        },
        {
          id: 'span-4',
          trace_id: 'trace-1',
          parent_id: 'span-1',
          name: 'ai.generateText.doGenerate',
          status: '1',
          status_message: '',
          duration_ms: '1300',
          timestamp: '2024-01-01T00:00:03.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: '233',
          output_tokens: '24',
          tokens: '257',
          cost: '0.0008225',
          input: 'prompt 2',
          output: 'response 2',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-1');

      expect(result).not.toBeNull();
      // Should only sum GENERATION spans: 165 + 257 = 422 (not 257 + 165 + 257 = 679)
      expect(result!.tokens).toBe(422);
      // Should only sum GENERATION costs: 0.0005475 + 0.0008225 = 0.00137
      expect(result!.cost).toBeCloseTo(0.00137, 5);
    });

    it('should handle trace with only GENERATION spans correctly', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-2',
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
          input: 'test',
          output: 'response',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-2');

      expect(result!.tokens).toBe(150);
      expect(result!.cost).toBe(0.005);
    });

    it('should return zero tokens/cost when no GENERATION spans exist', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-3',
          parent_id: '',
          name: 'agent.run',
          status: '1',
          status_message: '',
          duration_ms: '5000',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '500',
          output_tokens: '200',
          tokens: '700', // stored but should not be counted
          cost: '0.01',
          input: '',
          output: '',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-3');

      expect(result!.tokens).toBe(0);
      expect(result!.cost).toBe(0);
    });

    it('should not double-count nested SPAN types with duplicated values', async () => {
      // Nested structure: SPAN (root) -> SPAN (wrapper) -> GENERATION
      // Both SPANs store duplicated tokens from the GENERATION child
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-4',
          parent_id: '',
          name: 'root',
          status: '1',
          status_message: '',
          duration_ms: '3000',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '100',
          output_tokens: '50',
          tokens: '150', // duplicated
          cost: '0.003', // duplicated
          input: '',
          output: '',
        },
        {
          id: 'span-2',
          trace_id: 'trace-4',
          parent_id: 'span-1',
          name: 'wrapper',
          status: '1',
          status_message: '',
          duration_ms: '2000',
          timestamp: '2024-01-01T00:00:01.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '100',
          output_tokens: '50',
          tokens: '150', // duplicated
          cost: '0.003', // duplicated
          input: '',
          output: '',
        },
        {
          id: 'span-3',
          trace_id: 'trace-4',
          parent_id: 'span-2',
          name: 'llm.generate',
          status: '1',
          status_message: '',
          duration_ms: '1500',
          timestamp: '2024-01-01T00:00:02.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: '100',
          output_tokens: '50',
          tokens: '150',
          cost: '0.003',
          input: 'prompt',
          output: 'response',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-4');

      // Should only count the GENERATION span once: 150 tokens, not 450
      expect(result!.tokens).toBe(150);
      expect(result!.cost).toBe(0.003);
    });
  });

  describe('getTraceDetail extended field mapping', () => {
    it('should only sum tokens/cost from GENERATION spans', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-1',
          parent_id: '',
          name: 'agent',
          status: '1',
          status_message: '',
          duration_ms: '5000',
          timestamp: '2024-01-01T00:00:00.000Z',
          type: 'SPAN',
          model: '',
          input_tokens: '300',
          output_tokens: '100',
          tokens: '400', // duplicated
          cost: '0.01', // duplicated
          input: '',
          output: '',
          output_object: '',
          tool_calls: '',
          finish_reason: '',
          settings: '',
          reasoning_tokens: '0',
          metadata: {},
          props: '',
          span_kind: 'INTERNAL',
          service_name: 'test',
        },
        {
          id: 'span-2',
          trace_id: 'trace-1',
          parent_id: 'span-1',
          name: 'llm.call',
          status: '1',
          status_message: '',
          duration_ms: '2000',
          timestamp: '2024-01-01T00:00:01.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: '200',
          output_tokens: '50',
          tokens: '250',
          cost: '0.006',
          input: 'prompt',
          output: 'response',
          output_object: '{}',
          tool_calls: '',
          finish_reason: 'stop',
          settings: '{}',
          reasoning_tokens: '0',
          metadata: {},
          props: '',
          span_kind: 'CLIENT',
          service_name: 'test',
        },
        {
          id: 'span-3',
          trace_id: 'trace-1',
          parent_id: 'span-1',
          name: 'llm.call.2',
          status: '1',
          status_message: '',
          duration_ms: '1500',
          timestamp: '2024-01-01T00:00:02.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: '100',
          output_tokens: '50',
          tokens: '150',
          cost: '0.004',
          input: 'prompt 2',
          output: 'response 2',
          output_object: '{}',
          tool_calls: '',
          finish_reason: 'stop',
          settings: '{}',
          reasoning_tokens: '0',
          metadata: {},
          props: '',
          span_kind: 'CLIENT',
          service_name: 'test',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-1');

      expect(result).not.toBeNull();
      // Should only sum GENERATION spans: 250 + 150 = 400
      expect(result!.tokens).toBe(400);
      expect(result!.cost).toBeCloseTo(0.01, 5);
    });

    it('should map props as raw string from ClickHouse', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-ext-2',
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
          input: 'prompt',
          output: 'response',
          output_object: '',
          tool_calls: '',
          finish_reason: 'stop',
          settings: '',
          reasoning_tokens: '0',
          metadata: {},
          props: '{"customer_question": "What is your return policy?"}',
          span_kind: 'CLIENT',
          service_name: 'test',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-ext-2');

      expect(result!.spans[0]!.props).toBe('{"customer_question": "What is your return policy?"}');
    });

    it('should handle null/empty extended fields gracefully', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-ext-3',
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
          input: 'prompt',
          output: 'response',
          output_object: '',
          tool_calls: '',
          finish_reason: '',
          settings: '',
          reasoning_tokens: '0',
          metadata: {},
          props: '',
          span_kind: '',
          service_name: '',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-ext-3');

      expect(result!.spans[0]!.props).toBeNull();
      expect(result!.spans[0]!.outputObject).toBeNull();
      expect(result!.spans[0]!.finishReason).toBeNull();
      expect(result!.spans[0]!.spanKind).toBe('INTERNAL');
      expect(result!.spans[0]!.serviceName).toBe('');
    });

    it('should map outputObject from raw output_object field', async () => {
      const rawSpans = [
        {
          id: 'span-1',
          trace_id: 'trace-ext-4',
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
          input: 'prompt',
          output: '',
          output_object: '{"structured": "response"}',
          tool_calls: '[{"name": "search"}]',
          finish_reason: 'tool_calls',
          settings: '{"temperature": 0.7}',
          reasoning_tokens: '25',
          metadata: { custom: 'data' },
          props: '',
          span_kind: 'CLIENT',
          service_name: 'my-service',
        },
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-ext-4');

      const span = result!.spans[0]!;
      expect(span.outputObject).toBe('{"structured": "response"}');
      expect(span.toolCalls).toBe('[{"name": "search"}]');
      expect(span.finishReason).toBe('tool_calls');
      expect(span.settings).toBe('{"temperature": 0.7}');
      expect(span.reasoningTokens).toBe(25);
      expect(span.spanKind).toBe('CLIENT');
      expect(span.serviceName).toBe('my-service');
    });
  });

  describe('getTraceDetail I/O aggregation', () => {
    /**
     * Helper to generate a raw span with all required fields.
     * Each test only specifies the fields that matter for the I/O scenario.
     */
    function makeRawSpan(overrides: Record<string, any> = {}) {
      return {
        id: 'span-1',
        trace_id: 'trace-io',
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
        input: 'default input',
        output: 'default output',
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

    it('should prefer the root span I/O (runner-recorded agentmark.input/output)', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'root-1',
          type: 'SPAN',
          timestamp: '2024-01-01T00:00:01.000Z',
          input: 'root input',
          output: 'root output',
        }),
        makeRawSpan({
          id: 'gen-2',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:02.000Z',
          input: 'gen input',
          output: 'gen output',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('root input');
      expect(result!.output).toBe('root output');
    });

    it('should fall back to earliest GENERATION input / latest GENERATION output when the root span has no I/O', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'root-1',
          type: 'SPAN',
          timestamp: '2024-01-01T00:00:00.000Z',
          input: '',
          output: '',
        }),
        makeRawSpan({
          id: 'gen-2',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:02.000Z',
          input: 'second input',
          output: 'second output',
        }),
        makeRawSpan({
          id: 'gen-3',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:03.000Z',
          input: 'third input',
          output: 'third output',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('second input');
      expect(result!.output).toBe('third output');
    });

    it('should set both input and output from a single GENERATION span', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'gen-single',
          input: 'only input',
          output: 'only output',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('only input');
      expect(result!.output).toBe('only output');
    });

    it('should use root span I/O even when no GENERATION spans exist (runner-only trace)', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'span-only',
          type: 'SPAN',
          input: 'span input',
          output: 'span output',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('span input');
      expect(result!.output).toBe('span output');
    });

    it('should skip GENERATION spans with empty input when falling back', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'root-1',
          type: 'SPAN',
          timestamp: '2024-01-01T00:00:00.000Z',
          input: '',
          output: '',
        }),
        makeRawSpan({
          id: 'gen-empty-input',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:01.000Z',
          input: '',
          output: 'first output',
        }),
        makeRawSpan({
          id: 'gen-with-input',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:02.000Z',
          input: 'some input',
          output: 'second output',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      // Fields resolve independently: input skips the empty first GENERATION
      // span; output still comes from the last GENERATION span with one.
      expect(result!.input).toBe('some input');
      expect(result!.output).toBe('second output');
    });

    it('should skip GENERATION spans with empty output when falling back', async () => {
      const rawSpans = [
        makeRawSpan({
          id: 'root-1',
          type: 'SPAN',
          timestamp: '2024-01-01T00:00:00.000Z',
          input: '',
          output: '',
        }),
        makeRawSpan({
          id: 'gen-with-output',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:01.000Z',
          input: 'first input',
          output: 'first output',
        }),
        makeRawSpan({
          id: 'gen-empty-output',
          parent_id: 'root-1',
          timestamp: '2024-01-01T00:00:02.000Z',
          input: 'second input',
          output: '',
        }),
      ];

      mockQuery.mockResolvedValue({
        json: vi.fn().mockResolvedValue(rawSpans),
      });

      const result = await service.getTraceDetail(testCtx, 'trace-io');

      expect(result).not.toBeNull();
      expect(result!.input).toBe('first input');
      // The last GENERATION span's output is empty — fall back to the most
      // recent one that has an output instead of dropping the field.
      expect(result!.output).toBe('first output');
    });
  });

  describe('getTraceDetail spanScores batch fetch', () => {
    function makeRawSpan(overrides: Record<string, any> = {}) {
      return {
        id: 'span-1',
        trace_id: 'trace-scores',
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
        input: 'test',
        output: 'response',
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

    it('should attach spanScores from batch scores query', async () => {
      const rawSpans = [makeRawSpan({ id: 'span-a' }), makeRawSpan({ id: 'span-b' })];
      const rawScores = [
        {
          id: 'score-1',
          resource_id: 'span-a',
          name: 'answer-fit',
          score: '1.00',
          label: '',
          reason: '',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:01.000Z',
        },
        {
          id: 'score-2',
          resource_id: 'span-a',
          name: 'coherence',
          score: '0.75',
          label: '',
          reason: '',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:02.000Z',
        },
        {
          id: 'score-3',
          resource_id: 'span-b',
          name: 'answer-fit',
          score: '0.5',
          label: '',
          reason: '',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:03.000Z',
        },
      ];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawScores) });

      const result = await service.getTraceDetail(testCtx, 'trace-scores');

      expect(result).not.toBeNull();
      expect(Object.keys(result!.spanScores!).sort()).toEqual(['span-a', 'span-b']);
      expect(result!.spanScores!['span-a']).toHaveLength(2);
      expect(result!.spanScores!['span-a']![0]!.name).toBe('answer-fit');
      expect(result!.spanScores!['span-a']![0]!.score).toBe(1);
      expect(result!.spanScores!['span-a']![1]!.name).toBe('coherence');
      expect(result!.spanScores!['span-a']![1]!.score).toBe(0.75);
      expect(result!.spanScores!['span-b']).toHaveLength(1);
      expect(result!.spanScores!['span-b']![0]!.score).toBe(0.5);
    });

    it('should return empty spanScores when no scores exist for spans', async () => {
      const rawSpans = [makeRawSpan({ id: 'span-no-scores' })];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getTraceDetail(testCtx, 'trace-scores');

      expect(result).not.toBeNull();
      expect(result!.spanScores).toEqual({});
    });

    it('should return spanScores as empty object when scores fetch fails', async () => {
      const rawSpans = [makeRawSpan({ id: 'span-error' })];

      mockQuery
        // 1st call: TraceId→time-range lookup (empty → unbounded detail query)
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rawSpans) })
        .mockRejectedValueOnce(new Error('ClickHouse scores query failed'));

      const result = await service.getTraceDetail(testCtx, 'trace-scores');

      expect(result).not.toBeNull();
      // Scores fetch failure should not break trace detail
      expect(result!.spanScores).toEqual({});
    });
  });

  describe('getScoresBySpanIds', () => {
    it('should return empty map for empty span IDs array', async () => {
      const result = await service.getScoresBySpanIds(testCtx, []);
      expect(result).toEqual({});
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should group scores by resourceId', async () => {
      const rawScores = [
        {
          id: 'sc-1',
          resource_id: 'span-x',
          name: 'my-eval',
          score: '0.9',
          label: 'pass',
          reason: 'good',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'sc-2',
          resource_id: 'span-y',
          name: 'my-eval',
          score: '0.3',
          label: 'fail',
          reason: 'bad',
          source: 'eval',
          user_id: '',
          created_at: '2024-01-01T00:00:01.000Z',
        },
      ];

      mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawScores) });

      const result = await service.getScoresBySpanIds(testCtx, ['span-x', 'span-y']);

      expect(result['span-x']).toHaveLength(1);
      expect(result['span-x']![0]!.score).toBe(0.9);
      expect(result['span-y']).toHaveLength(1);
      expect(result['span-y']![0]!.score).toBe(0.3);
    });
  });
});
