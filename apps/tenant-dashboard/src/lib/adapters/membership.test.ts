/**
 * The `MembershipService` crossing. `MembershipService` and `AuditLogService`
 * are mocked (their own suites cover the real DB logic); the admin client is
 * REAL, running against the shared MSW `membership`/`custom_role` handlers
 * (per apps/tenant-dashboard/CLAUDE.md — no hand-built Supabase mocks). This
 * pins the adapter's own wiring — which service method each export calls
 * with which args, and `sendMemberInvite`'s custom-role attach branch
 * (tenant-verify-fails, membership-update-fails, and the entitlement_denied
 * passthrough that skips the branch entirely) — ported from the
 * pre-migration sections/admin/settings/actions.test.ts coverage of the same
 * logic, now exercised over the real wire instead of a hand-faked chain.
 */

const {
  sendInviteFn,
  resendInviteLinkFn,
  changeUserRoleFn,
  removeUserFromOrgFn,
  auditLogCreateFn,
} = vi.hoisted(() => ({
  sendInviteFn: vi.fn(),
  resendInviteLinkFn: vi.fn(),
  changeUserRoleFn: vi.fn(),
  removeUserFromOrgFn: vi.fn(),
  auditLogCreateFn: vi.fn(),
}));

vi.mock("@/lib/system/membership-service", () => ({
  // A real function expression, not an arrow — `new MembershipService(...)`
  // requires a constructible mock.
  MembershipService: vi.fn().mockImplementation(function () {
    return {
      sendInvite: sendInviteFn,
      resendInviteLink: resendInviteLinkFn,
      changeUserRole: changeUserRoleFn,
      removeUserFromOrg: removeUserFromOrgFn,
    };
  }),
}));

vi.mock("@/lib/external-services", () => ({
  createBillingService: vi.fn().mockReturnValue({}),
  createEmailService: vi.fn().mockReturnValue({}),
  createInviteRateLimiter: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/system/audit-log", () => ({
  AuditLogService: vi.fn().mockImplementation(function () {
    return { create: auditLogCreateFn };
  }),
}));

import { seedMembershipMswState, type MembershipMswRow } from "@/test-helpers/msw-handlers";
import { MembershipService } from "@/lib/system/membership-service";
import { AuditLogService } from "@/lib/system/audit-log";
import { sendMemberInvite, resendMemberInvite, changeMemberRole, removeMember } from "./membership";

const mockMembershipServiceCtor = vi.mocked(MembershipService);
const mockAuditLogServiceCtor = vi.mocked(AuditLogService);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createMembershipService wiring", () => {
  it("constructs MembershipService with the real admin/server clients and every collaborator service", async () => {
    changeUserRoleFn.mockResolvedValue({ success: true });

    await changeMemberRole({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
      newRole: "read",
    });

    expect(mockMembershipServiceCtor).toHaveBeenCalledTimes(1);
    const deps = mockMembershipServiceCtor.mock.calls[0]![0];
    // An empty deps object (the `{}` mutant) would fail this — every
    // collaborator MembershipService needs is present, nothing extra.
    expect(Object.keys(deps).sort()).toEqual(
      ["emailService", "rateLimitService", "stripeService", "supabaseAdmin", "supabaseServer"].sort(),
    );
  });
});

