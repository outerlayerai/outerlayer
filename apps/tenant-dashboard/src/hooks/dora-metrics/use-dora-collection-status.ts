'use client';

/**
 * useDoraCollectionStatus Hook
 *
 * Fetches platform_dora_collection_state rows so the dashboard can surface
 * pipeline staleness/failures instead of silently showing "No Data Yet".
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';

import type { CollectionStatusResponse } from '@/lib/dora-metrics/types';

const fetcher = (url: string): Promise<CollectionStatusResponse> =>
  apiFetch<CollectionStatusResponse>(url);

export function useDoraCollectionStatus() {
  const { data, error, isLoading } = useSWR<CollectionStatusResponse, Error>(
    '/api/platform-admin/dora-metrics/collection-status',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
    },
  );

  return {
    sources: data?.sources ?? [],
    error,
    isLoading,
  };
}
