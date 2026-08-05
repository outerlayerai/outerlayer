/**
 * Integration Tests for MembershipService
 *
 * Tests the MembershipService with:
 * - REAL Supabase (test database)
 * - MOCKED external services (Stripe, Email, RateLimit)
 *
 * This validates business logic + database interactions together.
 */

import type { Mock } from 'vitest';
import { createSupabaseAdminClient } from "../lib/supabase-admin";
import { createAuthenticatedUser, cleanupTestUsers } from "../lib/test-utils";
import { MembershipService } from "tenant-dashboard/src/lib/system/membership-service";
import {
  EmailService,
  RateLimitService,
  StripeService,
} from "tenant-dashboard/src/lib/external-services";
import { TestUser } from "../lib/test-utils";
import type { User } from "@supabase/supabase-js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Inserts a billing row with an active Stripe subscription for the given tenant.
 * Required for any sendInvite test that expects to pass the billing gate.
 */
async function createBillingRecord(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  owner: TestUser,
) {
  const { error } = await supabaseAdmin.from("billing").insert({
    tenant_id: owner.tenantId,
    stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
    stripe_subscription_id: `sub_test_${crypto.randomUUID()}`,
    tier_id: 'growth',
    created_by: owner.id,
  });
  if (error) {
    throw new Error(`Failed to create billing record for tenant ${owner.tenantId}: ${error.message}`);
  }
}

/**
 * Creates a MembershipService using the owner's authenticated client as
 * supabaseServer. This gives the billing query proper RLS scoping to the
 * owner's tenant, matching production behavior.
 */
function createScopedService(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  owner: TestUser,
) {
  return new MembershipService({
    supabaseAdmin,
    supabaseServer: owner.client,
    emailService: mockEmailService,
    rateLimitService: mockRateLimitService,
    stripeService: mockStripeService,
  });
}

// ============================================================================
// Mock External Services
// ============================================================================

const mockEmailService: EmailService = {
  sendEmail: vi.fn().mockResolvedValue({ error: null }),
  addToBroadcastAudience: vi.fn().mockResolvedValue({ success: true }),
};

const mockRateLimitService: RateLimitService = {
  limit: vi.fn().mockResolvedValue({ success: true }),
};

const mockStripeService: StripeService = {
  createCustomer: vi.fn().mockResolvedValue({ id: "cus_mock_123" }),
  retrieveCustomer: vi.fn().mockResolvedValue({ id: "cus_mock_123" }),
  deleteCustomer: vi.fn().mockResolvedValue(undefined),
  retrieveSubscription: vi.fn().mockResolvedValue({
    id: "sub_mock_123",
    items: { data: [] },
  }),
  updateSubscription: vi.fn().mockResolvedValue({ id: "sub_mock_123" }),
};

// ============================================================================
// Tests
// ============================================================================

