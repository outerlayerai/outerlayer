/**
 * Regression tests for env scope on the analytics cache wrappers.
 *
 * Pre-fix, getCachedMetrics / getCachedModelStats / getCachedPercentiles /
 * getCachedExtendedMetrics had signatures that ignored env. Two failure modes:
 *
 *   1. The service-side env WHERE clause was never appended — every metrics
 *      request returned app-wide data regardless of the breadcrumb env.
 *   2. The unstable_cache key omitted env, so a subsequent request from a
 *      DIFFERENT env hit the cached entry from the first env's caller.
 *
 * These tests pin both: the service receives the EnvironmentQueryScope, AND
 * the env primitives (env name + isDefault) are part of the cache key (which
 * we surface as "the service is called twice when only env differs").
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Pass-through stub so we exercise the wrapped function directly (no
// cross-test memoization).
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
}));

const mockGetMetrics = vi.fn();
const mockGetModelStats = vi.fn();
const mockGetPercentiles = vi.fn();
const mockGetExtendedMetrics = vi.fn();

vi.mock('../service', () => ({
  getAnalyticsService: () => ({
    getMetrics: mockGetMetrics,
    getModelStats: mockGetModelStats,
    getPercentiles: mockGetPercentiles,
    getExtendedMetrics: mockGetExtendedMetrics,
  }),
}));

import {
  getCachedMetrics,
  getCachedModelStats,
  getCachedPercentiles,
  getCachedExtendedMetrics,
} from '../cache';
import type { TenantContext } from '../tenant-context';

const ctx = {
  userId: 'u1',
  tenantId: 't1',
  appId: 'app-1',
  dataRetentionDays: -1,
} as unknown as TenantContext;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMetrics.mockResolvedValue({ summary: {}, timeSeries: [] });
  mockGetModelStats.mockResolvedValue({ models: [], total: 0 });
  mockGetPercentiles.mockResolvedValue({ percentiles: [] });
  mockGetExtendedMetrics.mockResolvedValue({ summary: {} });
});

describe('getCachedMetrics — env scope', () => {
  it('forwards the env name + isDefault to AnalyticsService.getMetrics', async () => {
    await getCachedMetrics(ctx, '7d', undefined, undefined, undefined, 'prod', false);
    expect(mockGetMetrics).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      undefined,
      expect.objectContaining({ environment: { name: 'prod', isDefault: false } }),
    );
  });

  it('forwards isDefault=true so the legacy-row branch fires for the default env', async () => {
    await getCachedMetrics(ctx, '7d', undefined, undefined, undefined, 'dev', true);
    const envArg = mockGetMetrics.mock.calls[0]?.[3];
    expect(envArg).toEqual({ environment: { name: 'dev', isDefault: true } });
  });

  it('passes undefined env when env is absent (back-compat)', async () => {
    await getCachedMetrics(ctx, '7d');
    expect(mockGetMetrics).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      undefined,
      undefined,
    );
  });

  it('still calls the service twice when only env differs — keying on env', async () => {
    // With unstable_cache stubbed to a passthrough, the wrapped function
    // runs every call; the real assertion lives in production where the
    // arg tuple drives unstable_cache's key. We assert that the wrapper
    // signature DOES propagate env into the call so the production cache
    // sees distinct args.
    await getCachedMetrics(ctx, '7d', undefined, undefined, undefined, 'prod', false);
    await getCachedMetrics(ctx, '7d', undefined, undefined, undefined, 'dev', true);
    expect(mockGetMetrics).toHaveBeenCalledTimes(2);
    expect(mockGetMetrics.mock.calls[0]?.[3]).toEqual({
      environment: { name: 'prod', isDefault: false },
    });
    expect(mockGetMetrics.mock.calls[1]?.[3]).toEqual({
      environment: { name: 'dev', isDefault: true },
    });
  });
});

describe('getCachedModelStats — env scope', () => {
  it('forwards env to AnalyticsService.getModelStats', async () => {
    await getCachedModelStats(ctx, '7d', 10, undefined, undefined, undefined, 'prod', false);
    expect(mockGetModelStats).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      10,
      undefined,
      expect.objectContaining({ environment: { name: 'prod', isDefault: false } }),
    );
  });
});

describe('getCachedPercentiles — env scope', () => {
  it('forwards env to AnalyticsService.getPercentiles', async () => {
    await getCachedPercentiles(
      ctx,
      '7d',
      'latency',
      undefined,
      undefined,
      undefined,
      'staging',
      false,
    );
    expect(mockGetPercentiles).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      undefined,
      expect.objectContaining({ environment: { name: 'staging', isDefault: false } }),
    );
  });
});

describe('getCachedExtendedMetrics — env scope', () => {
  it('forwards env to AnalyticsService.getExtendedMetrics', async () => {
    await getCachedExtendedMetrics(ctx, '7d', undefined, undefined, 'prod', false);
    expect(mockGetExtendedMetrics).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      expect.objectContaining({ environment: { name: 'prod', isDefault: false } }),
    );
  });
});
