// @vitest-environment jsdom
/**
 * Tests: DORA metrics hooks (useDoraMetrics, useDoraApps, useDoraRankings, useDoraTrends)
 *
 * Tests the URL construction and fetch behavior for each hook.
 * SWR caching/revalidation is tested by SWR itself.
 */

import { http, HttpResponse } from 'msw';
import { server } from '@/test-helpers/msw-server';

// Mock SWR to capture the key and fetcher synchronously for simpler testing.
// The mock data factory allows individual tests to override returned data.
let swrKey: string | null = null;
let swrCallback: ((url: string) => Promise<any>) | null = null;
let swrMutate = vi.fn();
let swrMockData: any = undefined;

vi.mock('swr', () => ({
  default: (key: string | null, fetcher: any, _options: any) => {
    swrKey = key;
    swrCallback = fetcher;
    return {
      data: swrMockData,
      error: undefined,
      isLoading: key !== null,
      mutate: swrMutate,
    };
  },
}));

import { renderHook } from '@testing-library/react';
import { useDoraMetrics } from '../use-dora-metrics';
import { useDoraApps } from '../use-dora-apps';
import { useDoraRankings } from '../use-dora-rankings';
import { useDoraTrends } from '../use-dora-trends';

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  swrKey = null;
  swrCallback = null;
  swrMutate = vi.fn();
  swrMockData = undefined;
});

// ---------------------------------------------------------------------------
// useDoraMetrics
// ---------------------------------------------------------------------------

