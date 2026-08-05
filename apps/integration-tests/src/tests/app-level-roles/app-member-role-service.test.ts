/**
 * Integration Tests for AppMemberRoleService
 *
 * Tests service-layer methods against a real local Supabase database.
 * Uses the admin client so tests are not blocked by RLS.
 *
 * Covered:
 *   - assign: happy path, validation error, entitlement gate, owner protection, duplicate
 *   - bulkAssign: happy path, entitlement gate, owner protection
 *   - updateRole: happy path, entitlement gate
 *   - revoke: happy path, entitlement gate
 *   - revokeAllForMembership: happy path, entitlement gate
 *   - setAppScoped: happy path, entitlement gate, owner protection
 *   - isAppScoped: reads explicit is_app_scoped flag
 *
 * All tests use a shared tenant to avoid collision; billing is set to enterprise
 * tier for "allowed" tests and left absent for "denied" tests.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from './helpers';
import { AppMemberRoleService } from '@ee/features/app-access/app-member-role-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setEnterpriseTier(supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>, tenantId: string, createdBy: string): Promise<void> {
  // Create billing row at enterprise tier (idempotent: upsert by primary key)
  const { error } = await supabaseAdmin.from('billing').upsert(
    {
      tenant_id: tenantId,
      tier_id: 'enterprise',
      stripe_customer_id: `cus_test_${tenantId.replace(/-/g, '').slice(0, 14)}`,
      created_by: createdBy,
    },
    { onConflict: 'tenant_id' }
  );
  if (error) throw new Error(`Failed to set enterprise billing: ${error.message}`);
}

async function cleanupBilling(supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>, tenantId: string): Promise<void> {
  await supabaseAdmin.from('billing').delete().eq('tenant_id', tenantId);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AppMemberRoleService integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();

  let ownerUser: SameTenantUser;
  let adminUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string };
  let service: AppMemberRoleService;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    adminUser = await addUserToTenant(tenantId, 'admin');
    readUser = await addUserToTenant(tenantId, 'read');

    const { data, error } = await supabaseAdmin
      .from('app')
      .insert({ name: `Svc Test App ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create test app: ${error.message}`);
    testApp = data!;

    // Service uses admin client so it bypasses RLS
    service = new AppMemberRoleService({ db: supabaseAdmin });
  });

  afterAll(async () => {
    await cleanupBilling(supabaseAdmin, tenantId);
    await cleanupTenantAndUsers(tenantId, [ownerUser, adminUser, readUser]);
  });

  beforeEach(async () => {
    // Clear state: remove all app_member_role rows and reset is_app_scoped
    await supabaseAdmin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await supabaseAdmin
      .from('membership')
      .update({ is_app_scoped: false })
      .eq('tenant_id', tenantId);
  });

  // --------------------------------------------------------------------------
  // isAppScoped
  // --------------------------------------------------------------------------

  describe('isAppScoped()', () => {
    it('should return false when is_app_scoped is not set (default)', async () => {
      const result = await service.isAppScoped(readUser.membershipId);
      expect(result).toBe(false);
    });

    it('should return true after is_app_scoped is set to true', async () => {
      await supabaseAdmin
        .from('membership')
        .update({ is_app_scoped: true })
        .eq('id', readUser.membershipId);

      const result = await service.isAppScoped(readUser.membershipId);
      expect(result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // setAppScoped
  // --------------------------------------------------------------------------

  describe('setAppScoped()', () => {
    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available (no billing → hobby tier)', async () => {
      // No billing row → defaults to hobby tier → app_level_roles=false
      const result = await service.setAppScoped(tenantId, readUser.membershipId, true);

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
      expect((result as any).entitlement.featureKey).toBe('app_level_roles');
    });

    it('should set is_app_scoped=true when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.setAppScoped(tenantId, readUser.membershipId, true);

      expect(result.success).toBe(true);
      expect((result as any).data.isAppScoped).toBe(true);

      // Verify via DB directly
      const { data } = await supabaseAdmin
        .from('membership')
        .select('is_app_scoped')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.is_app_scoped).toBe(true);
    });

    it('should set is_app_scoped=false when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      // First set to true
      await supabaseAdmin
        .from('membership')
        .update({ is_app_scoped: true })
        .eq('id', readUser.membershipId);

      const result = await service.setAppScoped(tenantId, readUser.membershipId, false);
      expect(result.success).toBe(true);
      expect((result as any).data.isAppScoped).toBe(false);
    });

    it('should deny setAppScoped for org owners', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.setAppScoped(tenantId, ownerUser.membershipId, true);

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Cannot restrict app access for org owners');
    });
  });

  // --------------------------------------------------------------------------
  // assign()
  // --------------------------------------------------------------------------

  describe('assign()', () => {
    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available', async () => {
      const result = await service.assign(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
    });

    it('should assign a role when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.assign(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
      });

      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.membership_id).toBe(readUser.membershipId);
      expect(data.app_id).toBe(testApp.id);
      expect(data.role).toBe('read');
      expect(data.tenant_id).toBe(tenantId);
    });

    it('should deny assigning per-app roles to org owners', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.assign(tenantId, {
        membershipId: ownerUser.membershipId,
        appId: testApp.id,
        role: 'read',
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Cannot assign per-app roles to org owners');
    });

    it('should return error for duplicate assignment', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      // First assignment
      await service.assign(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'read',
      });

      // Duplicate
      const result = await service.assign(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'write',
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('already has a role');
    });

    it('should return validation error for invalid role', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.assign(tenantId, {
        membershipId: readUser.membershipId,
        appId: testApp.id,
        role: 'owner' as any,
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toBe(
        'role must be one of the following values: read, write, admin',
      );
    });
  });

  // --------------------------------------------------------------------------
  // bulkAssign()
  // --------------------------------------------------------------------------

  describe('bulkAssign()', () => {
    let testApp2: { id: string };

    beforeAll(async () => {
      const { data } = await supabaseAdmin
        .from('app')
        .insert({ name: `Bulk App2 ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();
      testApp2 = data!;
    });

    afterAll(async () => {
      if (testApp2) await supabaseAdmin.from('app').delete().eq('id', testApp2.id);
    });

    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available', async () => {
      const result = await service.bulkAssign(tenantId, {
        membershipId: readUser.membershipId,
        assignments: [{ appId: testApp.id, role: 'read' }],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
    });

    it('should assign multiple apps in bulk when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.bulkAssign(tenantId, {
        membershipId: readUser.membershipId,
        assignments: [
          { appId: testApp.id, role: 'read' },
          { appId: testApp2.id, role: 'write' },
        ],
      });

      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.created).toBe(2);
      expect(data.errors).toHaveLength(0);

      // Verify rows exist in DB
      const { data: rows } = await supabaseAdmin
        .from('app_member_role')
        .select('app_id, role')
        .eq('membership_id', readUser.membershipId)
        .eq('tenant_id', tenantId);
      expect(rows).toHaveLength(2);
    });

    it('should deny bulkAssign for org owners', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.bulkAssign(tenantId, {
        membershipId: ownerUser.membershipId,
        assignments: [{ appId: testApp.id, role: 'read' }],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Cannot assign per-app roles to org owners');
    });

    it('should report individual errors within a bulk operation', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      // First insert one to create a duplicate scenario
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });

      // Bulk assign with one duplicate (testApp.id) and one new (testApp2.id)
      const result = await service.bulkAssign(tenantId, {
        membershipId: readUser.membershipId,
        assignments: [
          { appId: testApp.id, role: 'write' }, // duplicate — should error
          { appId: testApp2.id, role: 'admin' }, // new — should succeed
        ],
      });

      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.created).toBe(1);
      expect(data.errors).toHaveLength(1);
      expect(data.errors[0].appId).toBe(testApp.id);
    });
  });

  // --------------------------------------------------------------------------
  // updateRole()
  // --------------------------------------------------------------------------

  describe('updateRole()', () => {
    let roleRecordId: string;

    beforeEach(async () => {
      // Seed a role record for readUser
      const { data } = await supabaseAdmin
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
      roleRecordId = data!.id;
    });

    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available', async () => {
      const result = await service.updateRole(tenantId, roleRecordId, 'write');

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');
    });

    it('should update role when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.updateRole(tenantId, roleRecordId, 'admin');

      expect(result.success).toBe(true);
      expect((result as any).data.role).toBe('admin');
      expect((result as any).data.id).toBe(roleRecordId);

      // Verify in DB
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('role')
        .eq('id', roleRecordId)
        .single();
      expect(data!.role).toBe('admin');
    });
  });

  // --------------------------------------------------------------------------
  // revoke()
  // --------------------------------------------------------------------------

  describe('revoke()', () => {
    let roleRecordId: string;

    beforeEach(async () => {
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .insert({
          membership_id: readUser.membershipId,
          app_id: testApp.id,
          tenant_id: tenantId,
          role: 'write',
          created_by: ownerUser.id,
        })
        .select('id')
        .single();
      roleRecordId = data!.id;
    });

    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available', async () => {
      const result = await service.revoke(tenantId, roleRecordId);

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');

      // Row should still exist
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('id', roleRecordId)
        .single();
      expect(data).not.toBeNull();
    });

    it('should delete the role record when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.revoke(tenantId, roleRecordId);

      expect(result.success).toBe(true);

      // Row should be gone
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('id', roleRecordId);
      expect(data).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // revokeAllForMembership()
  // --------------------------------------------------------------------------

  describe('revokeAllForMembership()', () => {
    let testApp3: { id: string };

    beforeAll(async () => {
      const { data } = await supabaseAdmin
        .from('app')
        .insert({ name: `Revoke App3 ${Date.now()}`, tenant_id: tenantId, created_by: ownerUser.id })
        .select('id')
        .single();
      testApp3 = data!;
    });

    afterAll(async () => {
      if (testApp3) await supabaseAdmin.from('app').delete().eq('id', testApp3.id);
    });

    beforeEach(async () => {
      // Seed multiple role records for readUser
      await supabaseAdmin.from('app_member_role').insert([
        { membership_id: readUser.membershipId, app_id: testApp.id, tenant_id: tenantId, role: 'read', created_by: ownerUser.id },
        { membership_id: readUser.membershipId, app_id: testApp3.id, tenant_id: tenantId, role: 'write', created_by: ownerUser.id },
      ]);
    });

    afterEach(async () => {
      await cleanupBilling(supabaseAdmin, tenantId);
    });

    it('should deny when entitlement not available', async () => {
      const result = await service.revokeAllForMembership(tenantId, readUser.membershipId);

      expect(result.success).toBe(false);
      expect((result as any).error).toBe('entitlement_denied');

      // Rows should still exist
      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('membership_id', readUser.membershipId);
      expect(data!.length).toBeGreaterThanOrEqual(2);
    });

    it('should delete all role records for a membership when entitlement is available', async () => {
      await setEnterpriseTier(supabaseAdmin, tenantId, ownerUser.id);

      const result = await service.revokeAllForMembership(tenantId, readUser.membershipId);

      expect(result.success).toBe(true);

      const { data } = await supabaseAdmin
        .from('app_member_role')
        .select('id')
        .eq('membership_id', readUser.membershipId)
        .eq('tenant_id', tenantId);
      expect(data).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getByMembership() and getByApp() queries
  // --------------------------------------------------------------------------

  describe('getByMembership()', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'read',
        created_by: ownerUser.id,
      });
    });

    it('should return all role records for a membership', async () => {
      const rows = await service.getByMembership(readUser.membershipId);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.membership_id).toBe(readUser.membershipId);
      expect(rows[0]!.app_id).toBe(testApp.id);
      expect(rows[0]!.role).toBe('read');
    });

    it('should return empty array when membership has no role records', async () => {
      const rows = await service.getByMembership(adminUser.membershipId);
      expect(rows).toHaveLength(0);
    });
  });

  describe('getByApp()', () => {
    beforeEach(async () => {
      await supabaseAdmin.from('app_member_role').insert({
        membership_id: readUser.membershipId,
        app_id: testApp.id,
        tenant_id: tenantId,
        role: 'write',
        created_by: ownerUser.id,
      });
    });

    it('should return all role records for an app', async () => {
      const rows = await service.getByApp(testApp.id);

      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some(r => r.membership_id === readUser.membershipId)).toBe(true);
    });
  });
});
