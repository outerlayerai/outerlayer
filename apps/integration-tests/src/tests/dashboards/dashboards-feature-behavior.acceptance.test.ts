/**
 * Dashboards feature-behavior acceptance — every read shape and mutation
 * `dashboardsService` exposes, driven through a real, tenant-scoped Supabase
 * client (Postgres/PostgREST/RLS), not mocks.
 * `dashboards-tenancy.acceptance.test.ts` already covers the
 * tenant/permission boundary (cross-tenant leak, read-vs-write denial,
 * spoofed-tenant writes) — cited, not re-proven here; this suite covers the
 * feature's OWN business logic: every service method's success shape, its
 * failure modes, and the promises the service's own code makes.
 *
 * Surface → coverage map (features/dashboards/):
 *
 *   service.ts
 *     list                → D-1  (ordering + widgetCount projection)
 *     get                 → D-1, D-6 (exact shape; NotFoundError, no oracle)
 *     create              → D-2  (template widget seeding, duplicate-name
 *                                  rejection, MAX_DASHBOARDS_PER_APP)
 *     update / saveLayout → D-3  (partial update, duplicate-name rejection,
 *                                  NotFoundError)
 *     delete              → D-4  (NotFoundError; cascades widgets)
 *     addWidget           → D-5  (MAX_WIDGETS_PER_DASHBOARD, duplicate title)
 *     updateWidget        → D-3  (NotFoundError)
 *     deleteWidget        → D-4  (NotFoundError)
 *     duplicate           → D-7  (deep copy: widgets + remapped layout)
 *     setDefault          → D-8  (one-default-per-app swap)
 *     getOrCreateDefault  → D-9  (creates from DEFAULT_TEMPLATE_ID once;
 *                                  additive template sync is idempotent)
 *   read.ts
 *     loadDashboardsForApp / loadDashboardForApp / loadDefaultDashboardForApp
 *       — thin wrappers: `loadRequestServiceContext()` needs a live Next.js
 *         cookie-session request scope this harness cannot construct
 *         (same gap as every other domain's authorizedAction — see
 *         `workers-feature-behavior.acceptance.test.ts`). UNCOVERABLE here;
 *         driven instead via the exact `dashboardsService` calls each wrapper
 *         makes (D-1, D-9), which is everything past the ctx-resolution seam.
 *     loadTemplates          → D-10 (static catalog, no ctx — driven directly)
 *   actions.ts
 *     createDashboard / renameDashboard / deleteDashboard / duplicateDashboard/
 *     setDefaultDashboard / saveDashboardLayout / addWidget / updateWidget /
 *     deleteWidget
 *       — every export is `authorizedAction`-wrapped, same Next.js-request-
 *         scope gap. UNCOVERABLE at the action layer; `actions.test.ts`
 *         (co-located, tenant-dashboard) already unit-tests each action's
 *         permission mirror + zod-schema rejection with a REAL zod parse
 *         (only the service call is mocked) — cited, not duplicated. This
 *         suite drives the service call every action delegates to, under a
 *         real tenant-scoped client instead of a mock.
 *
 * Widget-data query correctness (the `// live:` poll's own surface) is out of
 * this file's scope — see `dashboard-widget-data-query.acceptance.test.ts`
 * (real ClickHouse, the `clickhouse` vitest project).
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';
import { dashboardsService } from 'tenant-dashboard/src/features/dashboards/service';
import { loadTemplates } from 'tenant-dashboard/src/features/dashboards/read';
import { DEFAULT_TEMPLATE_ID } from 'tenant-dashboard/src/features/dashboards/templates';
import { MAX_DASHBOARDS_PER_APP, MAX_WIDGETS_PER_DASHBOARD } from 'tenant-dashboard/src/features/dashboards/types';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';

const untyped = (client: unknown): SupabaseClient => client as SupabaseClient;

/** A minimal ServiceContext over a real, already-authenticated tenant client —
 * the exact shape `authorizedAction` hands the handler, built by hand since
 * the wrapper itself can't run here (no Next.js request scope). */
function ctxFor(user: SameTenantUser, tenantId: string = user.tenantId): ServiceContext {
  return { db: untyped(user.client), tenantId, actor: { userId: user.id, role: user.orgRole } };
}

