/**
 * Seed request-scope acceptance — the app cluster's RSC seed (app object,
 * app list, permission set, and per-app role assignments) resolves under the
 * URL org the request names, not the JWT claim, asserted through the real
 * PostgREST → RLS wire path.
 *
 * The `[appName]` layout seeds the client cluster once, server-side, by
 * reading the app row (`getAppByName`), the org's app list (`listOrgApps`),
 * the effective permission set (`get_current_user_app_permissions`), and the
 * user's own `app_member_role` rows, all through a header-scoped client. The
 * org layout also seeds the role assignments a second time, org-wide, so
 * org-level consumers (outside any specific app) resolve them too.
 * These tests drive those exact reads: a member operating under their own org
 * gets that org's seed; the same member operating under an org they do not
 * belong to gets the fail-closed empty seed — never another org's — so a
 * stale claim can never seed one tenant's data into another's view.
 *
 * Complements rbac/request-tenant-visibility.acceptance.test.ts (table reads);
 * this pins the reads the app cluster's seed specifically depends on.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';

describe('app-cluster seed is request-scoped', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser; // owner of A
  let orgB: SameTenantUser; // owner of B (A's owner is NOT a member of B)
  let restrictedA: SameTenantUser; // app-scoped member of A with a role on appA

  let appA: string;
  let appAName: string;
  let appA2Name: string;

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();

    const suffix = randomUUID().slice(0, 8);
    appAName = `seed-a-${suffix}`;
    appA2Name = `seed-a2-${suffix}`;
    const { data: appRow, error: appError } = await admin
      .from('app')
      .insert({ name: appAName, tenant_id: orgA.tenantId, created_by: orgA.id })
      .select('id')
      .single();
    if (appError) throw new Error(`seed app: ${appError.message}`);
    appA = appRow!.id;

    // A second app in A, so the app-LIST seed (listOrgApps) has more than one
    // row to order and scope.
    const { error: app2Error } = await admin
      .from('app')
      .insert({ name: appA2Name, tenant_id: orgA.tenantId, created_by: orgA.id });
    if (app2Error) throw new Error(`seed app 2: ${app2Error.message}`);

    // A restricted member of A with exactly one per-app role row (on appA), so
    // the app_member_role seed read has a scoped row to return.
    restrictedA = await addUserToTenant(orgA.tenantId, 'read');
    const { error: scopeError } = await admin
      .from('membership')
      .update({ is_app_scoped: true })
      .eq('id', restrictedA.membershipId);
    if (scopeError) throw new Error(`is_app_scoped: ${scopeError.message}`);
    const { error: roleError } = await admin.from('app_member_role').insert({
      membership_id: restrictedA.membershipId,
      app_id: appA,
      tenant_id: orgA.tenantId,
      role: 'read',
    });
    if (roleError) throw new Error(`app_member_role: ${roleError.message}`);
  }, 90000);

  afterAll(async () => {
    await admin.from('app_member_role').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin
      .from('membership')
      .delete()
      .in('user_id', [orgA.id, orgB.id, restrictedA.id]);
    for (const user of [orgA, orgB, restrictedA]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it("seeds the permission set under the member's own org, and the fail-closed empty set under a non-member org", async () => {
    // Owner of A, operating under A: the seed's permission RPC grants A's set.
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: aPerms, error: aErr } = await asA.rpc(
      'get_current_user_app_permissions',
      { target_app_id: appA },
    );
    expect(aErr).toBeNull();
    expect((aPerms ?? []).length).toBeGreaterThan(0);

    // The SAME user operating under org B (not a member): the seed resolves to
    // the empty set — B's header admits nothing, and A's permissions never leak
    // through it.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);
    const { data: bPerms, error: bErr } = await asBSpoof.rpc(
      'get_current_user_app_permissions',
      { target_app_id: appA },
    );
    expect(bErr).toBeNull();
    expect(bPerms ?? []).toEqual([]);
  });

  it("seeds the member's own app_member_role rows under their org, and none under a non-member org", async () => {
    // Under A the app-role seed read (filtered by the caller's membership_id)
    // returns exactly the restricted member's own row on appA.
    const asA = await createTenantScopedClient(restrictedA, orgA.tenantId);
    const { data: aRoles, error: aErr } = await asA
      .from('app_member_role')
      .select('app_id, role, membership_id')
      .eq('membership_id', restrictedA.membershipId);
    expect(aErr).toBeNull();
    expect(aRoles).toEqual([
      { app_id: appA, role: 'read', membership_id: restrictedA.membershipId },
    ]);

    // Under org B (non-member) the same read is fail-closed: no rows, so the
    // seed never hands a member another org's (or a stale) access scope.
    const asBSpoof = await createTenantScopedClient(restrictedA, orgB.tenantId);
    const { data: bRoles, error: bErr } = await asBSpoof
      .from('app_member_role')
      .select('app_id, role, membership_id')
      .eq('membership_id', restrictedA.membershipId);
    expect(bErr).toBeNull();
    expect(bRoles).toEqual([]);
  });

  // Pins the read `getAppByName` performs.
  it("seeds the app object under the member's own org, and the fail-closed empty result under a non-member org", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: aApp, error: aErr } = await asA
      .from('app')
      .select('*, git_connection!git_connection_app_id_fkey(app_id, repository, provider), git_branch!github_branch_app_id_fkey(branch_name)')
      .eq('name', appAName)
      .single();
    expect(aErr).toBeNull();
    expect(aApp?.id).toBe(appA);

    // The SAME user under org B's header (not a member): the row never
    // resolves through B's tenant scope — `.single()` errors on zero rows,
    // it never silently returns A's row.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);
    const { data: bApp, error: bErr } = await asBSpoof
      .from('app')
      .select('*, git_connection!git_connection_app_id_fkey(app_id, repository, provider), git_branch!github_branch_app_id_fkey(branch_name)')
      .eq('name', appAName)
      .single();
    expect(bApp).toBeNull();
    expect(bErr).not.toBeNull();
  });

  // Pins the read `listOrgApps` performs.
  it("seeds the org's app list under the member's own org, and none under a non-member org", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);
    const { data: aApps, error: aErr } = await asA
      .from('app')
      .select('id, name, display_name')
      .order('name', { ascending: true });
    expect(aErr).toBeNull();
    // Re-sort in JS: the DB's ORDER BY follows the database collation, which
    // differs between C.UTF-8 and en_US.UTF-8 stacks for hyphenated names —
    // the invariant is WHICH apps are seeded, not their locale ordering.
    expect((aApps ?? []).map((a) => a.name).sort()).toEqual(
      [appAName, appA2Name].sort(),
    );

    // The SAME user under org B's header (not a member): B admits none of A's
    // apps — never a leaked row through the wrong tenant header.
    const asBSpoof = await createTenantScopedClient(orgA, orgB.tenantId);
    const { data: bApps, error: bErr } = await asBSpoof
      .from('app')
      .select('id, name, display_name')
      .order('name', { ascending: true });
    expect(bErr).toBeNull();
    expect((bApps ?? []).filter((a) => a.name === appAName || a.name === appA2Name)).toEqual([]);
  });
});

// The org-level role-seed case — `orgs/[orgName]/layout.tsx` (mounted above
// `TenantGuard`) calls the SAME request-scoped `app_member_role` read pinned
// above, just from a wider (org-level) call site; there is no additional
// data-layer behavior to distinguish there. The wiring itself (the seed
// reaching a consumer through the provider mounted above `TenantGuard`,
// `TenantGuard` still wrapping the exact same children) is pinned by the
// component-level suite: `src/app/(authenticated)/orgs/[orgName]/__tests__/layout.test.tsx`
// in the tenant-dashboard app.
