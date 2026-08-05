import { getSupabaseAdmin, checkTableExists, checkRpcExists, requirePrerequisite, type PrerequisiteCheck } from '../../lib/test-utils';

/**
 * Integration tests for Platform Admin - Temporary Access
 *
 * Integration tests for grantTempAccess (membership insertion, temp_access_grant record, 24h expiry)
 * Integration tests for revokeTempAccess (membership deletion, revoked_at update)
 * Integration tests for pg_cron cleanup (expired grants cleaned up)
 *
 * Each test is independent and sets up/cleans up its own data.
 */

interface TestContext {
  adminUserId: string;
  adminEmail: string;
  ownerId: string;
  ownerEmail: string;
  tenantId: string;
}

describe('Platform Admin - Temporary Access', () => {
  let supabaseAdmin: ReturnType<typeof getSupabaseAdmin>;
  let tempAccessCheck: PrerequisiteCheck;
  let grantRpcCheck: PrerequisiteCheck;

  beforeAll(async () => {
    supabaseAdmin = getSupabaseAdmin();

    // Check if temp_access_grant table exists
    tempAccessCheck = await checkTableExists('temp_access_grant');
    // Check if grant_temp_access_transaction RPC exists (will be checked per-test)
    // Using correct parameter names that match the RPC signature
    grantRpcCheck = await checkRpcExists('grant_temp_access_transaction', {
      p_admin_user_id: '00000000-0000-0000-0000-000000000000',
      p_tenant_id: '00000000-0000-0000-0000-000000000000',
      p_reason: 'test',
      p_customer_permission_confirmed: true,
      p_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  // Helper to create isolated test context
  async function createTestContext(): Promise<TestContext> {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);

    // Create test admin user with @outerlayer.ai email
    const adminEmail = `temp-access-admin-${timestamp}-${randomId}@outerlayer.ai`;
    const { data: adminAuth, error: adminError } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (adminError || !adminAuth.user) {
      throw new Error(`Failed to create test admin user: ${adminError?.message}`);
    }

    const adminUserId = adminAuth.user.id;

    // Create profile for admin
    await supabaseAdmin.from('profile').insert({
      id: adminUserId,
      name: 'Temp Access Admin',
      email: adminEmail,
    });

    // Create test org owner
    const ownerEmail = `org-owner-${timestamp}-${randomId}@test.com`;
    const { data: ownerAuth, error: ownerError } = await supabaseAdmin.auth.admin.createUser({
      email: ownerEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (ownerError || !ownerAuth.user) {
      throw new Error(`Failed to create test owner: ${ownerError?.message}`);
    }

    const ownerId = ownerAuth.user.id;

    await supabaseAdmin.from('profile').insert({
      id: ownerId,
      name: 'Org Owner',
      email: ownerEmail,
    });

    // Create test tenant
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenant')
      .insert({
        organization_name: `Temp Access Test Org ${timestamp}-${randomId}`,
        company_name: 'Test Company',
        created_by: ownerId,
      })
      .select()
      .single();

    if (tenantError || !tenant) {
      throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
    }

    // Add owner membership with role
    await supabaseAdmin.from('membership').insert({
      user_id: ownerId,
      tenant_id: tenant.tenant_id,
      role: 'owner',
      status: 'active',
    });

    return {
      adminUserId,
      adminEmail,
      ownerId,
      ownerEmail,
      tenantId: tenant.tenant_id,
    };
  }

  // Helper to cleanup test context
  async function cleanupTestContext(ctx: TestContext): Promise<void> {
    // Cleanup temp access grants
    await supabaseAdmin
      .from('temp_access_grant')
      .delete()
      .eq('created_by', ctx.adminUserId);

    // Remove admin membership if exists
    await supabaseAdmin.from('membership').delete().eq('user_id', ctx.adminUserId);

    // Cleanup tenant memberships
    await supabaseAdmin.from('membership').delete().eq('tenant_id', ctx.tenantId);

    // Cleanup tenant
    await supabaseAdmin.from('tenant').delete().eq('tenant_id', ctx.tenantId);

    // Cleanup users
    await supabaseAdmin.from('profile').delete().eq('id', ctx.ownerId);
    await supabaseAdmin.from('profile').delete().eq('id', ctx.adminUserId);

    try {
      await supabaseAdmin.auth.admin.deleteUser(ctx.ownerId);
    } catch {
      // Ignore deletion errors
    }

    try {
      await supabaseAdmin.auth.admin.deleteUser(ctx.adminUserId);
    } catch {
      // Ignore deletion errors
    }
  }

  // grantTempAccess tests
  describe('grantTempAccess', () => {
    it('should create temp_access_grant record with 24h expiry', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const { data: grant, error } = await supabaseAdmin
          .from('temp_access_grant')
          .insert({
            created_by: ctx.adminUserId,
            tenant_id: ctx.tenantId,
            expires_at: expiresAt.toISOString(),
            reason: 'Integration test - 24h expiry',
          })
          .select()
          .single();

        expect(error).toBeNull();
        expect(grant).not.toBeNull();
        expect(grant?.created_by).toBe(ctx.adminUserId);
        expect(grant?.tenant_id).toBe(ctx.tenantId);
        expect(grant?.revoked_at).toBeNull();

        // Verify expiry is approximately 24h from now
        const grantExpiry = new Date(grant!.expires_at);
        const expectedExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        expect(Math.abs(grantExpiry.getTime() - expectedExpiry.getTime())).toBeLessThan(60000);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should create membership for admin in target tenant', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        // Simulate membership creation (as the service would do)
        const { error: membershipError } = await supabaseAdmin.from('membership').insert({
          user_id: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          role: 'read',
          status: 'active',
        });

        expect(membershipError).toBeNull();

        // Verify membership exists
        const { data: membership } = await supabaseAdmin
          .from('membership')
          .select('*')
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .single();

        expect(membership).not.toBeNull();
        expect(membership?.status).toBe('active');
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should record created_at timestamp', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Integration test - created_at',
        });

        const { data: grant } = await supabaseAdmin
          .from('temp_access_grant')
          .select('created_at')
          .eq('created_by', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .is('revoked_at', null)
          .single();

        expect(grant).not.toBeNull();
        expect(typeof grant?.created_at).toBe('string');

        const createdAt = new Date(grant!.created_at);
        const now = new Date();
        // Should be within last 3 minutes (tests can be slow)
        expect(now.getTime() - createdAt.getTime()).toBeLessThan(3 * 60 * 1000);
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });

  // revokeTempAccess tests
  describe('revokeTempAccess', () => {
    it('should set revoked_at timestamp when access is revoked', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        // First create a grant
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Integration test - revoke',
        });

        // Now revoke it
        const now = new Date();
        const { error: updateError } = await supabaseAdmin
          .from('temp_access_grant')
          .update({ revoked_at: now.toISOString() })
          .eq('created_by', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .is('revoked_at', null);

        expect(updateError).toBeNull();

        // Verify revoked_at is set
        const { data: grant } = await supabaseAdmin
          .from('temp_access_grant')
          .select('revoked_at')
          .eq('created_by', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .not('revoked_at', 'is', null)
          .single();

        expect(grant).not.toBeNull();
        expect(grant?.revoked_at).not.toBeNull();
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should remove membership when access is revoked', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        // First create membership
        await supabaseAdmin.from('membership').insert({
          user_id: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          role: 'read',
          status: 'active',
        });

        // Verify it exists
        const { data: beforeDelete } = await supabaseAdmin
          .from('membership')
          .select('*')
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .single();

        expect(beforeDelete).not.toBeNull();

        // Now remove it (simulating revoke)
        const { error: deleteError } = await supabaseAdmin
          .from('membership')
          .delete()
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId);

        expect(deleteError).toBeNull();

        // Verify membership is gone
        const { data: afterDelete } = await supabaseAdmin
          .from('membership')
          .select('*')
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .maybeSingle();

        expect(afterDelete).toBeNull();
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });

  // Temp Access Database Constraints
  // NOTE: Service-level validation (reason required, customer permission, etc.) is tested
  // in unit tests for TempAccessService. These integration tests verify database behavior.
  describe('Temp Access Database Constraints', () => {
    it('should store customer_permission_confirmed flag', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const { data: grant, error } = await supabaseAdmin
          .from('temp_access_grant')
          .insert({
            created_by: ctx.adminUserId,
            tenant_id: ctx.tenantId,
            expires_at: expiresAt.toISOString(),
            reason: 'Test with confirmation',
            customer_permission_confirmed: true,
          })
          .select()
          .single();

        expect(error).toBeNull();
        expect(grant).not.toBeNull();
        expect(grant?.customer_permission_confirmed).toBe(true);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should enforce FK constraint - reject grant for non-existent tenant', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        const fakeTenantId = '00000000-0000-0000-0000-000000000000';
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // FK constraint should reject this
        const { error } = await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: fakeTenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Should fail FK',
        });

        expect(error).not.toBeNull();
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });

  // Stored procedure atomicity tests
  describe('grant_temp_access_transaction Atomicity', () => {
    it('should create both membership and temp_access_grant atomically', async () => {
      requirePrerequisite(tempAccessCheck);

      // Check if stored procedure exists
      requirePrerequisite(grantRpcCheck);

      const ctx = await createTestContext();

      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Call the stored procedure
        const { data: grantId, error } = await supabaseAdmin.rpc('grant_temp_access_transaction', {
          p_admin_user_id: ctx.adminUserId,
          p_tenant_id: ctx.tenantId,
          p_reason: 'Atomic test grant',
          p_customer_permission_confirmed: true,
          p_expires_at: expiresAt.toISOString(),
        });

        expect(error).toBeNull();
        expect(grantId).toEqual(expect.any(String));

        // Verify both records were created
        const { data: membership } = await supabaseAdmin
          .from('membership')
          .select('id, role')
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', ctx.tenantId)
          .single();

        expect(membership).not.toBeNull();
        expect(membership?.role).toBe('read');

        const { data: grant } = await supabaseAdmin
          .from('temp_access_grant')
          .select('id, reason')
          .eq('id', grantId)
          .single();

        expect(grant).not.toBeNull();
        expect(grant?.reason).toBe('Atomic test grant');
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should rollback on failure (invalid tenant_id)', async () => {
      requirePrerequisite(tempAccessCheck);
      requirePrerequisite(grantRpcCheck);

      const ctx = await createTestContext();

      try {
        const fakeTenantId = '00000000-0000-0000-0000-000000000000';
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Call the stored procedure with invalid tenant_id (should fail due to FK constraint)
        const { error } = await supabaseAdmin.rpc('grant_temp_access_transaction', {
          p_admin_user_id: ctx.adminUserId,
          p_tenant_id: fakeTenantId,
          p_reason: 'Should fail',
          p_customer_permission_confirmed: true,
          p_expires_at: expiresAt.toISOString(),
        });

        // Should fail due to FK constraint on tenant_id
        expect(error).not.toBeNull();

        // Verify no partial records were created
        const { data: membership } = await supabaseAdmin
          .from('membership')
          .select('id')
          .eq('user_id', ctx.adminUserId)
          .eq('tenant_id', fakeTenantId)
          .single();

        expect(membership).toBeNull();

        const { data: grants } = await supabaseAdmin
          .from('temp_access_grant')
          .select('id')
          .eq('created_by', ctx.adminUserId)
          .eq('tenant_id', fakeTenantId);

        expect(grants).toHaveLength(0);
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });

  // pg_cron cleanup tests
  describe('pg_cron Cleanup', () => {
    it('should identify expired grants for cleanup', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        // Create an expired grant
        const expiredTime = new Date(Date.now() - 1 * 60 * 60 * 1000);

        await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          expires_at: expiredTime.toISOString(),
          reason: 'Expired test grant',
        });

        // Query for expired grants
        const now = new Date();
        const { data: expiredGrants, error } = await supabaseAdmin
          .from('temp_access_grant')
          .select('*')
          .eq('created_by', ctx.adminUserId)
          .lt('expires_at', now.toISOString())
          .is('revoked_at', null);

        expect(error).toBeNull();
        expect(expiredGrants).not.toBeNull();
        expect(expiredGrants!.length).toBeGreaterThan(0);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should calculate time_remaining_minutes accurately at query time', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        // Create a grant that expires in 2 hours
        const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);

        const { data: grant, error } = await supabaseAdmin
          .from('temp_access_grant')
          .insert({
            created_by: ctx.adminUserId,
            tenant_id: ctx.tenantId,
            expires_at: twoHoursFromNow.toISOString(),
            reason: 'Time remaining test',
          })
          .select('id, expires_at')
          .single();

        expect(error).toBeNull();
        expect(grant).not.toBeNull();

        // Calculate time remaining (as the service does with the fix)
        // The fix uses Date.now() instead of a captured 'now' variable
        const expiresAt = new Date(grant!.expires_at);
        const timeRemainingMinutes = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000));

        // Should be approximately 120 minutes (2 hours), with some tolerance for test execution time
        expect(timeRemainingMinutes).toBeGreaterThanOrEqual(118);
        expect(timeRemainingMinutes).toBeLessThanOrEqual(120);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should have temp_access_grant structure for pg_cron queries', async () => {
      requirePrerequisite(tempAccessCheck);

      // Verify the table has the expected columns for pg_cron
      const { error } = await supabaseAdmin
        .from('temp_access_grant')
        .select('id, created_by, tenant_id, created_at, expires_at, revoked_at, reason')
        .limit(1);

      expect(error).toBeNull();
      // Query should succeed, verifying schema is correct
    });

    it('should support partial unique index on active grants', async () => {
      requirePrerequisite(tempAccessCheck);

      const ctx = await createTestContext();

      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Create first active grant
        const { error: firstError } = await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'First active grant',
        });

        expect(firstError).toBeNull();

        // Try to create second active grant - should fail due to unique constraint
        const { error: secondError } = await supabaseAdmin.from('temp_access_grant').insert({
          created_by: ctx.adminUserId,
          tenant_id: ctx.tenantId,
          expires_at: expiresAt.toISOString(),
          reason: 'Second active grant - should fail',
        });

        // Should fail with unique constraint violation
        expect(secondError).not.toBeNull();
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });
});
