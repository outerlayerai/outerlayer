/**
 * Dashboard Org-Scoping RLS Integration Tests
 *
 * Verifies that dashboards and widgets are org-scoped (tenant + app):
 * - Two users in the same tenant see the same dashboards/widgets for a given app
 * - Users in different tenants are isolated
 * - Dashboards for different apps within the same tenant are independent
 * - All CRUD operations respect tenant-scoped RLS
 */

import {
  createAuthenticatedUser,
  cleanupTestUsers,
  getSupabaseAdmin,
  type TestUser,
} from '../lib/test-utils';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a second user in an existing tenant. */
async function createCoTenantUser(
  existingTenantId: string,
  role: string
): Promise<TestUser> {
  const admin = getSupabaseAdmin();
  const randomId = Math.random().toString(36).substring(2, 8);
  const email = `co-user-${Date.now()}-${randomId}@test.com`;
  const password = 'TestPassword123!';

  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (authError || !authData?.user)
    throw new Error(`Failed to create co-tenant user: ${authError?.message}`);

  const userId = authData.user.id;

  const { error: profileError } = await admin.from('profile').insert({
    id: userId,
    name: `Co-tenant User ${randomId}`,
    email,
  });
  if (profileError)
    throw new Error(`Profile creation failed: ${profileError.message}`);

  const { error: membershipError } = await admin.from('membership').insert({
    user_id: userId,
    tenant_id: existingTenantId,
    role,
    status: 'active',
  });
  if (membershipError)
    throw new Error(`Membership creation failed: ${membershipError.message}`);

  await admin.rpc('set_claim', { claim: 'tenant_id', uid: userId, value: existingTenantId });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: role });

  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
  );
  await userClient.auth.signInWithPassword({ email, password });
  await userClient.auth.refreshSession();

  return { id: userId, email, password, tenantId: existingTenantId, client: userClient };
}

