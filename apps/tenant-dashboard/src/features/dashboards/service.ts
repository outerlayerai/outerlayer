import 'server-only';

/**
 * DashboardService — CRUD for `dashboard` / `dashboard_widget`
 * (supabase/schemas), ServiceContext-first. Every method runs its queries
 * through `ctx.db` (RLS-scoped) — `dashboard.read/insert/update/delete`
 * policies plus the tenant match enforce visibility, so a row outside the
 * caller's app/tenant is indistinguishable from a missing one (no oracle).
 * The service opens no client of its own; `ctx.tenantId`/`ctx.actor.userId`
 * back the audit columns (`tenant_id`, `created_by`), never a positional
 * caller argument.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ServiceContext } from '@/lib/action-kit/service-context';
import { NotFoundError, ValidationError } from '@/lib/analytics/errors';

import { getTemplate, DEFAULT_TEMPLATE_ID } from './templates';
import type {
  Dashboard,
  DashboardSummary,
  DashboardRow,
  DashboardWidgetRow,
  Widget,
  CreateDashboardRequest,
  UpdateDashboardRequest,
  CreateWidgetRequest,
  UpdateWidgetRequest,
  LayoutItem,
  WidgetEnvironmentConfig,
} from './types';
import {
  MAX_DASHBOARDS_PER_APP,
  MAX_DASHBOARDS_PER_ORG,
  MAX_WIDGETS_PER_DASHBOARD,
  resolveWidgetEnvironmentConfig,
} from './types';

// ---------------------------------------------------------------------------
// Method input shapes — every mutation carries `appId` (the authorizedAction
// permission-narrowing target) alongside the fields the query actually needs.
// ---------------------------------------------------------------------------

type CreateDashboardInput = { appId: string } & CreateDashboardRequest;
type UpdateDashboardInput = { appId: string; dashboardId: string } & UpdateDashboardRequest;
type DeleteDashboardInput = { appId: string; dashboardId: string };
type DuplicateDashboardInput = { appId: string; dashboardId: string };
type SetDefaultDashboardInput = { appId: string; dashboardId: string };
type SaveLayoutInput = { appId: string; dashboardId: string; layout: LayoutItem[] };
type AddWidgetInput = { appId: string; dashboardId: string } & CreateWidgetRequest;
type UpdateWidgetInput = { appId: string; dashboardId: string; widgetId: string } & UpdateWidgetRequest;
type DeleteWidgetInput = { appId: string; dashboardId: string; widgetId: string };

// ---------------------------------------------------------------------------
// Row -> API transformers
// ---------------------------------------------------------------------------

function toDashboardSummary(row: DashboardRow, widgetCount: number): DashboardSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    widgetCount,
    globalTimeRange: row.global_time_range,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a widget env config to its persisted JSONB form. `inherit` — the
 * default — is stored as NULL so legacy rows and freshly inheriting widgets
 * share one representation. `override` persists the full `{ mode,
 * environments }` object.
 */
function toPersistedEnvConfig(config: WidgetEnvironmentConfig | undefined): WidgetEnvironmentConfig | null {
  const resolved = resolveWidgetEnvironmentConfig(config);
  return resolved.mode === 'override' ? resolved : null;
}

