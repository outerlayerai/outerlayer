'use client';

/**
 * useDoraTrends Hook
 *
 * Fetches DORA trend time-series data for a given time range and optional
 * app filter. Uses SWR for caching and deduplication.
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';

import type { DoraTrendsResponse, DoraTimeRange } from '@/lib/dora-metrics/types';

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

const fetcher = (url: string): Promise<DoraTrendsResponse> =>
  apiFetch<DoraTrendsResponse>(url);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDoraTrends(timeRange: DoraTimeRange, appId?: string | null) {
  const params = new URLSearchParams({ timeRange });

  if (appId) {
    params.set('appId', appId);
  }

  const key = `/api/platform-admin/dora-metrics/trends?${params.toString()}`;

  const { data, error, isLoading } = useSWR<DoraTrendsResponse, Error>(
    key,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  return { data, error, isLoading };
}
