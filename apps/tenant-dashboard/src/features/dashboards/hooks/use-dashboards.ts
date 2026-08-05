/**
 * useDashboards Hook
 *
 * Presents the dashboard list seeded by a React Server Component (RSC) for
 * one app and provides CRUD
 * operations (create/delete/rename/duplicate/set-default) via the
 * `authorizedAction` server actions in `features/dashboards/actions.ts`.
 * There is no GET route behind this list — the list is loaded server-side
 * (`features/dashboards/read.ts`) and handed in as `initialDashboards`;
 * every write updates the SWR cache directly via the global
 * `mutate(key, next, { revalidate: false })` rather than refetching. Using
 * the global mutate (keyed, not the per-render binding) also keeps every
 * mounted consumer of this key — the list page and the dashboard-detail
 * selector — in sync from a single write.
 *
 * `setDefault` is the one cross-entity write: the server clears every other
 * dashboard's default flag when it sets the new one, so the local update
 * reproduces that — not just the target row.
 *
 * A failed action throws a plain `Error` carrying the server's message (the
 * `authorizedAction` wrapper's structured `{code, message}` collapses to
 * `.message` here — there is no route-side remapConflict/remapLimit
 * distinction to preserve on this side of the migration). Callers that only
 * need a message for a toast already do `err instanceof Error ? err.message
 * : ...`, unchanged.
 */

import useSWR, { mutate as globalMutate } from 'swr';

import {
  createDashboard as createDashboardAction,
  deleteDashboard as deleteDashboardAction,
  renameDashboard as renameDashboardAction,
  duplicateDashboard as duplicateDashboardAction,
  setDefaultDashboard as setDefaultDashboardAction,
} from '../actions';
import type { Dashboard, DashboardSummary } from '../types';

interface UseDashboardsOptions {
  appId: string;
  initialDashboards: DashboardSummary[];
}

type DashboardsKey = readonly ['/api/dashboards', string];

function toSummary(dashboard: Dashboard): DashboardSummary {
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    isDefault: dashboard.isDefault,
    widgetCount: dashboard.widgets.length,
    globalTimeRange: dashboard.globalTimeRange,
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
  };
}

export function useDashboards({ appId, initialDashboards }: UseDashboardsOptions) {
  const key: DashboardsKey = ['/api/dashboards', appId];

  // live: no — the fetcher is `null` and every revalidation flag below is
  // off, so this call never fetches. The list arrives seeded from the RSC;
  // every update below is a direct, local cache write instead.
  const { data } = useSWR<DashboardSummary[]>(key, null, {
    fallbackData: initialDashboards,
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const dashboards = data ?? initialDashboards;

  const setCache = (next: DashboardSummary[]) => globalMutate(key, next, { revalidate: false });

  const createDashboard = async (body: { name: string; description?: string; templateId?: string }) => {
    const result = await createDashboardAction({ appId, ...body });
    if (!result.ok) throw new Error(result.error.message);
    await setCache([...dashboards, toSummary(result.data)]);
    return result.data;
  };

  const deleteDashboard = async (dashboardId: string) => {
    const result = await deleteDashboardAction({ appId, dashboardId });
    if (!result.ok) throw new Error(result.error.message);
    await setCache(dashboards.filter((d) => d.id !== dashboardId));
  };

  const renameDashboard = async (dashboardId: string, name: string) => {
    const result = await renameDashboardAction({ appId, dashboardId, name });
    if (!result.ok) throw new Error(result.error.message);
    const summary = toSummary(result.data);
    await setCache(dashboards.map((d) => (d.id === dashboardId ? summary : d)));
  };

  const duplicateDashboard = async (dashboardId: string) => {
    const result = await duplicateDashboardAction({ appId, dashboardId });
    if (!result.ok) throw new Error(result.error.message);
    await setCache([...dashboards, toSummary(result.data)]);
    return result.data;
  };

  // Cross-entity write: the server clears every other row's `is_default`
  // when it sets this one — the local cache has to clear them too, not just
  // flag the target, or the list would show two "defaults" until reload.
  const setDefault = async (dashboardId: string) => {
    const result = await setDefaultDashboardAction({ appId, dashboardId });
    if (!result.ok) throw new Error(result.error.message);
    await setCache(dashboards.map((d) => ({ ...d, isDefault: d.id === dashboardId })));
  };

  return {
    dashboards,
    createDashboard,
    deleteDashboard,
    renameDashboard,
    duplicateDashboard,
    setDefault,
  };
}
