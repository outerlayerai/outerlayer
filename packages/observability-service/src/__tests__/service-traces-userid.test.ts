/**
 * Service Traces userId Filter Tests
 *
 * Verifies that getTraces() includes a userId WHERE clause
 * in the ClickHouse query when a userId param is provided.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService.getTraces userId filtering', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should include AND UserId = clause when userId is provided', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
      userId: 'user-abc',
    });

    // Both list and count queries should be called
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Verify the list query includes the userId clause
    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('AND UserId = {userId:String}');
    expect(listCall.query_params.userId).toBe('user-abc');

    // Verify the count query includes the userId clause
    const countCall = mockQuery.mock.calls[1]![0];
    expect(countCall.query).toContain('AND UserId = {userId:String}');
    expect(countCall.query_params.userId).toBe('user-abc');
  });

  it('should NOT include userId clause when userId is not provided', async () => {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ total: '0' }]),
    });

    await service.getTraces(testCtx, {
      limit: 10,
      offset: 0,
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).not.toContain('AND UserId =');
    expect(listCall.query_params.userId).toBeUndefined();
  });
});
