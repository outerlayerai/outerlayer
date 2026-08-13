/**
 * SAGA COMPENSATION TESTS - Organization Creation
 *
 * With skip-company-setup, Stripe/Unkey are now called during ORGANIZATION CREATION,
 * not during registration. These tests verify that compensation mechanisms work correctly
 * when external services fail during org creation.
 *
 * Tests that compensation mechanisms ACTUALLY work when external services fail.
 * Verifies that our saga pattern properly rolls back data when things go wrong.
 */

import { createAuthenticatedUser, cleanupTestUsers, getSupabaseAdmin } from '../lib/test-utils';
import { deleteTenantsAndUsers, TenantCleanupError } from '../lib/tenant-cleanup';
import { OrganizationService, OrganizationServiceConfig } from '../../../tenant-dashboard/src/lib/system/organization-service';
import type { StripeService } from '../../../tenant-dashboard/src/lib/external-services';

vi.setConfig({ testTimeout: 30_000 });

// Environment setup
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key_for_testing';
process.env.UNKEY_API_KEY = 'unkey_dummy_key_for_testing';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// ---------------
// Test Helpers
// ---------------

const uniqueOrgName = (prefix: string) =>
  `${prefix}-${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}`;

// Track test tenants for cleanup (additional orgs created during tests)
const testTenantIds: string[] = [];

const verifyNoOrphanedOrgData = async (orgName: string) => {
  const supabase = getSupabaseAdmin();
  const [tenant, billing] = await Promise.all([
    supabase.from('tenant').select('*').ilike('organization_name', orgName),
    supabase.from('tenant').select('tenant_id').ilike('organization_name', orgName)
      .then(async (res) => {
        if (res.data?.[0]) {
          return supabase.from('billing').select('*').eq('tenant_id', res.data[0].tenant_id);
        }
        return { data: [] };
      }),
  ]);

  return {
    hasTenant: (tenant.data?.length || 0) > 0,
    hasBilling: (billing.data?.length || 0) > 0,
    tenant: tenant.data?.[0],
  };
};

// ---------------
// Mock Services
// ---------------

const mockCallTracker = {
  stripeCreate: 0,
  stripeDelete: 0,
  reset: function () {
    this.stripeCreate = 0;
    this.stripeDelete = 0;
  }
};

class MockStripeService implements StripeService {
  public shouldFail = false;

  async createCustomer(_params: any, _options?: any): Promise<any> {
    mockCallTracker.stripeCreate++;
    if (this.shouldFail) {
      throw new Error('SIMULATED STRIPE FAILURE');
    }
    return { id: `cus_test_${crypto.randomUUID()}` };
  }

  async retrieveCustomer(customerId: string): Promise<any> {
    return { id: customerId };
  }

  async deleteCustomer(_customerId: string): Promise<void> {
    mockCallTracker.stripeDelete++;
  }

  async retrieveSubscription(subscriptionId: string): Promise<any> {
    return { id: subscriptionId };
  }

  async updateSubscription(subscriptionId: string, _params: any): Promise<any> {
    return { id: subscriptionId };
  }
}

// Cleanup additional test tenants created directly via createOrganization
// (their owner is `testUser`, tracked and cleaned separately by
// cleanupTestUsers — see the afterEach ordering below for why these must go
// first).
async function cleanupTestTenants() {
  const supabase = getSupabaseAdmin();
  const snapshot = [...testTenantIds];
  try {
    await deleteTenantsAndUsers(supabase, snapshot, []);
    testTenantIds.length = 0;
  } catch (err) {
    if (err instanceof TenantCleanupError) {
      for (const tenantId of err.succeededTenantIds) {
        const index = testTenantIds.indexOf(tenantId);
        if (index !== -1) testTenantIds.splice(index, 1);
      }
    }
    throw err;
  }
}

// ---------------
// SAGA COMPENSATION TESTS
// ---------------

