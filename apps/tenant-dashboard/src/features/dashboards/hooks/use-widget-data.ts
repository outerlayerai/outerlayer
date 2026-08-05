/**
 * useWidgetData Hook
 *
 * Fetches data for a single widget based on its config and time range.
 *
 * // live: widget metrics advance server-side as new spans land; the
 * dashboard polls this endpoint (60s + focus revalidation) rather than
 * reading it from a React Server Component (RSC).
 */

import useSWR from 'swr';
import { apiFetch } from '@/hooks/shared/api-error';
import type { WidgetDataResponse } from '../types';

interface WidgetConfig {
  metric: string;
  visualization: string;
  filters: unknown[];
  groupBy?: string | null;
  timeGranularity?: string;
  scoreName?: string;
  scoreNameB?: string;
  /**
   * Resolved env scope. The dashboard view
   * resolves each widget's env (inherit ⇒ dashboard env, override ⇒ widget
   * list) before passing it here. Empty / absent ⇒ no env filter.
   */
  environments?: string[];
  /** True when the single resolved env is the app's default env. */
  environmentIsDefault?: boolean;
  /**
   * Fleet/PR query scope: 'app' (default — the app's dominant repo) or 'org'
   * (tenant-wide rollup — the dashboard header's Organization toggle). Only
   * affects agent-fleet and PR-lifecycle metrics; the base LLM metrics are
   * app-scoped by construction.
   */
  scope?: 'app' | 'org';
}

interface TimeRange {
  preset?: string;
  start?: string;
  end?: string;
}

const fetcher = (
  _key: string,
  orgName: string,
  appId: string,
  config: WidgetConfig,
  timeRange: TimeRange,
): Promise<WidgetDataResponse> =>
  apiFetch<WidgetDataResponse>(
    `/api/orgs/${encodeURIComponent(orgName)}/apps/${encodeURIComponent(appId)}/analytics/widget-data?appId=${encodeURIComponent(appId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, timeRange }),
    },
  );

interface UseWidgetDataOptions {
  enabled?: boolean;
}

export function useWidgetData(
  orgName: string | undefined,
  appId: string | undefined,
  config: WidgetConfig,
  timeRange: TimeRange,
  options: UseWidgetDataOptions = {}
) {
  const { enabled = true } = options;

  // `scoreName` / `scoreNameB` are part of the POST body and must be part of
  // the key too: omitting them would collide two score widgets on one
  // dashboard that differ only by score name onto the same SWR entry,
  // rendering each other's data — and an in-place score-name edit would keep
  // serving the stale response.
  const key = enabled && config.metric && orgName && appId
    ? `widget-data:${orgName}:${appId}:${config.metric}:${config.visualization}:${JSON.stringify(config.filters)}:${config.groupBy ?? ''}:${config.timeGranularity ?? ''}:${config.scoreName ?? ''}:${config.scoreNameB ?? ''}:${JSON.stringify(config.environments ?? [])}:${config.environmentIsDefault ? '1' : '0'}:${config.scope ?? 'app'}:${JSON.stringify(timeRange)}`
    : null;

  // live: widget metrics advance server-side as new spans land; the
  // dashboard polls this endpoint (60s + focus revalidation) rather than
  // reading it from an RSC.
  const { data, error, isLoading, isValidating, mutate } = useSWR<WidgetDataResponse, Error>(
    key,
    () => fetcher(key!, orgName!, appId!, config, timeRange),
    {
      revalidateOnFocus: true,
      // A tab flip shouldn't re-fire every widget's query — at most one
      // focus-triggered revalidation per widget per minute.
      focusThrottleInterval: 60_000,
      dedupingInterval: 5000,
      // Dashboards don't need 10s freshness: N widgets each polling 6×/min
      // was constant analytics-store load — and N chances per minute to hit
      // a transient failure. The renderer keeps the last good data when a
      // background refresh fails, so a slower cadence costs nothing visible.
      refreshInterval: 60_000,
    }
  );

  return {
    data,
    error,
    isLoading,
    isValidating,
    refresh: () => mutate(),
  };
}
