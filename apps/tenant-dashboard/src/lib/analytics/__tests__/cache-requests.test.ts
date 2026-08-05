/**
 * getCachedRequests Tests
 *
 * The cache wrapper around `AnalyticsService.getRequests`. With
 * `unstable_cache` stubbed to a passthrough, this exercises the wrapped
 * function: filters-JSON parsing for cache-key stability, the params
 * assembly, and the delegation to `AnalyticsService.getRequests`.
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
}));

const mockGetRequests = vi.fn();
vi.mock('../service', () => ({
  getAnalyticsService: () => ({ getRequests: mockGetRequests }),
}));

import { getCachedRequests } from '../cache';
import type { TenantContext } from '../tenant-context';

const ctx = {
  userId: 'u1',
  tenantId: 't1',
  appId: 'app-1',
  dataRetentionDays: -1,
} as unknown as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequests.mockResolvedValue({ requests: [], total: 0, limit: 50, offset: 0 });
});

describe('getCachedRequests', () => {
  it('delegates to AnalyticsService.getRequests with assembled params', async () => {
    const result = await getCachedRequests(ctx, 50, 0, undefined, undefined, undefined);
    expect(result).toEqual({ requests: [], total: 0, limit: 50, offset: 0 });
    expect(mockGetRequests).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ limit: 50, offset: 0, startDate: undefined, endDate: undefined, filters: undefined }),
    );
  });

  it('passes the date range through', async () => {
    await getCachedRequests(ctx, 25, 10, '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.000Z', undefined);
    expect(mockGetRequests).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        limit: 25,
        offset: 10,
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T23:59:59.000Z',
      }),
    );
  });

  it('parses the serialized filters JSON back into an array', async () => {
    const filtersJson = JSON.stringify([{ field: 'model', operator: 'equals', value: 'gpt-4o' }]);
    await getCachedRequests(ctx, 50, 0, undefined, undefined, filtersJson);
    expect(mockGetRequests).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        filters: [{ field: 'model', operator: 'equals', value: 'gpt-4o' }],
      }),
    );
  });

  it('returns the service result unchanged', async () => {
    const rows = { requests: [{ id: 's1', modelUsed: 'gpt-4o' }], total: 1, limit: 50, offset: 0 };
    mockGetRequests.mockResolvedValue(rows);
    await expect(getCachedRequests(ctx, 50, 0, undefined, undefined, undefined)).resolves.toEqual(rows);
  });
});
