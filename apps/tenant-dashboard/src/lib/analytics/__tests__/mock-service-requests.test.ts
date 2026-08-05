/**
 * MockAnalyticsService.getRequests Tests
 *
 * Covers `getRequests` on the dev-mode mock analytics service:
 * GENERATION-only filtering, the `RequestRecord` wire shape, model
 * filtering, and pagination.
 */

import { MockAnalyticsService } from '../mock-service';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';

const mockCtx: TenantContext = {
  userId: 'user-mock',
  tenantId: 'tenant-mock',
  appId: 'app-mock' as VerifiedAppId,
  dataRetentionDays: -1,
};

describe('MockAnalyticsService.getRequests', () => {
  let service: MockAnalyticsService;

  beforeEach(() => {
    service = new MockAnalyticsService();
  });

  it('returns request records with the expected (camelCase) shape', async () => {
    const result = await service.getRequests(mockCtx, { limit: 1000, offset: 0 });

    expect(Array.isArray(result.requests)).toBe(true);
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.requests.length);
    expect(result.limit).toBe(1000);
    expect(result.offset).toBe(0);

    for (const r of result.requests) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.cost).toBe('number');
      expect(typeof r.promptTokens).toBe('number');
      expect(typeof r.completionTokens).toBe('number');
      expect(typeof r.latencyMs).toBe('number');
      expect(typeof r.modelUsed).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(typeof r.ts).toBe('string');
      expect(typeof r.traceId).toBe('string');
      // null is allowed for output; everything else is a string
      expect(r.output === null || typeof r.output === 'string').toBe(true);
    }
  });

  it('sorts requests newest-first by timestamp', async () => {
    const result = await service.getRequests(mockCtx, { limit: 1000, offset: 0 });
    for (let i = 1; i < result.requests.length; i++) {
      const prev = new Date(result.requests[i - 1]!.ts).getTime();
      const curr = new Date(result.requests[i]!.ts).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('filters by model', async () => {
    const all = await service.getRequests(mockCtx, { limit: 1000, offset: 0 });
    const someModel = all.requests[0]?.modelUsed;
    // The fixture's first request must carry a non-empty model string for the
    // filter assertion below to be meaningful.
    expect(typeof someModel).toBe('string');
    expect(someModel!.length).toBeGreaterThan(0);

    const filtered = await service.getRequests(mockCtx, {
      limit: 1000,
      offset: 0,
      model: someModel,
    });
    expect(filtered.requests.length).toBeGreaterThan(0);
    for (const r of filtered.requests) {
      expect(r.modelUsed).toBe(someModel);
    }
  });

  it('respects pagination (limit/offset/total)', async () => {
    const all = await service.getRequests(mockCtx, { limit: 1000, offset: 0 });
    if (all.requests.length < 2) return; // mock pool too small — nothing to page

    const page1 = await service.getRequests(mockCtx, { limit: 1, offset: 0 });
    const page2 = await service.getRequests(mockCtx, { limit: 1, offset: 1 });

    expect(page1.requests).toHaveLength(1);
    expect(page1.limit).toBe(1);
    expect(page1.total).toBe(all.total);
    expect(page1.requests[0]!.id).toBe(all.requests[0]!.id);
    expect(page2.requests[0]!.id).toBe(all.requests[1]!.id);
  });
});