/** Create an app via admin client. */
async function createApp(tenantId: string, createdBy: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('app')
    .insert({
      name: `Test App ${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      tenant_id: tenantId,
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (error) throw new Error(`App creation failed: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard Org-Scoping (RLS)', () => {
  let userA: TestUser;
  let userB: TestUser; // same tenant as A
  let outsider: TestUser; // different tenant
  let appId: string;
  let appBId: string; // second app in the same tenant
  let dashboardId: string;
  let widgetId: string;

  // IDs created during tests that need cleanup
  const createdDashboardIds: string[] = [];
  const createdWidgetIds: string[] = [];

  beforeAll(async () => {
    const admin = getSupabaseAdmin();

    userA = await createAuthenticatedUser('admin');
    userB = await createCoTenantUser(userA.tenantId, 'write');
    outsider = await createAuthenticatedUser('admin');

    // Two apps in the same tenant
    appId = await createApp(userA.tenantId, userA.id);
    appBId = await createApp(userA.tenantId, userA.id);

    // Create a dashboard + widget in App A (via admin client)
    const { data: dashboard, error: dashError } = await admin
      .from('dashboard')
      .insert({
        app_id: appId,
        tenant_id: userA.tenantId,
        name: 'Shared Dashboard',
        created_by: userA.id,
      })
      .select()
      .single();
    if (dashError) throw new Error(`Dashboard creation failed: ${dashError.message}`);
    dashboardId = dashboard.id;
    createdDashboardIds.push(dashboardId);

    const { data: widget, error: widgetError } = await admin
      .from('dashboard_widget')
      .insert({
        dashboard_id: dashboardId,
        tenant_id: userA.tenantId,
        title: 'Request Count',
        metric: 'request_count',
        visualization: 'line',
        created_by: userA.id,
      })
      .select()
      .single();
    if (widgetError) throw new Error(`Widget creation failed: ${widgetError.message}`);
    widgetId = widget.id;
    createdWidgetIds.push(widgetId);
  });

  afterAll(async () => {
    const admin = getSupabaseAdmin();

    // Clean up widgets, dashboards, apps
    for (const wid of createdWidgetIds) {
      await admin.from('dashboard_widget').delete().eq('id', wid);
    }
    for (const did of createdDashboardIds) {
      await admin.from('dashboard').delete().eq('id', did);
    }
    await admin.from('app').delete().eq('id', appId);
    await admin.from('app').delete().eq('id', appBId);

    // Clean up co-tenant user
    await admin.from('membership').delete().eq('user_id', userB.id);
    await admin.from('profile').delete().eq('id', userB.id);
    await admin.auth.admin.deleteUser(userB.id);

    await cleanupTestUsers();
  });

  // =========================================================================
  // Dashboard: same-tenant visibility
  // =========================================================================

  it('user A can see the dashboard', async () => {
    const { data, error } = await userA.client
      .from('dashboard')
      .select('id, name')
      .eq('id', dashboardId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.name).toBe('Shared Dashboard');
  });

  it('user B (same tenant, different user) can see the dashboard', async () => {
    const { data, error } = await userB.client
      .from('dashboard')
      .select('id, name')
      .eq('id', dashboardId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.name).toBe('Shared Dashboard');
  });

  it('both users see identical dashboard lists for the app', async () => {
    const [resultA, resultB] = await Promise.all([
      userA.client.from('dashboard').select('id, name').eq('app_id', appId),
      userB.client.from('dashboard').select('id, name').eq('app_id', appId),
    ]);

    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();
    expect(resultA.data).toEqual(resultB.data);
  });

  // =========================================================================
  // Widget: same-tenant visibility
  // =========================================================================

  it('user A can see widgets on the dashboard', async () => {
    const { data, error } = await userA.client
      .from('dashboard_widget')
      .select('id, title')
      .eq('dashboard_id', dashboardId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.title).toBe('Request Count');
  });

  it('user B can see widgets on a dashboard created by user A', async () => {
    const { data, error } = await userB.client
      .from('dashboard_widget')
      .select('id, title')
      .eq('dashboard_id', dashboardId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.title).toBe('Request Count');
  });

  // =========================================================================
  // Cross-tenant isolation: dashboards
  // =========================================================================

  it('outsider cannot read the dashboard', async () => {
    const { data, error } = await outsider.client
      .from('dashboard')
      .select('id')
      .eq('id', dashboardId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('outsider cannot update the dashboard', async () => {
    const { data } = await outsider.client
      .from('dashboard')
      .update({ description: 'Hacked' })
      .eq('id', dashboardId)
      .select();

    expect(data).toHaveLength(0);
  });

  it('outsider cannot delete the dashboard', async () => {
    const { data } = await outsider.client
      .from('dashboard')
      .delete()
      .eq('id', dashboardId)
      .select();

    expect(data).toHaveLength(0);

    // Verify it still exists
    const admin = getSupabaseAdmin();
    const { data: check } = await admin
      .from('dashboard')
      .select('id')
      .eq('id', dashboardId);
    expect(check).toHaveLength(1);
  });

  // =========================================================================
  // Cross-tenant isolation: widgets
  // =========================================================================

  it('outsider cannot read widgets', async () => {
    const { data, error } = await outsider.client
      .from('dashboard_widget')
      .select('id')
      .eq('id', widgetId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('outsider cannot update widgets', async () => {
    const { data } = await outsider.client
      .from('dashboard_widget')
      .update({ title: 'Hacked Widget' })
      .eq('id', widgetId)
      .select();

    expect(data).toHaveLength(0);
  });

  // =========================================================================
  // App-level isolation within the same tenant
  // =========================================================================

  it('dashboards for App A do not appear when querying App B', async () => {
    const { data, error } = await userA.client
      .from('dashboard')
      .select('id, name')
      .eq('app_id', appBId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('App B gets its own dashboard independent of App A', async () => {
    const admin = getSupabaseAdmin();

    const { data: appBDash, error } = await admin
      .from('dashboard')
      .insert({
        app_id: appBId,
        tenant_id: userA.tenantId,
        name: 'App B Dashboard',
        created_by: userA.id,
      })
      .select()
      .single();
    if (error) throw new Error(`App B dashboard creation failed: ${error.message}`);
    createdDashboardIds.push(appBDash.id);

    // User A sees 1 dashboard per app
    const [appAResult, appBResult] = await Promise.all([
      userA.client.from('dashboard').select('id, name').eq('app_id', appId),
      userA.client.from('dashboard').select('id, name').eq('app_id', appBId),
    ]);

    expect(appAResult.data).toHaveLength(1);
    expect(appAResult.data![0]!.name).toBe('Shared Dashboard');

    expect(appBResult.data).toHaveLength(1);
    expect(appBResult.data![0]!.name).toBe('App B Dashboard');
  });

  // =========================================================================
  // Insert via authenticated client (proves INSERT policy works)
  // =========================================================================

  it('user B can create a dashboard via their own client', async () => {
    const { data, error } = await userB.client
      .from('dashboard')
      .insert({
        app_id: appId,
        tenant_id: userA.tenantId,
        name: 'Created By User B',
        created_by: userB.id,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.name).toBe('Created By User B');
    createdDashboardIds.push(data!.id);

    // User A can see it too
    const { data: fromA } = await userA.client
      .from('dashboard')
      .select('id, name')
      .eq('id', data!.id);
    expect(fromA).toHaveLength(1);
  });

  it('user B can add a widget via their own client', async () => {
    const { data, error } = await userB.client
      .from('dashboard_widget')
      .insert({
        dashboard_id: dashboardId,
        tenant_id: userA.tenantId,
        title: 'Widget By User B',
        metric: 'total_cost',
        visualization: 'stat',
        created_by: userB.id,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.title).toBe('Widget By User B');
    createdWidgetIds.push(data!.id);

    // User A can see the new widget
    const { data: fromA } = await userA.client
      .from('dashboard_widget')
      .select('id, title')
      .eq('id', data!.id);
    expect(fromA).toHaveLength(1);
  });

  it('outsider cannot insert a dashboard into the tenant', async () => {
    const { error } = await outsider.client
      .from('dashboard')
      .insert({
        app_id: appId,
        tenant_id: userA.tenantId,
        name: 'Outsider Dashboard',
        created_by: outsider.id,
      });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('row-level security');
  });

  // =========================================================================
  // Write operations are org-scoped
  // =========================================================================

  it('user B can update a dashboard created by user A', async () => {
    const { data, error } = await userB.client
      .from('dashboard')
      .update({ description: 'Updated by user B' })
      .eq('id', dashboardId)
      .select('id, description');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.description).toBe('Updated by user B');
  });

  it('user B can update a widget created by user A', async () => {
    const { data, error } = await userB.client
      .from('dashboard_widget')
      .update({ title: 'Renamed by B' })
      .eq('id', widgetId)
      .select('id, title');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.title).toBe('Renamed by B');
  });
});