describe('dashboards feature behavior — DashboardService + read.ts surface', () => {
  const admin = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  const suffix = randomUUID().slice(0, 8);

  // MAX_DASHBOARDS_PER_APP is 10 and several `it`s below each create more
  // than one dashboard, so every test gets its OWN fresh app rather than
  // sharing one — independent of test order and total dashboard count.
  async function createApp(label: string): Promise<string> {
    const { data, error } = await admin
      .from('app')
      .insert({ name: `dash-${label}-${suffix}-${randomUUID().slice(0, 6)}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (error) throw new Error(`app insert (${label}): ${error.message}`);
    return data!.id as string;
  }

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();
  }, 90000);

  afterAll(async () => {
    await admin.from('dashboard_widget').delete().eq('tenant_id', owner.tenantId);
    await admin.from('dashboard').delete().eq('tenant_id', owner.tenantId);
    await admin.from('app').delete().eq('tenant_id', owner.tenantId);
    await admin.from('membership').delete().in('user_id', [owner.id, otherOrg.id]);
    for (const user of [owner, otherOrg]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [owner.tenantId, otherOrg.tenantId]);
  });

  describe('D-1 — list: ordering + widgetCount projection', () => {
    it('lists dashboards newest-first with an accurate widget count, excluding a foreign tenant entirely', async () => {
      const appId = await createApp('d1');
      const ctx = ctxFor(owner);
      const first = await dashboardsService.create(ctx, { appId, name: `d1-first-${suffix}` });
      const second = await dashboardsService.create(ctx, { appId, name: `d1-second-${suffix}` });
      await dashboardsService.addWidget(ctx, {
        appId,
        dashboardId: second.id,
        title: 'Requests',
        metric: 'request_count',
      });

      const list = await dashboardsService.list(ctx, appId);
      const ids = list.map((d) => d.id);
      // Newest-first: second created after first, so it sorts before it.
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

      const secondSummary = list.find((d) => d.id === second.id);
      expect(secondSummary).toMatchObject({ id: second.id, name: `d1-second-${suffix}`, widgetCount: 1 });
      const firstSummary = list.find((d) => d.id === first.id);
      expect(firstSummary).toMatchObject({ id: first.id, name: `d1-first-${suffix}`, widgetCount: 0 });

      // A foreign tenant's read of the same app id sees nothing (RLS, not a filter).
      const foreignList = await dashboardsService.list(ctxFor(otherOrg), appId);
      expect(foreignList).toEqual([]);
    });
  });

  describe('D-6 — get: exact detail shape; unknown/foreign id is NotFoundError, no oracle', () => {
    it('returns the exact dashboard + widget projection for an existing row', async () => {
      const appId = await createApp('d6-shape');
      const ctx = ctxFor(owner);
      const created = await dashboardsService.create(ctx, { appId, name: `d6-${suffix}`, description: 'd6 desc' });
      const widget = await dashboardsService.addWidget(ctx, {
        appId,
        dashboardId: created.id,
        title: 'Cost',
        metric: 'total_cost',
        visualization: 'stat',
      });

      const detail = await dashboardsService.get(ctx, appId, created.id);
      expect(detail).toEqual({
        id: created.id,
        name: `d6-${suffix}`,
        description: 'd6 desc',
        isDefault: false,
        globalTimeRange: '7d',
        layout: [],
        widgets: [
          {
            id: widget.id,
            dashboardId: created.id,
            title: 'Cost',
            metric: 'total_cost',
            visualization: 'stat',
            filters: [],
            groupBy: null,
            timeGranularity: 'auto',
            scoreName: undefined,
            scoreNameB: undefined,
            environmentConfig: { mode: 'inherit' },
            createdAt: expect.any(String),
            updatedAt: null,
          },
        ],
        createdAt: expect.any(String),
        updatedAt: null,
      });
    });

    it('throws NotFoundError for an unknown dashboard id — the same outcome a foreign-tenant id produces (no oracle)', async () => {
      const appId = await createApp('d6-notfound');
      await expect(dashboardsService.get(ctxFor(owner), appId, randomUUID())).rejects.toMatchObject({
        name: 'NotFoundError',
      });

      const foreign = await dashboardsService.create(ctxFor(owner), { appId, name: `d6-foreign-${suffix}` });
      await expect(dashboardsService.get(ctxFor(otherOrg), appId, foreign.id)).rejects.toMatchObject({
        name: 'NotFoundError',
      });
    });
  });

  describe('D-2 — create: template widget seeding, duplicate-name rejection, per-app limit', () => {
    it('seeds every template widget + a layout entry per widget when created from a template', async () => {
      const appId = await createApp('d2-template');
      const created = await dashboardsService.create(ctxFor(owner), {
        appId,
        name: `d2-templated-${suffix}`,
        templateId: DEFAULT_TEMPLATE_ID,
      });
      const template = await loadTemplates().then((ts) => ts.find((t) => t.id === DEFAULT_TEMPLATE_ID)!);

      expect(created.widgets).toHaveLength(template.widgetCount);
      expect(created.layout).toHaveLength(template.widgetCount);
      // Every layout entry names a real widget on this dashboard.
      const widgetIds = new Set(created.widgets.map((w) => w.id));
      for (const item of created.layout) expect(widgetIds.has(item.widgetId)).toBe(true);
    });

    it('rejects a case-insensitive duplicate name within the same app as a ValidationError', async () => {
      const appId = await createApp('d2-dup');
      const name = `d2-dup-${suffix}`;
      await dashboardsService.create(ctxFor(owner), { appId, name });
      await expect(
        dashboardsService.create(ctxFor(owner), { appId, name: name.toUpperCase() }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it(`refuses the ${MAX_DASHBOARDS_PER_APP + 1}th dashboard in one app`, async () => {
      const capAppId = await createApp('d2-cap');
      const ctx = ctxFor(owner);
      for (let i = 0; i < MAX_DASHBOARDS_PER_APP; i++) {
        await dashboardsService.create(ctx, { appId: capAppId, name: `d2-cap-${i}-${suffix}` });
      }
      await expect(
        dashboardsService.create(ctx, { appId: capAppId, name: `d2-cap-over-${suffix}` }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });
  });

  describe('D-3 — update / updateWidget: partial fields, duplicate-name rejection, NotFoundError', () => {
    it('update only writes the fields present in the input, leaving the rest untouched', async () => {
      const appId = await createApp('d3-partial');
      const ctx = ctxFor(owner);
      const created = await dashboardsService.create(ctx, { appId, name: `d3-${suffix}`, description: 'orig' });
      const updated = await dashboardsService.update(ctx, { appId, dashboardId: created.id, name: `d3-renamed-${suffix}` });
      expect(updated.name).toBe(`d3-renamed-${suffix}`);
      expect(updated.description).toBe('orig');
    });

    it('rejects renaming into a name already used by another dashboard in the same app', async () => {
      const appId = await createApp('d3-dup');
      const ctx = ctxFor(owner);
      const taken = await dashboardsService.create(ctx, { appId, name: `d3-taken-${suffix}` });
      const other = await dashboardsService.create(ctx, { appId, name: `d3-other-${suffix}` });
      await expect(
        dashboardsService.update(ctx, { appId, dashboardId: other.id, name: taken.name }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it('update/updateWidget throw NotFoundError for an id that does not exist', async () => {
      const appId = await createApp('d3-notfound');
      await expect(
        dashboardsService.update(ctxFor(owner), { appId, dashboardId: randomUUID(), name: 'ghost' }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });

      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d3-widget-host-${suffix}` });
      await expect(
        dashboardsService.updateWidget(ctx, { appId, dashboardId: dash.id, widgetId: randomUUID(), title: 'ghost' }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    it('saveLayout persists only the layout, re-readable via get', async () => {
      const appId = await createApp('d3-layout');
      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d3-layout-${suffix}` });
      const widget = await dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: 'W', metric: 'request_count' });
      const layout = [{ widgetId: widget.id, x: 0, y: 0, w: 6, h: 4 }];

      await dashboardsService.saveLayout(ctx, { appId, dashboardId: dash.id, layout });
      const reread = await dashboardsService.get(ctx, appId, dash.id);
      expect(reread.layout).toEqual(layout);
    });
  });

  describe('D-4 — delete / deleteWidget: NotFoundError, and delete cascades widgets', () => {
    it('delete removes the dashboard and its widgets are gone with it (ON DELETE CASCADE)', async () => {
      const appId = await createApp('d4-cascade');
      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d4-${suffix}` });
      const widget = await dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: 'W', metric: 'request_count' });

      await dashboardsService.delete(ctx, { appId, dashboardId: dash.id });

      await expect(dashboardsService.get(ctx, appId, dash.id)).rejects.toMatchObject({ name: 'NotFoundError' });
      const { data: orphanWidget } = await admin.from('dashboard_widget').select('id').eq('id', widget.id);
      expect(orphanWidget).toEqual([]);
    });

    it('delete/deleteWidget throw NotFoundError for an id that does not exist', async () => {
      const appId = await createApp('d4-notfound');
      await expect(
        dashboardsService.delete(ctxFor(owner), { appId, dashboardId: randomUUID() }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });

      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d4-widget-host-${suffix}` });
      await expect(
        dashboardsService.deleteWidget(ctx, { appId, dashboardId: dash.id, widgetId: randomUUID() }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });
  });

  describe('D-5 — addWidget: per-dashboard limit + duplicate title rejection', () => {
    it('rejects a duplicate widget title (case-insensitive) on the same dashboard', async () => {
      const appId = await createApp('d5-dup');
      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d5-dup-${suffix}` });
      await dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: 'Requests', metric: 'request_count' });
      await expect(
        dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: 'REQUESTS', metric: 'total_cost' }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it(`refuses the ${MAX_WIDGETS_PER_DASHBOARD + 1}th widget on one dashboard`, async () => {
      const appId = await createApp('d5-cap');
      const ctx = ctxFor(owner);
      const dash = await dashboardsService.create(ctx, { appId, name: `d5-cap-${suffix}` });
      for (let i = 0; i < MAX_WIDGETS_PER_DASHBOARD; i++) {
        await dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: `W-${i}`, metric: 'request_count' });
      }
      await expect(
        dashboardsService.addWidget(ctx, { appId, dashboardId: dash.id, title: 'One too many', metric: 'request_count' }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });
  });

  describe('D-7 — duplicate: deep copy of widgets + remapped layout', () => {
    it('copies every widget and remaps the layout to the NEW widget ids, leaving the source untouched', async () => {
      const appId = await createApp('d7');
      const ctx = ctxFor(owner);
      const source = await dashboardsService.create(ctx, { appId, name: `d7-src-${suffix}`, description: 'src desc' });
      const w1 = await dashboardsService.addWidget(ctx, { appId, dashboardId: source.id, title: 'W1', metric: 'request_count' });
      const w2 = await dashboardsService.addWidget(ctx, { appId, dashboardId: source.id, title: 'W2', metric: 'total_cost' });
      const layout = [
        { widgetId: w1.id, x: 0, y: 0, w: 6, h: 4 },
        { widgetId: w2.id, x: 6, y: 0, w: 6, h: 4 },
      ];
      await dashboardsService.saveLayout(ctx, { appId, dashboardId: source.id, layout });

      const copy = await dashboardsService.duplicate(ctx, { appId, dashboardId: source.id });

      expect(copy.name).toBe(`${source.name} (Copy)`);
      expect(copy.description).toBe('src desc');
      expect(copy.widgets.map((w) => w.title).sort()).toEqual(['W1', 'W2']);
      // Every copied widget has a NEW id, distinct from the source's.
      const copyIds = new Set(copy.widgets.map((w) => w.id));
      expect(copyIds.has(w1.id)).toBe(false);
      expect(copyIds.has(w2.id)).toBe(false);
      // The copy's layout references only the copy's own widget ids.
      for (const item of copy.layout) expect(copyIds.has(item.widgetId)).toBe(true);
      expect(copy.layout).toHaveLength(2);

      // The source is untouched — same widget ids, same layout as before.
      const sourceAfter = await dashboardsService.get(ctx, appId, source.id);
      expect(sourceAfter.widgets.map((w) => w.id).sort()).toEqual([w1.id, w2.id].sort());
      expect(sourceAfter.layout).toEqual(layout);
    });
  });

  describe('D-8 — setDefault: exactly one default per app', () => {
    it('setting a new default unsets the prior one — never two defaults at once', async () => {
      const defAppId = await createApp('d8-default');
      const ctx = ctxFor(owner);
      const first = await dashboardsService.create(ctx, { appId: defAppId, name: `d8-first-${suffix}`, isDefault: true });
      const second = await dashboardsService.create(ctx, { appId: defAppId, name: `d8-second-${suffix}` });

      await dashboardsService.setDefault(ctx, { appId: defAppId, dashboardId: second.id });

      const list = await dashboardsService.list(ctx, defAppId);
      const defaults = list.filter((d) => d.isDefault);
      expect(defaults).toEqual([expect.objectContaining({ id: second.id })]);
      expect(list.find((d) => d.id === first.id)!.isDefault).toBe(false);
    });
  });

  describe('D-9 — getOrCreateDefault: creates once from the template, then reuses it (additive sync is idempotent)', () => {
    it('the first call creates an "Overview" dashboard from DEFAULT_TEMPLATE_ID; the second call returns the SAME dashboard unchanged', async () => {
      const gocdAppId = await createApp('d9-gocd');
      const ctx = ctxFor(owner);
      const first = await dashboardsService.getOrCreateDefault(ctx, gocdAppId);
      expect(first.name).toBe('Overview');
      expect(first.isDefault).toBe(true);
      const template = await loadTemplates().then((ts) => ts.find((t) => t.id === DEFAULT_TEMPLATE_ID)!);
      expect(first.widgets).toHaveLength(template.widgetCount);

      const second = await dashboardsService.getOrCreateDefault(ctx, gocdAppId);
      expect(second.id).toBe(first.id);
      expect(second.widgets).toHaveLength(template.widgetCount);

      const list = await dashboardsService.list(ctx, gocdAppId);
      expect(list).toHaveLength(1);
    });
  });

  describe('D-10 — loadTemplates: the static catalog, no request context needed', () => {
    it('returns all three named templates with a positive widget count each', async () => {
      const templates = await loadTemplates();
      expect(templates.map((t) => t.id).sort()).toEqual(['agent-operations', 'agent-outcomes', 'cost-impact'].sort());
      for (const t of templates) expect(t.widgetCount).toBeGreaterThan(0);
    });
  });
});
