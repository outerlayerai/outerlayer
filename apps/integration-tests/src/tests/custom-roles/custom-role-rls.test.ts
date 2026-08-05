/**
 * Integration Tests for Custom Role RLS Policies
 *
 * Tests row-level security isolation between tenants:
 * - Tenant A cannot see tenant B's custom roles
 * - custom_role_permission rows follow parent role visibility
 * - Service role can see all custom roles
 *
 * Creates two separate tenants to verify cross-tenant isolation.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  SameTenantUser,
  CustomRole,
} from './helpers';

describe('custom_role RLS policies', () => {
  const supabaseAdmin = createSupabaseAdminClient();

  // Tenant A
  let ownerA: SameTenantUser;
  let adminA: SameTenantUser;
  let readA: SameTenantUser;
  let tenantIdA: string;
  let roleA: CustomRole;

  // Tenant B
  let ownerB: SameTenantUser;
  let tenantIdB: string;
  let roleB: CustomRole;

  beforeAll(async () => {
    // Create two separate tenants
    ownerA = await createTenantWithOwner();
    tenantIdA = ownerA.tenantId;
    adminA = await addUserToTenant(tenantIdA, 'admin');
    readA = await addUserToTenant(tenantIdA, 'read');

    ownerB = await createTenantWithOwner();
    tenantIdB = ownerB.tenantId;

    // Create custom roles in each tenant
    roleA = await createCustomRole(supabaseAdmin, tenantIdA, 'Tenant A Role', [
      'sso_config.read',
      'app.read',
    ]);
    roleB = await createCustomRole(supabaseAdmin, tenantIdB, 'Tenant B Role', [
      'sso_config.update',
      'app.insert',
    ]);
  });

  afterAll(async () => {
    await cleanupCustomRoles(supabaseAdmin, tenantIdA);
    await cleanupCustomRoles(supabaseAdmin, tenantIdB);
    await cleanupTenantAndUsers(tenantIdA, [ownerA, adminA, readA]);
    await cleanupTenantAndUsers(tenantIdB, [ownerB]);
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant isolation
  // ---------------------------------------------------------------------------
  describe('Cross-tenant isolation', () => {
    it('should return zero rows when tenant A owner queries tenant B custom role by id', async () => {
      // Act
      const { data, error } = await ownerA.client
        .from('custom_role')
        .select('id, name')
        .eq('id', roleB.id);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should return zero rows when tenant B owner queries tenant A custom role by id', async () => {
      // Act
      const { data, error } = await ownerB.client
        .from('custom_role')
        .select('id, name')
        .eq('id', roleA.id);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should return only own-tenant custom roles when tenant A owner queries all', async () => {
      // Act
      const { data, error } = await ownerA.client
        .from('custom_role')
        .select('id, name, tenant_id');

      // Assert
      expect(error).toBeNull();
      for (const role of data!) {
        expect(role.tenant_id).toBe(tenantIdA);
      }
      expect(data!.find((r) => r.id === roleA.id)).toBeDefined();
      expect(data!.find((r) => r.id === roleB.id)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // custom_role_permission follows parent visibility
  // ---------------------------------------------------------------------------
  describe('custom_role_permission follows parent role visibility', () => {
    it('should return zero rows when tenant A queries tenant B permission rows', async () => {
      // Act
      const { data, error } = await ownerA.client
        .from('custom_role_permission')
        .select('id, custom_role_id, permission')
        .eq('custom_role_id', roleB.id);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('should return own permission rows when tenant A queries own custom role permissions', async () => {
      // Act
      const { data, error } = await ownerA.client
        .from('custom_role_permission')
        .select('id, custom_role_id, permission')
        .eq('custom_role_id', roleA.id);

      // Assert
      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(2);
      expect(data!.map((p) => p.permission).sort()).toEqual([
        'app.read',
        'sso_config.read',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Service role access
  // ---------------------------------------------------------------------------
  describe('Service role access', () => {
    it('should return both tenants custom roles when service role queries by ids', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('custom_role')
        .select('id, tenant_id')
        .in('id', [roleA.id, roleB.id]);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      const tenantIds = data!.map((r) => r.tenant_id);
      expect(tenantIds).toContain(tenantIdA);
      expect(tenantIds).toContain(tenantIdB);
    });

    it('should return all permission rows across tenants when service role queries', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id, custom_role_id')
        .in('custom_role_id', [roleA.id, roleB.id]);

      // Assert
      expect(error).toBeNull();
      // roleA has 2 permissions, roleB has 2 permissions = 4 total
      expect(data).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant mutation prevention
  // ---------------------------------------------------------------------------
  describe('Cross-tenant mutation prevention', () => {
    it('should leave name unchanged when tenant A attempts to update tenant B custom role', async () => {
      // Arrange — roleB already exists with name 'Tenant B Role'

      // Act
      await ownerA.client
        .from('custom_role')
        .update({ name: 'Hacked By A' })
        .eq('id', roleB.id);

      // Assert — verify name is unchanged regardless of error shape
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('name')
        .eq('id', roleB.id)
        .single();
      expect(data!.name).toBe('Tenant B Role');
    });

    it('should leave role intact when tenant A attempts to delete tenant B custom role', async () => {
      // Arrange — roleB already exists

      // Act
      await ownerA.client
        .from('custom_role')
        .delete()
        .eq('id', roleB.id);

      // Assert — verify the record still exists regardless of error shape
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('id')
        .eq('id', roleB.id);
      expect(data!.length).toBeGreaterThan(0);
    });

    it('should return RLS error when tenant A attempts to insert permissions for tenant B role', async () => {
      // Act
      const { error } = await ownerA.client
        .from('custom_role_permission')
        .insert({
          custom_role_id: roleB.id,
          permission: 'sso_config.update',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });
  });

  // ---------------------------------------------------------------------------
  // custom_role_permission RLS for non-owner roles
  // ---------------------------------------------------------------------------
  describe('custom_role_permission RLS for read and admin roles', () => {
    // read user denied from inserting permissions
    it('should return RLS error when read user attempts to insert permissions on custom roles', async () => {
      // Act
      const { error } = await readA.client
        .from('custom_role_permission')
        .insert({
          custom_role_id: roleA.id,
          permission: 'app.delete',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });

    // read user denied from deleting permissions
    it('should leave permissions intact when read user attempts to delete permissions on custom roles', async () => {
      // Arrange -- get current permission count
      const { data: before } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id')
        .eq('custom_role_id', roleA.id);
      const beforeCount = before!.length;

      // Act
      await readA.client
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', roleA.id);

      // Assert -- verify permissions unchanged
      const { data: after } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id')
        .eq('custom_role_id', roleA.id);
      expect(after).toHaveLength(beforeCount);
    });

    // admin can insert permissions
    it('should allow admin to insert permissions on custom roles', async () => {
      // Act
      const { error } = await adminA.client
        .from('custom_role_permission')
        .insert({
          custom_role_id: roleA.id,
          permission: 'app.delete',
        });

      // Assert
      expect(error).toBeNull();

      // Verify the permission was added
      const { data } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', roleA.id)
        .eq('permission', 'app.delete');
      expect(data).toHaveLength(1);

      // Cleanup
      await supabaseAdmin
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', roleA.id)
        .eq('permission', 'app.delete');
    });

    // admin can delete permissions
    it('should allow admin to delete permissions on custom roles', async () => {
      // Arrange -- add a permission to delete
      await supabaseAdmin
        .from('custom_role_permission')
        .insert({
          custom_role_id: roleA.id,
          permission: 'app.insert',
        });

      // Act
      const { error } = await adminA.client
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', roleA.id)
        .eq('permission', 'app.insert');

      // Assert
      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', roleA.id)
        .eq('permission', 'app.insert');
      expect(data).toHaveLength(0);
    });

    // cross-tenant permission insert prevented for admin
    it('should return RLS error when admin attempts to insert permission for a different tenant custom role', async () => {
      // Act
      const { error } = await adminA.client
        .from('custom_role_permission')
        .insert({
          custom_role_id: roleB.id,
          permission: 'app.read',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });
  });
});