describe("MembershipService Integration Tests", { retry: 2 }, () => {
  let supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;
  let service: MembershipService;

  beforeAll(() => {
    supabaseAdmin = createSupabaseAdminClient();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockRateLimitService.limit as Mock).mockResolvedValue({ success: true });
    (mockEmailService.sendEmail as Mock).mockResolvedValue({ error: null });

    service = new MembershipService({
      supabaseAdmin,
      supabaseServer: supabaseAdmin,
      emailService: mockEmailService,
      rateLimitService: mockRateLimitService,
      stripeService: mockStripeService,
    });
  });

  afterEach(async () => {
    await cleanupTestUsers();
  });

  describe("sendInvite", () => {
    it("should create pending membership with role for existing user", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const inviteeEmail = `test-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: inviteeEmail }).eq("id", invitee.id);

      await createBillingRecord(supabaseAdmin, inviter);
      const billingService = createScopedService(supabaseAdmin, inviter);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      const result = await billingService.sendInvite({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        name: "Test Invitee",
        email: inviteeEmail,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(true);
      expect(result.membershipId).toEqual(expect.any(String));

      // Verify membership was created with pending status and role
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("id", result.membershipId)
        .single();

      expect(membership).not.toBeNull();
      expect(membership.status).toBe("pending");
      expect(membership.user_id).toBe(invitee.id);
      expect(membership.tenant_id).toBe(inviter.tenantId);
      expect(membership.invited_by).toBe(inviter.id);
      expect(membership.role).toBe("read");

      // Verify email was sent
      expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: inviteeEmail,
          emailType: "invite",
        })
      );

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", result.membershipId);
    });

    it("should reject if user already has a role in the tenant", async () => {
      const owner = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      const memberEmail = `test-member-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: memberEmail }).eq("id", member.id);

      await createBillingRecord(supabaseAdmin, owner);
      const billingService = createScopedService(supabaseAdmin, owner);

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // First invitation - should succeed
      const firstResult = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Test Member",
        email: memberEmail,
        role: "read",
        origin: "http://localhost:3000",
      });
      if (!firstResult.success) {
        throw new Error(`First invite should succeed but failed: ${JSON.stringify(firstResult)}`);
      }

      // Second invitation - should fail
      const secondResult = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Test Member",
        email: memberEmail,
        role: "admin",
        origin: "http://localhost:3000",
      });

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe("User is already a member of this organization");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", firstResult.membershipId);
    });

    it("should create new user and invite them when email does not exist", async () => {
      const inviter = await createAuthenticatedUser("owner");

      const newUserEmail = `new-user-${crypto.randomUUID()}@example.com`;

      await createBillingRecord(supabaseAdmin, inviter);
      const billingService = createScopedService(supabaseAdmin, inviter);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      // Track new user ID for cleanup in case assertions fail
      let newUserId: string | undefined;
      try {
        const result = await billingService.sendInvite({
          adminUser: inviterUser!,
          tenantId: inviterUser!.app_metadata.tenant_id as string,
          name: "New User",
          email: newUserEmail,
          role: "admin",
          origin: "http://localhost:3000",
        });

        expect(result.success).toBe(true);

        // Verify new auth user was created
        const { data: profiles } = await supabaseAdmin
          .from("profile")
          .select("id, email, name")
          .eq("email", newUserEmail);

        expect(profiles).toHaveLength(1);
        expect(profiles![0]!.name).toBe("New User");

        newUserId = profiles![0]!.id;

        // Verify membership was created with role
        const { data: membership } = await supabaseAdmin
          .from("membership")
          .select("*")
          .eq("user_id", newUserId)
          .eq("tenant_id", inviter.tenantId)
          .single();

        expect(membership).not.toBeNull();
        expect(membership.status).toBe("pending");
        expect(membership.invited_by).toBe(inviter.id);
        expect(membership.role).toBe("admin");

        // Verify invite email contains /auth/confirm link with token_hash
        expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: newUserEmail,
            emailType: "invite",
            templateParams: expect.objectContaining({
              inviteLink: expect.stringContaining("/auth/confirm?token_hash="),
            }),
          })
        );

        // Verify the invite link has the correct query params
        const emailCall = (mockEmailService.sendEmail as Mock).mock.calls[0]![0];
        const inviteLink: string = emailCall.templateParams.inviteLink;
        expect(inviteLink).toContain("token_hash=");
        expect(inviteLink).toContain("type=invite");
        // flow=invite rides URL-encoded inside `next` so the password page
        // can render first-time-setup copy instead of the reset copy.
        expect(inviteLink).toContain(
          `next=${encodeURIComponent("/auth/new-password?flow=invite")}`
        );
        expect(inviteLink).toMatch(/^http:\/\/localhost:3000\/auth\/confirm\?/);
      } finally {
        // Always clean up the generated user, even if assertions fail.
        // This user isn't tracked by cleanupTestUsers since it was created
        // via generateLink, not createAuthenticatedUser.
        if (!newUserId) {
          const { data: profiles } = await supabaseAdmin
            .from("profile")
            .select("id")
            .eq("email", newUserEmail);
          newUserId = profiles?.[0]?.id;
        }
        if (newUserId) {
          await supabaseAdmin.from("membership").delete().eq("user_id", newUserId);
          await supabaseAdmin.from("profile").delete().eq("id", newUserId);
          await supabaseAdmin.auth.admin.deleteUser(newUserId);
        }
      }
    });

    it("should not set the invitee's tenant claim until they accept", async () => {
      const inviter = await createAuthenticatedUser("owner");

      const newUserEmail = `pending-claim-${crypto.randomUUID()}@example.com`;

      await createBillingRecord(supabaseAdmin, inviter);
      const billingService = createScopedService(supabaseAdmin, inviter);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      let newUserId: string | undefined;
      try {
        const result = await billingService.sendInvite({
          adminUser: inviterUser!,
          tenantId: inviterUser!.app_metadata.tenant_id as string,
          name: "Pending Claim User",
          email: newUserEmail,
          role: "admin",
          origin: "http://localhost:3000",
        });

        expect(result.success).toBe(true);

        const { data: profiles } = await supabaseAdmin
          .from("profile")
          .select("id")
          .eq("email", newUserEmail);

        expect(profiles).toHaveLength(1);
        newUserId = profiles![0]!.id;

        // Membership is pending: the invitee must not read the inviting
        // tenant's data (e.g. headerless Realtime traffic) before accepting.
        const { data: membership } = await supabaseAdmin
          .from("membership")
          .select("status")
          .eq("user_id", newUserId)
          .eq("tenant_id", inviter.tenantId)
          .single();
        expect(membership?.status).toBe("pending");

        const { data: { user: invitedUser } } = await supabaseAdmin.auth.admin.getUserById(newUserId);
        expect(invitedUser?.app_metadata?.tenant_id).toBeUndefined();
      } finally {
        if (!newUserId) {
          const { data: profiles } = await supabaseAdmin
            .from("profile")
            .select("id")
            .eq("email", newUserEmail);
          newUserId = profiles?.[0]?.id;
        }
        if (newUserId) {
          await supabaseAdmin.from("membership").delete().eq("user_id", newUserId);
          await supabaseAdmin.from("profile").delete().eq("id", newUserId);
          await supabaseAdmin.auth.admin.deleteUser(newUserId);
        }
      }
    });

    it("should respect rate limiting", async () => {
      const inviter = await createAuthenticatedUser("owner");

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      (mockRateLimitService.limit as Mock).mockResolvedValue({ success: false });

      // Rate limit check runs before billing — no billing row needed
      const result = await service.sendInvite({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        name: "Test Invitee",
        email: `test-ratelimit-${crypto.randomUUID()}@example.com`,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An email was just recently sent. Please wait longer before trying to send another email");
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
    });

    it("should reject invite when tenant has no billing subscription", async () => {
      const owner = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // No billing row exists for this tenant — use owner's RLS-scoped client
      // so the billing query correctly returns no rows for this tenant
      const billingCheckService = createScopedService(supabaseAdmin, owner);

      // hobby tier allows 2 users — fill the slot so the next invite is denied
      const fillerEmail = `filler-${crypto.randomUUID()}@example.com`;
      const { data: fillerAuth } = await supabaseAdmin.auth.admin.createUser({
        email: fillerEmail, password: "Test123!", email_confirm: true,
      });
      await supabaseAdmin.from("profile").insert({ id: fillerAuth.user!.id, name: "Filler", email: fillerEmail });
      await supabaseAdmin.from("membership").insert({
        user_id: fillerAuth.user!.id, tenant_id: owner.tenantId, role: "read", status: "active",
      });

      const result = await billingCheckService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "External User",
        email: `external-${crypto.randomUUID()}@example.com`,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      // Without a billing row, tier falls back to hobby (max_users: 2).
      // The owner + filler = 2 active members, so the entitlement check denies.
      expect(result.error).toBe("entitlement_denied");
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", fillerAuth.user!.id);
      await supabaseAdmin.from("profile").delete().eq("id", fillerAuth.user!.id);
      await supabaseAdmin.auth.admin.deleteUser(fillerAuth.user!.id);
    });

    it("should reject invite with invalid email format", async () => {
      const owner = await createAuthenticatedUser("owner");
      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      const result = await service.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Bad Email",
        email: "not-an-email",
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid email format");
    });

    it("should prevent non-owner from inviting as owner", async () => {
      const owner = await createAuthenticatedUser("owner");
      const admin = await createAuthenticatedUser("owner");

      // Make admin an admin-role user in owner's tenant
      await supabaseAdmin.from("membership").insert({
        user_id: admin.id,
        tenant_id: owner.tenantId,
        role: "admin",
        status: "active",
      });
      await supabaseAdmin.rpc("set_claim", { claim: "tenant_id", uid: admin.id, value: owner.tenantId });
      await supabaseAdmin.rpc("set_claim", { claim: "role", uid: admin.id, value: "admin" });

      const { data: { user: adminUser } } = await supabaseAdmin.auth.admin.getUserById(admin.id);

      const result = await service.sendInvite({
        adminUser: adminUser!,
        tenantId: adminUser!.app_metadata.tenant_id as string,
        name: "New Owner",
        email: `invite-owner-${crypto.randomUUID()}@example.com`,
        role: "owner",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only owners can invite users as owners");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", admin.id).eq("tenant_id", owner.tenantId);
    });

    it("should reject invite for previously disabled user", async () => {
      const owner = await createAuthenticatedUser("owner");
      const disabledUser = await createAuthenticatedUser("owner");

      const disabledEmail = `disabled-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: disabledEmail }).eq("id", disabledUser.id);

      // Create a disabled membership in the owner's tenant
      await supabaseAdmin.from("membership").insert({
        user_id: disabledUser.id,
        tenant_id: owner.tenantId,
        role: "disabled",
        status: "active",
      });

      await createBillingRecord(supabaseAdmin, owner);
      const billingService = createScopedService(supabaseAdmin, owner);

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      const result = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Disabled User",
        email: disabledEmail,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("This user was previously disabled in this organization");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", disabledUser.id).eq("tenant_id", owner.tenantId);
    });

    it("should reject invite when user limit is reached", async () => {
      const owner = await createAuthenticatedUser("owner");

      // Use hobby tier (max_users: 2) — owner counts as 1, add 1 more to fill the limit
      await supabaseAdmin.from("billing").insert({
        tenant_id: owner.tenantId,
        stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
        stripe_subscription_id: null,
        tier_id: 'hobby',
        created_by: owner.id,
      });
      const billingService = createScopedService(supabaseAdmin, owner);

      const fillerEmail = `bulk-0-${crypto.randomUUID()}@example.com`;
      const { data: fillerAuth } = await supabaseAdmin.auth.admin.createUser({
        email: fillerEmail, password: "Test123!", email_confirm: true,
      });
      const fillerId = fillerAuth.user!.id;
      await supabaseAdmin.from("profile").insert({ id: fillerId, name: "Bulk 0", email: fillerEmail });
      await supabaseAdmin.from("membership").insert({
        user_id: fillerId, tenant_id: owner.tenantId, role: "read", status: "active",
      });

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Owner + filler = 2 (hobby limit), so this invite should be denied
      const result = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "One Too Many",
        email: `over-limit-${crypto.randomUUID()}@example.com`,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("entitlement_denied");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", fillerId);
      await supabaseAdmin.from("profile").delete().eq("id", fillerId);
      await supabaseAdmin.auth.admin.deleteUser(fillerId);
    });

    it("should count pending invites toward user limit", async () => {
      const owner = await createAuthenticatedUser("owner");

      // Hobby tier: max_users = 2
      await supabaseAdmin.from("billing").insert({
        tenant_id: owner.tenantId,
        stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
        stripe_subscription_id: null,
        tier_id: 'hobby',
        created_by: owner.id,
      });
      const billingService = createScopedService(supabaseAdmin, owner);

      // Create a pending membership (invited but not yet accepted)
      const pendingEmail = `pending-${crypto.randomUUID()}@example.com`;
      const { data: pendingAuth } = await supabaseAdmin.auth.admin.createUser({
        email: pendingEmail, password: "Test123!", email_confirm: true,
      });
      const pendingId = pendingAuth.user!.id;
      await supabaseAdmin.from("profile").insert({ id: pendingId, name: "Pending User", email: pendingEmail });
      await supabaseAdmin.from("membership").insert({
        user_id: pendingId, tenant_id: owner.tenantId, role: "read", status: "pending",
      });

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Owner (active) + pending user = 2, at hobby limit.
      // Next invite should be denied because pending counts toward the limit.
      const result = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Should Be Denied",
        email: `denied-${crypto.randomUUID()}@example.com`,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("entitlement_denied");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", pendingId);
      await supabaseAdmin.from("profile").delete().eq("id", pendingId);
      await supabaseAdmin.auth.admin.deleteUser(pendingId);
    });

    it("should return error when email fails to send for existing user invite", async () => {
      const owner = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const inviteeEmail = `email-fail-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: inviteeEmail }).eq("id", invitee.id);

      await createBillingRecord(supabaseAdmin, owner);
      const billingService = createScopedService(supabaseAdmin, owner);

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Make email service fail
      (mockEmailService.sendEmail as Mock).mockResolvedValueOnce({ error: "SMTP failure" });

      const result = await billingService.sendInvite({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        name: "Email Fail",
        email: inviteeEmail,
        role: "read",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invitation created but failed to send email. Please resend the invite.");

      // The membership was still created despite the email failure
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("id, status")
        .eq("user_id", invitee.id)
        .eq("tenant_id", owner.tenantId)
        .single();

      expect(membership).not.toBeNull();
      expect(membership!.status).toBe("pending");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });

  });

  describe("changeUserRole", () => {
    it("should allow owner to change user role", async () => {
      const owner = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Add member to owner's org first
      await supabaseAdmin.from("membership").insert({
        user_id: member.id,
        tenant_id: owner.tenantId,
        role: "read",
        status: "active",
      });

      const result = await service.changeUserRole({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        targetUserId: member.id,
        newRole: "admin",
      });

      expect(result.success).toBe(true);

      // Verify role was changed in membership table
      const { data: updatedMembership } = await supabaseAdmin
        .from("membership")
        .select("role")
        .eq("user_id", member.id)
        .eq("tenant_id", owner.tenantId)
        .single();

      expect(updatedMembership?.role).toBe("admin");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", member.id).eq("tenant_id", owner.tenantId);
    });

    it("should prevent non-owner from promoting to owner", async () => {
      const owner = await createAuthenticatedUser("owner");
      const admin = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      // Add admin and member to owner's org
      await supabaseAdmin.from("membership").insert([
        { user_id: admin.id, tenant_id: owner.tenantId, role: "admin", status: "active" },
        { user_id: member.id, tenant_id: owner.tenantId, role: "read", status: "active" },
      ]);

      // Create admin user object with admin role in app_metadata
      const adminUser: User = {
        id: admin.id,
        app_metadata: { tenant_id: owner.tenantId, role: "admin" },
        user_metadata: {},
        aud: "authenticated",
        created_at: new Date().toISOString(),
      };

      // Admin tries to promote member to owner - should fail
      const result = await service.changeUserRole({
        adminUser,
        tenantId: adminUser.app_metadata.tenant_id as string,
        targetUserId: member.id,
        newRole: "owner",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only owners can promote users to owner role");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("tenant_id", owner.tenantId).in("user_id", [admin.id, member.id]);
    });

    it("should prevent demoting the last owner", async () => {
      const owner = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      const result = await service.changeUserRole({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        targetUserId: owner.id,
        newRole: "admin",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot demote the last owner. Transfer ownership first.");
    });
  });

  describe("removeUserFromOrg", () => {
    it("should remove user and their membership", async () => {
      const owner = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Add member to owner's org
      await supabaseAdmin.from("membership").insert({
        user_id: member.id,
        tenant_id: owner.tenantId,
        role: "read",
        status: "active",
      });

      const result = await service.removeUserFromOrg({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        targetUserId: member.id,
      });

      expect(result.success).toBe(true);

      // Verify membership was deleted
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("user_id", member.id)
        .eq("tenant_id", owner.tenantId);

      expect(membership).toHaveLength(0);
    });

    it("should prevent removing the last owner", async () => {
      const owner = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      const result = await service.removeUserFromOrg({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        targetUserId: owner.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot remove the last owner from the organization");
    });

    it("should allow removing owner when another owner exists", async () => {
      const owner1 = await createAuthenticatedUser("owner");
      const owner2 = await createAuthenticatedUser("owner");

      const { data: { user: owner1User } } = await supabaseAdmin.auth.admin.getUserById(owner1.id);

      // Add owner2 to owner1's org as another owner
      await supabaseAdmin.from("membership").insert({
        user_id: owner2.id,
        tenant_id: owner1.tenantId,
        role: "owner",
        status: "active",
      });

      // Now owner1 can remove owner2
      const result = await service.removeUserFromOrg({
        adminUser: owner1User!,
        tenantId: owner1User!.app_metadata.tenant_id as string,
        targetUserId: owner2.id,
      });

      expect(result.success).toBe(true);

      // Verify owner2's membership was actually deleted
      const { data: removedMembership } = await supabaseAdmin
        .from("membership")
        .select("id")
        .eq("user_id", owner2.id)
        .eq("tenant_id", owner1.tenantId);

      expect(removedMembership).toHaveLength(0);
    });

    it("should prevent read users from deleting memberships due to lack of permission", async () => {
      // Read users don't have profile.delete permission, so they can't remove anyone
      const owner = await createAuthenticatedUser("owner");
      const readUser = await createAuthenticatedUser("read");

      // Add read user to owner's org
      await supabaseAdmin.from("membership").insert({
        user_id: readUser.id,
        tenant_id: owner.tenantId,
        role: "read",
        status: "active",
      });

      // Update readUser's tenant claim to owner's tenant
      await supabaseAdmin.rpc("set_claim", {
        claim: "tenant_id",
        uid: readUser.id,
        value: owner.tenantId,
      });

      // Refresh session to get updated claims
      await readUser.client.auth.refreshSession();

      // Try to delete owner's membership using read user's client
      // This should fail due to lack of profile.delete permission
      const { count } = await readUser.client
        .from("membership")
        .delete({ count: "exact" })
        .eq("user_id", owner.id)
        .eq("tenant_id", owner.tenantId);

      // RLS denies the delete due to lack of permission
      expect(count).toBe(0);

      // Verify owner's membership still exists
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("user_id", owner.id)
        .eq("tenant_id", owner.tenantId);

      expect(membership).toHaveLength(1);
    });

    it("should prevent non-owner from removing owner", async () => {
      const owner = await createAuthenticatedUser("owner");
      const admin = await createAuthenticatedUser("owner");

      // Add admin to owner's org as admin role, plus a second owner so last-owner check passes
      const secondOwner = await createAuthenticatedUser("owner");
      await supabaseAdmin.from("membership").insert([
        { user_id: admin.id, tenant_id: owner.tenantId, role: "admin", status: "active" },
        { user_id: secondOwner.id, tenant_id: owner.tenantId, role: "owner", status: "active" },
      ]);

      // Set admin's claims to owner's tenant with admin role
      await supabaseAdmin.rpc("set_claim", {
        claim: "tenant_id",
        uid: admin.id,
        value: owner.tenantId,
      });
      await supabaseAdmin.rpc("set_claim", {
        claim: "role",
        uid: admin.id,
        value: "admin",
      });

      // Get admin as User object (with admin role in app_metadata)
      const { data: { user: adminUser } } = await supabaseAdmin.auth.admin.getUserById(admin.id);

      // Admin tries to remove owner — should fail
      const result = await service.removeUserFromOrg({
        adminUser: adminUser!,
        tenantId: adminUser!.app_metadata.tenant_id as string,
        targetUserId: owner.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only owners can remove other owners");

      // Verify owner's membership is still intact
      const { data: ownerMembership } = await supabaseAdmin
        .from("membership")
        .select("*")
        .eq("user_id", owner.id)
        .eq("tenant_id", owner.tenantId);

      expect(ownerMembership).toHaveLength(1);

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("tenant_id", owner.tenantId).in("user_id", [admin.id, secondOwner.id]);
    });
  });

  // NOTE: leaveOrganization is not exposed in the UI. Users cannot
  // voluntarily leave organizations; only admins can remove users, via the
  // removeUserFromOrg method. The leaveOrganization method still exists in
  // MembershipService for potential future use but is not exposed to users.

  describe("resendInviteLink", () => {
    it("should resend invite for pending existing user and extend expiry", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const inviteeEmail = `test-resend-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: inviteeEmail }).eq("id", invitee.id);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      // Create pending membership with short expiry
      const oldExpiresAt = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000); // 1 day
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .insert({
          user_id: invitee.id,
          tenant_id: inviter.tenantId,
          role: "read",
          status: "pending",
          invited_by: inviter.id,
          expires_at: oldExpiresAt.toISOString(),
        })
        .select()
        .single();

      const result = await service.resendInviteLink({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        email: inviteeEmail,
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(true);

      // Verify expiry was extended
      const { data: updatedMembership } = await supabaseAdmin
        .from("membership")
        .select("expires_at")
        .eq("id", membership!.id)
        .single();

      const newExpiresAt = new Date(updatedMembership!.expires_at!);
      expect(newExpiresAt.getTime()).toBeGreaterThan(oldExpiresAt.getTime());

      // Verify email was sent
      expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: inviteeEmail,
        })
      );

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });

    it("should reject resend when rate limited", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const invitee = await createAuthenticatedUser("owner");

      const inviteeEmail = `test-resend-ratelimit-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: inviteeEmail }).eq("id", invitee.id);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      // Create pending membership
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

      // Set rate limit to fail
      (mockRateLimitService.limit as Mock).mockResolvedValue({ success: false });

      const result = await service.resendInviteLink({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        email: inviteeEmail,
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An email was just recently sent. Please wait longer before trying to send another email");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("id", membership!.id);
    });

    it("should reject resend for user not in organization", async () => {
      const inviter = await createAuthenticatedUser("owner");

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      const result = await service.resendInviteLink({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        email: "nonexistent@test.com",
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });

    it("should reject resend for active (non-pending) membership", async () => {
      const inviter = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      const memberEmail = `test-active-${crypto.randomUUID()}@example.com`;
      await supabaseAdmin.from("profile").update({ email: memberEmail }).eq("id", member.id);

      const { data: { user: inviterUser } } = await supabaseAdmin.auth.admin.getUserById(inviter.id);

      // Create active membership (not pending)
      await supabaseAdmin.from("membership").insert({
        user_id: member.id,
        tenant_id: inviter.tenantId,
        role: "read",
        status: "active",
      });

      const result = await service.resendInviteLink({
        adminUser: inviterUser!,
        tenantId: inviterUser!.app_metadata.tenant_id as string,
        email: memberEmail,
        origin: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("No pending invitation found for this user");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", member.id).eq("tenant_id", inviter.tenantId);
    });
  });

  describe("JWT Claims from membership.role", () => {
    it("should populate JWT claims with role from membership table", async () => {
      const user = await createAuthenticatedUser("admin");

      // Get the user's session to check JWT claims
      const { data: sessionData } = await user.client.auth.getSession();

      expect(sessionData.session).not.toBeNull();
      expect(sessionData.session?.user.app_metadata.role).toBe("admin");
      expect(sessionData.session?.user.app_metadata.tenant_id).toBe(user.tenantId);
    });

    it("should update JWT claims when role changes in membership", async () => {
      const owner = await createAuthenticatedUser("owner");
      const member = await createAuthenticatedUser("owner");

      const { data: { user: ownerUser } } = await supabaseAdmin.auth.admin.getUserById(owner.id);

      // Add member to owner's org as "read" role
      await supabaseAdmin.from("membership").insert({
        user_id: member.id,
        tenant_id: owner.tenantId,
        role: "read",
        status: "active",
      });

      // Change role to "admin"
      const result = await service.changeUserRole({
        adminUser: ownerUser!,
        tenantId: ownerUser!.app_metadata.tenant_id as string,
        targetUserId: member.id,
        newRole: "admin",
      });

      expect(result.success).toBe(true);

      // Verify the role was updated in the database
      const { data: updatedMembership } = await supabaseAdmin
        .from("membership")
        .select("role")
        .eq("user_id", member.id)
        .eq("tenant_id", owner.tenantId)
        .single();

      expect(updatedMembership?.role).toBe("admin");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", member.id).eq("tenant_id", owner.tenantId);
    });
  });

  describe("protect_last_owner trigger", () => {
    it("should prevent deleting the last owner via direct database delete", async () => {
      const owner = await createAuthenticatedUser("owner");

      // Try to directly delete the owner's membership (bypassing service layer)
      const { error } = await supabaseAdmin
        .from("membership")
        .delete()
        .eq("user_id", owner.id)
        .eq("tenant_id", owner.tenantId)
        .eq("role", "owner");

      // The trigger should prevent this deletion
      expect(error).not.toBeNull();
      expect(error?.message).toContain("Cannot remove the last owner from organization");
    });

    it("should prevent changing the last owner role to non-owner via direct update", async () => {
      const owner = await createAuthenticatedUser("owner");

      // Try to directly update the owner's role to admin (bypassing service layer)
      const { error } = await supabaseAdmin
        .from("membership")
        .update({ role: "admin" })
        .eq("user_id", owner.id)
        .eq("tenant_id", owner.tenantId);

      // The trigger should prevent this update
      expect(error).not.toBeNull();
      expect(error?.message).toContain("Cannot remove the last owner from organization");
    });

    it("should allow role change when multiple owners exist", async () => {
      const owner1 = await createAuthenticatedUser("owner");
      const owner2 = await createAuthenticatedUser("owner");

      // Add owner2 to owner1's org as another owner
      await supabaseAdmin.from("membership").insert({
        user_id: owner2.id,
        tenant_id: owner1.tenantId,
        role: "owner",
        status: "active",
      });

      // Now we can change owner1's role since owner2 is also an owner
      const { error } = await supabaseAdmin
        .from("membership")
        .update({ role: "admin" })
        .eq("user_id", owner1.id)
        .eq("tenant_id", owner1.tenantId);

      // Should succeed because owner2 is still an owner
      expect(error).toBeNull();

      // Verify the role was changed
      const { data: membership } = await supabaseAdmin
        .from("membership")
        .select("role")
        .eq("user_id", owner1.id)
        .eq("tenant_id", owner1.tenantId)
        .single();

      expect(membership?.role).toBe("admin");

      // Cleanup
      await supabaseAdmin.from("membership").delete().eq("user_id", owner2.id).eq("tenant_id", owner1.tenantId);
    });
  });

  describe("prevent_membership_self_privilege_change trigger (S3)", () => {
    // The self-service "Users can accept invitations" RLS policy lets a member
    // UPDATE their OWN membership row. RLS can't restrict WHICH columns change,
    // so the column guard is the only thing stopping a member from raising their
    // own privilege columns on that update. These use member.client
    // (the 'authenticated' DB role) — NOT supabaseAdmin — because the guard is
    // gated on current_user and deliberately skips service_role / SECURITY
    // DEFINER paths.

    // Two layers stand between a member and their own privilege columns, and
    // they engage at different points:
    //
    //   RLS      — the self-UPDATE policy admits only a PENDING row becoming
    //              active, so an already-active member has no self-update path at
    //              all. The row is filtered out, which reads as "0 rows affected"
    //              with NO error, not as a rejection.
    //   trigger  — prevent_membership_self_privilege_change, which guards the one
    //              UPDATE the policy does admit (acceptance).
    //
    // So the assertions below pin the OUTCOME (the column is unchanged) rather
    // than which layer refused. The trigger's own behaviour is pinned separately,
    // on the pending row where it is actually reachable.

    it("an active member cannot self-escalate their role to owner", async () => {
      const member = await createAuthenticatedUser("read");

      await member.client
        .from("membership")
        .update({ role: "owner" })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      const { data } = await supabaseAdmin
        .from("membership")
        .select("role")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      expect(data?.role).toBe("read");
    });

    it("an active member cannot self-change other privilege-bearing columns (is_app_scoped)", async () => {
      const member = await createAuthenticatedUser("read");

      await member.client
        .from("membership")
        .update({ is_app_scoped: true })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      const { data } = await supabaseAdmin
        .from("membership")
        .select("is_app_scoped")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      expect(data?.is_app_scoped).toBe(false);
    });

    it("the trigger still blocks a role change smuggled into an invitation acceptance", async () => {
      const member = await createAuthenticatedUser("read");
      // A pending row is the one UPDATE the policy admits, so this is where the
      // trigger has to hold: accepting must not be a vehicle for escalation.
      await supabaseAdmin
        .from("membership")
        .update({
          status: "pending",
          accepted_at: null,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      const { error } = await member.client
        .from("membership")
        .update({ status: "active", accepted_at: new Date().toISOString(), role: "owner" })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      // Here the row IS visible to the policy, so the trigger runs and raises.
      expect(error).not.toBeNull();
      const { data } = await supabaseAdmin
        .from("membership")
        .select("role, status")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      expect(data?.role).toBe("read");
      // The whole statement is rejected, so the acceptance does not land either.
      expect(data?.status).toBe("pending");
    });

    it("still allows a member to accept their own LIVE invitation (status / accepted_at)", async () => {
      const member = await createAuthenticatedUser("read");
      // Acceptance operates on a pending invite, so put the row in that state
      // first. The policy's USING clause pins the pre-image to `status =
      // 'pending'` with an unexpired `expires_at`; an already-active row is not
      // an invitation and re-accepting one is not a flow the product has.
      await supabaseAdmin
        .from("membership")
        .update({
          status: "pending",
          accepted_at: null,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      const acceptedAt = new Date().toISOString();
      const { error } = await member.client
        .from("membership")
        .update({ status: "active", accepted_at: acceptedAt })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from("membership")
        .select("accepted_at, role, status")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      expect(data?.accepted_at).not.toBeNull();
      expect(data?.status).toBe("active");
      expect(data?.role).toBe("read"); // privilege column untouched
    });

    it("refuses to accept an invitation that has already expired", async () => {
      const member = await createAuthenticatedUser("read");
      await supabaseAdmin
        .from("membership")
        .update({
          status: "pending",
          accepted_at: null,
          // Long dead. The service layer's expiry check is in TypeScript, so
          // this drives the policy predicate directly over PostgREST.
          expires_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      await member.client
        .from("membership")
        .update({ status: "active", accepted_at: new Date().toISOString() })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      const { data } = await supabaseAdmin
        .from("membership")
        .select("status, accepted_at")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      // RLS filters the row out rather than erroring, so the tell is that the
      // row is untouched — not an error code.
      expect(data?.status).toBe("pending");
      expect(data?.accepted_at).toBeNull();
    });

    it("does not block a service_role role change (the guard targets only direct authenticated callers)", async () => {
      const member = await createAuthenticatedUser("read");

      // The legitimate admin path runs as service_role (and via SECURITY DEFINER
      // RPCs); the guard must skip it so real role changes are not broken.
      const { error } = await supabaseAdmin
        .from("membership")
        .update({ role: "admin" })
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId);

      expect(error).toBeNull();
      const { data } = await supabaseAdmin
        .from("membership")
        .select("role")
        .eq("user_id", member.id)
        .eq("tenant_id", member.tenantId)
        .single();
      expect(data?.role).toBe("admin");
    });
  });

  describe("Concurrent Owner Demotion", () => {
    it("should preserve at least one owner when two owners are demoted concurrently", async () => {
      const owner1 = await createAuthenticatedUser("owner");
      const owner2 = await createAuthenticatedUser("owner");

      // Put both owners in the same tenant
      await supabaseAdmin.from("membership").insert({
        user_id: owner2.id,
        tenant_id: owner1.tenantId,
        role: "owner",
        status: "active",
      });

      const { data: { user: owner1User } } = await supabaseAdmin.auth.admin.getUserById(owner1.id);

      // Update owner2's claims so the service sees them in owner1's tenant
      await supabaseAdmin.rpc("set_claim", { claim: "tenant_id", uid: owner2.id, value: owner1.tenantId });
      await supabaseAdmin.rpc("set_claim", { claim: "role", uid: owner2.id, value: "owner" });
      const { data: { user: owner2User } } = await supabaseAdmin.auth.admin.getUserById(owner2.id);

      // Each owner tries to demote the other concurrently.
      // The FOR UPDATE lock in the trigger serializes these — one succeeds,
      // the other sees the updated state and rejects the demotion.
      const [result1, result2] = await Promise.all([
        service.changeUserRole({
          adminUser: owner1User!,
          tenantId: owner1User!.app_metadata.tenant_id as string,
          targetUserId: owner2.id,
          newRole: "admin",
        }),
        service.changeUserRole({
          adminUser: owner2User!,
          tenantId: owner2User!.app_metadata.tenant_id as string,
          targetUserId: owner1.id,
          newRole: "admin",
        }),
      ]);

      // Exactly one should succeed and one should fail — if both succeed,
      // the advisory lock failed to serialize the demotions.
      const successes = [result1, result2].filter(r => r.success).length;
      const failures = [result1, result2].filter(r => !r.success).length;
      expect(successes).toBe(1);
      expect(failures).toBe(1);

      // At least one owner must remain
      const { count: ownerCount } = await supabaseAdmin
        .from("membership")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", owner1.tenantId)
        .eq("role", "owner")
        .eq("status", "active");

      expect(ownerCount).toBeGreaterThanOrEqual(1);

      // Cleanup
      await supabaseAdmin.from("membership").delete()
        .eq("tenant_id", owner1.tenantId)
        .eq("user_id", owner2.id);
    });
  });
});
