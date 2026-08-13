/**
 * Integration tests for app-scoped custom-role permission resolution.
 *
 * Client-side permission gating for an app-scoped user assigned a per-app custom
 * role routes through the SECURITY DEFINER RPC
 * `get_current_user_app_permissions`, which mirrors `app_authorize()` and
 * returns the caller's full effective set. Reading the RLS-gated
 * `custom_role_permission` table directly cannot work for such a user: that
 * table requires `custom_role.read`, a permission they do not hold, so the read
 * returns nothing and the app renders with zero permissions.
 *
 * These tests run against a REAL local Supabase (RLS + the actual SQL
 * functions) — exactly the surface the mocked unit tests can't exercise:
 *   1. The RPC returns the correct set for each resolution branch.
 *   2. The RPC agrees with `app_authorize()` permission-for-permission (parity).
 *   3. Security negatives: anon cannot call the RPC; authenticated cannot call
 *      the `get_org_permission_set` helper directly (it takes a tenant_id +
 *      custom_role_id and is SECURITY DEFINER — direct access would disclose
 *      any tenant's role permissions); no cross-tenant leak via the RPC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  checkRpcExists,
  type TestUser,
} from '../../lib/test-utils';
import { createTestApp } from '../../lib/app-test-utils';
import { retryOnTransientError } from '../../lib/retry';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ---------------------------------------------------------------------------
// Helpers (admin-side setup of custom roles + per-app assignments)
// ---------------------------------------------------------------------------

async function getMembershipId(userId: string, tenantId: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('membership')
    .select('id')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();
  if (error || !data) throw new Error(`membership lookup failed: ${error?.message}`);
  return data.id;
}

async function createCustomRole(
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('custom_role')
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error || !data) throw new Error(`custom_role insert failed: ${error?.message}`);

  const rows = permissions.map((permission) => ({
    custom_role_id: data.id,
    permission: permission as never,
  }));
  const { error: permError } = await retryOnTransientError(() =>
    admin.from('custom_role_permission').insert(rows),
  );
  if (permError) throw new Error(`custom_role_permission insert failed: ${permError.message}`);

  return data.id;
}

async function assignPerAppRole(opts: {
  membershipId: string;
  appId: string;
  tenantId: string;
  role: 'read' | 'write' | 'admin';
  customRoleId?: string | null;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.from('app_member_role').insert({
    membership_id: opts.membershipId,
    app_id: opts.appId,
    tenant_id: opts.tenantId,
    role: opts.role,
    custom_role_id: opts.customRoleId ?? null,
  });
  if (error) throw new Error(`app_member_role insert failed: ${error.message}`);
}

async function setMembershipScope(
  userId: string,
  opts: { isAppScoped: boolean; orgCustomRoleId?: string | null },
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('membership')
    .update({
      is_app_scoped: opts.isAppScoped,
      custom_role_id: opts.orgCustomRoleId ?? null,
    })
    .eq('user_id', userId);
  if (error) throw new Error(`membership scope update failed: ${error.message}`);
}

/** Call the RPC as the given user and return the granted permission set. */
async function appPerms(user: TestUser, appId: string): Promise<Set<string>> {
  // Wrapped: under CI load Kong/PostgREST can surface a transient "upstream
  // server" blip on this read — retry it rather than fail the suite.
  const { data, error } = await retryOnTransientError(() =>
    user.client.rpc('get_current_user_app_permissions', {
      target_app_id: appId,
    })
  );
  if (error) throw new Error(`get_current_user_app_permissions failed: ${error.message}`);
  return new Set((data ?? []) as string[]);
}

/** Call app_authorize as the given user for one permission. */
async function appAuthorize(user: TestUser, permission: string, appId: string): Promise<boolean> {
  // Wrapped: the parity loop fires this RPC many times back-to-back, which is
  // exactly where a transient gateway blip surfaces.
  const { data, error } = await retryOnTransientError(() =>
    user.client.rpc('app_authorize', {
      requested_permission: permission as never,
      target_app_id: appId,
    })
  );
  if (error) throw new Error(`app_authorize(${permission}) failed: ${error.message}`);
  return data === true;
}

// A spread of permissions across resources — used for parity assertions.
const PARITY_PROBE = [
  'app.read',
  'app.update',
  'app.delete',
  'sso_config.read',
  'sso_config.insert',
  'sso_config.update',
  'sso_config.delete',
  'trace.read',
  'audit_log.read',
  'env_var.read',
];

