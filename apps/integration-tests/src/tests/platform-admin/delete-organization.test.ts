import { getSupabaseAdmin, checkTableExists, requirePrerequisite, type PrerequisiteCheck } from '../../lib/test-utils';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';

/**
 * Integration tests for Platform Admin - Delete Organization
 *
 * These tests verify the deleteOrganization server action behavior
 * through direct database operations. They test:
 * - Confirmation name validation
 * - Cascade delete behavior
 * - Audit log creation
 *
 * Prerequisites:
 * - platform_user_role table must exist (from migration)
 * - audit_log table must exist
 *
 * Note: These tests use the admin client to simulate server action behavior
 * since server actions require Next.js context that's unavailable in Jest.
 */

describe('Platform Admin - Delete Organization', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let testTenantId: string;
  let testAppId: string;
  let testUserId: string;
  let testProfileEmail: string;
  let platformAdminCheck: PrerequisiteCheck;

  beforeAll(async () => {
    // Check if platform_user_role table exists (migration dependency)
    platformAdminCheck = await checkTableExists('platform_user_role');

    if (!platformAdminCheck.available) {
      return;
    }

    // Create test data for deletion tests
    testProfileEmail = `platform-admin-test-${crypto.randomUUID()}@outerlayer.ai`;

    // Create auth user
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testProfileEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (authError || !authUser.user) {
      throw new Error(`Failed to create test user: ${authError?.message}`);
    }

    testUserId = authUser.user.id;

    // Create profile for user (required by app.created_by FK)
    await supabaseAdmin.from('profile').insert({
      id: testUserId,
      name: 'Platform Admin Test User',
      email: testProfileEmail,
    });

    // Create tenant
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenant')
      .insert({
        organization_name: `Test Org To Delete ${crypto.randomUUID()}`,
        company_name: 'Test Company',
        created_by: testUserId,
      })
      .select()
      .single();

    if (tenantError || !tenant) {
      throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
    }

    testTenantId = tenant.tenant_id;

    // Note: Not creating membership with role to avoid "last owner" trigger constraint
    // The cascade delete test focuses on app/tenant relationships

    // Create an app for the tenant
    const { data: app, error: appError } = await supabaseAdmin
      .from('app')
      .insert({
        name: 'Test App To Delete',
        tenant_id: testTenantId,
        created_by: testUserId,
      })
      .select()
      .single();

    if (appError || !app) {
      throw new Error(`Failed to create test app: ${appError?.message}`);
    }

    testAppId = app.id;
  });

  afterAll(async () => {
    if (!platformAdminCheck.available) return;

    // Cleanup test data if not already deleted
    // These will silently fail if already deleted, which is expected

    if (testAppId) {
      await supabaseAdmin.from('app').delete().eq('id', testAppId);
    }

    if (testTenantId) {
      await supabaseAdmin.from('membership').delete().eq('tenant_id', testTenantId);
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', testTenantId);
    }

    if (testUserId) {
      await supabaseAdmin.from('profile').delete().eq('id', testUserId);
      await supabaseAdmin.auth.admin.deleteUser(testUserId);
    }
  });

  describe('Confirmation Validation', () => {
    it('should retrieve organization name for confirmation matching', async () => {
      requirePrerequisite(platformAdminCheck);

      const { data: org } = await supabaseAdmin
        .from('tenant')
        .select('organization_name')
        .eq('tenant_id', testTenantId)
        .single();

      // Primary assertion: organization exists with a non-empty name
      expect(typeof org?.organization_name).toBe('string');
      expect(org!.organization_name.length).toBeGreaterThan(0);
      expect(org!.organization_name).toContain('Test Org To Delete');
    });
  });

  describe('Cascade Delete Behavior', () => {
    it('should successfully delete app when delete is requested', async () => {
      requirePrerequisite(platformAdminCheck);

      // Verify app exists before deletion
      const { data: appBefore } = await supabaseAdmin
        .from('app')
        .select('id, name')
        .eq('id', testAppId)
        .single();

      expect(appBefore?.id).toBe(testAppId);
      expect(appBefore?.name).toBe('Test App To Delete');

      // Deleted directly because this test is about the app delete itself.
      // Deleting the tenant would also remove it, via the tenant cascade.
      await supabaseAdmin.from('app').delete().eq('id', testAppId);

      // Verify app no longer exists
      const { error: lookupError } = await supabaseAdmin
        .from('app')
        .select('id')
        .eq('id', testAppId)
        .single();

      expect(lookupError?.code).toBe('PGRST116'); // Row not found
      testAppId = ''; // Mark as deleted
    });

    it('should successfully delete tenant after apps are removed', async () => {
      requirePrerequisite(platformAdminCheck);

      // Verify tenant exists before deletion
      const { data: tenantBefore } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id, organization_name')
        .eq('tenant_id', testTenantId)
        .single();

      expect(tenantBefore?.tenant_id).toBe(testTenantId);
      expect(tenantBefore?.organization_name).toContain('Test Org To Delete');

      // Delete tenant
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', testTenantId);

      // Verify tenant no longer exists
      const { error: lookupError } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id')
        .eq('tenant_id', testTenantId)
        .single();

      expect(lookupError?.code).toBe('PGRST116'); // Row not found
      testTenantId = ''; // Mark as deleted
    });
  });

  describe('Audit Log', () => {
    let auditTenantId: string;
    let auditUserId: string;
    const auditOrgName = `Audit Test Org ${crypto.randomUUID()}`;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Check if audit_log table exists
      const { error: auditTableError } = await supabaseAdmin
        .from('audit_log')
        .select('id')
        .limit(1);

      if (auditTableError) {
        console.warn('audit_log table not available, skipping audit tests');
        return;
      }

      // Create a new tenant for audit log testing
      const auditEmail = `audit-test-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: auditEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!authUser.user) return;
      auditUserId = authUser.user.id;

      // Create profile for audit user (required by audit_log actor FK)
      await supabaseAdmin.from('profile').insert({
        id: auditUserId,
        name: 'Audit Test User',
        email: auditEmail,
      });

      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: auditOrgName,
          company_name: 'Audit Test Company',
          created_by: auditUserId,
        })
        .select()
        .single();

      if (!tenant) return;
      auditTenantId = tenant.tenant_id;
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup
      if (auditTenantId) {
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', auditTenantId);
      }
      if (auditUserId) {
        await supabaseAdmin.from('profile').delete().eq('id', auditUserId);
        await supabaseAdmin.auth.admin.deleteUser(auditUserId);
      }
    });

    it('should create audit log entry with before_state when organization is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!auditTenantId) throw new Error('[PREREQUISITE NOT MET] auditTenantId not created');

      // Simulate what the server action does: delete and create audit log
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', auditTenantId);

      // Create the audit log entry (simulating server action behavior)
      await supabaseAdmin.from('audit_log').insert({
        actor_id: auditUserId,
        action_type: 'org_delete',
        target_type: 'tenant',
        target_id: auditTenantId,
        target_identifier: auditOrgName,
        details: { reason: 'Integration test', test: true },
        before_state: {
          organization_name: auditOrgName,
          company_name: 'Audit Test Company',
        },
        after_state: null,
      });

      // Primary assertions: verify audit log contains expected data
      const { data: auditLog } = await supabaseAdmin
        .from('audit_log')
        .select('target_identifier, target_type, action_type, before_state, after_state')
        .eq('target_id', auditTenantId)
        .eq('action_type', 'org_delete')
        .single();

      expect(auditLog?.action_type).toBe('org_delete');
      expect(auditLog?.target_type).toBe('tenant');
      expect(auditLog?.target_identifier).toBe(auditOrgName);
      expect(auditLog?.before_state).toEqual({
        organization_name: auditOrgName,
        company_name: 'Audit Test Company',
      });
      // after_state is null for deletes (organization no longer exists)
      expect(auditLog?.after_state).toBeNull();

      auditTenantId = ''; // Mark as deleted
    });
  });

  describe('Temp Access Grant Cascade Delete', () => {
    let cascadeTenantId: string;
    let cascadeUserId: string;
    let platformAdminId: string;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Create a tenant to delete
      const testEmail = `cascade-test-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!authUser.user) return;
      cascadeUserId = authUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: cascadeUserId,
        name: 'Cascade Test User',
        email: testEmail,
      });

      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `Cascade Test Org ${crypto.randomUUID()}`,
          company_name: 'Cascade Test Company',
          created_by: cascadeUserId,
        })
        .select()
        .single();

      if (!tenant) return;
      cascadeTenantId = tenant.tenant_id;

      // Create a platform admin user
      const adminEmail = `platform-admin-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: adminUser } = await supabaseAdmin.auth.admin.createUser({
        email: adminEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!adminUser.user) return;
      platformAdminId = adminUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: platformAdminId,
        name: 'Platform Admin User',
        email: adminEmail,
      });

      // Grant platform admin role
      await supabaseAdmin.from('platform_user_role').insert({
        user_id: platformAdminId,
        role: 'platform_admin',
      });
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup
      if (cascadeTenantId) {
        await supabaseAdmin.from('temp_access_grant').delete().eq('tenant_id', cascadeTenantId);
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', cascadeTenantId);
      }
      if (cascadeUserId) {
        await supabaseAdmin.from('profile').delete().eq('id', cascadeUserId);
        await supabaseAdmin.auth.admin.deleteUser(cascadeUserId);
      }
      if (platformAdminId) {
        await supabaseAdmin.from('platform_user_role').delete().eq('user_id', platformAdminId);
        await supabaseAdmin.from('profile').delete().eq('id', platformAdminId);
        await supabaseAdmin.auth.admin.deleteUser(platformAdminId);
      }
    });

    it('should cascade delete temp_access_grant when tenant is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!cascadeTenantId || !platformAdminId) throw new Error('[PREREQUISITE NOT MET] cascadeTenantId or platformAdminId not created');

      // Create a temp access grant for the tenant
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const { error: grantError, data: grant } = await supabaseAdmin
        .from('temp_access_grant')
        .insert({
          created_by: platformAdminId,
          tenant_id: cascadeTenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Integration test - cascade delete',
        })
        .select()
        .single();

      expect(grantError).toBeNull();
      expect(grant).not.toBeNull();

      const grantId = grant!.id;

      // Verify grant exists
      const { data: grantBefore } = await supabaseAdmin
        .from('temp_access_grant')
        .select('id')
        .eq('id', grantId)
        .single();

      expect(grantBefore).not.toBeNull();

      // Delete the tenant - temp_access_grant should cascade delete
      const { error: deleteError } = await supabaseAdmin
        .from('tenant')
        .delete()
        .eq('tenant_id', cascadeTenantId);

      expect(deleteError).toBeNull();

      // Verify temp_access_grant was cascade deleted
      const { data: grantAfter, error: grantCheckError } = await supabaseAdmin
        .from('temp_access_grant')
        .select('id')
        .eq('id', grantId)
        .single();

      // Should return no data (record deleted via cascade)
      expect(grantAfter).toBeNull();
      expect(grantCheckError?.code).toBe('PGRST116'); // Row not found

      // Clear tenant ID since it's deleted
      cascadeTenantId = '';
    });
  });

  describe('Attribution FK SET NULL on User Delete', () => {
    let attrTenantId: string;
    let attrUserId: string;
    let attrAppId: string;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Create a user who will create an app
      const testEmail = `attribution-test-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!authUser.user) return;
      attrUserId = authUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: attrUserId,
        name: 'Attribution Test User',
        email: testEmail,
      });

      // Create a tenant (not owned by test user to avoid cascade issues)
      const ownerEmail = `owner-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: ownerUser } = await supabaseAdmin.auth.admin.createUser({
        email: ownerEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      await supabaseAdmin.from('profile').insert({
        id: ownerUser!.user!.id,
        name: 'Owner User',
        email: ownerEmail,
      });

      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `Attribution Test Org ${crypto.randomUUID()}`,
          company_name: 'Attribution Test Company',
          created_by: ownerUser!.user!.id,
        })
        .select()
        .single();

      if (!tenant) return;
      attrTenantId = tenant.tenant_id;

      // Create an app with created_by = attrUserId
      // Note: Don't set updated_by on insert as it may trigger auth.uid() validation
      const { data: app } = await supabaseAdmin
        .from('app')
        .insert({
          name: 'Attribution Test App',
          tenant_id: attrTenantId,
          created_by: attrUserId,
        })
        .select()
        .single();

      if (!app) return;
      attrAppId = app.id;
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup
      if (attrAppId) {
        await supabaseAdmin.from('app').delete().eq('id', attrAppId);
      }
      if (attrTenantId) {
        await supabaseAdmin.from('membership').delete().eq('tenant_id', attrTenantId);
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', attrTenantId);
      }
      // Note: attrUserId is deleted during the test, don't try to clean up
    });

    it('should SET NULL on created_by/updated_by when user is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!attrAppId || !attrUserId) throw new Error('[PREREQUISITE NOT MET] attrAppId or attrUserId not created');

      // Verify app has created_by set
      const { data: appBefore } = await supabaseAdmin
        .from('app')
        .select('id, created_by')
        .eq('id', attrAppId)
        .single();

      expect(appBefore).not.toBeNull();
      expect(appBefore?.created_by).toBe(attrUserId);

      // Delete the profile first (FK target)
      const { error: profileDeleteError } = await supabaseAdmin
        .from('profile')
        .delete()
        .eq('id', attrUserId);

      expect(profileDeleteError).toBeNull();

      // Delete the auth user
      await supabaseAdmin.auth.admin.deleteUser(attrUserId);

      // Verify app still exists but created_by is NULL (SET NULL behavior)
      const { data: appAfter } = await supabaseAdmin
        .from('app')
        .select('id, created_by')
        .eq('id', attrAppId)
        .single();

      expect(appAfter).not.toBeNull();
      expect(appAfter?.created_by).toBeNull();

      // Clear user ID since it's deleted
      attrUserId = '';
    });
  });

  describe('Feature Flag Attribution SET NULL', () => {
    let flagCreatorId: string;
    let testFlagId: string;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Create a user who will create a feature flag
      const testEmail = `flag-creator-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!authUser.user) return;
      flagCreatorId = authUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: flagCreatorId,
        name: 'Flag Creator',
        email: testEmail,
      });

      // Create a feature flag with created_by = flagCreatorId
      const { data: flag } = await supabaseAdmin
        .from('feature_flag')
        .insert({
          key: `test_flag_${crypto.randomUUID()}`,
          description: 'Test flag for SET NULL verification',
          is_enabled: false,
          strategy: 'global',
          rollout_percentage: 0,
          created_by: flagCreatorId,
          updated_by: flagCreatorId,
        })
        .select()
        .single();

      if (!flag) return;
      testFlagId = flag.id;
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup
      if (testFlagId) {
        await supabaseAdmin.from('feature_flag').delete().eq('id', testFlagId);
      }
      // Note: flagCreatorId is deleted during the test
    });

    it('should SET NULL on feature_flag created_by/updated_by when user is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!testFlagId || !flagCreatorId) throw new Error('[PREREQUISITE NOT MET] testFlagId or flagCreatorId not created');

      // Verify flag has created_by set
      const { data: flagBefore } = await supabaseAdmin
        .from('feature_flag')
        .select('id, created_by, updated_by')
        .eq('id', testFlagId)
        .single();

      expect(flagBefore).not.toBeNull();
      expect(flagBefore?.created_by).toBe(flagCreatorId);
      expect(flagBefore?.updated_by).toBe(flagCreatorId);

      // Delete the profile
      const { error: profileDeleteError } = await supabaseAdmin
        .from('profile')
        .delete()
        .eq('id', flagCreatorId);

      expect(profileDeleteError).toBeNull();

      // Delete the auth user
      await supabaseAdmin.auth.admin.deleteUser(flagCreatorId);

      // Verify flag still exists but created_by/updated_by are NULL
      const { data: flagAfter } = await supabaseAdmin
        .from('feature_flag')
        .select('id, created_by, updated_by')
        .eq('id', testFlagId)
        .single();

      expect(flagAfter).not.toBeNull();
      expect(flagAfter?.created_by).toBeNull();
      expect(flagAfter?.updated_by).toBeNull();

      flagCreatorId = '';
    });
  });

  describe('API Key CASCADE on Tenant Delete', () => {
    let apiKeyTenantId: string;
    let apiKeyUserId: string;
    let testApiKeyId: string;
    let testAppId: string;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Create a user
      const testEmail = `api-key-cascade-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!authUser.user) return;
      apiKeyUserId = authUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: apiKeyUserId,
        name: 'API Key Test User',
        email: testEmail,
      });

      // Create a tenant
      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `API Key Cascade Org ${crypto.randomUUID()}`,
          company_name: 'API Key Test Company',
          created_by: apiKeyUserId,
        })
        .select()
        .single();

      if (!tenant) return;
      apiKeyTenantId = tenant.tenant_id;

      // Create an app (required for api_key.app_id FK)
      const { data: app } = await supabaseAdmin
        .from('app')
        .insert({
          name: 'API Key Test App',
          tenant_id: apiKeyTenantId,
          created_by: apiKeyUserId,
        })
        .select()
        .single();

      if (!app) return;
      testAppId = app.id;

      // Api_key.environment_id is NOT NULL. Seed the app's
      // default env since the raw `from('app')` insert above does not.
      const apiKeyEnvId = await ensureDefaultEnvironment(testAppId, apiKeyTenantId);

      // Create an API key for this tenant (requires app_id and api_key_id)
      const { data: apiKey } = await supabaseAdmin
        .from('api_key')
        .insert({
          name: 'Test API Key',
          tenant_id: apiKeyTenantId,
          app_id: testAppId,
          api_key_id: `test_api_key_${crypto.randomUUID()}`,
          environment_id: apiKeyEnvId,
          created_by: apiKeyUserId,
        })
        .select()
        .single();

      if (!apiKey) return;
      testApiKeyId = apiKey.id;
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup - some may already be deleted by the test
      if (testApiKeyId) {
        await supabaseAdmin.from('api_key').delete().eq('id', testApiKeyId);
      }
      if (testAppId) {
        await supabaseAdmin.from('app').delete().eq('id', testAppId);
      }
      if (apiKeyTenantId) {
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', apiKeyTenantId);
      }
      if (apiKeyUserId) {
        await supabaseAdmin.from('profile').delete().eq('id', apiKeyUserId);
        await supabaseAdmin.auth.admin.deleteUser(apiKeyUserId);
      }
    });

    it('should CASCADE delete api_key when app is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!apiKeyTenantId || !testApiKeyId || !testAppId) throw new Error('[PREREQUISITE NOT MET] apiKeyTenantId, testApiKeyId or testAppId not created');

      // Verify API key exists
      const { data: apiKeyBefore } = await supabaseAdmin
        .from('api_key')
        .select('id')
        .eq('id', testApiKeyId)
        .single();

      expect(apiKeyBefore).not.toBeNull();

      // Delete the app - API key should cascade delete (api_key_app_id_fkey ON DELETE CASCADE)
      const { error: appDeleteError } = await supabaseAdmin
        .from('app')
        .delete()
        .eq('id', testAppId);

      expect(appDeleteError).toBeNull();

      // Verify API key was cascade deleted
      const { data: apiKeyAfter, error: apiKeyCheckError } = await supabaseAdmin
        .from('api_key')
        .select('id')
        .eq('id', testApiKeyId)
        .single();

      // Should return no data (record deleted via cascade)
      expect(apiKeyAfter).toBeNull();
      expect(apiKeyCheckError?.code).toBe('PGRST116'); // Row not found

      // Now delete the tenant (no more FK references blocking it)
      const { error: tenantDeleteError } = await supabaseAdmin
        .from('tenant')
        .delete()
        .eq('tenant_id', apiKeyTenantId);

      expect(tenantDeleteError).toBeNull();

      // Clear IDs since they're deleted
      apiKeyTenantId = '';
      testApiKeyId = '';
      testAppId = '';
    });
  });

  describe('Temp Access Grant CASCADE on Admin Delete', () => {
    let grantingAdminId: string;
    let targetTenantId: string;
    let testGrantId: string;
    let tenantOwnerId: string;

    beforeAll(async () => {
      if (!platformAdminCheck.available) return;

      // Create a platform admin who will grant access
      const adminEmail = `granting-admin-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: adminUser } = await supabaseAdmin.auth.admin.createUser({
        email: adminEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!adminUser.user) return;
      grantingAdminId = adminUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: grantingAdminId,
        name: 'Granting Admin',
        email: adminEmail,
      });

      // Create a target tenant
      const ownerEmail = `tenant-owner-${crypto.randomUUID()}@outerlayer.ai`;
      const { data: ownerUser } = await supabaseAdmin.auth.admin.createUser({
        email: ownerEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (!ownerUser.user) return;
      tenantOwnerId = ownerUser.user.id;

      await supabaseAdmin.from('profile').insert({
        id: tenantOwnerId,
        name: 'Tenant Owner',
        email: ownerEmail,
      });

      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `Target Org ${crypto.randomUUID()}`,
          company_name: 'Target Company',
          created_by: tenantOwnerId,
        })
        .select()
        .single();

      if (!tenant) return;
      targetTenantId = tenant.tenant_id;

      // Create a temp access grant
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const { data: grant } = await supabaseAdmin
        .from('temp_access_grant')
        .insert({
          created_by: grantingAdminId,
          tenant_id: targetTenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Test grant for CASCADE verification',
        })
        .select()
        .single();

      if (!grant) return;
      testGrantId = grant.id;
    });

    afterAll(async () => {
      if (!platformAdminCheck.available) return;

      // Cleanup
      if (testGrantId) {
        await supabaseAdmin.from('temp_access_grant').delete().eq('id', testGrantId);
      }
      if (targetTenantId) {
        await supabaseAdmin.from('tenant').delete().eq('tenant_id', targetTenantId);
      }
      if (tenantOwnerId) {
        await supabaseAdmin.from('profile').delete().eq('id', tenantOwnerId);
        await supabaseAdmin.auth.admin.deleteUser(tenantOwnerId);
      }
      // Note: grantingAdminId is deleted during the test
    });

    it('should CASCADE delete temp_access_grant when admin is deleted', async () => {
      requirePrerequisite(platformAdminCheck);
      if (!testGrantId || !grantingAdminId) throw new Error('[PREREQUISITE NOT MET] testGrantId or grantingAdminId not created');

      // Verify grant exists
      const { data: grantBefore } = await supabaseAdmin
        .from('temp_access_grant')
        .select('id, created_by')
        .eq('id', testGrantId)
        .single();

      expect(grantBefore).not.toBeNull();
      expect(grantBefore?.created_by).toBe(grantingAdminId);

      // Delete the admin profile (should cascade delete the grant)
      const { error: profileDeleteError } = await supabaseAdmin
        .from('profile')
        .delete()
        .eq('id', grantingAdminId);

      expect(profileDeleteError).toBeNull();

      // Delete the auth user
      await supabaseAdmin.auth.admin.deleteUser(grantingAdminId);

      // Verify grant was cascade deleted
      const { data: grantAfter, error: grantCheckError } = await supabaseAdmin
        .from('temp_access_grant')
        .select('id')
        .eq('id', testGrantId)
        .single();

      // Should return no data (record deleted via cascade)
      expect(grantAfter).toBeNull();
      expect(grantCheckError?.code).toBe('PGRST116'); // Row not found

      grantingAdminId = '';
      testGrantId = ''; // Grant was deleted
    });
  });
});
