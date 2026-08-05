/**
 * MockAnalyticsService.getTraceDetail — userId / sessionId mapping.
 *
 * The mock service powers local dev (no CLICKHOUSE_HOST) and preview deploys,
 * so userId/sessionId must flow from MockTrace → TraceDetail exactly as they
 * do through the real ClickHouse pipeline. These tests pin that contract so
 * local dev reliably shows the TraceSummaryHeader user/session chips.
 */

import { MockAnalyticsService } from '../mock-service';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';

const mockCtx: TenantContext = {
  userId: 'user-mock',
  tenantId: 'tenant-mock',
  appId: 'app-mock' as VerifiedAppId,
  dataRetentionDays: -1,
};

describe('MockAnalyticsService.getTraceDetail — userId / sessionId', () => {
  let service: MockAnalyticsService;

  beforeEach(() => {
    service = new MockAnalyticsService();
  });

  it('surfaces userId when the trace has one, omits it for experiment traces', async () => {
    const { traces } = await service.getTraces(mockCtx, { limit: 200, offset: 0 });
    expect(traces.length).toBeGreaterThan(0);

    let foundWithUser = false;
    let foundWithoutUser = false;

    for (const summary of traces) {
      const detail = await service.getTraceDetail(mockCtx, summary.id);
      expect(detail).not.toBeNull();

      if (detail!.userId !== undefined) {
        foundWithUser = true;
        // Must be a non-empty string, never 'null' or 'undefined'
        expect(typeof detail!.userId).toBe('string');
        expect(detail!.userId!.length).toBeGreaterThan(0);
        expect(detail!.userId).not.toBe('undefined');
      } else {
        foundWithoutUser = true;
        // Explicitly absent — experiment traces have no user
        expect(detail!.userId).toBeUndefined();
      }

      if (foundWithUser && foundWithoutUser) break;
    }

    expect(foundWithUser).toBe(true);
    expect(foundWithoutUser).toBe(true);
  });

  it('surfaces sessionId exactly when the trace has one, omits it otherwise', async () => {
    const { traces } = await service.getTraces(mockCtx, { limit: 200, offset: 0 });
    expect(traces.length).toBeGreaterThan(0);

    let foundWithSession = false;
    let foundWithoutSession = false;

    for (const summary of traces) {
      const detail = await service.getTraceDetail(mockCtx, summary.id);
      expect(detail).not.toBeNull();

      if (detail!.sessionId !== undefined) {
        foundWithSession = true;
        // Must be a non-empty string, never the string 'null' or 'undefined'
        expect(typeof detail!.sessionId).toBe('string');
        expect(detail!.sessionId!.length).toBeGreaterThan(0);
        expect(detail!.sessionId).not.toBe('null');
        expect(detail!.sessionId).not.toBe('undefined');
      } else {
        foundWithoutSession = true;
        // Explicitly absent — not an empty string or null
        expect(detail!.sessionId).toBeUndefined();
      }

      if (foundWithSession && foundWithoutSession) break;
    }

    // The mock pool has ~83% traces with sessionId and ~17% without —
    // with 200 traces sampled both branches must be covered.
    expect(foundWithSession).toBe(true);
    expect(foundWithoutSession).toBe(true);
  });

  it('getTraceDetailLightweight returns the same userId/sessionId as getTraceDetail', async () => {
    const { traces } = await service.getTraces(mockCtx, { limit: 5, offset: 0 });
    expect(traces.length).toBeGreaterThan(0);

    for (const summary of traces) {
      const full = await service.getTraceDetail(mockCtx, summary.id);
      const lightweight = await service.getTraceDetailLightweight(mockCtx, summary.id);
      expect(full).not.toBeNull();
      expect(lightweight).not.toBeNull();
      expect(lightweight!.userId).toBe(full!.userId);
      expect(lightweight!.sessionId).toBe(full!.sessionId);
    }
  });
});