// ---------------------------------------------------------------------------

describe('get_current_user_app_permissions — app-scoped custom-role resolution', () => {
  let skip = false;

  beforeAll(async () => {
    const check = await checkRpcExists('get_current_user_app_permissions', {
      target_app_id: '00000000-0000-0000-0000-000000000000',
    });
    skip = !check.available;
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('returns the per-app custom role permission set for an app-scoped user (the blank-app bug)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read'); // org built-in role is plain "read"
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);

    // Custom role grants write perms the built-in "read" role does NOT have —
    // so a regression to the built-in role would be visible (insert/update drop).
    const granted = ['app.read', 'app.update', 'sso_config.read', 'sso_config.insert', 'sso_config.update'];
    const customRoleId = await createCustomRole(user.tenantId, `files-editor-${Date.now()}`, granted);

    await assignPerAppRole({
      membershipId,
      appId: app.id,
      tenantId: user.tenantId,
      role: 'read',
      customRoleId,
    });
    await setMembershipScope(user.id, { isAppScoped: true });

    const perms = await appPerms(user, app.id);

    // Exact set — not a superset, not the built-in "read" set.
    expect([...perms].sort()).toEqual([...granted].sort());
    // The write perms that the built-in "read" role lacks are present.
    expect(perms.has('sso_config.insert')).toBe(true);
    expect(perms.has('sso_config.update')).toBe(true);
    expect(perms.has('app.update')).toBe(true);
    // Perms the custom role does not grant are absent.
    expect(perms.has('sso_config.delete')).toBe(false);
    expect(perms.has('trace.read')).toBe(false);
  });

  it('agrees with app_authorize() permission-for-permission for that user (parity)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);
    const granted = ['app.read', 'app.update', 'sso_config.read', 'sso_config.insert', 'sso_config.update'];
    const customRoleId = await createCustomRole(user.tenantId, `files-editor-${Date.now()}`, granted);
    await assignPerAppRole({ membershipId, appId: app.id, tenantId: user.tenantId, role: 'read', customRoleId });
    await setMembershipScope(user.id, { isAppScoped: true });

    const perms = await appPerms(user, app.id);
    for (const permission of PARITY_PROBE) {
      const viaAuthorize = await appAuthorize(user, permission, app.id);
      expect(perms.has(permission)).toBe(viaAuthorize);
    }
  });

  // proves AC-075-06
  it('returns an empty set for an app the app-scoped user is not assigned to (fail-closed)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const assignedApp = await createTestApp(user.tenantId);
    const otherApp = await createTestApp(user.tenantId);
    const customRoleId = await createCustomRole(user.tenantId, `files-editor-${Date.now()}`, ['app.read', 'sso_config.read']);
    await assignPerAppRole({ membershipId, appId: assignedApp.id, tenantId: user.tenantId, role: 'read', customRoleId });
    await setMembershipScope(user.id, { isAppScoped: true });

    const perms = await appPerms(user, otherApp.id);
    expect(perms.size).toBe(0);
    expect(await appAuthorize(user, 'sso_config.read', otherApp.id)).toBe(false);
  });

  it('returns the built-in role set when the per-app assignment uses a built-in role', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);
    await assignPerAppRole({ membershipId, appId: app.id, tenantId: user.tenantId, role: 'read', customRoleId: null });
    await setMembershipScope(user.id, { isAppScoped: true });

    const perms = await appPerms(user, app.id);
    // Built-in "read" grants tenant.read but not tenant.update.
    expect(perms.has('tenant.read')).toBe(true);
    expect(perms.has('app.read')).toBe(true);
    expect(perms.has('tenant.update')).toBe(false);
    // Parity with app_authorize on the built-in path too.
    for (const permission of PARITY_PROBE) {
      expect(perms.has(permission)).toBe(await appAuthorize(user, permission, app.id));
    }
  });

  it('falls back to the org-level custom role for an unrestricted user (not app-scoped)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const app = await createTestApp(user.tenantId);
    const granted = ['app.read', 'sso_config.read', 'sso_config.insert'];
    const customRoleId = await createCustomRole(user.tenantId, `org-role-${Date.now()}`, granted);

    // Unrestricted + org-level custom role. Refresh the session so the access
    // token hook repopulates the custom_role_id claim from membership — this is
    // the production flow and keeps authorize() (JWT) in sync with the RPC
    // (table) for the org-level branch.
    await setMembershipScope(user.id, { isAppScoped: false, orgCustomRoleId: customRoleId });
    await user.client.auth.refreshSession();

    const perms = await appPerms(user, app.id);
    expect([...perms].sort()).toEqual([...granted].sort());
    for (const permission of PARITY_PROBE) {
      expect(perms.has(permission)).toBe(await appAuthorize(user, permission, app.id));
    }
  });
});

