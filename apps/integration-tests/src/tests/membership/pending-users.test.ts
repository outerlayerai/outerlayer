/**
 * Integration tests for MembershipService operations on pending (invited) users.
 *
 * Verifies that users who have been invited but haven't accepted yet can be:
 * - Resent invite links
 * - Have their role changed
 * - Removed from the organization
 *
 * These tests use the real local Supabase database with actual data.
 * Setup uses createAuthenticatedUser() and MembershipService.sendInvite().
 */

import type { Mock } from 'vitest';
import { getSupabaseAdmin, createAuthenticatedUser, cleanupTestUsers } from '../../lib/test-utils';

// Mock server-only before any tenant-dashboard imports
vi.mock('server-only', () => ({}));

// Mock logger to avoid @logtail/next dependency
vi.mock('../../../../tenant-dashboard/src/lib/observability/server-logger', () => ({
  serverLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn().mockReturnValue(Promise.resolve()),
    debug: vi.fn(),
  },
}));

// Mock @logtail/next and @sentry/nextjs in case they're imported transitively
vi.mock('@logtail/next', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { MembershipService } from 'tenant-dashboard/src/lib/system/membership-service';
import { UserRoleEnum } from 'tenant-dashboard/src/auth/types';
import type { EmailService, RateLimitService, StripeService } from 'tenant-dashboard/src/lib/external-services';
import type { User } from '@supabase/supabase-js';

// ============================================================================
// Test Helpers
// ============================================================================

const uuid = (): string => require('crypto').randomUUID();

interface TestSetup {
  tenantId: string;
  ownerId: string;
  ownerEmail: string;
  pendingUserId: string;
  pendingUserEmail: string;
}

/**
 * Creates a minimal User object for MembershipService methods.
 * Fills only the required User fields plus the app_metadata that
 * MembershipService reads (tenant_id, role).
 */
function buildAdminUser(params: {
  id: string;
  email?: string;
  tenantId: string;
  role: string;
}): User {
  return {
    id: params.id,
    email: params.email,
    app_metadata: { tenant_id: params.tenantId, role: params.role },
    user_metadata: {},
    aud: 'authenticated',
    created_at: new Date().toISOString(),
  };
}

function createMockEmailService(): EmailService {
  return {
    sendEmail: vi.fn<() => Promise<{ error: null }>>().mockResolvedValue({ error: null }),
  } as unknown as EmailService;
}

function createMockRateLimitService(): RateLimitService {
  return {
    limit: vi.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
  } as unknown as RateLimitService;
}

function createMockStripeService(): StripeService {
  return {
    createCustomer: vi.fn(),
    retrieveCustomer: vi.fn(),
    deleteCustomer: vi.fn(),
    retrieveSubscription: vi.fn<() => Promise<{ items: { data: unknown[] } }>>().mockResolvedValue({ items: { data: [] } }),
    updateSubscription: vi.fn(),
  } as unknown as StripeService;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('MembershipService - pending user operations (integration)', () => {
  let setup: TestSetup;
  let service: MembershipService;
  let emailService: EmailService;

  beforeAll(async () => {
    const adminClient = getSupabaseAdmin();
    const randomId = Math.random().toString(36).substring(2, 8);
    const pendingUserEmail = `pending-${randomId}@integration-test.com`;

    // 1. Create owner via test utility (tenant, auth user, profile, membership, claims, sign-in)
    const owner = await createAuthenticatedUser('owner');

    // 2. Insert billing record so sendInvite passes the billing check
    await adminClient.from('billing').insert({
      tenant_id: owner.tenantId,
      stripe_customer_id: `cus_test_${randomId}`,
      stripe_subscription_id: `sub_test_${randomId}`,
      tier_id: 'growth',
    });

    // 3. Create mocked external services
    emailService = createMockEmailService();
    const rateLimitService = createMockRateLimitService();
    const stripeService = createMockStripeService();

    // 4. Use MembershipService.sendInvite to create the pending user
    const inviteService = new MembershipService({
      supabaseAdmin: adminClient,
      supabaseServer: owner.client,
      emailService,
      rateLimitService,
      stripeService,
    });

    const inviteResult = await inviteService.sendInvite({
      adminUser: buildAdminUser({ id: owner.id, email: owner.email, tenantId: owner.tenantId, role: UserRoleEnum.OWNER }),
      tenantId: owner.tenantId,
      name: 'Pending User',
      email: pendingUserEmail,
      role: UserRoleEnum.READ,
      origin: 'http://localhost:3002',
    });

    if (!inviteResult.success) {
      throw new Error(`Failed to send invite: ${inviteResult.error}`);
    }

    // 5. Look up the pending user ID from the profile created by sendInvite
    const { data: pendingProfile } = await adminClient
      .from('profile')
      .select('id')
      .eq('email', pendingUserEmail)
      .single();

    if (!pendingProfile) throw new Error('Pending user profile not found after invite');

    setup = {
      tenantId: owner.tenantId,
      ownerId: owner.id,
      ownerEmail: owner.email,
      pendingUserId: pendingProfile.id,
      pendingUserEmail,
    };

    // 6. Create the service instance used by tests (fresh mocks)
    emailService = createMockEmailService();
    service = new MembershipService({
      supabaseAdmin: adminClient,
      supabaseServer: owner.client,
      emailService,
      rateLimitService: createMockRateLimitService(),
      stripeService: createMockStripeService(),
    });
  });

  afterAll(async () => {
    const adminClient = getSupabaseAdmin();

    if (setup) {
      // Clean up pending user records (not tracked by cleanupTestUsers)
      await adminClient.from('membership').delete().eq('user_id', setup.pendingUserId);
      await adminClient.from('profile').delete().eq('id', setup.pendingUserId);
      try { await adminClient.auth.admin.deleteUser(setup.pendingUserId); } catch {}
      await adminClient.from('billing').delete().eq('tenant_id', setup.tenantId);
    }

    await cleanupTestUsers();
  });

  // ==========================================================================
  // resendInviteLink
  // ==========================================================================

  describe('resendInviteLink', () => {
    // proves AC-077-06
    it('should successfully resend invite to a pending user', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, email: setup.ownerEmail, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.resendInviteLink({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        email: setup.pendingUserEmail,
        origin: 'http://localhost:3002',
      });

      expect(result.success).toBe(true);
      expect((emailService.sendEmail as Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ to: setup.pendingUserEmail })
      );
    });

    it('should return error when resending invite to non-existent email', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.resendInviteLink({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        email: 'nonexistent@nobody.com',
        origin: 'http://localhost:3002',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });
  });

  // ==========================================================================
  // changeUserRole
  // ==========================================================================

  describe('changeUserRole', () => {
    // proves AC-077-07
    it('should change role for a pending user when called by owner', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.changeUserRole({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        targetUserId: setup.pendingUserId,
        newRole: UserRoleEnum.ADMIN,
      });

      expect(result.success).toBe(true);

      // Verify the role was actually updated in the database
      const { data: membership } = await getSupabaseAdmin()
        .from('membership')
        .select('role')
        .eq('user_id', setup.pendingUserId)
        .eq('tenant_id', setup.tenantId)
        .single();

      expect(membership?.role).toBe(UserRoleEnum.ADMIN);
    });

    it('should return error when changing role for non-existent user', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.changeUserRole({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        targetUserId: uuid(),
        newRole: UserRoleEnum.ADMIN,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found in organization');
    });
  });

  // ==========================================================================
  // removeUserFromOrg
  // ==========================================================================

  describe('removeUserFromOrg', () => {
    // Ensure the pending membership exists before each test in this block.
    // The remove test is destructive — without this, test ordering would matter (II.A).
    beforeEach(async () => {
      const admin = getSupabaseAdmin();
      const { data: existing } = await admin
        .from('membership')
        .select('id')
        .eq('user_id', setup.pendingUserId)
        .eq('tenant_id', setup.tenantId)
        .maybeSingle();

      if (!existing) {
        await admin.from('membership').insert({
          user_id: setup.pendingUserId,
          tenant_id: setup.tenantId,
          role: UserRoleEnum.READ,
          status: 'pending',
        });
      }
    });

    // proves AC-077-08
    it('should remove a pending user from the organization when called by owner', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.removeUserFromOrg({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        targetUserId: setup.pendingUserId,
      });

      expect(result.success).toBe(true);

      // Verify the membership was actually deleted
      const { data: membership } = await getSupabaseAdmin()
        .from('membership')
        .select('id')
        .eq('user_id', setup.pendingUserId)
        .eq('tenant_id', setup.tenantId)
        .single();

      expect(membership).toBeNull();
    });

    it('should return error when removing non-existent user from org', async () => {
      const ownerUser = buildAdminUser({ id: setup.ownerId, tenantId: setup.tenantId, role: UserRoleEnum.OWNER });

      const result = await service.removeUserFromOrg({
        adminUser: ownerUser,
        tenantId: setup.tenantId,
        targetUserId: uuid(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found in organization');
    });
  });
});
