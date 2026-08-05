'use client';

/**
 * useDoraMetrics Hook
 *
 * Fetches the DORA metrics summary for a given time range and optional app filter.
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';

import type { DoraMetricsResponse, DoraTimeRange } from '@/lib/dora-metrics/types';

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

const fetcher = (url: string): Promise<DoraMetricsResponse> =>
  apiFetch<DoraMetricsResponse>(url);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDoraMetrics(timeRange: DoraTimeRange, appId?: string | null) {
  const params = new URLSearchParams({ timeRange });

  if (appId) {
    params.set('appId', appId);
  }

  const key = `/api/platform-admin/dora-metrics?${params.toString()}`;

  const { data, error, isLoading, mutate } = useSWR<DoraMetricsResponse, Error>(
    key,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
      refreshInterval: (latestData) => {
        if (!latestData) return 0;
        const allEmpty = Object.values(latestData.metrics).every((m) => m.sampleSize === 0);
        return allEmpty ? 10_000 : 0;
      },
    }
  );

  const isEmpty = data
    ? Object.values(data.metrics).every((m) => m.sampleSize === 0)
    : false;

  return {
    data,
    error,
    isLoading,
    isEmpty,
    refresh: () => mutate(),
  };
}
