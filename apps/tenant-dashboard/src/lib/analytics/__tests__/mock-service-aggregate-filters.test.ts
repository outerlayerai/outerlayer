/**
 * Mock Service Aggregate Filter Tests
 *
 * Tests that getAggregateRequests respects filters — filters should
 * reduce the span pool before aggregation, not after.
 */

import { MockAnalyticsService } from '../mock-service';
import type { TenantContext, VerifiedAppId, AnalyticsFilter } from '@repo/observability-service';

// Use a wide date range to capture all mock data
const mockCtx: TenantContext = {
  userId: 'user-mock',
  tenantId: 'tenant-mock',
  appId: 'mock-app' as VerifiedAppId,
  dataRetentionDays: -1,
};
const wideRange = {
  startDate: '2020-01-01',
  endDate: '2030-12-31',
};

describe('getAggregateRequests - filter support', () => {
  let service: MockAnalyticsService;

  beforeEach(() => {
    service = new MockAnalyticsService();
  });

  it('should return only matching model when filtered by model equals', async () => {
    const filters: AnalyticsFilter[] = [
      { field: 'model', operator: 'equals', value: 'gpt-4o' },
    ];
    const result = await service.getAggregateRequests(mockCtx, {
      dimension: 'model',
      ...wideRange,
      offset: 0,
      limit: 100,
      filters,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.dimensionValue).toBe('gpt-4o');
    }
  });

  it('should aggregate only the filtered user when filtered by user_id', async () => {
    const filters: AnalyticsFilter[] = [
      { field: 'user_id', operator: 'equals', value: 'user-alice' },
    ];
    const result = await service.getAggregateRequests(mockCtx, {
      dimension: 'user_id',
      ...wideRange,
      offset: 0,
      limit: 100,
      filters,
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]!.dimensionValue).toBe('user-alice');
  });

  it('should reduce total requests when status filter excludes some spans', async () => {
    const unfilteredResult = await service.getAggregateRequests(mockCtx, {
      dimension: 'model',
      ...wideRange,
      offset: 0,
      limit: 100,
    });
    const unfilteredTotal = unfilteredResult.items.reduce((s, i) => s + i.requests, 0);

    const filteredResult = await service.getAggregateRequests(mockCtx, {
      dimension: 'model',
      ...wideRange,
      offset: 0,
      limit: 100,
      filters: [{ field: 'status', operator: 'equals', value: 'OK' }],
    });
    const filteredTotal = filteredResult.items.reduce((s, i) => s + i.requests, 0);

    expect(filteredTotal).toBeLessThan(unfilteredTotal);
  });

  it('should return empty items when no spans match the filter', async () => {
    const filters: AnalyticsFilter[] = [
      { field: 'model', operator: 'equals', value: 'nonexistent-model-xyz' },
    ];
    const result = await service.getAggregateRequests(mockCtx, {
      dimension: 'model',
      ...wideRange,
      offset: 0,
      limit: 100,
      filters,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('should return all items when no filters are provided', async () => {
    const result = await service.getAggregateRequests(mockCtx, {
      dimension: 'model',
      ...wideRange,
      offset: 0,
      limit: 100,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.total).toBe(result.items.length);
  });
});
