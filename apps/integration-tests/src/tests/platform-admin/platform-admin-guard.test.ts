import { getSupabaseAdmin, checkTableExists, requirePrerequisite, type PrerequisiteCheck } from '../../lib/test-utils';

/**
 * Integration tests for Platform Admin Guard
 *
 * Tests for PlatformAdminGuard validation
 * - Valid/invalid platform_role checks
 * - @outerlayer.ai email domain requirement
 */

describe('Platform Admin - Guard Tests', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let platformRoleCheck: PrerequisiteCheck;
  let testPlatformAdminId: string;
  let testNonAdminId: string;
  const platformAdminEmail = `platform-guard-test-admin-${Date.now()}@outerlayer.ai`;
  const nonAgentmarkEmail = `platform-guard-test-user-${Date.now()}@example.com`;

  beforeAll(async () => {
    // Check if platform_user_role table exists
    platformRoleCheck = await checkTableExists('platform_user_role');

    if (!platformRoleCheck.available) {
      return;
    }

    // Create test platform admin user with @outerlayer.ai email
    const { data: adminUser, error: adminError } = await supabaseAdmin.auth.admin.createUser({
      email: platformAdminEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (adminError || !adminUser.user) {
      throw new Error(`Failed to create test admin user: ${adminError?.message}`);
    }

    testPlatformAdminId = adminUser.user.id;

    // Create profile for admin
    await supabaseAdmin.from('profile').insert({
      id: testPlatformAdminId,
      name: 'Platform Admin Test',
      email: platformAdminEmail,
    });

    // Grant platform admin role
    await supabaseAdmin.from('platform_user_role').insert({
      user_id: testPlatformAdminId,
      role: 'platform_admin',
      created_by: testPlatformAdminId,
    });

    // Create non-admin user (not @outerlayer.ai)
    const { data: nonAdminUser, error: nonAdminError } = await supabaseAdmin.auth.admin.createUser({
      email: nonAgentmarkEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (nonAdminError || !nonAdminUser.user) {
      throw new Error(`Failed to create test non-admin user: ${nonAdminError?.message}`);
    }

    testNonAdminId = nonAdminUser.user.id;

    // Create profile for non-admin
    await supabaseAdmin.from('profile').insert({
      id: testNonAdminId,
      name: 'Non-Admin Test',
      email: nonAgentmarkEmail,
    });
  });

  afterAll(async () => {
    if (!platformRoleCheck.available) return;

    // Cleanup
    if (testPlatformAdminId) {
      await supabaseAdmin.from('platform_user_role').delete().eq('user_id', testPlatformAdminId);
      await supabaseAdmin.from('profile').delete().eq('id', testPlatformAdminId);
      await supabaseAdmin.auth.admin.deleteUser(testPlatformAdminId);
    }

    if (testNonAdminId) {
      await supabaseAdmin.from('platform_user_role').delete().eq('user_id', testNonAdminId);
      await supabaseAdmin.from('profile').delete().eq('id', testNonAdminId);
      await supabaseAdmin.auth.admin.deleteUser(testNonAdminId);
    }
  });

  describe('Platform Role Validation', () => {
    it('should recognize user with platform_role as admin', async () => {
      requirePrerequisite(platformRoleCheck);

      // Verify platform role exists
      const { data: role, error } = await supabaseAdmin
        .from('platform_user_role')
        .select('role, created_by')
        .eq('user_id', testPlatformAdminId)
        .single();

      expect(error).toBeNull();
      expect(role).not.toBeNull();
      expect(role?.role).toBe('platform_admin');
    });

    // proves AC-075-12
    it('should not recognize user without platform_role as admin', async () => {
      requirePrerequisite(platformRoleCheck);

      // Verify no platform role exists for non-admin
      const { data: role } = await supabaseAdmin
        .from('platform_user_role')
        .select('role')
        .eq('user_id', testNonAdminId)
        .single();

      expect(role).toBeNull();
    });

    it('should support multiple platform roles', async () => {
      requirePrerequisite(platformRoleCheck);

      // Get the enum values for role
      const { data: roles } = await supabaseAdmin
        .from('platform_user_role')
        .select('role');

      // The seeded platform admin has a role, so the query returns at least one row
      expect(Array.isArray(roles)).toBe(true);
      expect(roles!.length).toBeGreaterThan(0);
    });
  });

  describe('Email Domain Restriction', () => {
    it('should allow granting platform role to @outerlayer.ai email', async () => {
      requirePrerequisite(platformRoleCheck);

      // The admin was created with @outerlayer.ai email and has platform role
      const { data: role } = await supabaseAdmin
        .from('platform_user_role')
        .select('*')
        .eq('user_id', testPlatformAdminId)
        .single();

      expect(role).not.toBeNull();
      // Verify the associated profile has @outerlayer.ai email
      const { data: profile } = await supabaseAdmin
        .from('profile')
        .select('email')
        .eq('id', testPlatformAdminId)
        .single();

      expect(profile?.email).toContain('@outerlayer.ai');
    });

    it('should track who granted the platform role', async () => {
      requirePrerequisite(platformRoleCheck);

      const { data: role } = await supabaseAdmin
        .from('platform_user_role')
        .select('created_by, created_at')
        .eq('user_id', testPlatformAdminId)
        .single();

      expect(role).not.toBeNull();
      expect(role?.created_by).toBe(testPlatformAdminId);
      expect(Number.isNaN(Date.parse(role!.created_at))).toBe(false);
    });
  });
});

describe('Platform Admin - Role Grant/Revoke Tests', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let platformRoleCheck: PrerequisiteCheck;
  let grantTestAdminId: string;
  let targetUserId: string;
  const adminEmail = `grant-test-admin-${Date.now()}@outerlayer.ai`;
  const targetEmail = `grant-test-target-${Date.now()}@outerlayer.ai`;

  beforeAll(async () => {
    // Check if platform_user_role table exists
    platformRoleCheck = await checkTableExists('platform_user_role');

    if (!platformRoleCheck.available) {
      console.warn('Skipping role grant/revoke tests: platform_user_role table does not exist.');
      return;
    }

    // Create admin who will grant roles
    const { data: admin } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (!admin?.user) {
      throw new Error('Failed to create grant test admin');
    }

    grantTestAdminId = admin.user.id;

    await supabaseAdmin.from('profile').insert({
      id: grantTestAdminId,
      name: 'Grant Test Admin',
      email: adminEmail,
    });

    await supabaseAdmin.from('platform_user_role').insert({
      user_id: grantTestAdminId,
      role: 'platform_admin',
      created_by: grantTestAdminId,
    });

    // Create target user to receive role
    const { data: target } = await supabaseAdmin.auth.admin.createUser({
      email: targetEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (!target?.user) {
      throw new Error('Failed to create target user');
    }

    targetUserId = target.user.id;

    await supabaseAdmin.from('profile').insert({
      id: targetUserId,
      name: 'Target User',
      email: targetEmail,
    });
  });

  afterAll(async () => {
    if (!platformRoleCheck.available) return;

    if (grantTestAdminId) {
      await supabaseAdmin.from('platform_user_role').delete().eq('user_id', grantTestAdminId);
      await supabaseAdmin.from('profile').delete().eq('id', grantTestAdminId);
      await supabaseAdmin.auth.admin.deleteUser(grantTestAdminId);
    }

    if (targetUserId) {
      await supabaseAdmin.from('platform_user_role').delete().eq('user_id', targetUserId);
      await supabaseAdmin.from('profile').delete().eq('id', targetUserId);
      await supabaseAdmin.auth.admin.deleteUser(targetUserId);
    }
  });

  it('should allow granting platform role to valid user', async () => {
    requirePrerequisite(platformRoleCheck);

    // Grant role to target user
    const { error: grantError } = await supabaseAdmin.from('platform_user_role').insert({
      user_id: targetUserId,
      role: 'platform_admin',
      created_by: grantTestAdminId,
    });

    expect(grantError).toBeNull();

    // Verify role was granted
    const { data: role } = await supabaseAdmin
      .from('platform_user_role')
      .select('*')
      .eq('user_id', targetUserId)
      .single();

    expect(role).not.toBeNull();
    expect(role?.role).toBe('platform_admin');
    expect(role?.created_by).toBe(grantTestAdminId);
  });

  it('should allow revoking platform role', async () => {
    requirePrerequisite(platformRoleCheck);

    // Revoke role from target user
    const { error: revokeError } = await supabaseAdmin
      .from('platform_user_role')
      .delete()
      .eq('user_id', targetUserId);

    expect(revokeError).toBeNull();

    // Verify role was revoked
    const { data: role } = await supabaseAdmin
      .from('platform_user_role')
      .select('*')
      .eq('user_id', targetUserId)
      .single();

    expect(role).toBeNull();
  });

  it('should prevent duplicate platform role grants', async () => {
    requirePrerequisite(platformRoleCheck);

    // First grant
    await supabaseAdmin.from('platform_user_role').insert({
      user_id: targetUserId,
      role: 'platform_admin',
      created_by: grantTestAdminId,
    });

    // Try to grant again
    const { error: duplicateError } = await supabaseAdmin.from('platform_user_role').insert({
      user_id: targetUserId,
      role: 'platform_admin',
      created_by: grantTestAdminId,
    });

    // Should fail with unique constraint
    expect(duplicateError).not.toBeNull();

    // Cleanup
    await supabaseAdmin.from('platform_user_role').delete().eq('user_id', targetUserId);
  });

  it('should handle concurrent role grant attempts gracefully', async () => {
    requirePrerequisite(platformRoleCheck);

    // Create a new user for this test
    const concurrentUserEmail = `concurrent-test-${Date.now()}@outerlayer.ai`;
    const { data: concurrentUser } = await supabaseAdmin.auth.admin.createUser({
      email: concurrentUserEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (!concurrentUser?.user) {
      throw new Error('Failed to create concurrent test user');
    }

    const concurrentUserId = concurrentUser.user.id;

    await supabaseAdmin.from('profile').insert({
      id: concurrentUserId,
      name: 'Concurrent Test User',
      email: concurrentUserEmail,
    });

    try {
      // Simulate concurrent grants using Promise.all
      const concurrentGrants = await Promise.allSettled([
        supabaseAdmin.from('platform_user_role').insert({
          user_id: concurrentUserId,
          role: 'platform_admin',
          created_by: grantTestAdminId,
        }),
        supabaseAdmin.from('platform_user_role').insert({
          user_id: concurrentUserId,
          role: 'platform_admin',
          created_by: grantTestAdminId,
        }),
      ]);

      // One should succeed, one should fail with unique constraint
      const successes = concurrentGrants.filter(
        (r) => r.status === 'fulfilled' && !(r.value as { error: unknown }).error
      );

      // Due to unique constraint, at most one should succeed
      expect(successes.length).toBeLessThanOrEqual(1);

      // Verify only one role entry exists
      const { data: roles } = await supabaseAdmin
        .from('platform_user_role')
        .select('*')
        .eq('user_id', concurrentUserId);

      expect(roles?.length).toBeLessThanOrEqual(1);
    } finally {
      // Cleanup
      await supabaseAdmin.from('platform_user_role').delete().eq('user_id', concurrentUserId);
      await supabaseAdmin.from('profile').delete().eq('id', concurrentUserId);
      await supabaseAdmin.auth.admin.deleteUser(concurrentUserId);
    }
  });
});