describe("sendMemberInvite", () => {
  const baseInput = {
    tenantId: "tenant-1",
    actorUserId: "user-1",
    name: "Ryan",
    email: "ryan@example.com",
    role: "read" as const,
    origin: "https://app.example.com",
  };

  it("forwards the actor id (not a full User object) and invite fields to MembershipService.sendInvite", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });

    await sendMemberInvite(baseInput);

    expect(sendInviteFn).toHaveBeenCalledWith({
      adminUser: { id: "user-1" },
      tenantId: "tenant-1",
      name: "Ryan",
      email: "ryan@example.com",
      role: "read",
      origin: "https://app.example.com",
      appRoles: undefined,
    });
  });

  it("returns the service result unchanged when no customRoleId is given, without writing an audit row", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });

    const result = await sendMemberInvite(baseInput);

    expect(result).toEqual({ success: true, membershipId: "mem-1" });
    expect(auditLogCreateFn).not.toHaveBeenCalled();
  });

  it("passes through an entitlement_denied failure unchanged, skipping the custom-role branch even when a customRoleId is given", async () => {
    // No custom_role/membership rows seeded — if the branch ran anyway it
    // would 406 rather than silently succeed, so this also proves the skip.
    const denied = {
      success: false,
      error: "entitlement_denied",
      entitlement: { featureKey: "max_users", requiredTier: "growth" },
    };
    sendInviteFn.mockResolvedValue(denied);

    const result = await sendMemberInvite({ ...baseInput, customRoleId: "cr-1" });

    expect(result).toEqual(denied);
    expect(auditLogCreateFn).not.toHaveBeenCalled();
  });

  it("skips the custom-role branch whenever the invite itself did not succeed, even if the service also returned a membershipId", async () => {
    sendInviteFn.mockResolvedValue({
      success: false,
      membershipId: "mem-should-not-be-used",
      error: "some failure",
    });

    const result = await sendMemberInvite({ ...baseInput, customRoleId: "cr-1" });

    expect(result).toEqual({
      success: false,
      membershipId: "mem-should-not-be-used",
      error: "some failure",
    });
    expect(auditLogCreateFn).not.toHaveBeenCalled();
  });

  it("passes through a generic (non-entitlement) invite failure unchanged", async () => {
    sendInviteFn.mockResolvedValue({ success: false, error: "Invalid email format" });

    const result = await sendMemberInvite(baseInput);

    expect(result).toEqual({ success: false, error: "Invalid email format" });
  });

  it("assigns the custom role to the new membership and writes an exact audit row after a successful invite", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });
    // Kept as a live reference — the MSW PATCH handler mutates this exact
    // object via Object.assign, so asserting on it afterwards proves the
    // real PATCH payload actually carried custom_role_id (the audit row's
    // afterState is built from `input.customRoleId` directly, so it alone
    // can't tell an `.update({ custom_role_id })` from an `.update({})`).
    const membershipRow: MembershipMswRow = { id: "mem-1", user_id: "invitee-1", tenant_id: "tenant-1", role: "read", status: "pending" };
    seedMembershipMswState({
      customRoles: [{ id: "cr-1", tenant_id: "tenant-1" }],
      memberships: [membershipRow],
    });

    const result = await sendMemberInvite({ ...baseInput, customRoleId: "cr-1" });

    expect(result).toEqual({ success: true, membershipId: "mem-1" });
    expect(membershipRow.custom_role_id).toBe("cr-1");
    expect(mockAuditLogServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockAuditLogServiceCtor.mock.calls[0]![0]).toHaveProperty("db");
    expect(auditLogCreateFn).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorId: "user-1",
      actionType: "custom_role_assigned",
      targetType: "membership",
      targetId: "mem-1",
      targetIdentifier: "ryan@example.com",
      afterState: { custom_role_id: "cr-1" },
      details: { during: "invite" },
    });
  });

  it("errors when the custom role is not found in the tenant (tenant-verify-fails) — invite still counts as created", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });
    // No custom_role row seeded — the tenant-verify lookup misses.
    seedMembershipMswState({
      memberships: [
        { id: "mem-1", user_id: "invitee-1", tenant_id: "tenant-1", role: "read", status: "pending" },
      ],
    });

    const result = await sendMemberInvite({ ...baseInput, customRoleId: "cr-missing" });

    expect(result).toEqual({
      success: false,
      membershipId: "mem-1",
      error: "User was invited but custom role assignment failed. Role not found.",
    });
    expect(auditLogCreateFn).not.toHaveBeenCalled();
  });

  it("errors when the membership custom-role update fails (membership-update-fails)", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });
    // Role verifies, but no membership row is seeded — the PATCH misses (406),
    // exercising the same failure branch a real DB error would.
    seedMembershipMswState({ customRoles: [{ id: "cr-1", tenant_id: "tenant-1" }] });

    const result = await sendMemberInvite({ ...baseInput, customRoleId: "cr-1" });

    expect(result).toEqual({
      success: false,
      membershipId: "mem-1",
      error: "User was invited but custom role assignment failed. Please assign the role manually.",
    });
    expect(auditLogCreateFn).not.toHaveBeenCalled();
  });
});

describe("resendMemberInvite", () => {
  it("forwards the actor id and email/origin to MembershipService.resendInviteLink", async () => {
    resendInviteLinkFn.mockResolvedValue({ success: true });

    const result = await resendMemberInvite({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      email: "ryan@example.com",
      origin: "https://app.example.com",
    });

    expect(result).toEqual({ success: true });
    expect(resendInviteLinkFn).toHaveBeenCalledWith({
      adminUser: { id: "user-1" },
      tenantId: "tenant-1",
      email: "ryan@example.com",
      origin: "https://app.example.com",
    });
  });

  it("surfaces the service error unchanged", async () => {
    resendInviteLinkFn.mockResolvedValue({ success: false, error: "No pending invitation found for this user" });

    const result = await resendMemberInvite({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      email: "ryan@example.com",
      origin: "https://app.example.com",
    });

    expect(result).toEqual({ success: false, error: "No pending invitation found for this user" });
  });
});

describe("changeMemberRole", () => {
  it("forwards target user, new role, and an explicit custom role id", async () => {
    changeUserRoleFn.mockResolvedValue({ success: true });

    await changeMemberRole({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
      newRole: "admin",
      customRoleId: "cr-9",
    });

    expect(changeUserRoleFn).toHaveBeenCalledWith({
      adminUser: { id: "user-1" },
      tenantId: "tenant-1",
      targetUserId: "user-2",
      newRole: "admin",
      customRoleId: "cr-9",
    });
  });

  it("surfaces the last-owner-protection error unchanged", async () => {
    changeUserRoleFn.mockResolvedValue({
      success: false,
      error: "Cannot demote the last owner. Transfer ownership first.",
    });

    const result = await changeMemberRole({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
      newRole: "read",
    });

    expect(result).toEqual({
      success: false,
      error: "Cannot demote the last owner. Transfer ownership first.",
    });
  });
});

describe("removeMember", () => {
  it("forwards the actor id and target user to MembershipService.removeUserFromOrg", async () => {
    removeUserFromOrgFn.mockResolvedValue({ success: true });

    const result = await removeMember({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
    });

    expect(result).toEqual({ success: true });
    expect(removeUserFromOrgFn).toHaveBeenCalledWith({
      adminUser: { id: "user-1" },
      tenantId: "tenant-1",
      targetUserId: "user-2",
    });
  });

  it("surfaces the service error unchanged", async () => {
    removeUserFromOrgFn.mockResolvedValue({ success: false, error: "Cannot remove the last owner from the organization" });

    const result = await removeMember({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
    });

    expect(result).toEqual({ success: false, error: "Cannot remove the last owner from the organization" });
  });
});
