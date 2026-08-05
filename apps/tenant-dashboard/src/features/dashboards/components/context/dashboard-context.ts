'use client';

/**
 * Dashboard Context
 *
 * Defines the shape of the dashboard context consumed by child components.
 *
 * Env scope: the dashboard view reads the app-wide env selector rather than
 * owning one. The canonical app-wide env scope is `EnvContext` — the header
 * env switch. Widgets that opt in to `environmentMode = 'inherit'` follow
 * `useEnvContext().selectedEnv`; widgets with `environmentMode = 'override'`
 * still pin to their own list verbatim (cross-env comparisons).
 */

import { createContext } from 'react';
import type { useDashboard } from '../../hooks/use-dashboard';
import type { LayoutItem, Widget } from '../../types';

export type DashboardTimeRange = '24h' | '7d' | '30d' | '90d';

/**
 * Fleet/PR query scope for the whole dashboard: 'app' (default — the app's
 * dominant repo, the historical behavior) or 'org' (tenant-wide rollup —
 * the CTO questions on the Executive Overview are org-level). View state
 * like timeRange, not persisted per-widget.
 */
export type DashboardScope = 'app' | 'org';

// Source of truth for the dashboard value in context: whatever the typed
// `useDashboard` hook returns. Derived via ReturnType so the spec-generated
// Dashboard shape stays authoritative — no parallel hand-authored type to
// drift.
type UseDashboardReturn = ReturnType<typeof useDashboard>;

// eslint-disable-next-line import/no-unused-modules -- consumed by sibling provider and hook
export interface DashboardContextValue {
  /**
   * The app id resolved by the React Server Component (RSC). Threaded through
   * context (not read from
   * `useAppContext`) so every nested consumer — the grid, the widget
   * dialog, the selector — stays a leaf that never reaches into
   * `sections/apps/context` itself.
   */
  appId: string;
  dashboard: UseDashboardReturn['dashboard'];
  /**
   * The RSC read's failure message, or null when the read succeeded. The
   * detail is server-loaded, so this is the only place a load failure can
   * come from — and it is what keeps a failed read from rendering as the
   * not-found state, which would tell the user their dashboard was deleted.
   */
  error: string | null;
  timeRange: DashboardTimeRange;
  onTimeRangeChange: (range: DashboardTimeRange) => void;
  scope: DashboardScope;
  onScopeChange: (scope: DashboardScope) => void;
  addWidget: (widget: Widget) => void;
  removeWidget: (widgetId: string) => void;
  updateWidget: (widget: Widget) => void;
  updateLayout: (layout: LayoutItem[]) => void;
}

export const DashboardContext = createContext<DashboardContextValue>({
  appId: '',
  dashboard: null,
  error: null,
  timeRange: '7d',
  onTimeRangeChange: () => {},
  scope: 'app',
  onScopeChange: () => {},
  addWidget: () => {},
  removeWidget: () => {},
  updateWidget: () => {},
  updateLayout: () => {},
});
