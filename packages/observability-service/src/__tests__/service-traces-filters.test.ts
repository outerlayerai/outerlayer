/**
 * Service Traces AnalyticsFilter[] Integration Tests
 *
 * Verifies that getTraces() correctly passes AnalyticsFilter[] through
 * to buildFilterWhereClause for parameterized SQL generation.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService.getTraces with filters', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should include filter clauses when filters array is provided', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      filters: [
        { field: 'model', operator: 'equals', value: 'gpt-4' },
      ],
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Model = {filter_0:String}');
    expect(listCall.query_params.filter_0).toBe('gpt-4');
    // Span-level filters must be applied via the inner trace-finding subquery
    // so the outer aggregate covers ALL spans of matching traces, not just
    // the spans that matched the filter (otherwise span_count/cost/tokens/
    // latency rollups would be contaminated).
    expect(listCall.query).toContain('SELECT DISTINCT TraceId');
    expect(listCall.query).toContain('AND TraceId IN (');

    // Count query should also include the filter clause + scope subquery
    const countCall = mockQuery.mock.calls[1]![0];
    expect(countCall.query).toContain('Model = {filter_0:String}');
    expect(countCall.query_params.filter_0).toBe('gpt-4');
    expect(countCall.query).toContain('SELECT DISTINCT TraceId');
  });

  it('should work without filters (empty array)', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      filters: [],
    });

    const listCall = mockQuery.mock.calls[0]![0];
    // No filter clauses should be added when filters is empty.
    expect(listCall.query).not.toContain('Model =');
    // The new status SELECT aggregate (`if(countIf(StatusCode='2')>0, '2', '1')`)
    // is always present; assert no StatusCode *filter* predicate is appended.
    expect(listCall.query).not.toContain("AND StatusCode = '2'");
    expect(listCall.query).not.toContain("AND StatusCode != '2'");
    // Without span-level filters, no inner trace-finding subquery should run.
    expect(listCall.query).not.toContain('SELECT DISTINCT TraceId');
    expect(listCall.query).not.toContain('AND TraceId IN (');
  });

  it('should combine userId clause with filters array', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
      filters: [
        { field: 'model', operator: 'equals', value: 'gpt-4' },
      ],
    });

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('AND UserId = {userId:String}');
    expect(listCall.query).toContain('Model = {filter_0:String}');
    expect(listCall.query_params.userId).toBe('user-abc');
    expect(listCall.query_params.filter_0).toBe('gpt-4');

    // Count query should also include both clauses
    const countCall = mockQuery.mock.calls[1]![0];
    expect(countCall.query).toContain('AND UserId = {userId:String}');
    expect(countCall.query).toContain('Model = {filter_0:String}');
  });
});
