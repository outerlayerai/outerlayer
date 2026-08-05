'use server';

/**
 * Every dashboard mutation, one `authorizedAction` export per operation.
 * Each validates its flat input (`./schemas.ts`), authorizes the declared
 * `dashboard.*` permission narrowed to `appId`, and delegates to the one
 * `dashboardsService` call under the resolved `ServiceContext` — no route,
 * no client construction here.
 *
 * Freshness: the dashboard-level mutations (create/rename/delete/duplicate/
 * set-default) revalidate the list route the React Server Component (RSC) read owns, so a fresh
 * navigation or reload reflects the change. The three widget mutations and
 * the layout autosave omit `revalidatePath` — they mutate one dashboard's
 * detail view, which the client already updates from the response via an
 * optimistic SWR cache write (`features/dashboards/read.ts`'s callers), and
 * there is no static path segment here to revalidate (org/app/env names
 * aren't part of the action input). Layout-autosave specifically must not
 * revalidate: it fires on every debounced drag, and re-rendering the RSC
 * mid-drag would fight the client's own optimistic layout state.
 */

import type { z } from 'zod';
import { revalidatePath } from 'next/cache';

import { authorizedAction, ActionForbiddenError } from '@/lib/action-kit';
import { hasCustomMetricsEntitlement } from '@/lib/adapters';

import { dashboardsService } from './service';
import { isDerivedMetric, isMetadataField } from './types';
import {
  CreateDashboardActionInput,
  RenameDashboardActionInput,
  DeleteDashboardActionInput,
  DuplicateDashboardActionInput,
  SetDefaultDashboardActionInput,
  SaveDashboardLayoutActionInput,
  AddWidgetActionInput,
  UpdateWidgetActionInput,
  DeleteWidgetActionInput,
} from './schemas';

type AddWidgetInputType = z.infer<typeof AddWidgetActionInput>;

/** The list route that renders every dashboard for an app; re-seeded after a list-level change. */
const DASHBOARDS_LIST_PATH = '/orgs/[orgName]/apps/[appName]/env/[envName]/dashboards';

export const createDashboard = authorizedAction({
  input: CreateDashboardActionInput,
  permission: 'dashboard.insert',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const dashboard = await dashboardsService.create(ctx, {
      appId: input.appId,
      name: input.name,
      description: input.description ?? undefined,
      isDefault: input.isDefault,
      templateId: input.templateId,
    });
    revalidatePath(DASHBOARDS_LIST_PATH, 'page');
    return dashboard;
  },
});

export const renameDashboard = authorizedAction({
  input: RenameDashboardActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const dashboard = await dashboardsService.update(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      name: input.name,
    });
    revalidatePath(DASHBOARDS_LIST_PATH, 'page');
    return dashboard;
  },
});

export const deleteDashboard = authorizedAction({
  input: DeleteDashboardActionInput,
  permission: 'dashboard.delete',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    await dashboardsService.delete(ctx, { appId: input.appId, dashboardId: input.dashboardId });
    revalidatePath(DASHBOARDS_LIST_PATH, 'page');
  },
});

export const duplicateDashboard = authorizedAction({
  input: DuplicateDashboardActionInput,
  permission: 'dashboard.insert',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const dashboard = await dashboardsService.duplicate(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
    });
    revalidatePath(DASHBOARDS_LIST_PATH, 'page');
    return dashboard;
  },
});

export const setDefaultDashboard = authorizedAction({
  input: SetDefaultDashboardActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    await dashboardsService.setDefault(ctx, { appId: input.appId, dashboardId: input.dashboardId });
    revalidatePath(DASHBOARDS_LIST_PATH, 'page');
  },
});

/**
 * Persists the grid layout — fires on every debounced drag. Deliberately
 * omits `revalidatePath`: the client already holds the optimistic layout
 * (`DashboardProvider`), and re-rendering the owning RSC mid-drag would
 * fight that local state with a server round-trip the user never asked for.
 * The next full navigation to the detail page reads the persisted layout.
 */
export const saveDashboardLayout = authorizedAction({
  input: SaveDashboardLayoutActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    return dashboardsService.saveLayout(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      layout: input.layout,
    });
  },
});

/** True when a widget config touches a custom-metrics feature (derived metrics, metadata filters/groupBy) — gated behind the Growth entitlement. */
function usesCustomMetrics(input: AddWidgetInputType): boolean {
  if (isDerivedMetric(input.metric)) return true;
  if (input.groupBy && isMetadataField(input.groupBy)) return true;
  if (input.filters?.some((f) => isMetadataField(f.field))) return true;
  return false;
}

/**
 * Adds a widget to a dashboard. No `revalidatePath` — see the module doc;
 * the caller applies the returned widget to its own optimistic cache.
 */
export const addWidget = authorizedAction({
  input: AddWidgetActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    if (usesCustomMetrics(input)) {
      const allowed = await hasCustomMetricsEntitlement(ctx.tenantId);
      if (!allowed) {
        throw new ActionForbiddenError(
          'Custom metrics require a Growth plan or higher. Please upgrade to access derived metrics and custom properties.',
        );
      }
    }
    return dashboardsService.addWidget(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      title: input.title,
      metric: input.metric,
      visualization: input.visualization,
      filters: input.filters,
      groupBy: input.groupBy,
      timeGranularity: input.timeGranularity,
      scoreName: input.scoreName,
      scoreNameB: input.scoreNameB,
      environmentConfig: input.environmentConfig,
    });
  },
});

/** No `revalidatePath` — see the module doc; the caller applies the returned widget to its own optimistic cache. */
export const updateWidget = authorizedAction({
  input: UpdateWidgetActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    return dashboardsService.updateWidget(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      widgetId: input.widgetId,
      title: input.title,
      metric: input.metric,
      visualization: input.visualization,
      filters: input.filters,
      groupBy: input.groupBy,
      timeGranularity: input.timeGranularity,
      scoreName: input.scoreName,
      scoreNameB: input.scoreNameB,
      environmentConfig: input.environmentConfig,
    });
  },
});

/** No `revalidatePath` — see the module doc; the caller removes the widget from its own optimistic cache. */
export const deleteWidget = authorizedAction({
  input: DeleteWidgetActionInput,
  permission: 'dashboard.update',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    await dashboardsService.deleteWidget(ctx, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      widgetId: input.widgetId,
    });
  },
});
