/**
 * Integration tests for app_authorize() RPC and role_permissions read access.
 *
 * Verifies that:
 * - app_authorize() is callable via supabase.rpc() by authenticated users
 * - App-level role overrides org-level role in permission checks
 * - The role_permissions table is readable by authenticated users
 *   (needed for the useAppPermissions client hook)
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from './helpers';

describe('app_authorize() RPC end-to-end', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let memberUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string };

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    memberUser = await addUserToTenant(tenantId, 'read');

    const { data, error } = await supabaseAdmin
      .from('app')
      .insert({
        name: `rpc-test-app-${Date.now()}`,
        tenant_id: tenantId,
        created_by: ownerUser.id,
      })
      .select('id')
      .single();
    if (error) throw new Error(`App create: ${error.message}`);
    testApp = data!;
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, memberUser]);
  });

  afterEach(async () => {
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('tenant_id', tenantId);
  });

  describe('RPC callable by authenticated users', () => {
    it('should return true for owner calling app_authorize', async () => {
      const { data, error } = await ownerUser.client.rpc('app_authorize', {
        requested_permission: 'app.read',
        target_app_id: testApp.id,
      });

      expect(error).toBeNull();
      expect(data).toBe(true);
    });

    it('should return true for org-level read permission (non-scoped user)', async () => {
      const { data, error } = await memberUser.client.rpc('app_authorize', {
        requested_permission: 'app.read',
        target_app_id: testApp.id,
      });

      expect(error).toBeNull();
      expect(data).toBe(true);
    });

    it('should return false for org-level write permission when user is read-only', async () => {
      const { data, error } = await memberUser.client.rpc('app_authorize', {
        requested_permission: 'app.insert',
        target_app_id: testApp.id,
      });

      expect(error).toBeNull();
      expect(data).toBe(false);
    });
  });

  describe('App-level role overrides org-level role', () => {
    it('should grant admin permissions when app role is admin even if org role is read', async () => {
      // Set memberUser as app-scoped with admin role on testApp
      await supabaseAdmin
        .from('membership')
        .update({ is_app_scoped: true })
        .eq('id', memberUser.membershipId);
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: memberUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'admin',
        created_by: ownerUser.id,
      });

      // Refresh session to pick up any JWT changes
      await memberUser.client.auth.refreshSession();

      // memberUser has org role 'read' but app role 'admin' for testApp
      // app_authorize should check the app role, which includes app.insert
      const { data: canInsert, error: insertError } = await memberUser.client.rpc(
        'app_authorize',
        {
          requested_permission: 'app.insert',
          target_app_id: testApp.id,
        }
      );

      expect(insertError).toBeNull();
      expect(canInsert).toBe(true);

      // Also check app.delete (admin permission)
      const { data: canDelete, error: deleteError } = await memberUser.client.rpc(
        'app_authorize',
        {
          requested_permission: 'app.delete',
          target_app_id: testApp.id,
        }
      );

      expect(deleteError).toBeNull();
      expect(canDelete).toBe(true);
    });

    it('should restrict to read when app role is read even if org role would be higher', async () => {
      // Create a write-level org user
      const writeUser = await addUserToTenant(tenantId, 'write');
      try {
        // Give writeUser a 'read' app-specific role — should downgrade within this app
        await supabaseAdmin
          .from('membership')
          .update({ is_app_scoped: true })
          .eq('id', writeUser.membershipId);
        await supabaseAdmin.from('app_member_role').insert({
          membership_id: writeUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
          created_by: ownerUser.id,
        });

        await writeUser.client.auth.refreshSession();

        // org role is 'write' which includes tenant.update,
        // but app role is 'read' which does NOT include tenant.update
        const { data, error } = await writeUser.client.rpc('app_authorize', {
          requested_permission: 'tenant.update',
          target_app_id: testApp.id,
        });

        expect(error).toBeNull();
        expect(data).toBe(false);
      } finally {
        await supabaseAdmin
          .from('app_member_role')
          .delete()
          .eq('membership_id', writeUser.membershipId);
        await supabaseAdmin
          .from('membership')
          .delete()
          .eq('id', writeUser.membershipId);
        await supabaseAdmin.from('profile').delete().eq('id', writeUser.id);
        await supabaseAdmin.auth.admin.deleteUser(writeUser.id);
      }
    });

    it('should deny access when app-scoped user has no role for the app', async () => {
      await supabaseAdmin
        .from('membership')
        .update({ is_app_scoped: true })
        .eq('id', memberUser.membershipId);

      // No app_member_role for memberUser on testApp
      const { data, error } = await memberUser.client.rpc('app_authorize', {
        requested_permission: 'app.read',
        target_app_id: testApp.id,
      });

      expect(error).toBeNull();
      expect(data).toBe(false);
    });
  });

  describe('role_permissions read access', () => {
    it('should allow authenticated users to read role_permissions', async () => {
      const { data, error } = await memberUser.client
        .from('role_permissions')
        .select('role, permission')
        .eq('role', 'admin')
        .limit(5);

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBeGreaterThan(0);
      expect(data![0]).toHaveProperty('role', 'admin');
      expect(data![0]).toHaveProperty('permission');
    });

    it('should return permissions for all standard roles', async () => {
      const { data, error } = await memberUser.client
        .from('role_permissions')
        .select('role')
        .limit(100);

      expect(error).toBeNull();
      const roles = [...new Set(data!.map((r) => r.role))].sort();
      expect(roles).toContain('admin');
      expect(roles).toContain('read');
      expect(roles).toContain('write');
    });
  });
});
