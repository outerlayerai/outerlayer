/**
 * Dashboards acceptance — CRUD reads/writes and cross-tenant isolation are
 * tenant- and permission-scoped, asserted as business behavior through the
 * real PostgREST → RLS wire path.
 *
 * A dashboard request derives its tenant from the URL org and sends it as an
 * `X-Tenant-Id` header — the signal `read.ts`'s RSC loaders and every
 * `authorizedAction` mutation in `features/dashboards/actions.ts` resolve
 * `ctx.tenantId` from, not the JWT claim. `dashboard`/`dashboard_widget`
 * policies gate SELECT on `dashboard.read` + tenant match, and
 * INSERT/UPDATE/DELETE on `dashboard.insert|update|delete` + tenant match
 * (widget policies mirror this through the parent dashboard's app via
 * `private.get_dashboard_app_id`). `dashboard-org-scoping.test.ts` already
 * proves this table's tenant isolation end-to-end under the legacy
 * claim-scoped client; this suite proves the same isolation holds under the
 * header-scoped client the migrated reads/writes actually use, and adds the
 * read-vs-write permission split the older suite never exercised (its two
 * co-tenant users both held write-capable roles).
 *
 * Widget-data's tenant scoping is not re-proven here: `route.test.ts`
 * (co-located with the re-pathed route) already asserts `getAnalyticsService`
 * is called with the request tenant, and `security/clickhouse-read-path-leak
 * .test.ts` already proves the cross-tenant ClickHouse leak case on the same
 * `AnalyticsService` class — duplicating either here would just be two tests
 * for one fact.
 *
 * `dashboard`/`dashboard_widget` are absent from the generated Database type
 * (a pre-existing gap, not introduced by this slice), so they are addressed
 * through an untyped client.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

/** Address dashboard/dashboard_widget (absent from the generated Database type) untyped. */
const untyped = (client: unknown) => client as SupabaseClient;

