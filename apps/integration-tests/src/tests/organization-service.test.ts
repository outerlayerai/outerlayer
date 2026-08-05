/**
 * Integration Tests for OrganizationService
 *
 * Tests the OrganizationService with:
 * - REAL Supabase (test database)
 * - MOCKED external services (Stripe, Unkey)
 *
 * This validates business logic + database interactions together.
 */

import type { Mock } from 'vitest';
import { createSupabaseAdminClient } from "../lib/supabase-admin";
import { createAuthenticatedUser, cleanupTestUsers } from "../lib/test-utils";
import { OrganizationService } from "tenant-dashboard/src/lib/system";
import { createOAuthRegistrationService } from "tenant-dashboard/src/lib/system/registration/oauth-registration";
import {
  StripeService,
} from "tenant-dashboard/src/lib/external-services";
import { randomUUID } from "crypto";

// Retry flaky tests caused by transient "upstream server" errors from Supabase in CI
// (Vitest uses describe-level retry option - applied below)

// Environment setup for OAuth registration tests
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key_for_testing';
process.env.UNKEY_API_KEY = process.env.UNKEY_API_KEY || 'unkey_dummy_key_for_testing';
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// Mock Stripe for OAuth registration tests
vi.mock('stripe', () => {
  const mockStripe = vi.fn().mockImplementation(() => ({
    customers: {
      create: vi.fn().mockImplementation((params?: any) => {
        const emailPart = params?.email ? String(params.email).replace(/[@.]/g, '_') : 'unknown';
        const uniquePart = Math.random().toString(36).substring(2, 15);
        return Promise.resolve({ id: `cus_test_${emailPart}_${uniquePart}` });
      }),
      del: vi.fn().mockReturnValue(Promise.resolve({ deleted: true })),
      retrieve: vi.fn().mockImplementation((id: string) => Promise.resolve({ id, deleted: false })),
    },
  }));
  // `stripe` is a default-export module — return `{ default }` (not the bare
  // factory) so vitest's mock-shape check passes regardless of ESM/CJS interop.
  return { default: mockStripe };
});

// ============================================================================
// Mock External Services
// ============================================================================

const mockStripeService: StripeService = {
  createCustomer: vi.fn().mockResolvedValue({ id: "cus_mock_123" }),
  retrieveCustomer: vi.fn().mockResolvedValue({ id: "cus_mock_123" }),
  deleteCustomer: vi.fn().mockResolvedValue(undefined),
  retrieveSubscription: vi.fn().mockResolvedValue({ id: "sub_mock_123", items: { data: [] } }),
  updateSubscription: vi.fn().mockResolvedValue({ id: "sub_mock_123" }),
};

// ============================================================================
// Tests
// ============================================================================

