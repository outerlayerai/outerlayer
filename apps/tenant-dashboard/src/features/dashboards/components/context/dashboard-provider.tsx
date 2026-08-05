'use client';

/**
 * Dashboard Provider
 *
 * Manages dashboard state (current dashboard, time range) and provides it
 * to child components via DashboardContext. The dashboard itself is seeded by
 * a React Server Component (RSC) (`initialDashboard`) — no detail GET route
 * backs it, so
 * `addWidget`/`removeWidget`/`updateWidget` apply their effect to the local
 * cache directly from the write's response instead of refetching. Layout
 * changes are still debounced and persisted via the `saveDashboardLayout`
 * server action, which deliberately omits `revalidatePath` (see the action's
 * doc) — the debounced save is fire-and-forget from here too.
 *
 * Env scope is intentionally NOT owned here. The header env switch
 * (`EnvContext`) is the canonical app-wide env scope; widgets
 * with `environmentMode = 'inherit'` read it directly via
 * `useEnvContext().selectedEnv`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboard } from '../../hooks/use-dashboard';
import { saveDashboardLayout } from '../../actions';
import { DashboardContext, type DashboardScope, type DashboardTimeRange } from './dashboard-context';
import type { Dashboard, LayoutItem, Widget } from '../../types';

interface DashboardProviderProps {
  dashboardId: string;
  appId: string;
  initialDashboard: Dashboard | null;
  /** The RSC read's failure message. A null `initialDashboard` alongside it
   *  means "unknown", not "gone". */
  loadError?: string | null;
  children: React.ReactNode;
}

const LAYOUT_SAVE_DEBOUNCE_MS = 500;

export function DashboardProvider({ dashboardId, appId, initialDashboard, loadError = null, children }: DashboardProviderProps) {
  const { dashboard, mutate } = useDashboard({ appId, dashboardId, initialDashboard });
  const [timeRange, setTimeRange] = useState<DashboardTimeRange>('7d');
  const [scope, setScope] = useState<DashboardScope>('app');

  // Debounced layout save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const onTimeRangeChange = useCallback((range: DashboardTimeRange) => {
    setTimeRange(range);
  }, []);

  const onScopeChange = useCallback((next: DashboardScope) => {
    setScope(next);
  }, []);

  // The write route (`POST .../widgets`) already created the widget
  // server-side; this appends it to the cached dashboard so the grid
  // reflects it immediately, with no refetch. Computed from the closed-over
  // `dashboard` rather than SWR's functional-updater form of `mutate` — the
  // installed SWR version doesn't apply a functional updater against a
  // fetcher-less key, so every write here passes `mutate` a plain next value.
  const addWidget = useCallback(
    (widget: Widget) => {
      if (!dashboard) return;
      mutate({ ...dashboard, widgets: [...dashboard.widgets, widget] }, { revalidate: false });
    },
    [dashboard, mutate]
  );

  const removeWidget = useCallback(
    (widgetId: string) => {
      if (!dashboard) return;
      mutate(
        {
          ...dashboard,
          widgets: dashboard.widgets.filter((w) => w.id !== widgetId),
          layout: dashboard.layout.filter((l) => l.widgetId !== widgetId),
        },
        { revalidate: false },
      );
    },
    [dashboard, mutate]
  );

  const updateWidget = useCallback(
    (widget: Widget) => {
      if (!dashboard) return;
      mutate(
        { ...dashboard, widgets: dashboard.widgets.map((w) => (w.id === widget.id ? widget : w)) },
        { revalidate: false },
      );
    },
    [dashboard, mutate]
  );

  const updateLayout = useCallback(
    (layout: LayoutItem[]) => {
      if (!dashboard) return;

      // Debounce the save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await saveDashboardLayout({ appId, dashboardId: dashboard.id, layout });
        } catch {
          // Layout save failed — will retry on next change
        }
      }, LAYOUT_SAVE_DEBOUNCE_MS);
    },
    [appId, dashboard]
  );

  const value = useMemo(
    () => ({
      appId,
      dashboard,
      error: loadError,
      timeRange,
      onTimeRangeChange,
      scope,
      onScopeChange,
      addWidget,
      removeWidget,
      updateWidget,
      updateLayout,
    }),
    [appId, dashboard, loadError, timeRange, onTimeRangeChange, scope, onScopeChange, addWidget, removeWidget, updateWidget, updateLayout]
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