describe('dashboards reads and writes are tenant- and permission-scoped', () => {
  const admin = createSupabaseAdminClientUntyped();

  let orgA: SameTenantUser; // owner of A → holds dashboard.insert/update/delete
  let orgB: SameTenantUser; // owner of B, member of B only
  let readerA: SameTenantUser; // read role in A → holds dashboard.read only

  let appA: string;
  let appB: string;
  let dashA: string; // a dashboard under org A
  let dashB: string; // a dashboard under org B
  let widgetA: string; // a widget on dashA

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id as string;
  };

  const seedDashboard = async (tenantId: string, appId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('dashboard')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        name: `dash-${randomUUID().slice(0, 8)}`,
        created_by: createdBy,
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed dashboard: ${error.message}`);
    return data!.id as string;
  };

  const seedWidget = async (tenantId: string, dashboardId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('dashboard_widget')
      .insert({
        tenant_id: tenantId,
        dashboard_id: dashboardId,
        title: 'Request Count',
        metric: 'request_count',
        visualization: 'line',
        created_by: createdBy,
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed widget: ${error.message}`);
    return data!.id as string;
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    readerA = await addUserToTenant(orgA.tenantId, 'read');

    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`dash-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`dash-b-${suffix}`, orgB.tenantId, orgB.id);
    dashA = await seedDashboard(orgA.tenantId, appA, orgA.id);
    dashB = await seedDashboard(orgB.tenantId, appB, orgB.id);
    widgetA = await seedWidget(orgA.tenantId, dashA, orgA.id);
  }, 90000);

  afterAll(async () => {
    await admin.from('dashboard_widget').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('dashboard').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, readerA.id]);
    for (const user of [orgA, orgB, readerA]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant leak — dashboards + widgets
  // ---------------------------------------------------------------------------

  it("a member of A sees exactly A's dashboards and widgets, never B's", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data: dashboards, error: dashError } = await untyped(asA).from('dashboard').select('id');
    expect(dashError).toBeNull();
    expect((dashboards ?? []).map((r: { id: string }) => r.id)).toEqual([dashA]);

    const { data: widgets, error: widgetError } = await untyped(asA)
      .from('dashboard_widget')
      .select('id')
      .eq('dashboard_id', dashA);
    expect(widgetError).toBeNull();
    expect((widgets ?? []).map((r: { id: string }) => r.id)).toEqual([widgetA]);

    // Org B's dashboard is never reachable under org A, even probed by its id.
    const { data: crossProbe, error: probeError } = await untyped(asA)
      .from('dashboard')
      .select('id')
      .eq('id', dashB);
    expect(probeError).toBeNull();
    expect(crossProbe).toEqual([]);
  });

  it('a request naming an app that belongs to another org returns empty, never that org\'s dashboards', async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data, error } = await untyped(asA).from('dashboard').select('id').eq('app_id', appB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('operating under an org the user does not belong to yields no dashboard reads', async () => {
    // Org A's owner is not a member of org B — the fail-closed / spoof case.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);

    const { data: reads, error: readError } = await untyped(asBSpoof).from('dashboard').select('id');
    expect(readError).toBeNull();
    expect(reads).toEqual([]);

    const { data: probe, error: probeError } = await untyped(asBSpoof)
      .from('dashboard')
      .select('id')
      .eq('id', dashB);
    expect(probeError).toBeNull();
    expect(probe).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // CRUD authz'd + tenant-scoped
  // ---------------------------------------------------------------------------

  it('the owner (dashboard.insert/update/delete) can create, rename, add a widget, and delete', async () => {
    const asOwner = await createTenantScopedClient(orgA, orgA.tenantId);

    const { data: created, error: createError } = await untyped(asOwner)
      .from('dashboard')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, name: `owner-crud-${randomUUID().slice(0, 8)}`, created_by: orgA.id })
      .select('id, name')
      .single();
    expect(createError).toBeNull();
    expect(created).not.toBeNull();
    const createdId = created!.id as string;

    const newName = `renamed-${randomUUID().slice(0, 8)}`;
    const { data: renamed, error: renameError } = await untyped(asOwner)
      .from('dashboard')
      .update({ name: newName })
      .eq('id', createdId)
      .select('id, name');
    expect(renameError).toBeNull();
    expect(renamed).toEqual([{ id: createdId, name: newName }]);

    const { data: widget, error: widgetError } = await untyped(asOwner)
      .from('dashboard_widget')
      .insert({
        tenant_id: orgA.tenantId,
        dashboard_id: createdId,
        title: 'New Widget',
        metric: 'total_cost',
        visualization: 'stat',
        created_by: orgA.id,
      })
      .select('id')
      .single();
    expect(widgetError).toBeNull();
    expect(widget).not.toBeNull();

    const { data: deleted, error: deleteError } = await untyped(asOwner)
      .from('dashboard')
      .delete()
      .eq('id', createdId)
      .select('id');
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([{ id: createdId }]);

    // ON DELETE CASCADE takes the widget with it.
    const { data: widgetAfter } = await admin.from('dashboard_widget').select('id').eq('id', widget!.id as string);
    expect(widgetAfter).toEqual([]);
  });

  it('a read-only role (dashboard.read only) is denied every write, but the owner is not', async () => {
    const asReader = await createTenantScopedClient(readerA, orgA.tenantId);

    // Read-only member sees the seeded dashboard.
    const { data: readerSees, error: readerReadError } = await untyped(asReader)
      .from('dashboard')
      .select('id')
      .eq('id', dashA);
    expect(readerReadError).toBeNull();
    expect((readerSees ?? []).map((r: { id: string }) => r.id)).toEqual([dashA]);

    // INSERT policy matches zero rows — the read-only member holds no dashboard.insert.
    const { data: deniedInsert, error: insertError } = await untyped(asReader)
      .from('dashboard')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, name: `reader-denied-${randomUUID().slice(0, 8)}`, created_by: readerA.id })
      .select('id');
    expect(insertError).not.toBeNull();
    expect(deniedInsert).toBeNull();

    // UPDATE policy matches zero rows.
    const { data: deniedUpdate, error: updateError } = await untyped(asReader)
      .from('dashboard')
      .update({ description: 'reader edit' })
      .eq('id', dashA)
      .select('id');
    expect(updateError).toBeNull();
    expect(deniedUpdate).toEqual([]);

    // DELETE policy matches zero rows.
    const { data: deniedDelete, error: deleteError } = await untyped(asReader)
      .from('dashboard')
      .delete()
      .eq('id', dashA)
      .select('id');
    expect(deleteError).toBeNull();
    expect(deniedDelete).toEqual([]);

    // Widget writes are denied the same way, through the parent-dashboard app lookup.
    const { data: deniedWidget, error: widgetInsertError } = await untyped(asReader)
      .from('dashboard_widget')
      .insert({ tenant_id: orgA.tenantId, dashboard_id: dashA, title: 'Reader Widget', metric: 'total_cost', visualization: 'stat', created_by: readerA.id })
      .select('id');
    expect(widgetInsertError).not.toBeNull();
    expect(deniedWidget).toBeNull();

    // The row is untouched by every denied write.
    const { data: afterReader } = await admin.from('dashboard').select('description').eq('id', dashA).single();
    expect(afterReader!.description).toBeNull();

    // The owner, holding dashboard.update, can make the same edit the reader was denied.
    const asOwner = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: ownerUpdate, error: ownerUpdateError } = await untyped(asOwner)
      .from('dashboard')
      .update({ description: 'owner edit' })
      .eq('id', dashA)
      .select('id, description');
    expect(ownerUpdateError).toBeNull();
    expect(ownerUpdate).toEqual([{ id: dashA, description: 'owner edit' }]);
  });

  it('a non-member write under a spoofed tenant header lands nothing', async () => {
    // Org B's owner, operating under org A's tenant, cannot create or touch A's rows.
    const asBSpoof = await createTenantScopedClient(orgB, orgA.tenantId);

    const { data: spoofedInsert, error: insertError } = await untyped(asBSpoof)
      .from('dashboard')
      .insert({ tenant_id: orgA.tenantId, app_id: appA, name: `spoof-${randomUUID().slice(0, 8)}`, created_by: orgB.id })
      .select('id');
    expect(insertError).not.toBeNull();
    expect(spoofedInsert).toBeNull();

    const { data: spoofedUpdate, error: updateError } = await untyped(asBSpoof)
      .from('dashboard')
      .update({ name: 'hijacked' })
      .eq('id', dashA)
      .select('id');
    expect(updateError).toBeNull();
    expect(spoofedUpdate).toEqual([]);

    const { data: spoofedDelete, error: deleteError } = await untyped(asBSpoof)
      .from('dashboard')
      .delete()
      .eq('id', dashA)
      .select('id');
    expect(deleteError).toBeNull();
    expect(spoofedDelete).toEqual([]);

    // dashA still exists, untouched.
    const { data: stillThere } = await admin.from('dashboard').select('id, name').eq('id', dashA).single();
    expect(stillThere!.id).toBe(dashA);
  });
});
