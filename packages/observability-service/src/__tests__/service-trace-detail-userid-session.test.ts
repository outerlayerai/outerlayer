/**
 * TracesService.transformTraceDetail — userId / sessionId extraction
 *
 * Verifies that the trace-detail pipeline surfaces userId and sessionId
 * from the root span's raw ClickHouse columns, and omits them when absent.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = { query: mockQuery } as any;

const verifiedAppId = 'app-test' as VerifiedAppId;
const testCtx: TenantContext = {
  userId: 'ctx-user',
  tenantId: 'tenant-test',
  appId: verifiedAppId,
  dataRetentionDays: -1,
};

function makeRawSpan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'span-1',
    trace_id: 'trace-1',
    parent_id: '',
    name: 'root',
    trace_name: '',
    status: '1',
    status_message: '',
    duration_ms: '1000',
    timestamp: '2024-01-01T00:00:00.000Z',
    type: 'SPAN',
    model: '',
    input_tokens: '0',
    output_tokens: '0',
    tokens: '0',
    cost: '0',
    input: '',
    output: '',
    output_object: '',
    tool_calls: '',
    finish_reason: '',
    settings: '',
    reasoning_tokens: '0',
    metadata: null,
    props: '',
    span_kind: '',
    service_name: '',
    ...overrides,
  };
}

describe('TracesService.transformTraceDetail userId / sessionId', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('includes userId in the result when the root span carries user_id', async () => {
    const rawSpans = [makeRawSpan({ user_id: 'user-abc' })];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.userId).toBe('user-abc');
  });

  it('includes sessionId in the result when the root span carries session_id', async () => {
    const rawSpans = [makeRawSpan({ session_id: 'sess-xyz' })];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.sessionId).toBe('sess-xyz');
  });

  it('omits userId when root span has no user_id', async () => {
    const rawSpans = [makeRawSpan()];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.userId).toBeUndefined();
  });

  it('omits sessionId when root span has no session_id', async () => {
    const rawSpans = [makeRawSpan()];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.sessionId).toBeUndefined();
  });

  it('extracts userId from the root span (no parent_id), not from a child span', async () => {
    const rawSpans = [
      makeRawSpan({ id: 'span-1', parent_id: '', user_id: 'root-user' }),
      makeRawSpan({ id: 'span-2', parent_id: 'span-1', user_id: 'child-user' }),
    ];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.userId).toBe('root-user');
  });

  it('extracts sessionId from the root span, not from a child span', async () => {
    const rawSpans = [
      makeRawSpan({ id: 'span-1', parent_id: '', session_id: 'root-session' }),
      makeRawSpan({ id: 'span-2', parent_id: 'span-1', session_id: 'child-session' }),
    ];
    mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rawSpans) });

    const result = await service.getTraceDetail(testCtx, 'trace-1');

    expect(result!.sessionId).toBe('root-session');
  });
});