function toWidget(row: DashboardWidgetRow): Widget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    title: row.title,
    metric: row.metric as Widget['metric'],
    visualization: row.visualization as Widget['visualization'],
    filters: row.filters,
    groupBy: row.group_by,
    timeGranularity: row.time_granularity as Widget['timeGranularity'],
    scoreName: row.score_name ?? undefined,
    scoreNameB: row.score_name_b ?? undefined,
    // NULL persists as inherit — surface a concrete config so the renderer
    // never has to special-case absence.
    environmentConfig: resolveWidgetEnvironmentConfig(row.environment_config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDashboard(row: DashboardRow, widgetRows: DashboardWidgetRow[]): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    globalTimeRange: row.global_time_range,
    layout: row.layout,
    widgets: widgetRows.map(toWidget),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class DashboardService {
  // --------------------------------------------------------------------------
  // Dashboard CRUD
  // --------------------------------------------------------------------------

  async list(ctx: ServiceContext, appId: string): Promise<DashboardSummary[]> {
    const db = ctx.db as SupabaseClient;
    const { data: dashboards, error } = await db
      .from('dashboard')
      .select('*, dashboard_widget(count)')
      .eq('app_id', appId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list dashboards: ${error.message}`);

    return (dashboards ?? []).map((row: DashboardRow & { dashboard_widget: { count: number }[] }) => {
      const widgetCount = row.dashboard_widget?.[0]?.count ?? 0;
      return toDashboardSummary(row, widgetCount);
    });
  }

  async get(ctx: ServiceContext, appId: string, dashboardId: string): Promise<Dashboard> {
    const db = ctx.db as SupabaseClient;
    const { data: row, error } = await db
      .from('dashboard')
      .select('*')
      .eq('id', dashboardId)
      .eq('app_id', appId)
      .single();

    // No-rows is the ONLY failure that means "not found". PostgREST reports it
    // as PGRST116, and RLS makes a foreign-tenant row indistinguishable from a
    // missing one — both land here, which is the no-oracle posture. Every other
    // error (connection, timeout, malformed query) is a genuine failure and
    // must stay one: collapsing it into not-found is how a transient outage
    // gets reported to the user as a deleted dashboard.
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to fetch dashboard: ${error.message}`);
    }
    if (error || !row) {
      throw new NotFoundError('Dashboard not found', 'dashboard', dashboardId);
    }

    const { data: widgetRows, error: widgetError } = await db
      .from('dashboard_widget')
      .select('*')
      .eq('dashboard_id', dashboardId)
      .order('sort_order', { ascending: true });

    if (widgetError) throw new Error(`Failed to fetch widgets: ${widgetError.message}`);

    return toDashboard(row as DashboardRow, (widgetRows ?? []) as DashboardWidgetRow[]);
  }

  async create(ctx: ServiceContext, input: CreateDashboardInput): Promise<Dashboard> {
    const db = ctx.db as SupabaseClient;
    const { appId } = input;
    const tenantId = ctx.tenantId;
    const createdBy = ctx.actor.userId;

    const { count, error: countError } = await db
      .from('dashboard')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId);
    if (countError) throw new Error(`Failed to check dashboard count: ${countError.message}`);
    if ((count ?? 0) >= MAX_DASHBOARDS_PER_APP) {
      throw new ValidationError(`Maximum of ${MAX_DASHBOARDS_PER_APP} dashboards per application reached`);
    }

    const { count: orgCount, error: orgCountError } = await db
      .from('dashboard')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (orgCountError) throw new Error(`Failed to check org dashboard count: ${orgCountError.message}`);
    if ((orgCount ?? 0) >= MAX_DASHBOARDS_PER_ORG) {
      throw new ValidationError(`Maximum of ${MAX_DASHBOARDS_PER_ORG} dashboards per organization reached`);
    }

    const { data: existing } = await db
      .from('dashboard')
      .select('id')
      .eq('app_id', appId)
      .ilike('name', input.name)
      .maybeSingle();
    if (existing) throw new ValidationError('Dashboard name already exists for this application');

    const template = input.templateId ? getTemplate(input.templateId) : undefined;

    const { data: row, error } = await db
      .from('dashboard')
      .insert({
        app_id: appId,
        tenant_id: tenantId,
        name: input.name,
        description: input.description ?? null,
        is_default: input.isDefault ?? false,
        created_by: createdBy,
        // Start with an empty layout; the layout is written after the
        // template's widgets are created (their ids don't exist yet).
        layout: [],
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw new ValidationError('Dashboard name already exists for this application');
      throw new Error(`Failed to create dashboard: ${error.message}`);
    }

    const dashboardRow = row as DashboardRow;
    let widgetRows: DashboardWidgetRow[] = [];

    if (template && template.widgets.length > 0) {
      const widgetInserts = template.widgets.map((widget, index) => ({
        dashboard_id: dashboardRow.id,
        tenant_id: tenantId,
        title: widget.title,
        metric: widget.metric,
        visualization: widget.visualization ?? 'line',
        filters: widget.filters ?? [],
        group_by: widget.groupBy ?? null,
        time_granularity: widget.timeGranularity ?? 'auto',
        sort_order: index,
        score_name: widget.scoreName ?? null,
        score_name_b: widget.scoreNameB ?? null,
        environment_config: toPersistedEnvConfig(widget.environmentConfig),
      }));

      const { data: insertedWidgets, error: widgetError } = await db
        .from('dashboard_widget')
        .insert(widgetInserts)
        .select()
        .order('sort_order', { ascending: true });

      if (widgetError) {
        // Roll back the dashboard if its template's widgets fail to insert —
        // never leave an empty, name-holding orphan behind.
        await db.from('dashboard').delete().eq('id', dashboardRow.id);
        throw new Error(`Failed to create template widgets: ${widgetError.message}`);
      }

      widgetRows = (insertedWidgets ?? []) as DashboardWidgetRow[];

      const layout: LayoutItem[] = template.layout.map((item, index) => ({
        ...item,
        widgetId: widgetRows[index]?.id ?? '',
      }));

      const { error: layoutError } = await db.from('dashboard').update({ layout }).eq('id', dashboardRow.id);
      if (layoutError) throw new Error(`Failed to update dashboard layout: ${layoutError.message}`);

      dashboardRow.layout = layout;
    }

    return toDashboard(dashboardRow, widgetRows);
  }

  async update(ctx: ServiceContext, input: UpdateDashboardInput): Promise<Dashboard> {
    const db = ctx.db as SupabaseClient;
    const { appId, dashboardId } = input;

    const updateFields: Record<string, unknown> = {};
    if (input.name !== undefined) updateFields.name = input.name;
    if (input.description !== undefined) updateFields.description = input.description;
    if (input.isDefault !== undefined) updateFields.is_default = input.isDefault;
    if (input.globalTimeRange !== undefined) updateFields.global_time_range = input.globalTimeRange;
    if (input.layout !== undefined) updateFields.layout = input.layout;

    const { data: row, error } = await db
      .from('dashboard')
      .update(updateFields)
      .eq('id', dashboardId)
      .eq('app_id', appId)
      .select()
      .single();

    if (error?.code === '23505') {
      throw new ValidationError('Dashboard name already exists for this application');
    }
    // Same classification as the read: an update matching no row reports
    // PGRST116, and only that means the dashboard is gone. Anything else is a
    // genuine failure, and labelling it not-found tells someone renaming a
    // dashboard they can still see in the list that it does not exist.
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to update dashboard: ${error.message}`);
    }
    if (error || !row) {
      throw new NotFoundError('Dashboard not found', 'dashboard', dashboardId);
    }

    const { data: widgetRows } = await db
      .from('dashboard_widget')
      .select('*')
      .eq('dashboard_id', dashboardId)
      .order('sort_order', { ascending: true });

    return toDashboard(row as DashboardRow, (widgetRows ?? []) as DashboardWidgetRow[]);
  }

  /** Persists only the grid layout — the debounced-drag path (no other field changes). */
  async saveLayout(ctx: ServiceContext, input: SaveLayoutInput): Promise<Dashboard> {
    return this.update(ctx, { appId: input.appId, dashboardId: input.dashboardId, layout: input.layout });
  }

  async delete(ctx: ServiceContext, input: DeleteDashboardInput): Promise<void> {
    const db = ctx.db as SupabaseClient;
    const { error, count } = await db
      .from('dashboard')
      .delete({ count: 'exact' })
      .eq('id', input.dashboardId)
      .eq('app_id', input.appId);

    if (error) throw new Error(`Failed to delete dashboard: ${error.message}`);
    if (count === 0) throw new NotFoundError('Dashboard not found', 'dashboard', input.dashboardId);
  }

  // --------------------------------------------------------------------------
  // Widget CRUD
  // --------------------------------------------------------------------------

  async addWidget(ctx: ServiceContext, input: AddWidgetInput): Promise<Widget> {
    const db = ctx.db as SupabaseClient;
    const { dashboardId } = input;
    const tenantId = ctx.tenantId;

    const { count, error: countError } = await db
      .from('dashboard_widget')
      .select('id', { count: 'exact', head: true })
      .eq('dashboard_id', dashboardId);
    if (countError) throw new Error(`Failed to check widget count: ${countError.message}`);
    if ((count ?? 0) >= MAX_WIDGETS_PER_DASHBOARD) {
      throw new ValidationError(`Maximum of ${MAX_WIDGETS_PER_DASHBOARD} widgets per dashboard reached`);
    }

    const { data: existingWidget } = await db
      .from('dashboard_widget')
      .select('id')
      .eq('dashboard_id', dashboardId)
      .ilike('title', input.title)
      .maybeSingle();
    if (existingWidget) throw new ValidationError('Widget title already exists on this dashboard');

    const nextSortOrder = count ?? 0;

    const { data: row, error } = await db
      .from('dashboard_widget')
      .insert({
        dashboard_id: dashboardId,
        tenant_id: tenantId,
        title: input.title,
        metric: input.metric,
        visualization: input.visualization ?? 'line',
        filters: input.filters ?? [],
        group_by: input.groupBy ?? null,
        time_granularity: input.timeGranularity ?? 'auto',
        sort_order: nextSortOrder,
        score_name: input.scoreName ?? null,
        score_name_b: input.scoreNameB ?? null,
        environment_config: toPersistedEnvConfig(input.environmentConfig),
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to add widget: ${error.message}`);

    return toWidget(row as DashboardWidgetRow);
  }

  async updateWidget(ctx: ServiceContext, input: UpdateWidgetInput): Promise<Widget> {
    const db = ctx.db as SupabaseClient;
    const { widgetId, dashboardId } = input;

    const updateFields: Record<string, unknown> = {};
    if (input.title !== undefined) updateFields.title = input.title;
    if (input.metric !== undefined) updateFields.metric = input.metric;
    if (input.visualization !== undefined) updateFields.visualization = input.visualization;
    if (input.filters !== undefined) updateFields.filters = input.filters;
    if (input.groupBy !== undefined) updateFields.group_by = input.groupBy;
    if (input.timeGranularity !== undefined) updateFields.time_granularity = input.timeGranularity;
    if (input.scoreName !== undefined) updateFields.score_name = input.scoreName;
    if (input.scoreNameB !== undefined) updateFields.score_name_b = input.scoreNameB;
    if (input.environmentConfig !== undefined) {
      updateFields.environment_config = toPersistedEnvConfig(input.environmentConfig);
    }

    const { data: row, error } = await db
      .from('dashboard_widget')
      .update(updateFields)
      .eq('id', widgetId)
      .eq('dashboard_id', dashboardId)
      .select()
      .single();

    if (error || !row) throw new NotFoundError('Widget not found', 'widget', widgetId);

    return toWidget(row as DashboardWidgetRow);
  }

  async deleteWidget(ctx: ServiceContext, input: DeleteWidgetInput): Promise<void> {
    const db = ctx.db as SupabaseClient;
    const { error, count } = await db
      .from('dashboard_widget')
      .delete({ count: 'exact' })
      .eq('id', input.widgetId)
      .eq('dashboard_id', input.dashboardId);

    if (error) throw new Error(`Failed to delete widget: ${error.message}`);
    if (count === 0) throw new NotFoundError('Widget not found', 'widget', input.widgetId);
  }

  // --------------------------------------------------------------------------
  // Dashboard operations
  // --------------------------------------------------------------------------

  /** Deep-copies a dashboard including all of its widgets and layout. */
  async duplicate(ctx: ServiceContext, input: DuplicateDashboardInput): Promise<Dashboard> {
    const db = ctx.db as SupabaseClient;
    const tenantId = ctx.tenantId;
    const createdBy = ctx.actor.userId;

    const source = await this.get(ctx, input.appId, input.dashboardId);

    const { data: row, error } = await db
      .from('dashboard')
      .insert({
        app_id: input.appId,
        tenant_id: tenantId,
        name: `${source.name} (Copy)`,
        description: source.description,
        is_default: false,
        created_by: createdBy,
        layout: [],
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to duplicate dashboard: ${error.message}`);

    const dashboardRow = row as DashboardRow;
    let widgetRows: DashboardWidgetRow[] = [];

    if (source.widgets.length > 0) {
      const widgetInserts = source.widgets.map((widget, index) => ({
        dashboard_id: dashboardRow.id,
        tenant_id: tenantId,
        title: widget.title,
        metric: widget.metric,
        visualization: widget.visualization,
        filters: widget.filters ?? [],
        group_by: widget.groupBy ?? null,
        time_granularity: widget.timeGranularity ?? 'auto',
        sort_order: index,
        score_name: widget.scoreName ?? null,
        score_name_b: widget.scoreNameB ?? null,
        environment_config: toPersistedEnvConfig(widget.environmentConfig),
      }));

      const { data: insertedWidgets, error: widgetError } = await db
        .from('dashboard_widget')
        .insert(widgetInserts)
        .select()
        .order('sort_order', { ascending: true });

      if (widgetError) {
        await db.from('dashboard').delete().eq('id', dashboardRow.id);
        throw new Error(`Failed to duplicate widgets: ${widgetError.message}`);
      }

      widgetRows = (insertedWidgets ?? []) as DashboardWidgetRow[];

      if (source.layout && source.layout.length > 0) {
        const oldToNewId = new Map<string, string>();
        source.widgets.forEach((w, i) => {
          if (widgetRows[i]) oldToNewId.set(w.id, widgetRows[i].id);
        });

        const layout: LayoutItem[] = source.layout.map((item) => ({
          ...item,
          widgetId: oldToNewId.get(item.widgetId) ?? item.widgetId,
        }));

        await db.from('dashboard').update({ layout }).eq('id', dashboardRow.id);
        dashboardRow.layout = layout;
      }
    }

    return toDashboard(dashboardRow, widgetRows);
  }

  /** Marks a dashboard as the app's default, unsetting any prior default (tenant-scoped via RLS). */
  async setDefault(ctx: ServiceContext, input: SetDefaultDashboardInput): Promise<void> {
    const db = ctx.db as SupabaseClient;
    const { appId, dashboardId } = input;

    await db.from('dashboard').update({ is_default: false }).eq('app_id', appId).eq('is_default', true);

    const { error } = await db.from('dashboard').update({ is_default: true }).eq('id', dashboardId).eq('app_id', appId);
    if (error) throw new Error(`Failed to set default dashboard: ${error.message}`);
  }

  /**
   * Returns the app's default dashboard, creating one from
   * `DEFAULT_TEMPLATE_ID` (agent-fleet-overview) if none exist yet, and
   * additively syncing an auto-created default with the current template.
   */
  async getOrCreateDefault(ctx: ServiceContext, appId: string): Promise<Dashboard> {
    const existing = await this.list(ctx, appId);

    if (existing.length > 0) {
      const defaultDashboard = existing.find((d) => d.isDefault) ?? existing[0]!;
      const dashboard = await this.get(ctx, appId, defaultDashboard.id);

      try {
        const synced = await this.syncWithTemplate(ctx, dashboard);
        if (synced) return this.get(ctx, appId, dashboard.id);
      } catch (err) {
        // Non-fatal: the existing dashboard is still a valid answer if sync fails.
        console.error('[dashboards] template sync failed:', err);
      }
      return dashboard;
    }

    return this.create(ctx, {
      appId,
      name: 'Overview',
      isDefault: true,
      templateId: DEFAULT_TEMPLATE_ID,
    });
  }

  /**
   * Additive-only template sync: inserts any widget the default dashboard is
   * missing from the current template. Never deletes a widget — user-added
   * widgets always survive. Returns true when it added anything.
   */
  private async syncWithTemplate(ctx: ServiceContext, dashboard: Dashboard): Promise<boolean> {
    const db = ctx.db as SupabaseClient;
    // Only sync auto-created default dashboards (named 'Overview').
    if (!dashboard.isDefault || dashboard.name !== 'Overview') return false;

    const template = getTemplate(DEFAULT_TEMPLATE_ID);
    if (!template) return false;

    const existingPairs = new Set(dashboard.widgets.map((w) => `${w.metric}:${w.visualization}`));

    // Lineage guard: additive sync is only safe against the template this
    // dashboard was actually built from, and no template id is stored, so
    // lineage is inferred. Fewer than half of the current template's widgets
    // present means this dashboard came from a different, since-retired
    // default — freeze it as-is rather than piling a second template's
    // widgets onto it. A freshly auto-created dashboard starts at 100%
    // presence, so it keeps receiving template additions.
    const presentCount = template.widgets.filter((tw) => existingPairs.has(`${tw.metric}:${tw.visualization ?? 'line'}`)).length;
    if (presentCount * 2 < template.widgets.length) return false;

    const missingIndices: number[] = [];
    for (let i = 0; i < template.widgets.length; i++) {
      const tw = template.widgets[i]!;
      const key = `${tw.metric}:${tw.visualization ?? 'line'}`;
      if (!existingPairs.has(key)) missingIndices.push(i);
    }
    if (missingIndices.length === 0) return false;

    const sortBase = dashboard.widgets.length;
    const widgetInserts = missingIndices.map((idx, offset) => {
      const tw = template.widgets[idx]!;
      return {
        dashboard_id: dashboard.id,
        tenant_id: ctx.tenantId,
        title: tw.title,
        metric: tw.metric,
        visualization: tw.visualization ?? 'line',
        filters: tw.filters ?? [],
        group_by: tw.groupBy ?? null,
        time_granularity: tw.timeGranularity ?? 'auto',
        score_name: tw.scoreName ?? null,
        score_name_b: tw.scoreNameB ?? null,
        environment_config: toPersistedEnvConfig(tw.environmentConfig),
        sort_order: sortBase + offset,
      };
    });

    const { data: insertedWidgets, error: widgetError } = await db
      .from('dashboard_widget')
      .insert(widgetInserts)
      .select()
      .order('sort_order', { ascending: true });
    if (widgetError) throw new Error(`Failed to sync template widgets: ${widgetError.message}`);

    const widgetRows = (insertedWidgets ?? []) as DashboardWidgetRow[];
    const maxY = dashboard.layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const newLayoutItems: LayoutItem[] = widgetRows.map((row, offset) => {
      const templateIdx = missingIndices[offset]!;
      const templateLayout = template.layout[templateIdx];
      return {
        widgetId: row.id,
        x: templateLayout?.x ?? 0,
        y: maxY + (templateLayout?.y ?? offset * 4),
        w: templateLayout?.w ?? 6,
        h: templateLayout?.h ?? 4,
      };
    });

    const updatedLayout = [...dashboard.layout, ...newLayoutItems];
    await db.from('dashboard').update({ layout: updatedLayout }).eq('id', dashboard.id);

    return true;
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const dashboardsService = new DashboardService();