describe('app-scoped custom-role RPC — security negatives', () => {
  let skip = false;

  beforeAll(async () => {
    const check = await checkRpcExists('get_current_user_app_permissions', {
      target_app_id: '00000000-0000-0000-0000-000000000000',
    });
    skip = !check.available;
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('denies an anonymous (unauthenticated) caller', async () => {
    if (skip) return;
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await anon.rpc('get_current_user_app_permissions', {
      target_app_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not.*find|forbidden/i);
  });

  it('forbids an authenticated user from calling get_org_permission_set directly', async () => {
    if (skip) return;
    // This SECURITY DEFINER helper takes tenant_id + custom_role_id as params;
    // direct access would disclose any tenant's role permissions, so
    // authenticated callers must hold no EXECUTE grant on it.
    const attacker = await createAuthenticatedUser('owner');
    const victim = await createAuthenticatedUser('read');
    const victimRoleId = await createCustomRole(victim.tenantId, `victim-secret-${Date.now()}`, [
      'app.read',
      'sso_config.delete',
    ]);

    const { data, error } = await (attacker.client.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('get_org_permission_set', {
      p_custom_role_id: victimRoleId,
      p_role: 'read',
      p_tenant_id: victim.tenantId,
    });

    expect(error).not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not.*find|forbidden/i);
    // Denied PostgREST RPC returns no rows.
    expect(data).toBeNull();
  });

  it('does not leak another tenant\'s app permissions via target_app_id', async () => {
    if (skip) return;
    const attacker = await createAuthenticatedUser('read');
    const victim = await createAuthenticatedUser('read');

    // Victim has a richly-permissioned per-app custom role in their own tenant.
    const victimMembership = await getMembershipId(victim.id, victim.tenantId);
    const victimApp = await createTestApp(victim.tenantId);
    const victimRoleId = await createCustomRole(victim.tenantId, `victim-${Date.now()}`, [
      'app.read',
      'sso_config.read',
      'sso_config.delete',
    ]);
    await assignPerAppRole({
      membershipId: victimMembership,
      appId: victimApp.id,
      tenantId: victim.tenantId,
      role: 'read',
      customRoleId: victimRoleId,
    });

    // Attacker is app-scoped in their own tenant with no row for the victim app.
    await setMembershipScope(attacker.id, { isAppScoped: true });

    // Asking for the victim's app id must NOT return the victim's permissions.
    const perms = await appPerms(attacker, victimApp.id);
    expect(perms.size).toBe(0);
    expect(perms.has('sso_config.delete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dashboard_widget RLS — app-aware policies.
//
// The parent `dashboard` policies authorize via app_authorize(perm, app_id),
// and the widget policies must resolve the same way — through the tenant-bound
// SECURITY DEFINER helper get_dashboard_app_id(). A widget policy that instead
// used org-level authorize() would fail RLS on EVERY widget write by an
// app-scoped member (custom roles and built-in per-app roles alike, e.g.
// creating a dashboard from a template), because such members hold no org-level
// permissions at all even when their per-app role grants dashboard.*.
// ---------------------------------------------------------------------------

describe('dashboard_widget RLS — app-scoped members', () => {
  let skip = false;

  beforeAll(async () => {
    const check = await checkRpcExists('get_dashboard_app_id', {
      target_dashboard_id: '00000000-0000-0000-0000-000000000000',
    });
    skip = !check.available;
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  async function createDashboard(appId: string, tenantId: string, name: string): Promise<string> {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('dashboard')
      .insert({ app_id: appId, tenant_id: tenantId, name })
      .select('id')
      .single();
    if (error || !data) throw new Error(`dashboard insert failed: ${error?.message}`);
    return data.id;
  }

  const widgetRow = (dashboardId: string, tenantId: string, title: string) => ({
    dashboard_id: dashboardId,
    tenant_id: tenantId,
    title,
    metric: 'trace_count',
    visualization: 'line',
  });

  it('lets an app-scoped custom-role member with dashboard.* manage widgets (the use-template bug)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);
    const customRoleId = await createCustomRole(user.tenantId, `dash-manager-${Date.now()}`, [
      'app.read',
      'dashboard.read',
      'dashboard.insert',
      'dashboard.update',
      'dashboard.delete',
    ]);
    await assignPerAppRole({ membershipId, appId: app.id, tenantId: user.tenantId, role: 'read', customRoleId });
    await setMembershipScope(user.id, { isAppScoped: true });

    const dashboardId = await createDashboard(app.id, user.tenantId, `widgets-${Date.now()}`);

    // INSERT — the write an org-level widget policy would reject with 42501.
    const { data: inserted, error: insertError } = await user.client
      .from('dashboard_widget')
      .insert(widgetRow(dashboardId, user.tenantId, 'Trace volume'))
      .select('id, title')
      .single();
    expect(insertError).toBeNull();
    expect(inserted?.title).toBe('Trace volume');

    // SELECT
    const { data: readBack } = await user.client
      .from('dashboard_widget')
      .select('id')
      .eq('dashboard_id', dashboardId);
    expect((readBack ?? []).map((r) => r.id)).toEqual([inserted!.id]);

    // UPDATE
    const { data: updated, error: updateError } = await user.client
      .from('dashboard_widget')
      .update({ title: 'Trace volume (renamed)' })
      .eq('id', inserted!.id)
      .select('title')
      .single();
    expect(updateError).toBeNull();
    expect(updated?.title).toBe('Trace volume (renamed)');

    // DELETE
    const { error: deleteError, count } = await user.client
      .from('dashboard_widget')
      .delete({ count: 'exact' })
      .eq('id', inserted!.id);
    expect(deleteError).toBeNull();
    expect(count).toBe(1);
  });

  it('lets an app-scoped member with the built-in write role create widgets', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);
    await assignPerAppRole({ membershipId, appId: app.id, tenantId: user.tenantId, role: 'write', customRoleId: null });
    await setMembershipScope(user.id, { isAppScoped: true });

    const dashboardId = await createDashboard(app.id, user.tenantId, `builtin-${Date.now()}`);

    const { error } = await user.client
      .from('dashboard_widget')
      .insert(widgetRow(dashboardId, user.tenantId, 'Cost over time'));
    expect(error).toBeNull();
  });

  it('still denies widget creation when the per-app role lacks dashboard.insert (fail-closed)', async () => {
    if (skip) return;
    const user = await createAuthenticatedUser('read');
    const membershipId = await getMembershipId(user.id, user.tenantId);
    const app = await createTestApp(user.tenantId);
    const viewerRoleId = await createCustomRole(user.tenantId, `dash-viewer-${Date.now()}`, [
      'app.read',
      'dashboard.read',
    ]);
    await assignPerAppRole({ membershipId, appId: app.id, tenantId: user.tenantId, role: 'read', customRoleId: viewerRoleId });
    await setMembershipScope(user.id, { isAppScoped: true });

    const dashboardId = await createDashboard(app.id, user.tenantId, `viewer-${Date.now()}`);

    const { error } = await user.client
      .from('dashboard_widget')
      .insert(widgetRow(dashboardId, user.tenantId, 'Should not exist'));
    expect(error?.code).toBe('42501');
  });

  it('denies inserting a widget under another tenant\'s dashboard even for an unrestricted owner', async () => {
    if (skip) return;
    // get_dashboard_app_id() is tenant-bound and returns NULL for a foreign
    // dashboard; the policies require it NOT NULL, which closes the path where
    // app_authorize(perm, NULL) falls back to the org-level role and passes.
    const attacker = await createAuthenticatedUser('owner');
    const victim = await createAuthenticatedUser('owner');
    const victimApp = await createTestApp(victim.tenantId);
    const victimDashboardId = await createDashboard(victimApp.id, victim.tenantId, `victim-${Date.now()}`);

    const { error } = await attacker.client
      .from('dashboard_widget')
      .insert(widgetRow(victimDashboardId, attacker.tenantId, 'Cross-tenant widget'));
    expect(error?.code).toBe('42501');
  });
});
