/**
 * Integration Tests for Custom Role Authorization
 *
 * Tests the authorize() function behavior with custom roles:
 * - Member with custom_role_id gets permissions from custom_role_permission table
 * - Member without custom_role_id falls back to built-in role_permissions
 * - Assigning a custom role changes authorize() results
 * - Unassigning (NULL custom_role_id) reverts to built-in role permissions
 *
 * The authorize() function reads `custom_role_id` from the JWT claim.
 * We use set_claim to inject it and refresh the session for each test.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  createCustomRole,
  assignCustomRole,
  setCustomRoleClaim,
  SameTenantUser,
} from './helpers';

describe('Custom role authorization via authorize()', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
  });

  afterAll(async () => {
    // Clean up custom_role_id claim before deleting users
    await setCustomRoleClaim(supabaseAdmin, readUser.id, null, readUser.client);
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  afterEach(async () => {
    // Reset custom_role_id claim and membership after each test
    await assignCustomRole(supabaseAdmin, readUser.membershipId, null);
    await setCustomRoleClaim(supabaseAdmin, readUser.id, null, readUser.client);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // Custom role permissions via authorize()
  // ---------------------------------------------------------------------------
  describe('Custom role permissions override built-in role', () => {
    // proves AC-075-03
    it('should authorize app.read via custom role when user has custom_role_id in JWT claim', async () => {
      // Arrange — create a custom role with app.read and seed an app for verification
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Writer Custom', [
        'sso_config.read',
        'sso_config.update',
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, customRole.id, readUser.client);

      // Seed an app so we can verify the query returns it
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Auth Test App' })
        .select('id')
        .single();

      // Act
      const { data: apps, error } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert — app.read is in the custom role, so readUser should see the app
      expect(error).toBeNull();
      expect(apps!.some((a) => a.id === testApp!.id)).toBe(true);

      // Cleanup seeded app
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });

    it('should deny app.read when custom role lacks it even though built-in read role has it', async () => {
      // Arrange — custom role with ONLY sso_config.read (no app.read)
      const restrictedRole = await createCustomRole(supabaseAdmin, tenantId, 'Restricted', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, restrictedRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, restrictedRole.id, readUser.client);

      // Seed an app so we can verify it is NOT returned
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Hidden App' })
        .select('id')
        .single();

      // Act
      const { data: apps } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert — custom role lacks app.read, so RLS should hide the app
      expect(apps).toHaveLength(0);

      // Cleanup seeded app
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback to built-in role
  // ---------------------------------------------------------------------------
  describe('Fallback to built-in role when no custom role', () => {
    it('should authorize app.read via built-in role when custom_role_id is NULL', async () => {
      // Arrange — seed an app so we can verify the query returns it
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Fallback Test App' })
        .select('id')
        .single();

      // Act — readUser has no custom_role_id, uses built-in 'read' permissions
      const { data: apps, error } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert — built-in 'read' role has app.read
      expect(error).toBeNull();
      expect(apps!.some((a) => a.id === testApp!.id)).toBe(true);

      // Cleanup seeded app
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });

    it('should return error when read user attempts to insert a custom_role', async () => {
      // Arrange — ensure no custom role is set
      await setCustomRoleClaim(supabaseAdmin, readUser.id, null, readUser.client);

      // Act — read role does not have custom_role.insert
      const { error } = await readUser.client
        .from('custom_role')
        .insert({
          name: 'Should Fail',
          tenant_id: tenantId,
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });
  });

  // ---------------------------------------------------------------------------
  // Assign custom role — grants new permissions
  // ---------------------------------------------------------------------------
  describe('Assigning custom role grants new permissions', () => {
    it('should deny read user from inserting custom roles without custom role assignment', async () => {
      // Arrange — readUser has built-in 'read' role, no custom role

      // Act
      const { error } = await readUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Should Fail For Read',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });

    it('should authorize custom_role.insert when read user is assigned a custom role with that permission', async () => {
      // Arrange — create and assign custom role with custom_role.insert
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Manager', [
        'custom_role.read',
        'custom_role.insert',
        'app.read',
        'profile.read',
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, customRole.id, readUser.client);

      // Act
      const { data, error } = await readUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Created By Custom Role User',
        })
        .select('id, name')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('Created By Custom Role User');
    });
  });

  // ---------------------------------------------------------------------------
  // Unassign custom role — reverts to built-in role
  // ---------------------------------------------------------------------------
  describe('Unassigning custom role reverts permissions', () => {
    it('should allow creating custom roles when custom role with insert permission is assigned', async () => {
      // Arrange
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Temp Manager', [
        'custom_role.read',
        'custom_role.insert',
        'app.read',
        'profile.read',
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, customRole.id, readUser.client);

      // Act
      const { data, error } = await readUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Temp Created',
        })
        .select('id, name')
        .single();

      // Assert
      expect(error).toBeNull();
      expect(data!.name).toBe('Temp Created');
    });

    it('should deny creating custom roles after custom role is unassigned from read user', async () => {
      // Arrange — create, assign, then unassign
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Revoked Manager', [
        'custom_role.read',
        'custom_role.insert',
        'app.read',
        'profile.read',
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, customRole.id, readUser.client);

      // Unassign the custom role
      await assignCustomRole(supabaseAdmin, readUser.membershipId, null);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, null, readUser.client);

      // Act
      const { error } = await readUser.client
        .from('custom_role')
        .insert({
          tenant_id: tenantId,
          name: 'Should Fail Again',
        });

      // Assert
      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security');
    });
  });

  // ---------------------------------------------------------------------------
  // authorize() edge cases
  // ---------------------------------------------------------------------------
  describe('authorize() edge cases', () => {
    // cross-tenant privilege escalation via forged custom_role_id
    it('should return false when custom_role_id in JWT references a role from another tenant', async () => {
      // Arrange -- create a second tenant with a custom role
      const otherOwner = await createTenantWithOwner();
      const otherTenantId = otherOwner.tenantId;
      const otherRole = await createCustomRole(supabaseAdmin, otherTenantId, 'Other Tenant Role', [
        'app.read',
        'sso_config.read',
        'custom_role.insert',
      ]);

      // Directly set membership.custom_role_id to cross-tenant role via admin
      // (setCustomRoleClaim writes to app_metadata, but the hook reads from membership)
      await supabaseAdmin
        .from('membership')
        .update({ custom_role_id: otherRole.id })
        .eq('id', readUser.membershipId);
      await readUser.client.auth.refreshSession();

      // Seed an app so we can verify it is NOT returned
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Cross Tenant Test App' })
        .select('id')
        .single();

      // Act -- readUser tries to read apps with cross-tenant custom_role_id
      const { data: apps } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert -- authorize() has tenant cross-check, should deny
      expect(apps).toHaveLength(0);

      // Cleanup
      await supabaseAdmin
        .from('membership')
        .update({ custom_role_id: null })
        .eq('id', readUser.membershipId);
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
      await cleanupCustomRoles(supabaseAdmin, otherTenantId);
      await cleanupTenantAndUsers(otherTenantId, [otherOwner]);
    });

    // malformed custom_role_id in JWT (non-UUID)
    it('should gracefully fall back to built-in role when custom_role_id in JWT is malformed', async () => {
      // Arrange -- set a non-UUID value as custom_role_id claim
      await supabaseAdmin.rpc('set_claim', {
        claim: 'custom_role_id',
        uid: readUser.id,
        value: 'not-a-valid-uuid',
      });
      await readUser.client.auth.refreshSession();

      // Seed an app to verify built-in role works
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Malformed UUID Test' })
        .select('id')
        .single();

      // Act -- readUser should fall back to built-in 'read' role which has app.read
      const { data: apps, error } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert -- EXCEPTION block in authorize() catches the bad cast,
      // sets custom_role_id_value to NULL, falls through to built-in role check
      expect(error).toBeNull();
      expect(apps!.some((a) => a.id === testApp!.id)).toBe(true);

      // Cleanup
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });

    // Deleted custom role while the JWT still carries the stale custom_role_id:
    // the per-app resolver reads the MEMBERSHIP TABLE, not the claim, so the
    // member immediately resolves to their stored built-in fallback ('read') —
    // there is no stale-claim window, and the deleted role's extra grants are
    // gone at once.
    it('falls back to the stored built-in role immediately when the assigned custom role is deleted (stale JWT ignored)', async () => {
      // Arrange -- create, assign, and refresh to get JWT with custom_role_id
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Soon Deleted', [
        'app.read',
        'sso_config.read',
        'sso_config.insert',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      // Refresh to get the hook to inject custom_role_id into JWT
      await readUser.client.auth.refreshSession();

      // Delete the custom role (ON DELETE SET NULL nulls membership.custom_role_id,
      // CASCADE deletes custom_role_permission rows)
      await supabaseAdmin.from('custom_role').delete().eq('id', customRole.id);

      // DO NOT refresh — the JWT still carries the stale custom_role_id.

      // Seed an app
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Deleted Role Test' })
        .select('id')
        .single();

      // Act — the app RLS resolver keys on membership.custom_role_id (now NULL)
      // and falls back to the stored built-in 'read', which grants app.read.
      const { data: apps } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);
      expect(apps!.map((a) => a.id)).toEqual([testApp!.id]);

      // The deleted role's write grant is gone: sso_config.insert is not part of
      // the 'read' fallback, and the stale claim resolves to zero permission
      // rows at the org level too.
      const { data: canInsert, error: insertErr } = await readUser.client.rpc('authorize', {
        requested_permission: 'sso_config.insert',
      });
      expect(insertErr).toBeNull();
      expect(canInsert).toBe(false);

      // Cleanup
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });

    // custom role with zero permissions denies everything
    it('should deny all permissions when custom role has zero permissions', async () => {
      // Arrange -- create custom role with NO permissions
      const emptyRole = await createCustomRole(supabaseAdmin, tenantId, 'Empty Role', []);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, emptyRole.id);
      await setCustomRoleClaim(supabaseAdmin, readUser.id, emptyRole.id, readUser.client);

      // Seed an app
      const { data: testApp } = await supabaseAdmin
        .from('app')
        .insert({ tenant_id: tenantId, name: 'Empty Perms Test' })
        .select('id')
        .single();

      // Act -- readUser with empty custom role tries to read apps
      const { data: apps } = await readUser.client
        .from('app')
        .select('id')
        .eq('tenant_id', tenantId);

      // Assert -- zero permissions in custom role = denied everything
      expect(apps).toHaveLength(0);

      // Cleanup
      await supabaseAdmin.from('app').delete().eq('id', testApp!.id);
    });
  });
});