describe("OrganizationService Integration Tests", { retry: 2 }, () => {
  let supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;
  let service: OrganizationService;

  beforeAll(() => {
    supabaseAdmin = createSupabaseAdminClient();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockStripeService.createCustomer as Mock).mockResolvedValue({ id: `cus_${randomUUID()}` });

    service = new OrganizationService({
      supabaseAdmin,
      supabaseServer: supabaseAdmin,
      stripeService: mockStripeService,
    });
  });

  afterEach(async () => {
    await cleanupTestUsers();
  });

  describe("setLastActiveOrg", () => {
    it("records the last-active org for a member and reports the tenant back", async () => {
      const user = await createAuthenticatedUser("owner");
      const anotherOwner = await createAuthenticatedUser("owner");

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      // Add user to another org
      await supabaseAdmin.from("membership").insert({
        user_id: user.id,
        tenant_id: anotherOwner.tenantId,
        role: "admin",
        status: "active",
      });

      const result = await service.setLastActiveOrg({
        user: userObj!,
        tenantId: anotherOwner.tenantId,
      });

      expect(result.success).toBe(true);
      expect(result.tenantId).toBe(anotherOwner.tenantId);

      // The write this method exists for: the preference row now names the
      // switched-to org.
      const { data: profile } = await supabaseAdmin
        .from("profile")
        .select("last_active_tenant_id")
        .eq("id", user.id)
        .single();
      expect(profile).toEqual({ last_active_tenant_id: anotherOwner.tenantId });

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", user.id).eq("tenant_id", anotherOwner.tenantId);
    });

    it("rejects a tenant the user is not a member of", async () => {
      const user = await createAuthenticatedUser("owner");
      const otherOwner = await createAuthenticatedUser("owner");

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      const result = await service.setLastActiveOrg({
        user: userObj!,
        tenantId: otherOwner.tenantId,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not a member");
    });

    it("rejects a pending membership", async () => {
      const user = await createAuthenticatedUser("owner");
      const inviter = await createAuthenticatedUser("owner");

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      // Add user with pending status
      await supabaseAdmin.from("membership").insert({
        user_id: user.id,
        tenant_id: inviter.tenantId,
        role: "read",
        status: "pending",
      });

      const result = await service.setLastActiveOrg({
        user: userObj!,
        tenantId: inviter.tenantId,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not a member");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", user.id).eq("tenant_id", inviter.tenantId);
    });
  });

  describe("createOrganization", () => {
    it("should create a new organization with all required records", async () => {
      const user = await createAuthenticatedUser("owner");
      const orgName = `test-org-${crypto.randomUUID()}`;

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      const result = await service.createOrganization({
        user: userObj!,
        organizationName: orgName,
        companyName: "Test Company",
      });

      // Better error logging for flaky test debugging
      if (!result.success) {
        console.error('[TEST DEBUG] createOrganization failed:', {
          error: result.error,
          orgName,
          userId: user.id,
        });
      }

      expect(result.success).toBe(true);
      expect(result.tenantId).toEqual(expect.any(String));
      expect(result.organizationName).toBe(orgName);

      // Verify tenant was created
      const { data: tenant } = await supabaseAdmin
        .from("tenant")
        .select("*")
        .eq("tenant_id", result.tenantId)
        .single();

      expect(tenant).not.toBeNull();
      expect(tenant.organization_name).toBe(orgName);
      expect(tenant.created_by).toBe(user.id);

      // Verify membership was created with role
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("user_id", user.id)
        .eq("tenant_id", result.tenantId)
        .single();

      expect(membership).not.toBeNull();
      expect(membership.status).toBe("active");
      expect(membership.role).toBe("owner");

      // Verify billing was created
      const { data: billing } = await supabaseAdmin
        .from("billing")
        .select("*")
        .eq("tenant_id", result.tenantId)
        .single();

      expect(billing).not.toBeNull();
      expect(billing.tenant_id).toBe(result.tenantId);
      // Billing ON: the real RPC stores the Stripe customer and the free 'hobby'
      // default tier (COALESCE fallback in create_organization_transaction).
      expect(billing.stripe_customer_id).toEqual(expect.stringMatching(/^cus_/));
      expect(billing.tier_id).toBe("hobby");

      // Verify Stripe was called with the inviting user's identity + org metadata
      expect(mockStripeService.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: userObj!.email,
          metadata: expect.objectContaining({
            organizationName: orgName,
            createdBy: user.id,
          }),
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", user.id).eq("tenant_id", result.tenantId);
      await supabaseAdmin.from("billing").delete().eq("tenant_id", result.tenantId);
      await supabaseAdmin.from("tenant").delete().eq("tenant_id", result.tenantId);
    });

    it("self-hosting (billing disabled): stores a NULL customer + enterprise tier via the real RPC", async () => {
      // Exercises the real create_organization_transaction against live Postgres:
      // with billing off, OrganizationService must skip Stripe entirely and drive
      // the RPC with a null customer id + 'enterprise' tier, so the billing row
      // lands with stripe_customer_id IS NULL (NULLIF('') path) and tier_id
      // 'enterprise' (entitlements then resolve unlimited through the normal
      // resolver). A regression that re-required the customer, or that defaulted
      // the tier to 'hobby', would fail one of the DB assertions below.
      const user = await createAuthenticatedUser("owner");
      const orgName = `selfhost-org-${crypto.randomUUID()}`;

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      const selfHostService = new OrganizationService({
        supabaseAdmin,
        supabaseServer: supabaseAdmin,
        stripeService: mockStripeService,
        billingEnabled: false,
      });

      const result = await selfHostService.createOrganization({
        user: userObj!,
        organizationName: orgName,
        companyName: "Self Host Co",
      });

      if (!result.success) {
        console.error('[TEST DEBUG] self-host createOrganization failed:', {
          error: result.error,
          orgName,
          userId: user.id,
        });
      }

      expect(result.success).toBe(true);
      // No Stripe customer provisioned when billing is disabled.
      expect(mockStripeService.createCustomer).not.toHaveBeenCalled();

      // The REAL billing row: null customer (not '' — NULLIF collapses it) and
      // the enterprise default tier.
      const { data: billing } = await supabaseAdmin
        .from("billing")
        .select("stripe_customer_id, tier_id")
        .eq("tenant_id", result.tenantId)
        .single();

      expect(billing).not.toBeNull();
      expect(billing!.stripe_customer_id).toBeNull();
      expect(billing!.tier_id).toBe("enterprise");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", user.id).eq("tenant_id", result.tenantId);
      await supabaseAdmin.from("billing").delete().eq("tenant_id", result.tenantId);
      await supabaseAdmin.from("tenant").delete().eq("tenant_id", result.tenantId);
    });

    it("should reject duplicate organization names (case-insensitive)", { retry: 2 }, async () => {
      const user = await createAuthenticatedUser("owner");
      const orgName = `test-org-${crypto.randomUUID()}`;

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      // Create first org
      const first = await service.createOrganization({
        user: userObj!,
        organizationName: orgName,
        companyName: "Test Company",
      });

      // Better error logging for flaky test debugging
      if (!first.success) {
        console.error('[TEST DEBUG] first createOrganization failed:', {
          error: first.error,
          orgName,
          userId: user.id,
        });
      }

      expect(first.success).toBe(true);

      // Try to create with same name (different case)
      const second = await service.createOrganization({
        user: userObj!,
        organizationName: orgName.toUpperCase(),
        companyName: "Test Company 2",
      });

      expect(second.success).toBe(false);
      expect(second.error).toContain("already taken");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", user.id).eq("tenant_id", first.tenantId);
      await supabaseAdmin.from("billing").delete().eq("tenant_id", first.tenantId);
      await supabaseAdmin.from("tenant").delete().eq("tenant_id", first.tenantId);
    });

    it("should rollback on Stripe failure", async () => {
      const user = await createAuthenticatedUser("owner");
      const orgName = `test-org-${crypto.randomUUID()}`;

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      (mockStripeService.createCustomer as Mock).mockRejectedValue(new Error("Stripe error"));

      const result = await service.createOrganization({
        user: userObj!,
        organizationName: orgName,
        companyName: "Test Company",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("billing");

      // Verify no tenant was created
      const { data: tenant } = await supabaseAdmin
        .from("tenant")
        .select("*")
        .ilike("organization_name", orgName);

      expect(tenant).toHaveLength(0);
    });

    /**
     * REGRESSION TEST: Verifies that creating an org fails when user has no profile.
     *
     * This catches a bug where OAuth register/login pages incorrectly passed
     * a 'next' parameter to /auth/callback, skipping processOAuthRegistration.
     * Users would authenticate but have no profile, causing billing FK to fail.
     */
    it("should fail when user has no profile (regression: skipped registration)", async () => {
      const email = `test-no-profile-${crypto.randomUUID()}@example.com`;
      const orgName = `test-org-${crypto.randomUUID()}`;

      // Create auth user WITHOUT registration (simulates the bug)
      const { data: authUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { name: "Test User" },
      });

      expect(createError).toBeNull();

      // Verify no profile exists (broken state)
      const { data: profile } = await supabaseAdmin
        .from("profile")
        .select("*")
        .eq("id", authUser.user!.id)
        .single();

      expect(profile).toBeNull();

      // Try to create org - should fail because billing.created_by FK references profile.id
      const result = await service.createOrganization({
        user: authUser.user!,
        organizationName: orgName,
        companyName: "Test Company",
      });

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);

      // Cleanup
      await supabaseAdmin.auth.admin.deleteUser(authUser.user!.id);
    });

    /**
     * VALIDATES: After OAuth registration, user CAN create their first organization.
     *
     * Skip-company-setup flow:
     * 1. User authenticates via OAuth (creates auth.users entry)
     * 2. Auth callback calls processOAuthRegistration
     * 3. processOAuthRegistration creates profile ONLY (no tenant/membership/billing)
     * 4. User creates their first organization via createOrganization
     */
    it("should succeed after OAuth registration (skip-company-setup)", async () => {
      const email = `test-oauth-fix-${crypto.randomUUID()}@testcompany.com`;
      const firstOrgName = `first-org-${crypto.randomUUID()}`;

      // Step 1: Create auth user (simulates OAuth authentication completing)
      const { data: authUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { name: "Test OAuth User" },
      });

      expect(createError).toBeNull();
      expect(authUser.user!.email).toBe(email);

      // Step 2: Run processOAuthRegistration (skip-company-setup: only creates profile)
      const oauthService = createOAuthRegistrationService();
      const registrationResult = await oauthService.processOAuthRegistration(authUser.user!);

      expect(registrationResult).toHaveProperty("userId");
      expect(typeof (registrationResult as any).userId).toBe("string");
      // Skip-company-setup: tenantId should NOT be returned (verify via type assertion)
      expect((registrationResult as any).tenantId).toBeUndefined();

      const { userId } = registrationResult as { userId: string };

      // Step 3: Verify only profile was created (no tenant/membership/billing)
      const { data: profile } = await supabaseAdmin
        .from("profile")
        .select("*")
        .eq("id", userId)
        .single();
      expect(profile).not.toBeNull();
      expect(profile!.email).toBe(email);

      // Verify NO membership was created during registration
      const { data: memberships } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("user_id", userId);
      expect(memberships).toHaveLength(0);

      // Step 4: NOW create first organization - this should succeed
      const { data: { user: freshUser } } = await supabaseAdmin.auth.admin.getUserById(userId);

      const result = await service.createOrganization({
        user: freshUser!,
        organizationName: firstOrgName,
        companyName: "First Company",
      });

      // Better error logging for flaky test debugging
      if (!result.success) {
        console.error('[TEST DEBUG] OAuth registration createOrganization failed:', {
          error: result.error,
          orgName: firstOrgName,
          userId,
        });
      }

      expect(result.success).toBe(true);
      expect(result.tenantId).toEqual(expect.any(String));
      expect(result.organizationName).toBe(firstOrgName);

      // Cleanup - only the org we created (no registration-created tenant to clean)
      if (result.tenantId) {
        await supabaseAdmin.from("membership").delete().eq("tenant_id", result.tenantId);
        await supabaseAdmin.from("billing").delete().eq("tenant_id", result.tenantId);
        await supabaseAdmin.from("tenant").delete().eq("tenant_id", result.tenantId);
      }
      await supabaseAdmin.from("profile").delete().eq("id", userId);
      await supabaseAdmin.auth.admin.deleteUser(userId);
    });
  });

  describe("acceptInvitation", () => {
    it("should accept a valid pending invitation", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const { data: { user: inviteeUser } } = await supabaseAdmin.auth.admin.getUserById(invitee.id);

      // Create pending membership with role
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .insert({
          user_id: invitee.id,
          tenant_id: inviter.tenantId,
          role: "read",
          status: "pending",
          invited_by: inviter.id,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      const result = await service.acceptInvitation({
        user: inviteeUser!,
        membershipId: membership!.id,
      });

      expect(result.success).toBe(true);
      expect(result.tenantId).toBe(inviter.tenantId);

      // Verify membership is now active
      const { data: updatedMembership } = await supabaseAdmin
        .from("membership")
        .select("status, accepted_at")
        .eq("id", membership!.id)
        .single();

      expect(updatedMembership?.status).toBe("active");
      expect(updatedMembership?.accepted_at).not.toBeNull();
      expect(Number.isNaN(Date.parse(updatedMembership!.accepted_at))).toBe(false);

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });

    it("should reject expired invitation", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const { data: { user: inviteeUser } } = await supabaseAdmin.auth.admin.getUserById(invitee.id);

      // Create expired membership with role
      const expiresAt = new Date(Date.now() - 1000); // Already expired
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .insert({
          user_id: invitee.id,
          tenant_id: inviter.tenantId,
          role: "read",
          status: "pending",
          invited_by: inviter.id,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      const result = await service.acceptInvitation({
        user: inviteeUser!,
        membershipId: membership!.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("expired");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });

    it("reports a real membership owned by someone else identically to a membership id that doesn't exist", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");
      const otherUser = await createAuthenticatedUser("owner");

      const { data: { user: otherUserObj } } = await supabaseAdmin.auth.admin.getUserById(otherUser.id);

      // Create pending membership for invitee with role
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .insert({
          user_id: invitee.id,
          tenant_id: inviter.tenantId,
          role: "read",
          status: "pending",
          invited_by: inviter.id,
        })
        .select()
        .single();

      // Other user tries to accept a real membership that isn't theirs.
      const mismatchedOwnerResult = await service.acceptInvitation({
        user: otherUserObj!,
        membershipId: membership!.id,
      });

      // Same user probes a membership id that was never created.
      const nonexistentResult = await service.acceptInvitation({
        user: otherUserObj!,
        membershipId: randomUUID(),
      });

      expect(mismatchedOwnerResult.success).toBe(false);
      expect(nonexistentResult.success).toBe(false);
      // Compared to each other, not each to a literal: an attacker probing
      // membership ids must not be able to tell "real, someone else's" apart
      // from "doesn't exist" from the response alone.
      expect(mismatchedOwnerResult.error).toBe(nonexistentResult.error);

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });
  });

  describe("getMembershipCount", () => {
    it("should return count of active memberships", async () => {
      const user = await createAuthenticatedUser("owner");

      const { data: { user: userObj } } = await supabaseAdmin.auth.admin.getUserById(user.id);

      const result = await service.getMembershipCount(userObj!);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1); // User has one active membership from createAuthenticatedUser
    });
  });

});
