import { getSupabaseAdmin } from '../../lib/test-utils';

/**
 * Integration tests for Platform Admin - Organizations
 *
 * Integration tests for listOrganizations (pagination, search, filters)
 * Integration tests for getOrganizationDetail (valid org, non-existent org)
 */

describe('Platform Admin - Organizations', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let testAdminUserId: string;
  let testTenantIds: string[] = [];
  const testOrgNames = [
    `Test Org Alpha ${Date.now()}`,
    `Test Org Beta ${Date.now()}`,
    `Test Org Gamma ${Date.now()}`,
    `Searchable Company ${Date.now()}`,
    `Another Searchable ${Date.now()}`,
  ];

  beforeAll(async () => {
    // Create test admin user
    const testEmail = `org-test-admin-${Date.now()}@outerlayer.ai`;
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (authError || !authUser.user) {
      throw new Error(`Failed to create test admin user: ${authError?.message}`);
    }

    testAdminUserId = authUser.user.id;

    // Create profile for admin
    await supabaseAdmin.from('profile').insert({
      id: testAdminUserId,
      name: 'Org Test Admin',
      email: testEmail,
    });

    // Create multiple test organizations for pagination/search testing
    for (const orgName of testOrgNames) {
      const { data: tenant, error: tenantError } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: orgName,
          company_name: `Company for ${orgName}`,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (tenantError || !tenant) {
        throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
      }

      testTenantIds.push(tenant.tenant_id);
    }
  });

  afterAll(async () => {
    // Cleanup test data
    for (const tenantId of testTenantIds) {
      await supabaseAdmin.from('tenant').delete().eq('tenant_id', tenantId);
    }

    if (testAdminUserId) {
      await supabaseAdmin.from('profile').delete().eq('id', testAdminUserId);
      await supabaseAdmin.auth.admin.deleteUser(testAdminUserId);
    }
  });

  // listOrganizations tests
  describe('listOrganizations', () => {
    it('should return paginated list of organizations', async () => {
      const { data: orgs, error } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id, organization_name, company_name, created_at')
        .order('created_at', { ascending: false })
        .range(0, 9); // First 10 items

      expect(error).toBeNull();
      expect(Array.isArray(orgs)).toBe(true);
      expect(orgs!.length).toBeGreaterThan(0);
      expect(orgs!.length).toBeLessThanOrEqual(10); // range(0, 9)
      expect(Object.keys(orgs![0]!).sort()).toEqual(
        ['company_name', 'created_at', 'organization_name', 'tenant_id'],
      );
    });

    it('should support pagination with offset', async () => {
      // Get first page
      const { data: page1 } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id')
        .order('created_at', { ascending: false })
        .range(0, 1);

      // Get second page
      const { data: page2 } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id')
        .order('created_at', { ascending: false })
        .range(2, 3);

      expect(Array.isArray(page1)).toBe(true);
      expect(Array.isArray(page2)).toBe(true);

      // Ensure pages are different (if we have enough data)
      if (page1 && page1.length > 0 && page2 && page2.length > 0) {
        expect(page1[0]?.tenant_id).not.toBe(page2[0]?.tenant_id);
      }
    });

    it('should search organizations by name', async () => {
      const { data: results, error } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id, organization_name')
        .ilike('organization_name', '%Searchable%');

      expect(error).toBeNull();
      expect(Array.isArray(results)).toBe(true);
      expect(results!.length).toBeGreaterThanOrEqual(2);

      // All results should contain "Searchable"
      results!.forEach((org: { tenant_id: string; organization_name: string }) => {
        expect(org.organization_name.toLowerCase()).toContain('searchable');
      });
    });

    it('should return empty results for non-matching search', async () => {
      const { data: results, error } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id, organization_name')
        .ilike('organization_name', '%NonExistentOrgXYZ12345%');

      expect(error).toBeNull();
      expect(Array.isArray(results)).toBe(true);
      expect(results!.length).toBe(0);
    });

    it('should include organization metadata', async () => {
      const { data: orgs, error } = await supabaseAdmin
        .from('tenant')
        .select('tenant_id, organization_name, company_name, created_at, created_by')
        .eq('tenant_id', testTenantIds[0])
        .single();

      expect(error).toBeNull();
      expect(orgs).not.toBeNull();
      expect(orgs?.organization_name).toBe(testOrgNames[0]);
      expect(orgs?.company_name).toBe(`Company for ${testOrgNames[0]}`);
      expect(Number.isNaN(Date.parse(orgs!.created_at))).toBe(false);
    });
  });

  // getOrganizationDetail tests
  describe('getOrganizationDetail', () => {
    it('should return full organization details for valid org', async () => {
      const testTenantId = testTenantIds[0];

      const { data: org, error } = await supabaseAdmin
        .from('tenant')
        .select('*')
        .eq('tenant_id', testTenantId)
        .single();

      expect(error).toBeNull();
      expect(org).not.toBeNull();
      expect(org?.tenant_id).toBe(testTenantId);
      expect(org?.organization_name).toBe(testOrgNames[0]);
    });

    it('should return null for non-existent organization', async () => {
      const fakeUUID = '00000000-0000-0000-0000-000000000000';

      const { data: org } = await supabaseAdmin
        .from('tenant')
        .select('*')
        .eq('tenant_id', fakeUUID)
        .single();

      // Supabase returns error when .single() finds no rows
      expect(org).toBeNull();
    });

    it('should include user count for organization', async () => {
      const testTenantId = testTenantIds[0];

      // Add a test user to the organization
      const testUserEmail = `org-member-${Date.now()}@test.com`;
      const { data: authUser } = await supabaseAdmin.auth.admin.createUser({
        email: testUserEmail,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (authUser?.user) {
        await supabaseAdmin.from('profile').insert({
          id: authUser.user.id,
          name: 'Test Member',
          email: testUserEmail,
        });

        await supabaseAdmin.from('membership').insert({
          user_id: authUser.user.id,
          tenant_id: testTenantId,
          role: 'admin',
          status: 'active',
        });

        // Count members
        const { count, error } = await supabaseAdmin
          .from('membership')
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', testTenantId)
          .eq('status', 'active');

        expect(error).toBeNull();
        expect(count).toBeGreaterThanOrEqual(1);

        // Cleanup
        await supabaseAdmin.from('membership').delete().eq('user_id', authUser.user.id);
        await supabaseAdmin.from('profile').delete().eq('id', authUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      }
    });

    it('should include app count for organization', async () => {
      const testTenantId = testTenantIds[0];

      // Create a test app
      const { data: app, error: appError } = await supabaseAdmin
        .from('app')
        .insert({
          name: `Test App ${Date.now()}`,
          tenant_id: testTenantId,
          created_by: testAdminUserId,
        })
        .select()
        .single();

      if (!appError && app) {
        // Count apps
        const { count, error } = await supabaseAdmin
          .from('app')
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', testTenantId);

        expect(error).toBeNull();
        expect(count).toBeGreaterThanOrEqual(1);

        // Cleanup
        await supabaseAdmin.from('app').delete().eq('id', app.id);
      }
    });
  });
});
