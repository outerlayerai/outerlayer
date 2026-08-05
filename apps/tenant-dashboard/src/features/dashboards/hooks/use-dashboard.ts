/**
 * useDashboard Hook
 *
 * Presents the single dashboard (with its widgets) seeded by a React Server
 * Component (RSC) for the detail view. No GET route backs it — the detail is
 * loaded server-side (`features/dashboards/read.ts`) and handed in as
 * `initialDashboard`; the returned `mutate` lets the provider apply local,
 * optimistic updates (add/remove/update widget) via
 * `mutate(next, { revalidate: false })`, since there is nothing to refetch
 * from.
 */

import useSWR from 'swr';
import type { Dashboard } from '../types';

interface UseDashboardOptions {
  appId: string;
  dashboardId: string;
  initialDashboard: Dashboard | null;
}

export function useDashboard({ appId, dashboardId, initialDashboard }: UseDashboardOptions) {
  const key = ['dashboard', appId, dashboardId] as const;

  // live: no — the fetcher is `null` and every revalidation flag below is
  // off, so this call never fetches. The dashboard arrives seeded from the
  // RSC; `mutate` below is the only way this cache entry changes.
  const { data, mutate } = useSWR<Dashboard | null>(key, null, {
    fallbackData: initialDashboard,
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  // No `error`: this hook never fetches, so it has no failure of its own to
  // report. A detail read can only fail server-side, and that failure reaches
  // the view as a prop from the page.
  return {
    dashboard: data ?? null,
    mutate,
  };
}
