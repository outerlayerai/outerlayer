'use client';

/**
 * useDoraApps Hook
 * Powers the app filter on the DORA metrics dashboard.
 *
 * Fetches a list of apps that have deployment data, for use in the
 * app filter dropdown on the DORA metrics dashboard.
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';

export interface DoraApp {
  id: string;
  name: string;
}

interface DoraAppsResponse {
  apps: DoraApp[];
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

const fetcher = (url: string): Promise<DoraAppsResponse> =>
  apiFetch<DoraAppsResponse>(url);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDoraApps() {
  const { data, error, isLoading } = useSWR<DoraAppsResponse, Error>(
    '/api/platform-admin/dora-metrics/apps',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
    }
  );

  return {
    apps: data?.apps ?? [],
    error,
    isLoading,
  };
}
