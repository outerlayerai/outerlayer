/**
 * AnalyticsService: VerifiedAppId Parameterization Test
 *
 * Verifies that the verified appId flows into ClickHouse via a parameterized
 * binding (`{appId:String}`), not via string interpolation. This is the
 * security contract that prevents SQL injection through the appId surface.
 *
 * Behavior checks live in service-experiments / service-datasets / service-metrics
 * / service-sessions / service-traces-* tests, and TypeScript's compile-time
 * checks enforce the VerifiedAppId brand at the type level (the runtime
 * `as VerifiedAppId` cast in those tests is the standard pattern).
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as unknown as { query: typeof mockQuery };

describe('AnalyticsService VerifiedAppId enforcement', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('uses the verified appId via a parameterized binding, never via string interpolation', async () => {
    const verifiedAppId = 'verified-app-id-xyz' as VerifiedAppId;
    const testCtx: TenantContext = {
      userId: 'test-user',
      tenantId: 'tenant-123',
      appId: verifiedAppId,
      dataRetentionDays: -1,
    };
    const dateRange = { start: '2024-01-01', end: '2024-01-07' };

    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        {
          total_requests: '0',
          success_count: '0',
          error_count: '0',
          total_cost: '0',
          total_tokens: '0',
          input_tokens: '0',
          output_tokens: '0',
          avg_latency_ms: '0',
          unique_users: '0',
        },
      ]),
    });

    await service.getMetrics(testCtx, dateRange);

    // SQL must reference the appId via a parameterized placeholder
    // (`{appId:String}`) — NOT via string interpolation of the literal
    // value. If a refactor concatenated the appId into the SQL string,
    // the query would no longer contain the placeholder and the query
    // text would contain the raw appId.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('AppId = {appId:String}'),
        query_params: expect.objectContaining({ appId: 'verified-app-id-xyz' }),
      }),
    );

    // Negative assertion: the raw appId value must NOT appear interpolated
    // into the SQL (it should only ever be in query_params).
    const sqlCall = mockQuery.mock.calls[0]![0] as { query: string };
    expect(sqlCall.query).not.toContain("'verified-app-id-xyz'");
    expect(sqlCall.query).not.toContain('"verified-app-id-xyz"');
  });
});
