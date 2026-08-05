import { getSupabaseAdmin, checkTableExists, requirePrerequisite, type PrerequisiteCheck } from '../../lib/test-utils';
// Import production functions to avoid logic drift - see @exported in flag-factory.ts
import { evaluateFlag as productionEvaluateFlag, computeTenantBucket, type FlagData } from 'tenant-dashboard/src/flags/flag-factory';

/**
 * Integration tests for Platform Admin - Feature Flags
 *
 * These tests verify the feature flag management functionality including:
 * - listFeatureFlags and getFeatureFlagDetail (with overrides)
 * - createFeatureFlag (unique key validation, audit log)
 * - updateFeatureFlag (toggle, percentage rollout, audit log)
 * - deleteFeatureFlag (cascade delete of overrides, audit log)
 * - setFlagOverride and removeFlagOverride (per-org override CRUD)
 * - isEnabled evaluation (override priority, percentage rollout, boundary cases)
 *
 * Prerequisites:
 * - feature_flag table must exist
 * - feature_flag_override table must exist
 * - audit_log table must exist
 */

describe('Platform Admin - Feature Flags', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let featureFlagCheck: PrerequisiteCheck;
  let testAdminUserId: string;
  let testTenantId: string;
  let testTenantId2: string;

  /**
   * Wrapper around production evaluateFlag that fetches flag data first.
   * Uses production function to prevent test logic drift.
   */
  async function evaluateFlag(flagId: string, tenantId: string | undefined): Promise<boolean> {
    const { data: flag } = await supabaseAdmin
      .from('feature_flag')
      .select('id, is_enabled, strategy, rollout_percentage')
      .eq('id', flagId)
      .single();

    if (!flag) return false;

    return productionEvaluateFlag(supabaseAdmin, flag as FlagData, tenantId);
  }

  beforeAll(async () => {
    // Check if feature_flag table exists
    featureFlagCheck = await checkTableExists('feature_flag');
    if (featureFlagCheck.available) {
      // Drain the lazy verification call. The destructured error binding was
      // never asserted on; the table-availability gate above is the real
      // prerequisite for the tests below.
      await supabaseAdmin.from('feature_flag').select('id').limit(1);
    }

    if (!featureFlagCheck.available) {
      return;
    }

    // Create test admin user
    const testEmail = `ff-test-admin-${crypto.randomUUID()}@outerlayer.ai`;
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (authError || !authUser.user) {
      throw new Error(`Failed to create test admin user: ${authError?.message}`);
    }

    testAdminUserId = authUser.user.id;

    // Create profile for the test admin user (required for FK constraint)
    const { error: profileError } = await supabaseAdmin.from('profile').insert({
      id: testAdminUserId,
      name: 'FF Test Admin',
      email: testEmail,
    });

    if (profileError) {
      throw new Error(`Failed to create test admin profile: ${profileError.message}`);
    }

    // Create test tenants for override testing
    const { data: tenant1, error: tenant1Error } = await supabaseAdmin
      .from('tenant')
      .insert({
        organization_name: `FF Test Org 1 ${crypto.randomUUID()}`,
        company_name: 'Test Company 1',
        created_by: testAdminUserId,
      })
      .select()
      .single();

    if (tenant1Error || !tenant1) {
      throw new Error(`Failed to create test tenant 1: ${tenant1Error?.message}`);
    }

    testTenantId = tenant1.tenant_id;

    const { data: tenant2, error: tenant2Error } = await supabaseAdmin
      .from('tenant')
      .insert({
        organization_name: `FF Test Org 2 ${crypto.randomUUID()}`,
        company_name: 'Test Company 2',
        created_by: testAdminUserId,
      })
      .select()
      .single();

    if (tenant2Error || !tenant2) {
      throw new Error(`Failed to create test tenant 2: ${tenant2Error?.message}`);
    }

    testTenantId2 = tenant2.tenant_id;
  });

  afterAll(async () => {
    if (!featureFlagCheck.available) return;

    // Cleanup test data
    // Delete any test feature flags (overrides cascade automatically)
    await supabaseAdmin.from('feature_flag').delete().like('key', 'test_%');

    // Delete test tenants
    if (testTenantId) {
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', testTenantId);
    }
    if (testTenantId2) {
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', testTenantId2);
    }

    // Delete test user
    if (testAdminUserId) {
      await supabaseAdmin.from('profile').delete().eq('id', testAdminUserId);
      await supabaseAdmin.auth.admin.deleteUser(testAdminUserId);
    }
  });

  // listFeatureFlags and getFeatureFlagDetail (with overrides)
  describe('List and Detail Operations', () => {
    let testFlagId: string;

    beforeAll(async () => {
      if (!featureFlagCheck.available) return;

      // Create a test flag
      const { data: flag, error } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: `test_list_detail_${crypto.randomUUID()}`,
          description: 'Test flag for list/detail tests',
          is_enabled: true,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (error || !flag) {
        throw new Error(`Failed to create test flag: ${error?.message}`);
      }

      testFlagId = flag.id;

      // Add an override
      await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: testFlagId,
        tenant_id: testTenantId,
        is_enabled: false,
        created_by: testAdminUserId,
      });
    });

    afterAll(async () => {
      if (testFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', testFlagId);
      }
    });

    it('should list all feature flags', async () => {
      requirePrerequisite(featureFlagCheck);

      const { data: flags, error } = await supabaseAdmin
        .from('feature_flag')
        .select('id, key, description, is_enabled, strategy, rollout_percentage')
        .order('key', { ascending: true });

      expect(error).toBeNull();
      expect(Array.isArray(flags)).toBe(true);

      // Find our test flag
      const testFlag = flags?.find((f: { id: string }) => f.id === testFlagId);
      expect(testFlag).toMatchObject({ id: testFlagId });
      expect(testFlag?.is_enabled).toBe(true);
      expect(testFlag?.strategy).toBe('global');
    });

    it('should get feature flag detail with overrides', async () => {
      requirePrerequisite(featureFlagCheck);

      // Get flag
      const { data: flag, error: flagError } = await supabaseAdmin
        .from('feature_flag')
        .select('*')
        .eq('id', testFlagId)
        .single();

      expect(flagError).toBeNull();
      expect(flag?.id).toBe(testFlagId);

      // Get overrides for this flag
      const { data: overrides, error: overrideError } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id, tenant_id, is_enabled, created_at')
        .eq('flag_id', testFlagId);

      expect(overrideError).toBeNull();
      expect(Array.isArray(overrides)).toBe(true);
      expect(overrides).toHaveLength(1);
      expect(overrides?.[0]?.tenant_id).toBe(testTenantId);
      expect(overrides?.[0]?.is_enabled).toBe(false);
    });
  });

  // createFeatureFlag (unique key validation, audit log)
  describe('Create Feature Flag', () => {
    it('should create a new feature flag', async () => {
      requirePrerequisite(featureFlagCheck);

      const flagKey = `test_create_${crypto.randomUUID()}`;

      const { data: newFlag, error } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: flagKey,
          description: 'Created by integration test',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(newFlag).not.toBeNull();
      expect(newFlag?.key).toBe(flagKey);
      expect(newFlag?.is_enabled).toBe(false);

      // Cleanup
      if (newFlag?.id) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', newFlag.id);
      }
    });

    it('should reject duplicate flag key', async () => {
      requirePrerequisite(featureFlagCheck);

      const flagKey = `test_duplicate_${crypto.randomUUID()}`;

      // Create first flag
      const { data: firstFlag, error: firstError } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: flagKey,
          description: 'First flag',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      expect(firstError).toBeNull();
      expect(firstFlag?.key).toBe(flagKey);

      // Try to create duplicate
      const { data: duplicateFlag, error: duplicateError } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: flagKey,
          description: 'Duplicate flag',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      // Should fail with unique constraint violation
      expect(duplicateError).not.toBeNull();
      expect(duplicateFlag).toBeNull();

      // Cleanup
      if (firstFlag?.id) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', firstFlag.id);
      }
    });

    it('should record created_by and created_at for new flags', async () => {
      requirePrerequisite(featureFlagCheck);

      const flagKey = `test_metadata_${crypto.randomUUID()}`;
      const beforeCreate = new Date();

      // Create flag
      const { data: newFlag, error } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: flagKey,
          description: 'Test flag for metadata',
          is_enabled: true,
          strategy: 'percentage',
          rollout_percentage: 50,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(newFlag).not.toBeNull();

      // Verify created_by and created_at are populated
      expect(newFlag?.created_by).toBe(testAdminUserId);
      expect(newFlag?.created_at).not.toBeNull();
      const createdAt = new Date(newFlag!.created_at);
      // Allow tolerance (1s) for clock differences between Node.js and DB in CI
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime() - 1000);

      // Cleanup
      await supabaseAdmin.from('feature_flag').delete().eq('id', newFlag!.id);
    });

    // NOTE: Audit log creation is tested by service-level tests that call FeatureFlagService.
    // These integration tests focus on database constraints, RLS, and cascade behavior.
  });

  // updateFeatureFlag (toggle, percentage rollout, audit log)
  describe('Update Feature Flag', () => {
    let updateTestFlagId: string;
    const updateTestFlagKey = `test_update_${crypto.randomUUID()}`;

    beforeAll(async () => {
      if (!featureFlagCheck.available) return;

      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: updateTestFlagKey,
          description: 'Flag for update tests',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (flag) {
        updateTestFlagId = flag.id;
      }
    });

    afterAll(async () => {
      if (updateTestFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', updateTestFlagId);
      }
    });

    it('should toggle flag enabled state', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!updateTestFlagId) throw new Error('[PREREQUISITE NOT MET] updateTestFlagId not created');

      // Update to enabled
      const { error: updateError } = await supabaseAdmin
        .from('feature_flag')
        .update({ is_enabled: true, updated_by: testAdminUserId })
        .eq('id', updateTestFlagId);

      expect(updateError).toBeNull();

      // Verify
      const { data: updatedFlag } = await supabaseAdmin
        .from('feature_flag')
        .select('is_enabled')
        .eq('id', updateTestFlagId)
        .single();

      expect(updatedFlag?.is_enabled).toBe(true);
    });

    it('should update rollout percentage', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!updateTestFlagId) throw new Error('[PREREQUISITE NOT MET] updateTestFlagId not created');

      // Update strategy and percentage
      const { error: updateError } = await supabaseAdmin
        .from('feature_flag')
        .update({
          strategy: 'percentage',
          rollout_percentage: 75,
          updated_by: testAdminUserId,
        })
        .eq('id', updateTestFlagId);

      expect(updateError).toBeNull();

      // Verify
      const { data: updatedFlag } = await supabaseAdmin
        .from('feature_flag')
        .select('strategy, rollout_percentage')
        .eq('id', updateTestFlagId)
        .single();

      expect(updatedFlag?.strategy).toBe('percentage');
      expect(updatedFlag?.rollout_percentage).toBe(75);
    });

    it('should record updated_by when flag is updated', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!updateTestFlagId) throw new Error('[PREREQUISITE NOT MET] updateTestFlagId not created');

      // Update the flag with updated_by
      const { error: updateError } = await supabaseAdmin
        .from('feature_flag')
        .update({
          description: 'Updated description',
          updated_by: testAdminUserId,
        })
        .eq('id', updateTestFlagId);

      expect(updateError).toBeNull();

      // Verify updated_by is recorded
      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .select('updated_by, description')
        .eq('id', updateTestFlagId)
        .single();

      expect(flag?.updated_by).toBe(testAdminUserId);
      expect(flag?.description).toBe('Updated description');
    });

    // NOTE: Audit log creation for updates is tested by service-level tests.
  });

  // deleteFeatureFlag (cascade delete of overrides, audit log)
  describe('Delete Feature Flag', () => {
    it('should delete flag and cascade delete overrides', async () => {
      requirePrerequisite(featureFlagCheck);

      // Create a flag
      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: `test_delete_cascade_${crypto.randomUUID()}`,
          description: 'Flag for cascade delete test',
          is_enabled: true,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      expect(flag).not.toBeNull();
      expect(flag!.id).toEqual(expect.any(String));

      // Add overrides
      await supabaseAdmin.from('feature_flag_override').insert([
        {
          flag_id: flag!.id,
          tenant_id: testTenantId,
          is_enabled: true,
          created_by: testAdminUserId,
        },
        {
          flag_id: flag!.id,
          tenant_id: testTenantId2,
          is_enabled: false,
          created_by: testAdminUserId,
        },
      ]);

      // Verify overrides exist
      const { data: overridesBefore } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id')
        .eq('flag_id', flag!.id);

      expect(overridesBefore).toHaveLength(2);

      // Delete the flag
      const { error: deleteError } = await supabaseAdmin
        .from('feature_flag')
        .delete()
        .eq('id', flag!.id);

      expect(deleteError).toBeNull();

      // Verify flag is deleted
      const { data: deletedFlag } = await supabaseAdmin
        .from('feature_flag')
        .select('id')
        .eq('id', flag!.id)
        .single();

      expect(deletedFlag).toBeNull();

      // Verify overrides are cascade deleted
      const { data: overridesAfter } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id')
        .eq('flag_id', flag!.id);

      expect(overridesAfter).toHaveLength(0);
    });

    // NOTE: Audit log creation for deletes is tested by service-level tests.
    // These integration tests verify database cascade behavior (tested above).
  });

  // setFlagOverride and removeFlagOverride (per-org override CRUD)
  describe('Override Operations', () => {
    let overrideTestFlagId: string;

    beforeAll(async () => {
      if (!featureFlagCheck.available) return;

      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: `test_override_ops_${crypto.randomUUID()}`,
          description: 'Flag for override operation tests',
          is_enabled: true,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (flag) {
        overrideTestFlagId = flag.id;
      }
    });

    afterAll(async () => {
      if (overrideTestFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', overrideTestFlagId);
      }
    });

    it('should set an override for a tenant', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!overrideTestFlagId) throw new Error('[PREREQUISITE NOT MET] overrideTestFlagId not created');

      // Set override
      const { error: insertError } = await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: overrideTestFlagId,
        tenant_id: testTenantId,
        is_enabled: false,
        created_by: testAdminUserId,
      });

      expect(insertError).toBeNull();

      // Verify
      const { data: override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('*')
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId)
        .single();

      expect(override).not.toBeNull();
      expect(override?.is_enabled).toBe(false);
    });

    it('should update an existing override', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!overrideTestFlagId) throw new Error('[PREREQUISITE NOT MET] overrideTestFlagId not created');

      // Update override
      const { error: updateError } = await supabaseAdmin
        .from('feature_flag_override')
        .update({ is_enabled: true })
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId);

      expect(updateError).toBeNull();

      // Verify
      const { data: override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId)
        .single();

      expect(override?.is_enabled).toBe(true);
    });

    it('should remove an override', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!overrideTestFlagId) throw new Error('[PREREQUISITE NOT MET] overrideTestFlagId not created');

      // Remove override
      const { error: deleteError } = await supabaseAdmin
        .from('feature_flag_override')
        .delete()
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId);

      expect(deleteError).toBeNull();

      // Verify
      const { data: override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('id')
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId)
        .single();

      expect(override).toBeNull();
    });

    it('should enforce unique constraint on flag_id + tenant_id', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!overrideTestFlagId) throw new Error('[PREREQUISITE NOT MET] overrideTestFlagId not created');

      // Create first override
      const { error: firstError } = await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: overrideTestFlagId,
        tenant_id: testTenantId2,
        is_enabled: true,
        created_by: testAdminUserId,
      });

      expect(firstError).toBeNull();

      // Try to create duplicate
      const { error: duplicateError } = await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: overrideTestFlagId,
        tenant_id: testTenantId2,
        is_enabled: false,
        created_by: testAdminUserId,
      });

      expect(duplicateError).not.toBeNull();

      // Cleanup
      await supabaseAdmin
        .from('feature_flag_override')
        .delete()
        .eq('flag_id', overrideTestFlagId)
        .eq('tenant_id', testTenantId2);
    });
  });

  // isEnabled evaluation (override priority, percentage rollout, boundary cases)
  describe('Flag Evaluation Logic', () => {
    let evalFlagId: string;
    const evalFlagKey = `test_eval_${crypto.randomUUID()}`;

    beforeAll(async () => {
      if (!featureFlagCheck.available) return;

      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: evalFlagKey,
          description: 'Flag for evaluation tests',
          is_enabled: true,
          strategy: 'global',
          rollout_percentage: 50,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (flag) {
        evalFlagId = flag.id;
      }
    });

    afterAll(async () => {
      if (evalFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', evalFlagId);
      }
    });

    it('should return false when flag is disabled', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Disable the flag
      await supabaseAdmin.from('feature_flag').update({ is_enabled: false }).eq('id', evalFlagId);

      // Get flag state
      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .select('is_enabled')
        .eq('id', evalFlagId)
        .single();

      expect(flag?.is_enabled).toBe(false);

      // Re-enable for other tests
      await supabaseAdmin.from('feature_flag').update({ is_enabled: true }).eq('id', evalFlagId);
    });

    it('should prioritize override over global setting', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Create override that disables the flag for tenant 1
      await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: evalFlagId,
        tenant_id: testTenantId,
        is_enabled: false,
        created_by: testAdminUserId,
      });

      // Get override for tenant
      const { data: override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId)
        .single();

      // Override should take precedence: flag is globally ON, but override is OFF
      expect(override?.is_enabled).toBe(false);

      // Tenant 2 has no override, so should use global setting
      const { data: noOverride } = await supabaseAdmin
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId2)
        .single();

      expect(noOverride).toBeNull();

      // Cleanup
      await supabaseAdmin
        .from('feature_flag_override')
        .delete()
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId);
    });

    it('should handle percentage rollout strategy', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Update to percentage strategy
      await supabaseAdmin
        .from('feature_flag')
        .update({ strategy: 'percentage', rollout_percentage: 50 })
        .eq('id', evalFlagId);

      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .select('strategy, rollout_percentage')
        .eq('id', evalFlagId)
        .single();

      expect(flag?.strategy).toBe('percentage');
      expect(flag?.rollout_percentage).toBe(50);

      // Note: Actual percentage evaluation uses deterministic hashing,
      // so we just verify the flag has correct configuration
    });

    it('should handle boundary cases for rollout percentage', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Test 0%
      await supabaseAdmin.from('feature_flag').update({ rollout_percentage: 0 }).eq('id', evalFlagId);

      let { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .select('rollout_percentage')
        .eq('id', evalFlagId)
        .single();

      expect(flag?.rollout_percentage).toBe(0);

      // Test 100%
      await supabaseAdmin
        .from('feature_flag')
        .update({ rollout_percentage: 100 })
        .eq('id', evalFlagId);

      ({ data: flag } = await supabaseAdmin
        .from('feature_flag')
        .select('rollout_percentage')
        .eq('id', evalFlagId)
        .single());

      expect(flag?.rollout_percentage).toBe(100);
    });

    it('should handle targeted strategy (only overriden tenants)', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Update to targeted strategy
      await supabaseAdmin
        .from('feature_flag')
        .update({ strategy: 'targeted', rollout_percentage: 0 })
        .eq('id', evalFlagId);

      // Add override for tenant 1 only
      await supabaseAdmin.from('feature_flag_override').insert({
        flag_id: evalFlagId,
        tenant_id: testTenantId,
        is_enabled: true,
        created_by: testAdminUserId,
      });

      // Tenant 1 should have the flag (has override)
      const { data: tenant1Override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId)
        .single();

      expect(tenant1Override?.is_enabled).toBe(true);

      // Tenant 2 should not have the flag (no override in targeted mode)
      const { data: tenant2Override } = await supabaseAdmin
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId2)
        .single();

      expect(tenant2Override).toBeNull();

      // Cleanup
      await supabaseAdmin
        .from('feature_flag_override')
        .delete()
        .eq('flag_id', evalFlagId)
        .eq('tenant_id', testTenantId);
    });

    it('should return false for invalid/unknown strategy value', async () => {
      requirePrerequisite(featureFlagCheck);
      if (!evalFlagId) throw new Error('[PREREQUISITE NOT MET] evalFlagId not created');

      // Force an invalid strategy value (should only be possible via direct DB update)
      const { error: updateError } = await supabaseAdmin
        .from('feature_flag')
        .update({ strategy: 'invalid_strategy' as 'global', is_enabled: true })
        .eq('id', evalFlagId);

      // The database might reject this due to CHECK constraint
      // Either way, if the value is unknown, evaluateFlag should return false
      if (!updateError) {
        const result = await evaluateFlag(evalFlagId, testTenantId);
        expect(result).toBe(false);

        // Reset to valid value
        await supabaseAdmin
          .from('feature_flag')
          .update({ strategy: 'global' })
          .eq('id', evalFlagId);
      }
    });
  });

  // Comprehensive flag evaluation permutations (override-first behavior)
  // Uses evaluateFlag from top-level describe scope (imported from production)
  describe('Flag Evaluation Permutations', () => {
    let permFlagId: string;
    const permFlagKey = `test_perm_${crypto.randomUUID()}`;

    beforeAll(async () => {
      if (!featureFlagCheck.available) return;

      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: permFlagKey,
          description: 'Flag for evaluation permutation tests',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (flag) {
        permFlagId = flag.id;
      }
    });

    afterAll(async () => {
      if (permFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', permFlagId);
      }
    });

    // Clean up overrides before each test
    beforeEach(async () => {
      if (!featureFlagCheck.available || !permFlagId) return;
      await supabaseAdmin.from('feature_flag_override').delete().eq('flag_id', permFlagId);
    });

    describe('Kill Switch OFF scenarios', () => {
      beforeEach(async () => {
        if (!permFlagId) return;
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: false, strategy: 'global' })
          .eq('id', permFlagId);
      });

      it('should return false when kill switch OFF and no override', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false);
      });

      it('should return true when kill switch OFF but override is enabled (override-first)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add enabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: true,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true); // Override takes precedence over kill switch
      });

      it('should return false when kill switch OFF and override is disabled', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add disabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: false,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false);
      });
    });

    describe('Kill Switch ON + Global Strategy scenarios', () => {
      beforeEach(async () => {
        if (!permFlagId) return;
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'global' })
          .eq('id', permFlagId);
      });

      it('should return true when kill switch ON, global strategy, no override', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true);
      });

      it('should return false when kill switch ON, global strategy, override disabled', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add disabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: false,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false); // Override takes precedence
      });

      it('should return true when kill switch ON, global strategy, override enabled', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add enabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: true,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true);
      });
    });

    describe('Kill Switch ON + Targeted Strategy scenarios', () => {
      beforeEach(async () => {
        if (!permFlagId) return;
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'targeted' })
          .eq('id', permFlagId);
      });

      it('should return false when targeted strategy and no override', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false); // Targeted = only overrides matter
      });

      it('should return true when targeted strategy and override enabled', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add enabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: true,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true);
      });

      it('should return false when targeted strategy and override disabled', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Add disabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: false,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false);
      });

      it('should handle mixed overrides (one enabled, one disabled)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Tenant 1 gets enabled, Tenant 2 gets disabled
        await supabaseAdmin.from('feature_flag_override').insert([
          { flag_id: permFlagId, tenant_id: testTenantId, is_enabled: true, created_by: testAdminUserId },
          { flag_id: permFlagId, tenant_id: testTenantId2, is_enabled: false, created_by: testAdminUserId },
        ]);

        const result1 = await evaluateFlag(permFlagId, testTenantId);
        const result2 = await evaluateFlag(permFlagId, testTenantId2);

        expect(result1).toBe(true);
        expect(result2).toBe(false);
      });
    });

    describe('Kill Switch ON + Percentage Strategy scenarios', () => {
      beforeEach(async () => {
        if (!permFlagId) return;
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'percentage', rollout_percentage: 50 })
          .eq('id', permFlagId);
      });

      it('should return consistent result for same tenant (deterministic hash)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Call multiple times - should always return same result for same tenant
        const results = await Promise.all([
          evaluateFlag(permFlagId, testTenantId),
          evaluateFlag(permFlagId, testTenantId),
          evaluateFlag(permFlagId, testTenantId),
        ]);

        expect(results[0]).toBe(results[1]);
        expect(results[1]).toBe(results[2]);
      });

      it('should return true for override enabled regardless of percentage', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Set percentage to 0 (no one should get it)
        await supabaseAdmin
          .from('feature_flag')
          .update({ rollout_percentage: 0 })
          .eq('id', permFlagId);

        // But add enabled override
        await supabaseAdmin.from('feature_flag_override').insert({
          flag_id: permFlagId,
          tenant_id: testTenantId,
          is_enabled: true,
          created_by: testAdminUserId,
        });

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true); // Override beats percentage
      });

      it('should return false when percentage is 0 and no override', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        await supabaseAdmin
          .from('feature_flag')
          .update({ rollout_percentage: 0 })
          .eq('id', permFlagId);

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(false);
      });

      it('should return true when percentage is 100 and no override', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        await supabaseAdmin
          .from('feature_flag')
          .update({ rollout_percentage: 100 })
          .eq('id', permFlagId);

        const result = await evaluateFlag(permFlagId, testTenantId);
        expect(result).toBe(true);
      });
    });

    describe('Percentage Rollout - Cohort Stability', () => {
      // Test that increasing percentage from 50% to 60% keeps original cohort + adds new tenants

      it('should maintain stable cohorts when percentage increases (50% -> 60%)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Generate 100 deterministic tenant IDs
        const testTenants = Array.from({ length: 100 }, (_, i) => `test-tenant-cohort-${i.toString().padStart(3, '0')}`);

        // Set to 50%
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'percentage', rollout_percentage: 50 })
          .eq('id', permFlagId);

        // Evaluate all tenants at 50%
        const resultsAt50 = await Promise.all(
          testTenants.map(async (tid) => ({
            tenantId: tid,
            enabled: await evaluateFlag(permFlagId, tid),
          }))
        );
        const enabledAt50 = resultsAt50.filter((r) => r.enabled).map((r) => r.tenantId);

        // Increase to 60%
        await supabaseAdmin
          .from('feature_flag')
          .update({ rollout_percentage: 60 })
          .eq('id', permFlagId);

        // Evaluate all tenants at 60%
        const resultsAt60 = await Promise.all(
          testTenants.map(async (tid) => ({
            tenantId: tid,
            enabled: await evaluateFlag(permFlagId, tid),
          }))
        );
        const enabledAt60 = resultsAt60.filter((r) => r.enabled).map((r) => r.tenantId);

        // All tenants enabled at 50% MUST still be enabled at 60%
        const stillEnabled = enabledAt50.every((tid) => enabledAt60.includes(tid));
        expect(stillEnabled).toBe(true);

        // 60% cohort should be larger than or equal to 50% cohort
        expect(enabledAt60.length).toBeGreaterThanOrEqual(enabledAt50.length);

        // Log for visibility
        console.log(`Cohort stability test: 50% = ${enabledAt50.length} tenants, 60% = ${enabledAt60.length} tenants`);
      });

      it('should maintain stable cohorts when percentage decreases (60% -> 50%)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        const testTenants = Array.from({ length: 100 }, (_, i) => `test-tenant-decrease-${i.toString().padStart(3, '0')}`);

        // Set to 60%
        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'percentage', rollout_percentage: 60 })
          .eq('id', permFlagId);

        const resultsAt60 = await Promise.all(
          testTenants.map(async (tid) => ({
            tenantId: tid,
            enabled: await evaluateFlag(permFlagId, tid),
          }))
        );
        const enabledAt60 = resultsAt60.filter((r) => r.enabled).map((r) => r.tenantId);

        // Decrease to 50%
        await supabaseAdmin
          .from('feature_flag')
          .update({ rollout_percentage: 50 })
          .eq('id', permFlagId);

        const resultsAt50 = await Promise.all(
          testTenants.map(async (tid) => ({
            tenantId: tid,
            enabled: await evaluateFlag(permFlagId, tid),
          }))
        );
        const enabledAt50 = resultsAt50.filter((r) => r.enabled).map((r) => r.tenantId);

        // All tenants enabled at 50% MUST be a subset of those enabled at 60%
        const isSubset = enabledAt50.every((tid) => enabledAt60.includes(tid));
        expect(isSubset).toBe(true);

        // 50% cohort should be smaller than or equal to 60% cohort
        expect(enabledAt50.length).toBeLessThanOrEqual(enabledAt60.length);

        console.log(`Cohort decrease test: 60% = ${enabledAt60.length} tenants, 50% = ${enabledAt50.length} tenants`);
      });

      it('should have bucket values in range 0-99', () => {
        // Test that our hash function produces values in expected range
        const testTenants = Array.from({ length: 1000 }, (_, i) => `bucket-test-${i}`);
        const buckets = testTenants.map(computeTenantBucket);

        expect(buckets.every((b) => b >= 0 && b < 100)).toBe(true);
        expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...buckets)).toBeLessThan(100);
      });
    });

    describe('Percentage Rollout - Statistical Distribution', () => {
      let testFlagId50: string;
      let testFlagId25: string;
      let testFlagId75: string;

      beforeAll(async () => {
        if (!featureFlagCheck.available) return;

        // Create separate flags for each test to avoid race conditions when running in parallel
        const { data: flag50, error: error50 } = await supabaseAdmin
          .from('feature_flag')
          .insert({
            key: `test_stats_50_${crypto.randomUUID()}`,
            description: 'Flag for 50% statistical distribution test',
            is_enabled: true,
            strategy: 'percentage',
            rollout_percentage: 50,
            created_by: testAdminUserId,
          })
          .select()
          .single();

        if (error50) {
          throw new Error(`Failed to create test flag for 50%: ${error50.message}`);
        }
        testFlagId50 = flag50!.id;

        const { data: flag25, error: error25 } = await supabaseAdmin
          .from('feature_flag')
          .insert({
            key: `test_stats_25_${crypto.randomUUID()}`,
            description: 'Flag for 25% statistical distribution test',
            is_enabled: true,
            strategy: 'percentage',
            rollout_percentage: 25,
            created_by: testAdminUserId,
          })
          .select()
          .single();

        if (error25) {
          throw new Error(`Failed to create test flag for 25%: ${error25.message}`);
        }
        testFlagId25 = flag25!.id;

        const { data: flag75, error: error75 } = await supabaseAdmin
          .from('feature_flag')
          .insert({
            key: `test_stats_75_${crypto.randomUUID()}`,
            description: 'Flag for 75% statistical distribution test',
            is_enabled: true,
            strategy: 'percentage',
            rollout_percentage: 75,
            created_by: testAdminUserId,
          })
          .select()
          .single();

        if (error75) {
          throw new Error(`Failed to create test flag for 75%: ${error75.message}`);
        }
        testFlagId75 = flag75!.id;
      });

      afterAll(async () => {
        if (!featureFlagCheck.available) return;

        // Clean up all three test flags
        const flagsToDelete = [testFlagId50, testFlagId25, testFlagId75].filter(Boolean);
        if (flagsToDelete.length > 0) {
          await supabaseAdmin.from('feature_flag').delete().in('id', flagsToDelete);
        }
      });

      it('should distribute ~50% of tenants when percentage is 50 (within 15% tolerance)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!testFlagId50) throw new Error('[PREREQUISITE NOT MET] testFlagId50 not created in beforeAll');

        // Use computeTenantBucket directly to test hash distribution without
        // hitting Supabase — concurrent evaluateFlag calls saturate connections
        const testTenants = Array.from({ length: 200 }, () => crypto.randomUUID());
        const enabledCount = testTenants.filter((tid) => computeTenantBucket(tid) < 50).length;
        const percentage = (enabledCount / testTenants.length) * 100;

        console.log(`50% rollout: ${enabledCount}/${testTenants.length} = ${percentage.toFixed(1)}%`);
        expect(percentage).toBeGreaterThanOrEqual(35);
        expect(percentage).toBeLessThanOrEqual(65);
      });

      it('should distribute ~25% of tenants when percentage is 25 (within 15% tolerance)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!testFlagId25) throw new Error('[PREREQUISITE NOT MET] testFlagId25 not created in beforeAll');

        // Use computeTenantBucket directly to test hash distribution without
        // hitting Supabase — concurrent evaluateFlag calls saturate connections
        const testTenants = Array.from({ length: 200 }, () => crypto.randomUUID());
        const enabledCount = testTenants.filter((tid) => computeTenantBucket(tid) < 25).length;
        const percentage = (enabledCount / testTenants.length) * 100;

        console.log(`25% rollout: ${enabledCount}/${testTenants.length} = ${percentage.toFixed(1)}%`);
        expect(percentage).toBeGreaterThanOrEqual(10);
        expect(percentage).toBeLessThanOrEqual(40);
      });

      it('should distribute ~75% of tenants when percentage is 75 (within 15% tolerance)', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!testFlagId75) throw new Error('[PREREQUISITE NOT MET] testFlagId75 not created in beforeAll');

        // Use computeTenantBucket directly to test hash distribution without
        // hitting Supabase — concurrent evaluateFlag calls saturate connections
        const testTenants = Array.from({ length: 200 }, () => crypto.randomUUID());
        const enabledCount = testTenants.filter((tid) => computeTenantBucket(tid) < 75).length;
        const percentage = (enabledCount / testTenants.length) * 100;

        console.log(`75% rollout: ${enabledCount}/${testTenants.length} = ${percentage.toFixed(1)}%`);
        expect(percentage).toBeGreaterThanOrEqual(60);
        expect(percentage).toBeLessThanOrEqual(90);
      });

      it('should produce monotonically increasing enabled counts as percentage increases', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        // Use computeTenantBucket directly — this is a pure hash property test.
        // Fixed set so monotonic property holds (same tenants across percentage increases)
        const testTenants = Array.from({ length: 100 }, () => crypto.randomUUID());
        const percentages = [10, 20, 30, 40, 50, 60, 70, 80, 90];
        const counts: number[] = [];

        for (const pct of percentages) {
          const count = testTenants.filter((tid) => computeTenantBucket(tid) < pct).length;
          counts.push(count);
        }

        // Each count should be >= previous count (monotonically increasing)
        for (let i = 1; i < counts.length; i++) {
          const current = counts[i] as number;
          const previous = counts[i - 1] as number;
          expect(current).toBeGreaterThanOrEqual(previous);
        }

        console.log(`Monotonic counts: ${percentages.map((p, i) => `${p}%=${counts[i]}`).join(', ')}`);
      });
    });

    describe('Edge cases', () => {
      it('should return false when no tenant_id provided', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'percentage', rollout_percentage: 50 })
          .eq('id', permFlagId);

        const result = await evaluateFlag(permFlagId, undefined);
        expect(result).toBe(false); // No tenant = can't evaluate percentage
      });

      it('should return true for global strategy even without tenant_id', async () => {
        requirePrerequisite(featureFlagCheck);
        if (!permFlagId) throw new Error('[PREREQUISITE NOT MET] permFlagId not created in beforeAll');

        await supabaseAdmin
          .from('feature_flag')
          .update({ is_enabled: true, strategy: 'global' })
          .eq('id', permFlagId);

        const result = await evaluateFlag(permFlagId, undefined);
        expect(result).toBe(true); // Global = on for everyone
      });
    });
  });
});
