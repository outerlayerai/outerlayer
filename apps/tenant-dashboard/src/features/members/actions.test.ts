/**
 * Unit tests for the member-lifecycle actions. Runs the REAL `authorizedAction`
 * wrapper and the REAL action bodies; only the two seams beneath the wrapper
 * (`@/lib/adapters` context resolution + permission check) and the
 * `MembershipService` crossing (also `@/lib/adapters`) are mocked — proving
 * the permission each action gates on, the exact adapter call it makes, and
 * the result envelope the wrapper returns for allow / deny / business failure.
 */

const {
  mockLoadCtx,
  mockCheckPerm,
  sendInviteFn,
  resendInviteFn,
  changeRoleFn,
  removeMemberFn,
} = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  sendInviteFn: vi.fn(),
  resendInviteFn: vi.fn(),
  changeRoleFn: vi.fn(),
  removeMemberFn: vi.fn(),
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
  sendMemberInvite: sendInviteFn,
  resendMemberInvite: resendInviteFn,
  changeMemberRole: changeRoleFn,
  removeMember: removeMemberFn,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import {
  sendInviteAction,
  resendInviteAction,
  changeMemberRoleAction,
  removeMemberAction,
} from "./actions";

const mockRevalidatePath = vi.mocked(revalidatePath);

const ACTOR = { userId: "user-1", role: "admin" };
const CTX = { db: {}, tenantId: "tenant-1", actor: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe("sendInviteAction", () => {
  it("gates on membership.insert (org-scoped, no appId) and forwards the parsed invite to the adapter", async () => {
    sendInviteFn.mockResolvedValue({ success: true, membershipId: "mem-1" });

    const result = await sendInviteAction({
      name: "Ryan",
      email: "ryan@example.com",
      role: "write",
    });

    expect(result).toEqual({ ok: true, data: { success: true, membershipId: "mem-1" } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "membership.insert", undefined);
    expect(sendInviteFn).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      name: "Ryan",
      email: "ryan@example.com",
      role: "write",
      origin: "",
      appRoles: undefined,
      customRoleId: undefined,
    });
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects invalid input before resolving context or calling the adapter", async () => {
    const result = await sendInviteAction({ name: "", email: "not-an-email", role: "write" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(sendInviteFn).not.toHaveBeenCalled();
  });

  it("denies without calling the adapter when the actor lacks membership.insert", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await sendInviteAction({ name: "Ryan", email: "ryan@example.com", role: "write" });

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: membership.insert" },
    });
    expect(sendInviteFn).not.toHaveBeenCalled();
  });

  it("surfaces a business-level failure (e.g. entitlement denial) inside a successful envelope — the wrapper only maps thrown errors", async () => {
    sendInviteFn.mockResolvedValue({ success: false, error: "entitlement_denied" });

    const result = await sendInviteAction({ name: "Ryan", email: "ryan@example.com", role: "write" });

    expect(result).toEqual({ ok: true, data: { success: false, error: "entitlement_denied" } });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("resendInviteAction", () => {
  it("gates on membership.insert and forwards the email", async () => {
    resendInviteFn.mockResolvedValue({ success: true });

    const result = await resendInviteAction({ email: "ryan@example.com" });

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "membership.insert", undefined);
    expect(resendInviteFn).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      email: "ryan@example.com",
      origin: "",
    });
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("does not revalidate when the resend fails", async () => {
    resendInviteFn.mockResolvedValue({ success: false, error: "user_not_found" });

    const result = await resendInviteAction({ email: "ryan@example.com" });

    expect(result).toEqual({ ok: true, data: { success: false, error: "user_not_found" } });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("changeMemberRoleAction", () => {
  it("gates on membership.update and forwards the target user, role, and custom role id", async () => {
    changeRoleFn.mockResolvedValue({ success: true });

    const result = await changeMemberRoleAction({
      userId: "user-2",
      role: "read",
      customRoleId: "cr-1",
    });

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "membership.update", undefined);
    expect(changeRoleFn).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
      newRole: "read",
      customRoleId: "cr-1",
    });
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("surfaces the last-owner-protection business failure unchanged and does not revalidate", async () => {
    changeRoleFn.mockResolvedValue({
      success: false,
      error: "Cannot demote the last owner. Transfer ownership first.",
    });

    const result = await changeMemberRoleAction({ userId: "user-2", role: "read" });

    expect(result).toEqual({
      ok: true,
      data: { success: false, error: "Cannot demote the last owner. Transfer ownership first." },
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeMemberAction", () => {
  it("gates on membership.delete and forwards the target user", async () => {
    removeMemberFn.mockResolvedValue({ success: true });

    const result = await removeMemberAction({ userId: "user-2" });

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "membership.delete", undefined);
    expect(removeMemberFn).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
    });
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  // proves AC-065-03
  it("denies without calling the adapter when the actor lacks membership.delete", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await removeMemberAction({ userId: "user-2" });

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: membership.delete" },
    });
    expect(removeMemberFn).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("does not revalidate when the removal fails", async () => {
    removeMemberFn.mockResolvedValue({ success: false, error: "cannot_remove_last_owner" });

    const result = await removeMemberAction({ userId: "user-2" });

    expect(result).toEqual({ ok: true, data: { success: false, error: "cannot_remove_last_owner" } });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * Asserts the shape of the gate, not four individual permission strings. Every
 * built-in role holds `profile.*` so a member can edit their OWN profile, which
 * makes those permissions unusable as a lifecycle gate — and the failure mode is
 * class-wide, so any action added here later is covered by the same assertion.
 */
describe("member-lifecycle permission gating", () => {
  it.each([
    ["sendInviteAction", () => sendInviteAction({ name: "R", email: "r@example.com", role: "write" })],
    ["resendInviteAction", () => resendInviteAction({ email: "r@example.com" })],
    ["changeMemberRoleAction", () => changeMemberRoleAction({ userId: "user-2", role: "read" })],
    ["removeMemberAction", () => removeMemberAction({ userId: "user-2" })],
  ])("%s gates on membership.*, never the self-service profile.*", async (_name, invoke) => {
    mockCheckPerm.mockResolvedValue(true);
    sendInviteFn.mockResolvedValue({ success: true });
    resendInviteFn.mockResolvedValue({ success: true });
    changeRoleFn.mockResolvedValue({ success: true });
    removeMemberFn.mockResolvedValue({ success: true });

    await invoke();

    expect(mockCheckPerm).toHaveBeenCalledTimes(1);
    const permission = mockCheckPerm.mock.calls[0]![1] as string;
    expect(permission).toMatch(/^membership\./);
    expect(permission).not.toMatch(/^profile\./);
  });
});
