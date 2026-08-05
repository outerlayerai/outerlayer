'use client';

/**
 * useDoraRankings Hook
 *
 * Fetches per-app DORA metrics rankings with sortable columns.
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';

import type { DoraRankingsResponse, DoraTimeRange, DoraMetricType } from '@/lib/dora-metrics/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maps DoraMetricType (snake_case) to the camelCase field names
 * expected by the rankings validation schema.
 */
const SORT_BY_API_MAP: Record<DoraMetricType, string> = {
  deployment_frequency: 'deploymentFrequency',
  lead_time: 'leadTime',
  change_failure_rate: 'changeFailureRate',
  mttr: 'mttr',
};

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

const fetcher = (url: string): Promise<DoraRankingsResponse> =>
  apiFetch<DoraRankingsResponse>(url);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDoraRankings(
  timeRange: DoraTimeRange,
  sortBy: DoraMetricType = 'deployment_frequency',
  sortOrder: 'asc' | 'desc' = 'desc',
) {
  const apiSortBy = SORT_BY_API_MAP[sortBy];
  const params = new URLSearchParams({ timeRange, sortBy: apiSortBy, sortOrder });

  const key = `/api/platform-admin/dora-metrics/rankings?${params.toString()}`;

  const { data, error, isLoading, mutate } = useSWR<DoraRankingsResponse, Error>(
    key,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  return {
    data,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}