describe('useDoraMetrics', () => {
  it('should construct URL with timeRange only when appId is not provided', () => {
    renderHook(() => useDoraMetrics('30d'));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics?timeRange=30d');
  });

  it('should include appId in URL when appId is provided', () => {
    renderHook(() => useDoraMetrics('7d', 'myapp'));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics?timeRange=7d&appId=myapp');
  });

  it('should not include appId in URL when appId is null', () => {
    renderHook(() => useDoraMetrics('30d', null));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics?timeRange=30d');
  });

  it('should not include appId in URL when appId is undefined', () => {
    renderHook(() => useDoraMetrics('30d', undefined));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics?timeRange=30d');
  });

  it('should throw error with server message when fetcher receives non-ok response', async () => {
    server.use(
      http.get('/api/platform-admin/dora-metrics', () => {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }),
    );

    renderHook(() => useDoraMetrics('30d'));

    await expect(
      swrCallback!('/api/platform-admin/dora-metrics?timeRange=30d')
    ).rejects.toThrow('Unauthorized');
  });

  it('should return parsed JSON when fetcher receives ok response', async () => {
    const mockData = { metrics: {}, period: {}, comparisonPeriod: {} };
    server.use(
      http.get('/api/platform-admin/dora-metrics', () => {
        return HttpResponse.json(mockData);
      }),
    );

    renderHook(() => useDoraMetrics('30d'));
    const result = await swrCallback!('/api/platform-admin/dora-metrics?timeRange=30d');

    expect(result).toEqual(mockData);
  });

  it('should return refresh function that calls mutate', () => {
    const { result } = renderHook(() => useDoraMetrics('30d'));

    result.current.refresh();

    expect(swrMutate).toHaveBeenCalledTimes(1);
  });

  it('should return isEmpty=false when data is undefined', () => {
    swrMockData = undefined;

    const { result } = renderHook(() => useDoraMetrics('30d'));

    expect(result.current.isEmpty).toBe(false);
  });

  it('should return isEmpty=true when all metrics have sampleSize of 0', () => {
    const zeroMetric = {
      value: 0,
      unit: '',
      performanceLevel: 'low',
      trend: { direction: 'stable', changePercent: 0 },
      sampleSize: 0,
    };
    swrMockData = {
      metrics: {
        deploymentFrequency: zeroMetric,
        leadTime: zeroMetric,
        changeFailureRate: zeroMetric,
        mttr: zeroMetric,
      },
      period: {},
      comparisonPeriod: {},
    };

    const { result } = renderHook(() => useDoraMetrics('30d'));

    expect(result.current.isEmpty).toBe(true);
  });

  it('should return isEmpty=false when any metric has sampleSize > 0', () => {
    const nonEmptyMetric = {
      value: 5,
      unit: 'deploys/day',
      performanceLevel: 'high',
      trend: { direction: 'up', changePercent: 10 },
      sampleSize: 5,
    };
    const zeroMetric = { ...nonEmptyMetric, sampleSize: 0 };
    swrMockData = {
      metrics: {
        deploymentFrequency: nonEmptyMetric,
        leadTime: zeroMetric,
        changeFailureRate: zeroMetric,
        mttr: zeroMetric,
      },
      period: {},
      comparisonPeriod: {},
    };

    const { result } = renderHook(() => useDoraMetrics('30d'));

    expect(result.current.isEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useDoraApps
// ---------------------------------------------------------------------------

describe('useDoraApps', () => {
  it('should always use the apps endpoint URL', () => {
    renderHook(() => useDoraApps());

    expect(swrKey).toBe('/api/platform-admin/dora-metrics/apps');
  });

  it('should return empty apps array when data is undefined', () => {
    swrMockData = undefined;

    const { result } = renderHook(() => useDoraApps());

    expect(result.current.apps).toEqual([]);
  });

  it('should return apps from data when data is available', () => {
    swrMockData = { apps: [{ id: 'app-1', name: 'Service A' }] };

    const { result } = renderHook(() => useDoraApps());

    expect(result.current.apps).toEqual([{ id: 'app-1', name: 'Service A' }]);
  });

  it('should throw error with server message when fetcher receives non-ok response', async () => {
    server.use(
      http.get('/api/platform-admin/dora-metrics/apps', () => {
        return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
      }),
    );

    renderHook(() => useDoraApps());

    await expect(
      swrCallback!('/api/platform-admin/dora-metrics/apps')
    ).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// useDoraRankings
// ---------------------------------------------------------------------------

describe('useDoraRankings', () => {
  it('should map deployment_frequency to deploymentFrequency in sortBy URL param', () => {
    renderHook(() => useDoraRankings('30d', 'deployment_frequency', 'desc'));

    expect(swrKey).toContain('sortBy=deploymentFrequency');
  });

  it('should map lead_time to leadTime in sortBy URL param', () => {
    renderHook(() => useDoraRankings('30d', 'lead_time', 'asc'));

    expect(swrKey).toContain('sortBy=leadTime');
  });

  it('should map change_failure_rate to changeFailureRate in sortBy URL param', () => {
    renderHook(() => useDoraRankings('30d', 'change_failure_rate', 'desc'));

    expect(swrKey).toContain('sortBy=changeFailureRate');
  });

  it('should map mttr to mttr in sortBy URL param', () => {
    renderHook(() => useDoraRankings('30d', 'mttr', 'desc'));

    expect(swrKey).toContain('sortBy=mttr');
  });

  it('should default to deployment_frequency sortBy when not specified', () => {
    renderHook(() => useDoraRankings('30d'));

    expect(swrKey).toContain('sortBy=deploymentFrequency');
  });

  it('should default to desc sortOrder when not specified', () => {
    renderHook(() => useDoraRankings('30d'));

    expect(swrKey).toContain('sortOrder=desc');
  });

  it('should include sortOrder in URL when specified as asc', () => {
    renderHook(() => useDoraRankings('30d', 'lead_time', 'asc'));

    expect(swrKey).toContain('sortOrder=asc');
  });

  it('should include timeRange in URL', () => {
    renderHook(() => useDoraRankings('7d'));

    expect(swrKey).toContain('timeRange=7d');
  });

  it('should throw error with server message when fetcher receives non-ok response', async () => {
    server.use(
      http.get('/api/platform-admin/dora-metrics/rankings', () => {
        return HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }),
    );

    renderHook(() => useDoraRankings('30d'));

    await expect(
      swrCallback!('/api/platform-admin/dora-metrics/rankings?timeRange=30d&sortBy=deploymentFrequency&sortOrder=desc')
    ).rejects.toThrow('Internal Server Error');
  });

  it('should return refresh function that calls mutate', () => {
    const { result } = renderHook(() => useDoraRankings('30d'));

    result.current.refresh();

    expect(swrMutate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useDoraTrends
// ---------------------------------------------------------------------------

describe('useDoraTrends', () => {
  it('should construct URL with timeRange only when appId is not provided', () => {
    renderHook(() => useDoraTrends('30d'));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics/trends?timeRange=30d');
  });

  it('should include appId in URL when appId is provided', () => {
    renderHook(() => useDoraTrends('7d', 'service-abc'));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics/trends?timeRange=7d&appId=service-abc');
  });

  it('should not include appId in URL when appId is null', () => {
    renderHook(() => useDoraTrends('90d', null));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics/trends?timeRange=90d');
  });

  it('should not include appId in URL when appId is undefined', () => {
    renderHook(() => useDoraTrends('30d', undefined));

    expect(swrKey).toBe('/api/platform-admin/dora-metrics/trends?timeRange=30d');
  });

  it('should throw error with server message when fetcher receives non-ok response', async () => {
    server.use(
      http.get('/api/platform-admin/dora-metrics/trends', () => {
        return HttpResponse.json({ error: 'Not found' }, { status: 404 });
      }),
    );

    renderHook(() => useDoraTrends('30d'));

    await expect(
      swrCallback!('/api/platform-admin/dora-metrics/trends?timeRange=30d')
    ).rejects.toThrow('Not found');
  });

  it('should return parsed JSON when fetcher receives ok response', async () => {
    const mockData = { trends: {}, period: {}, granularity: 'day' };
    server.use(
      http.get('/api/platform-admin/dora-metrics/trends', () => {
        return HttpResponse.json(mockData);
      }),
    );

    renderHook(() => useDoraTrends('30d'));
    const result = await swrCallback!('/api/platform-admin/dora-metrics/trends?timeRange=30d');

    expect(result).toEqual(mockData);
  });
});
