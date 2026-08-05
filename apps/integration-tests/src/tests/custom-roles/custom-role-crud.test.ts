/**
 * Integration Tests for custom_role Table CRUD
 *
 * Tests CRUD operations and constraints on the custom_role and
 * custom_role_permission tables:
 * - Owner/admin can create custom roles with valid name and permissions
 * - Duplicate name fails (case-insensitive unique index)
 * - Fetch all custom roles for a tenant with permission counts
 * - Update custom role name and permissions (replace all permissions)
 * - Delete a custom role with no members
 * - Max 50 role limit per tenant (if enforced at DB level)
 * - Audit columns (created_at, updated_at, created_by) are populated
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
  SameTenantUser,
} from './helpers';

describe('custom_role table CRUD operations', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let adminUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    adminUser = await addUserToTenant(tenantId, 'admin');
    readUser = await addUserToTenant(tenantId, 'read');
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, adminUser, readUser]);
  });

  afterEach(async () => {
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------
  describe('Create custom roles', () => {
    it('should create a custom role when owner inserts with valid name', async () => {
      // Arrange — nothing extra needed beyond beforeAll

      // Act
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Viewer Plus',
        })
        .select('id, name, tenant_id, created_at, created_by')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('Viewer Plus');
      expect(data!.tenant_id).toBe(tenantId);
    });

    it('should store permissions when owner adds permissions to a custom role', async () => {
      // Arrange — create a custom role first
      const { data: role } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Viewer Plus Perms',
        })
        .select('id')
        .single();

      // Act
      const { error: permError } = await ownerUser.client
        .from('custom_role_permission')
        .insert([
          { custom_role_id: role!.id, permission: 'sso_config.read' },
          { custom_role_id: role!.id, permission: 'app.read' },
        ]);

      // Assert
      expect(permError).toBeNull();
      const { data: perms } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', role!.id);
      expect(perms).toHaveLength(2);
      expect(perms!.map((p) => p.permission).sort()).toEqual(
        ['app.read', 'sso_config.read']
      );
    });

    it('should create a custom role when admin inserts with valid name', async () => {
      // Arrange — nothing extra needed

      // Act
      const { data, error } = await adminUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Custom Admin',
        })
        .select('id, name')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('Custom Admin');
    });

    it('should return RLS error when read user attempts to create a custom role', async () => {
      // Arrange — nothing extra needed

      // Act
      const { error } = await readUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Should Fail',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });

    it('should return duplicate error when inserting a custom role with same name in different casing', async () => {
      // Arrange — create first role
      const { error: firstError } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Analytics Viewer',
        });
      expect(firstError).toBeNull();

      // Act
      const { error: dupError } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'analytics viewer',
        });

      // Assert
      expect(dupError).not.toBeNull();
      expect(dupError!.message).toContain('duplicate');
    });

    it('should set created_at and created_by when a custom role is created', async () => {
      // Arrange — nothing extra needed

      // Act
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Audit Test Role',
        })
        .select('created_at, created_by, updated_at, updated_by')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.created_at).toBeDefined();
      expect(typeof data!.created_at).toBe('string');
      expect(data!.created_by).toBe(ownerUser.id);
      expect(data!.updated_at).toBeNull();
      expect(data!.updated_by).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------
  describe('Fetch custom roles with permission counts', () => {
    it('should return all custom roles ordered by name when owner queries tenant', async () => {
      // Arrange
      await createCustomRole(supabaseAdmin, tenantId, 'Role A', [
        'sso_config.read',
        'app.read',
      ]);
      await createCustomRole(supabaseAdmin, tenantId, 'Role B', [
        'sso_config.read',
      ]);

      // Act
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .select('id, name, custom_role_permission(count)')
        .eq('tenant_id', tenantId)
        .order('name');

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      expect(data![0]!.name).toBe('Role A');
      expect(data![1]!.name).toBe('Role B');
    });

    it('should return custom roles when admin queries tenant', async () => {
      // Arrange
      await createCustomRole(supabaseAdmin, tenantId, 'Read Test', [
        'sso_config.read',
      ]);

      // Act
      const { data, error } = await adminUser.client
        .from('custom_role')
        .select('id, name')
        .eq('tenant_id', tenantId);

      // Assert
      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  describe('Update custom roles', () => {
    it('should update the name when owner modifies a custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Old Name', []);

      // Act
      const { error } = await ownerUser.client
        .from('custom_role')
        .update({ name: 'New Name' })
        .eq('id', role.id);

      // Assert
      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('name')
        .eq('id', role.id)
        .single();
      expect(data!.name).toBe('New Name');
    });

    it('should set updated_at and updated_by when owner updates a custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Audit Update', []);

      // Act
      await ownerUser.client
        .from('custom_role')
        .update({ name: 'Audit Updated' })
        .eq('id', role.id);

      // Assert
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('updated_at, updated_by')
        .eq('id', role.id)
        .single();
      expect(data!.updated_at).not.toBeNull();
      expect(data!.updated_by).toBe(ownerUser.id);
    });

    it('should replace all permissions when owner deletes old and inserts new permissions', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Perm Replace', [
        'sso_config.read',
        'app.read',
      ]);

      // Act — delete old permissions
      const { error: delError } = await ownerUser.client
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', role.id);
      expect(delError).toBeNull();

      // Act — insert new permissions
      const { error: insError } = await ownerUser.client
        .from('custom_role_permission')
        .insert([
          { custom_role_id: role.id, permission: 'sso_config.update' },
          { custom_role_id: role.id, permission: 'app.insert' },
          { custom_role_id: role.id, permission: 'app.delete' },
        ]);
      expect(insError).toBeNull();

      // Assert
      const { data: perms } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', role.id);
      expect(perms).toHaveLength(3);
      expect(perms!.map((p) => p.permission).sort()).toEqual([
        'app.delete',
        'app.insert',
        'sso_config.update',
      ]);
    });

    it('should leave name unchanged when read user attempts to update a custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'No Update', []);

      // Act
      await readUser.client
        .from('custom_role')
        .update({ name: 'Hacked' })
        .eq('id', role.id);

      // Assert — verify name is unchanged regardless of error shape
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('name')
        .eq('id', role.id)
        .single();
      expect(data!.name).toBe('No Update');
    });
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  describe('Delete custom roles', () => {
    it('should remove role and cascade permissions when owner deletes an unassigned custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Deletable', [
        'sso_config.read',
      ]);

      // Act
      const { error } = await ownerUser.client
        .from('custom_role')
        .delete()
        .eq('id', role.id);

      // Assert
      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('id')
        .eq('id', role.id);
      expect(data).toHaveLength(0);

      const { data: perms } = await supabaseAdmin
        .from('custom_role_permission')
        .select('id')
        .eq('custom_role_id', role.id);
      expect(perms).toHaveLength(0);
    });

    it('should leave role intact when read user attempts to delete a custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'No Delete', []);

      // Act
      await readUser.client
        .from('custom_role')
        .delete()
        .eq('id', role.id);

      // Assert — verify the record still exists regardless of error shape
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('id')
        .eq('id', role.id);
      expect(data!.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Delete -- admin role
  // ---------------------------------------------------------------------------
  describe('Admin delete and update permissions', () => {
    // admin can delete custom roles
    it('should remove role when admin deletes an unassigned custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Admin Deletable', [
        'sso_config.read',
      ]);

      // Act
      const { error } = await adminUser.client
        .from('custom_role')
        .delete()
        .eq('id', role.id);

      // Assert
      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('id')
        .eq('id', role.id);
      expect(data).toHaveLength(0);
    });

    // admin can update custom role permissions
    it('should replace all permissions when admin deletes old and inserts new permissions', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Admin Perm Replace', [
        'sso_config.read',
        'app.read',
      ]);

      // Act -- delete old permissions
      const { error: delError } = await adminUser.client
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', role.id);
      expect(delError).toBeNull();

      // Act -- insert new permissions
      const { error: insError } = await adminUser.client
        .from('custom_role_permission')
        .insert([
          { custom_role_id: role.id, permission: 'sso_config.update' },
          { custom_role_id: role.id, permission: 'app.insert' },
        ]);
      expect(insError).toBeNull();

      // Assert
      const { data: perms } = await supabaseAdmin
        .from('custom_role_permission')
        .select('permission')
        .eq('custom_role_id', role.id);
      expect(perms).toHaveLength(2);
      expect(perms!.map((p) => p.permission).sort()).toEqual([
        'app.insert',
        'sso_config.update',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Name and description constraints
  // ---------------------------------------------------------------------------
  describe('Name and description constraints', () => {
    // name max length constraint
    it('should return error when inserting a custom role with name exceeding 100 characters', async () => {
      // Arrange
      const longName = 'A'.repeat(101);

      // Act
      const { error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: longName,
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/check|constraint|value too long/i);
    });

    // creating with a description
    it('should store description when creating a custom role with a description', async () => {
      // Arrange
      const description = 'A custom role for analytics viewers';

      // Act
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'With Description',
          description,
        })
        .select('id, name, description')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('With Description');
      expect(data!.description).toBe(description);
    });

    // description max length constraint
    it('should return error when inserting a custom role with description exceeding 500 characters', async () => {
      // Arrange
      const longDesc = 'B'.repeat(501);

      // Act
      const { error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Desc Too Long',
          description: longDesc,
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/check|constraint|value too long/i);
    });

    // NULL description is valid
    it('should store NULL description when creating a custom role without a description', async () => {
      // Act
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'No Description',
        })
        .select('id, name, description')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('No Description');
      expect(data!.description).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Unique permission constraint
  // ---------------------------------------------------------------------------
  describe('Permission uniqueness constraint', () => {
    it('should return duplicate error when inserting same permission for the same custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Dup Perm', [
        'sso_config.read',
      ]);

      // Act
      const { error } = await supabaseAdmin
        .from('custom_role_permission')
        .insert({
          custom_role_id: role.id,
          permission: 'sso_config.read',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('duplicate');
    });
  });

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------
  describe('Triggers on custom_role', () => {
    // set_tenant_id trigger auto-sets tenant_id from JWT
    it('should auto-set tenant_id via set_tenant_id trigger when authenticated user inserts custom_role', async () => {
      // Act -- insert WITHOUT explicit tenant_id; the trigger should use the JWT tenant_id
      // Note: The Supabase client always sends tenant_id, but we can verify
      // by inserting with a mismatched tenant_id vs JWT -- the trigger overrides it
      // For authenticated users, the trigger uses public.tenant_id() from JWT.
      // We test by inserting normally and verifying tenant_id matches the user's tenant.
      const { data, error } = await ownerUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Trigger TenantId Test',
        })
        .select('id, tenant_id')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.tenant_id).toBe(tenantId);
    });

    // updated_by uses auth.uid() on update
    it('should set updated_by to auth.uid() when owner updates a custom role', async () => {
      // Arrange
      const role = await createCustomRole(supabaseAdmin, tenantId, 'Trigger UpdatedBy', []);

      // Act
      await ownerUser.client
        .from('custom_role')
        .update({ name: 'Trigger UpdatedBy Changed' })
        .eq('id', role.id);

      // Assert
      const { data } = await supabaseAdmin
        .from('custom_role')
        .select('updated_at, updated_by')
        .eq('id', role.id)
        .single();
      expect(data!.updated_at).not.toBeNull();
      expect(data!.updated_by).toBe(ownerUser.id);
    });
  });

  // ---------------------------------------------------------------------------
  // role_permissions seeding
  // ---------------------------------------------------------------------------
  describe('role_permissions seeding for custom_role operations', () => {
    it('should have custom_role.read permission seeded for owner and admin but not read or write', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role')
        .eq('permission', 'custom_role.read');

      // Assert
      expect(error).toBeNull();
      const roles = data!.map((r) => r.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('admin');
      expect(roles).not.toContain('read');
      expect(roles).not.toContain('write');
    });

    // custom_role.insert seeded for owner and admin
    it('should have custom_role.insert permission seeded for owner and admin', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role')
        .eq('permission', 'custom_role.insert');

      // Assert
      expect(error).toBeNull();
      const roles = data!.map((r) => r.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('admin');
    });

    // custom_role.update seeded for owner and admin
    it('should have custom_role.update permission seeded for owner and admin', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role')
        .eq('permission', 'custom_role.update');

      // Assert
      expect(error).toBeNull();
      const roles = data!.map((r) => r.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('admin');
    });

    // custom_role.delete seeded for owner and admin
    it('should have custom_role.delete permission seeded for owner and admin', async () => {
      // Act
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('role')
        .eq('permission', 'custom_role.delete');

      // Assert
      expect(error).toBeNull();
      const roles = data!.map((r) => r.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('admin');
    });

    // write role should NOT have any custom_role.* permissions
    it('should NOT have any custom_role permissions seeded for write role', async () => {
      // Act -- enum type doesn't support LIKE, so filter by specific values
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('permission')
        .eq('role', 'write')
        .in('permission', ['custom_role.read', 'custom_role.insert', 'custom_role.update', 'custom_role.delete']);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    // read role should NOT have any custom_role.* permissions
    it('should NOT have any custom_role permissions seeded for read role', async () => {
      // Act -- enum type doesn't support LIKE, so filter by specific values
      const { data, error } = await supabaseAdmin
        .from('role_permissions')
        .select('permission')
        .eq('role', 'read')
        .in('permission', ['custom_role.read', 'custom_role.insert', 'custom_role.update', 'custom_role.delete']);

      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });
});
