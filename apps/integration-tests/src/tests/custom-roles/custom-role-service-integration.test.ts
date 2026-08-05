/**
 * Integration Tests for AppMemberRoleService — assignCustomRole() and updateCustomRole()
 *
 * Uses:
 *   - REAL Supabase (local test database)
 *   - AppMemberRoleService with admin client (bypasses RLS, focuses on service logic)
 *
 * These tests validate that custom-role-specific service methods correctly interact
 * with the database: mutual exclusivity (role XOR custom_role_id), entitlement gating,
 * owner protection, and duplicate handling.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  createCustomRole,
  createBillingRecord,
  cleanupBilling,
  cleanupCustomRoles,
  createTestApp,
  SameTenantUser,
  CustomRole,
} from './helpers';
import { AppMemberRoleService } from '@ee/features/app-access/app-member-role-service';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AppMemberRoleService custom role integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();

  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string; name: string };
  let customRole: CustomRole;
  let service: AppMemberRoleService;

  beforeAll(async () => {
    // Arrange — shared tenant with owner and read user
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');

    // Create a test app in the tenant
    testApp = await createTestApp(supabaseAdmin, tenantId, `custom-svc-test-app`);

    // Service uses admin client so it bypasses RLS
    service = new AppMemberRoleService({ db: supabaseAdmin });
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  beforeEach(async () => {
    // Clean state between tests
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
    await cleanupBilling(supabaseAdmin, tenantId);

    // Create a fresh custom role for each test
    customRole = await createCustomRole(supabaseAdmin, tenantId, `Test Custom Role ${Date.now()}`, [
      'sso_config.read',
      'app.read',
    ]);
  });

  // ==========================================================================
  // K: assignCustomRole() (tests 62-65)
  // ==========================================================================

  describe('assignCustomRole()', () => {
    it('should insert app_member_role with custom_role_id alongside built-in role when assignCustomRole succeeds', async () => {
      // Arrange — enterprise tier so entitlement passes
      await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);

      // Act
      const result = await service.assignCustomRole(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
        customRoleId: customRole.id,
      });

      // Assert — service returns success with correct shape
      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.role).toBe('read');
      expect(data.custom_role_id).toBe(customRole.id);
      expect(data.membership_id).toBe(readUser.membershipId);
      expect(data.app_id).toBe(testApp.id);
      expect(data.tenant_id).toBe(tenantId);

      // Verify via direct DB query — role kept as fallback, custom_role_id set
      const { data: dbRow } = await supabaseAdmin
        .from('app_member_role')
        .select('role, custom_role_id')
        .eq('id', data.id)
        .single();
      expect(dbRow!.role).toBe('read');
      expect(dbRow!.custom_role_id).toBe(customRole.id);
    });

    it('should return entitlement_denied when tenant is on hobby tier (assignCustomRole)', async () => {
      // Arrange — hobby tier blocks app_level_roles
      await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);

      // Act
      const result = await service.assignCustomRole(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
        customRoleId: customRole.id,
      });

      // Assert
      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
      expect((result as any).entitlement).toBeDefined();
      expect((result as any).entitlement.featureKey).toBe('app_level_roles');

      // Verify no row was inserted
      const { data: rows } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('membership_id', readUser.membershipId)
        .eq('tenant_id', tenantId);
      expect(rows).toHaveLength(0);
    });

    it('should return error when target is an org owner (assignCustomRole)', async () => {
      // Arrange
      await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);

      // Act
      const result = await service.assignCustomRole(tenantId, {
        membershipId: ownerUser.membershipId,
        appId: testApp.id,
        role: 'read',
        customRoleId: customRole.id,
      });

      // Assert
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Cannot assign per-app roles to org owners');
    });

    it('should return duplicate error when app_member_role already exists for membership+app (assignCustomRole)', async () => {
      // Arrange — enterprise tier, seed first assignment
      await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
      const firstResult = await service.assignCustomRole(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
        customRoleId: customRole.id,
      });
      expect(firstResult.success).toBe(true);

      // Act — second assignment with same membership+app
      const secondCustomRole = await createCustomRole(supabaseAdmin, tenantId, `Second Role ${Date.now()}`, [
        'sso_config.read',
      ]);
      const result = await service.assignCustomRole(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
        customRoleId: secondCustomRole.id,
      });

      // Assert — unique constraint violation
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('already has a role');
    });
  });

  // ==========================================================================
  // L: updateCustomRole() (tests 66-68)
  // ==========================================================================

  describe('updateCustomRole()', () => {
    let roleRecordId: string;

    beforeEach(async () => {
      // Seed a built-in role record for readUser to update
      const { data, error } = await supabaseAdmin
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'read',
          created_by: ownerUser.id,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Seed app_member_role: ${error.message}`);
      roleRecordId = data!.id;
    });

    // L66
    it('should set custom_role_id as override while keeping built-in role when updateCustomRole succeeds', async () => {
      // Arrange
      await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);

      // Act
      const result = await service.updateCustomRole(tenantId, roleRecordId, customRole.id);

      // Assert — service returns updated row with custom_role_id set, role preserved
      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.role).toBe('read');
      expect(data.custom_role_id).toBe(customRole.id);

      // Verify via direct DB query — role kept as fallback, custom_role_id set
      const { data: dbRow } = await supabaseAdmin
        .from('app_member_role')
        .select('role, custom_role_id')
        .eq('id', roleRecordId)
        .single();
      expect(dbRow!.role).toBe('read');
      expect(dbRow!.custom_role_id).toBe(customRole.id);
    });

    // L67
    it('should return entitlement_denied when tenant is on hobby tier (updateCustomRole)', async () => {
      // Arrange — hobby tier
      await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);

      // Act
      const result = await service.updateCustomRole(tenantId, roleRecordId, customRole.id);

      // Assert
      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
      expect((result as any).entitlement.featureKey).toBe('app_level_roles');

      // Verify the original row was not modified
      const { data: dbRow } = await supabaseAdmin
        .from('app_member_role')
        .select('role, custom_role_id')
        .eq('id', roleRecordId)
        .single();
      expect(dbRow!.role).toBe('read');
      expect(dbRow!.custom_role_id).toBeNull();
    });

    // L68
    it('should return DB error when update targets non-existent app_member_role row (updateCustomRole)', async () => {
      // Arrange
      await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
      const nonExistentId = '00000000-0000-4000-a000-000000000000';

      // Act
      const result = await service.updateCustomRole(tenantId, nonExistentId, customRole.id);

      // Assert — Supabase .single() returns error for zero matching rows
      expect(result.success).toBe(false);
      expect((result as any).error).toBeDefined();
      expect(typeof (result as any).error).toBe('string');
    });
  });
});
