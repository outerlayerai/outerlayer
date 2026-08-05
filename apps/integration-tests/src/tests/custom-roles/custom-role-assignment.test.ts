/**
 * Integration Tests for Custom Role Assignment
 *
 * Tests assignment/unassignment of custom roles to memberships:
 * - Can assign custom_role_id to a membership
 * - Can unassign (set custom_role_id to NULL)
 * - ON DELETE SET NULL: deleting a custom role NULLs the membership FK
 *
 * All users share a single tenant so RLS tenant_id checks work correctly.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  assignCustomRole,
  SameTenantUser,
} from './helpers';

describe('custom_role assignment on membership', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let writeUser: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    writeUser = await addUserToTenant(tenantId, 'write');
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser, writeUser]);
  });

  afterEach(async () => {
    // Reset membership custom_role_id
    await supabaseAdmin
      .from('membership')
      .update({ custom_role_id: null })
      .eq('tenant_id', tenantId);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // Assign
  // ---------------------------------------------------------------------------
  describe('Assign custom role to membership', () => {
    it('should set custom_role_id on membership when assigned via admin client', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Assigned Role', [
        'sso_config.read',
      ]);

      // Act
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      // Assert
      const { data, error } = await supabaseAdmin
        .from('membership')
        .select('custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(error).toBeNull();
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    it('should allow the same custom role on multiple memberships when assigned', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Shared Role', [
        'sso_config.read',
        'app.read',
      ]);

      // Act
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      // Assert
      const { data, error } = await supabaseAdmin
        .from('membership')
        .select('id, custom_role_id')
        .in('id', [readUser.membershipId, writeUser.membershipId]);
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      for (const membership of data!) {
        expect(membership.custom_role_id).toBe(customRole.id);
      }
    });

    it('should update custom_role_id when switching from one custom role to another', async () => {
      // Arrange
      const roleA = await createCustomRole(supabaseAdmin, tenantId, 'Role A', [
        'sso_config.read',
      ]);
      const roleB = await createCustomRole(supabaseAdmin, tenantId, 'Role B', [
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, roleA.id);

      // Act
      await assignCustomRole(supabaseAdmin, readUser.membershipId, roleB.id);

      // Assert
      const { data } = await supabaseAdmin
        .from('membership')
        .select('custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.custom_role_id).toBe(roleB.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Unassign
  // ---------------------------------------------------------------------------
  describe('Unassign custom role from membership', () => {
    it('should set custom_role_id to NULL when custom role is unassigned', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Temp Role', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      // Act
      await assignCustomRole(supabaseAdmin, readUser.membershipId, null);

      // Assert
      const { data } = await supabaseAdmin
        .from('membership')
        .select('custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ON DELETE SET NULL
  // ---------------------------------------------------------------------------
  describe('ON DELETE SET NULL for custom_role FK', () => {
    it('should NULL membership custom_role_id when the referenced custom role is deleted', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Deletable Role', [
        'sso_config.read',
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      // Act
      const { error: deleteError } = await supabaseAdmin
        .from('custom_role')
        .delete()
        .eq('id', customRole.id);
      expect(deleteError).toBeNull();

      // Assert
      const { data: after } = await supabaseAdmin
        .from('membership')
        .select('id, custom_role_id')
        .in('id', [readUser.membershipId, writeUser.membershipId]);
      expect(after).toHaveLength(2);
      for (const m of after!) {
        expect(m.custom_role_id).toBeNull();
      }
    });

    it('should preserve membership record when the referenced custom role is deleted', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Safe Delete', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      // Act
      await supabaseAdmin
        .from('custom_role')
        .delete()
        .eq('id', customRole.id);

      // Assert
      const { data, error } = await supabaseAdmin
        .from('membership')
        .select('id, role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(error).toBeNull();
      expect(data!.id).toBe(readUser.membershipId);
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // CASCADE on custom_role deletion for permissions
  // ---------------------------------------------------------------------------
  describe('CASCADE deletion of custom_role_permission', () => {
    it('should delete all permissions when the custom role is deleted', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Cascade Test', [
        'sso_config.read',
        'sso_config.update',
        'app.read',
      ]);
      const { data: before } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id')
        .eq('custom_role_id', customRole.id);
      expect(before).toHaveLength(3);

      // Act
      await supabaseAdmin
        .from('custom_role')
        .delete()
        .eq('id', customRole.id);

      // Assert
      const { data: after } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id')
        .eq('custom_role_id', customRole.id);
      expect(after).toHaveLength(0);
    });
  });
});
