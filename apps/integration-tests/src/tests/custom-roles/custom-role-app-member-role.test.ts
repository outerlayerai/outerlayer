/**
 * Integration Tests for app_member_role with custom_role_id
 *
 * Tests the custom_role_id override behavior:
 * - custom_role_id can be set alongside a built-in role (override)
 * - custom_role_id can be cleared to revert to built-in role
 * - ON DELETE SET NULL clears custom_role_id, leaving built-in role as fallback
 * - role is always required (NOT NULL)
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  createTestApp,
  createAppMemberRole,
  SameTenantUser,
} from './helpers';

describe('app_member_role with custom_role_id', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string; name: string };

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    testApp = await createTestApp(supabaseAdmin, tenantId);
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  afterEach(async () => {
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // Custom role override tests
  // ---------------------------------------------------------------------------
  describe('custom_role_id override behavior', () => {
    // insert with custom_role_id as override (role still required)
    it('should allow inserting app_member_role with custom_role_id alongside built-in role', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'App Custom', [
        'sso_config.read',
        'app.read',
      ]);

      const { data, error } = await supabaseAdmin
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
          custom_role_id: customRole.id,
        })
        .select('id, role, custom_role_id')
        .single();

      expect(error).toBeNull();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    // insert with only built-in role (no custom_role_id)
    it('should allow inserting app_member_role with only built-in role', async () => {
      const { data, error } = await supabaseAdmin
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
        })
        .select('id, role, custom_role_id')
        .single();

      expect(error).toBeNull();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });

    // role is required (NOT NULL constraint)
    it('should reject inserting app_member_role without a role', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'No Role', [
        'sso_config.read',
      ]);

      const { error } = await supabaseAdmin
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          // role intentionally omitted
          custom_role_id: customRole.id,
        } as Record<string, unknown>);

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/not-null|null value|violates/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Update transitions
  // ---------------------------------------------------------------------------
  describe('Updating app_member_role between role types', () => {
    // add custom_role_id override to existing built-in role
    it('should allow adding custom_role_id override to existing built-in role', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Switch Target', [
        'sso_config.read',
        'app.read',
      ]);
      const amr = await createAppMemberRole(supabaseAdmin, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        tenantId,
        role: 'read',
      });

      const { error } = await supabaseAdmin
        .from('app_member_role')
        .update({ custom_role_id: customRole.id })
        .eq('id', amr.id);

      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('role, custom_role_id')
        .eq('id', amr.id)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    // clear custom_role_id to revert to built-in role
    it('should allow clearing custom_role_id to revert to built-in role', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Revert Source', [
        'app.read',
      ]);
      const amr = await createAppMemberRole(supabaseAdmin, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        tenantId,
        role: 'read',
        customRoleId: customRole.id,
      });

      const { error } = await supabaseAdmin
        .from('app_member_role')
        .update({ custom_role_id: null })
        .eq('id', amr.id);

      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('role, custom_role_id')
        .eq('id', amr.id)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ON DELETE SET NULL behavior
  // ---------------------------------------------------------------------------
  describe('ON DELETE SET NULL for custom_role FK on app_member_role', () => {
    // deleting custom_role clears custom_role_id, built-in role remains as fallback
    it('should clear custom_role_id on custom role deletion, leaving built-in role as fallback', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Deletable App Role', [
        'app.read',
      ]);
      const amr = await createAppMemberRole(supabaseAdmin, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        tenantId,
        role: 'read',
        customRoleId: customRole.id,
      });

      // Act -- delete the custom role
      const { error: deleteError } = await supabaseAdmin
        .from('custom_role')
        .delete()
        .eq('id', customRole.id);

      // Assert -- delete succeeds, ON DELETE SET NULL clears custom_role_id
      expect(deleteError).toBeNull();

      // Verify the app_member_role still exists with built-in role as fallback
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id, role, custom_role_id')
        .eq('id', amr.id)
        .single();
      expect(data).not.toBeNull();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });
  });
});
