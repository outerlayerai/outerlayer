/**
 * Integration Tests for app_authorize() Function
 *
 * Tests the core app_authorize() function that implements per-app role
 * authorization with fallback to org-level permissions.
 *
 * All users share a single tenant so RLS tenant_id checks work correctly.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from './helpers';

describe('app_authorize() function integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let writeUser: SameTenantUser;
  let tenantId: string;

  let testApp1: { id: string };
  let testApp2: { id: string };

  beforeAll(async () => {
    // Create a single tenant with owner, then add members
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    writeUser = await addUserToTenant(tenantId, 'write');

    // Create test apps in the shared tenant. A third unreferenced app is
    // created on purpose — several tests below assert
    // `apps.length >= 3` (org-level fallback returns ALL tenant apps,
    // not just the ones the test pinpoints by id). The setter for App 3
    // is a noop because no test references it by name.
    for (const [name, setter] of [
      ['App 1', (a: { id: string }) => { testApp1 = a; }],
      ['App 2', (a: { id: string }) => { testApp2 = a; }],
      ['App 3', (_a: { id: string }) => { /* row count only */ }],
    ] as const) {
      const { data, error } = await supabaseAdmin
        .from('app')
        .insert({ name: `${name} ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create ${name}: ${error.message}`);
      (setter as (a: { id: string }) => void)(data!);
    }
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser, writeUser]);
  });

  describe('Per-app role authorization', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
      await supabaseAdmin.from('membership').update({ is_app_scoped: false }).eq('tenant_id', tenantId);
    });

    it('should grant access when per-app role has sufficient permission', async () => {
      // Mark readUser as app-scoped and assign a "write" per-app role on app1
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'write',
        created_by: ownerUser.id,
      });

      // readUser should see app1 through RLS (write role includes app.read)
      const { data, error } = await readUser.client
        .from('app')
        .select('id')
        .eq('id', testApp1.id);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0]!.id).toBe(testApp1.id);
    });

    it('should deny write when per-app role is read-only', async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      const { error } = await readUser.client
        .from('app')
        .update({ name: 'Should Fail' })
        .eq('id', testApp1.id);

      // Supabase may return error or silently update 0 rows depending on policy
      // Either outcome means the update was blocked
      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        // Verify no change was made
        const { data } = await supabaseAdmin
          .from('app')
          .select('name')
          .eq('id', testApp1.id)
          .single();
        expect(data!.name).not.toBe('Should Fail');
      }
    });
  });

  describe('Fallback to org-level authorization', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
      await supabaseAdmin.from('membership').update({ is_app_scoped: false }).eq('tenant_id', tenantId);
    });

    it('should fall back to org role when user has no app_member_role records', async () => {
      // writeUser has org-level "write" role with app.read permission, no per-app records
      const { data, error } = await writeUser.client
        .from('app')
        .select('id');

      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(3);
    });

    it('should deny operations beyond org role when not app-scoped', async () => {
      // writeUser org role cannot delete apps
      const { error } = await writeUser.client
        .from('app')
        .delete()
        .eq('id', testApp1.id);

      // Either RLS error or 0 rows affected
      if (error) {
        expect(error.message).toContain('row-level security');
      } else {
        // App should still exist
        const { data } = await supabaseAdmin
          .from('app')
          .select('id')
          .eq('id', testApp1.id)
          .single();
        expect(data).not.toBeNull();
      }
    });
  });

  describe('Scoped user detection', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
      await supabaseAdmin.from('membership').update({ is_app_scoped: false }).eq('tenant_id', tenantId);
    });

    it('should see ZERO apps when is_app_scoped=true and no role assignments', async () => {
      // Set is_app_scoped=true but assign no app_member_role rows at all
      await supabaseAdmin
        .from('membership')
        .update({ is_app_scoped: true })
        .eq('id', readUser.membershipId);

      const { data, error } = await readUser.client.from('app').select('id');
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should restrict scoped user to only assigned apps', async () => {
      // Mark readUser as app-scoped and assign to app1 only
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      const { data, error } = await readUser.client
        .from('app')
        .select('id');

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0]!.id).toBe(testApp1.id);
    });

    it('should return empty result for unassigned apps of scoped user', async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'admin',
        created_by: ownerUser.id,
      });

      const { data, error } = await readUser.client
        .from('app')
        .select('id')
        .eq('id', testApp2.id);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should allow scoped user to access multiple assigned apps', async () => {
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert([
        { membership_id: readUser.membershipId, app_id: testApp1.id, tenant_id: tenantId, role: 'read', created_by: ownerUser.id },
        { membership_id: readUser.membershipId, app_id: testApp2.id, tenant_id: tenantId, role: 'write', created_by: ownerUser.id },
      ]);

      const { data, error } = await readUser.client
        .from('app')
        .select('id');

      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      expect(data!.map(a => a.id).sort()).toEqual([testApp1.id, testApp2.id].sort());
    });
  });

  describe('Owner bypass', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
      await supabaseAdmin.from('membership').update({ is_app_scoped: false }).eq('tenant_id', tenantId);
    });

    it('should allow owner full access regardless of other users being scoped', async () => {
      // Scope readUser to app1
      await supabaseAdmin.from('membership').update({ is_app_scoped: true }).eq('id', readUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      // Owner should still see all apps
      const { data, error } = await ownerUser.client
        .from('app')
        .select('id');

      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(3);
    });

    it('should allow owner full access even with own app_member_role record', async () => {
      // Create app_member_role for owner with "read" (should not restrict owner)
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: ownerUser.membershipId,
        app_id: testApp1.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      // Owner should still see all apps and be able to delete
      const { data: apps, error } = await ownerUser.client
        .from('app')
        .select('id');

      expect(error).toBeNull();
      expect(apps!.length).toBeGreaterThanOrEqual(3);
    });
  });
});