describe('SAGA COMPENSATION - Organization Creation', () => {
  let mockStripeService: MockStripeService;
  let orgService: OrganizationService;
  let originalConsoleError: any;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = vi.fn();

    mockStripeService = new MockStripeService();
    mockStripeService.shouldFail = false;
    mockCallTracker.reset();

    const supabase = getSupabaseAdmin();
    const config: OrganizationServiceConfig = {
      supabaseAdmin: supabase,
      supabaseServer: supabase,
      stripeService: mockStripeService,
    };
    orgService = new OrganizationService(config);
  });

  afterEach(async () => {
    console.error = originalConsoleError;
    // Tenants before users: `testUser` owns both their own tenant (tracked
    // by cleanupTestUsers) and any createOrganization tenant tracked here,
    // and deleting the auth user cascades into whichever owner membership
    // is still standing — so the createOrganization tenant must be gone
    // first, or that cascade trips protect_last_owner same as a raw delete
    // would. Both cleanups are attempted regardless of the other failing.
    const errors: string[] = [];
    try {
      await cleanupTestTenants();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    try {
      await cleanupTestUsers();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (errors.length > 0) {
      throw new Error(`afterEach cleanup failed:\n${errors.join('\n')}`);
    }
  });

  describe('STRIPE FAILURE COMPENSATION', () => {
    it('Should fail gracefully when Stripe fails (no orphaned data)', async () => {
      const orgName = uniqueOrgName('stripe-fail-org');
      const testUser = await createAuthenticatedUser('owner');

      // Get the User object from the auth session
      const { data: { user } } = await testUser.client.auth.getUser();
      if (!user) throw new Error('Failed to get user from session');

      mockStripeService.shouldFail = true;

      const result = await orgService.createOrganization({
        user,
        organizationName: orgName,
        companyName: 'Test Company',
      });

      // Should fail with billing error
      expect(result.success).toBe(false);
      expect(result.error).toContain('billing');

      // Verify execution flow
      expect(mockCallTracker.stripeCreate).toBe(1);  // Stripe was attempted
      expect(mockCallTracker.stripeDelete).toBe(0);  // No customer to delete (creation failed)

      // Critical: NO orphaned data should exist
      const orphanCheck = await verifyNoOrphanedOrgData(orgName);
      expect(orphanCheck.hasTenant).toBe(false);
      expect(orphanCheck.hasBilling).toBe(false);
    });
  });

  describe('DATABASE FAILURE COMPENSATION', () => {
    it('Should rollback Stripe when tenant creation fails (duplicate name)', { retry: 2 }, async () => {
      const existingOrgName = uniqueOrgName('existing-org');
      const testUser = await createAuthenticatedUser('owner');

      // Get the User object from the auth session
      const { data: { user } } = await testUser.client.auth.getUser();
      if (!user) throw new Error('Failed to get user from session');

      // Setup: insert a tenant with the target name directly via admin client.
      // This avoids the full createOrganization saga (Stripe mock + DB RPC + claims)
      // which is prone to transient failures under CI load — and isn't what this test is testing.
      const supabase = getSupabaseAdmin();
      const { data: existingTenant, error: insertError } = await supabase
        .from('tenant')
        .insert({
          organization_name: existingOrgName,
          company_name: 'First Company',
          created_by: user.id,
        })
        .select('tenant_id')
        .single();

      if (insertError) throw new Error(`Test setup failed: ${insertError.message}`);
      testTenantIds.push(existingTenant.tenant_id);

      mockCallTracker.reset();

      // Now try to create with same name - should fail at tenant level
      const result = await orgService.createOrganization({
        user,
        organizationName: existingOrgName,
        companyName: 'Duplicate Company',
      });

      // Should fail with duplicate name error
      expect(result.success).toBe(false);
      expect(result.error).toContain('already taken');

      // With the new atomic transaction flow:
      // 1. Stripe customer is created first (external service, easy to rollback)
      // 2. DB transaction runs (includes duplicate check)
      // 3. If DB fails (duplicate), Stripe customer is rolled back
      expect(mockCallTracker.stripeCreate).toBe(1);
      expect(mockCallTracker.stripeDelete).toBe(1); // Rolled back due to duplicate
    });
  });

  describe('SAGA PATTERN VERIFICATION', () => {
    it('Should execute services in correct order on success', { retry: 2 }, async () => {
      const orgName = uniqueOrgName('saga-order-org');
      const testUser = await createAuthenticatedUser('owner');

      // Get the User object from the auth session
      const { data: { user } } = await testUser.client.auth.getUser();
      if (!user) throw new Error('Failed to get user from session');

      mockCallTracker.reset();

      const result = await orgService.createOrganization({
        user,
        organizationName: orgName,
        companyName: 'Test Company',
      });

      // Should succeed — surface error details on failure for CI debugging
      if (!result.success) {
        throw new Error(
          `createOrganization unexpectedly failed: ${result.error} (orgName=${orgName}, userId=${user.id})`
        );
      }
      expect(result.tenantId).toEqual(expect.any(String));
      if (result.tenantId) {
        testTenantIds.push(result.tenantId);
      }

      // Verify execution order
      expect(mockCallTracker.stripeCreate).toBe(1);  // Step 1: Stripe
      expect(mockCallTracker.stripeDelete).toBe(0);  // No compensation needed

      // Verify data was created
      const orgCheck = await verifyNoOrphanedOrgData(orgName);
      expect(orgCheck.hasTenant).toBe(true);
      expect(orgCheck.hasBilling).toBe(true);
    });

  });

  describe('DATA CONSISTENCY UNDER FAILURES', () => {
    it('Should maintain consistency when Stripe fails', async () => {
      const orgName = uniqueOrgName('consistency-org');
      const testUser = await createAuthenticatedUser('owner');

      // Get the User object from the auth session
      const { data: { user } } = await testUser.client.auth.getUser();
      if (!user) throw new Error('Failed to get user from session');

      mockStripeService.shouldFail = true;

      const result = await orgService.createOrganization({
        user,
        organizationName: orgName,
        companyName: 'Test Company',
      });

      expect(result.success).toBe(false);

      // CRITICAL: No partial data should exist
      const orphanCheck = await verifyNoOrphanedOrgData(orgName);
      expect(orphanCheck.hasTenant).toBe(false);
      expect(orphanCheck.hasBilling).toBe(false);
    });
  });
});
