/**
 * Service Traces combined parameter tests.
 *
 * Verifies that getTraces() handles multiple filter dimensions
 * simultaneously: userId and filters[].
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService.getTraces combined parameters', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should combine userId and filters in a single query', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
      filters: [
        { field: 'model', operator: 'equals', value: 'gpt-4' },
        { field: 'latency_ms', operator: 'gt', value: '100' },
      ],
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const listCall = mockQuery.mock.calls[0]![0];

    // userId clause
    expect(listCall.query).toContain('AND UserId = {userId:String}');
    expect(listCall.query_params.userId).toBe('user-abc');

    // filters clauses
    expect(listCall.query).toContain('Model = {filter_0:String}');
    expect(listCall.query_params.filter_0).toBe('gpt-4');
    expect(listCall.query).toContain('Duration > {filter_1:Float64}');
    expect(listCall.query_params.filter_1).toBe(100);

    // Count query should have same clauses
    const countCall = mockQuery.mock.calls[1]![0];
    expect(countCall.query).toContain('AND UserId = {userId:String}');
    expect(countCall.query).toContain('Model = {filter_0:String}');
  });

  it('should not include search preview fields', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
    });

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).not.toContain('inputPreview');
    expect(listCall.query).not.toContain('outputPreview');
  });

  it('should combine status filter with userId and filters', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
      filters: [
        { field: 'status', operator: 'equals', value: 'ERROR' },
      ],
    });

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('AND UserId = {userId:String}');
    expect(listCall.query).toContain("StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error')");
    expect(listCall.query_params.userId).toBe('user-abc');
  });

  it('should handle empty string userId (should not add clause)', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: '',
    });

    const listCall = mockQuery.mock.calls[0]![0];
    // Empty string is falsy, so no userId clause
    expect(listCall.query).not.toContain('AND UserId =');
  });

  it('should return correct response shape', async () => {
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          {
            id: 'trace-1',
            name: 'test-trace',
            start: '2025-01-01T00:00:00Z',
            end: '2025-01-01T00:01:00Z',
            status: '0',
            cost: '0.01',
            tokens: '100',
            latency_ms: '500',
          },
        ]),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total: '1' }]),
      });

    const result = await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
    });

    expect(result.traces).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
    expect(result.traces[0]!.id).toBe('trace-1');
    expect(result.traces[0]!.cost).toBe(0.01);
    expect(result.traces[0]!.tokens).toBe(100);
    expect(result.traces[0]!.latencyMs).toBe(500);
  });
});
