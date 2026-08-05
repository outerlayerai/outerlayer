/**
 * Unit tests for the app-access actions. Runs the REAL `authorizedAction`
 * wrapper and the REAL action bodies; only the two seams beneath the
 * wrapper (`@/lib/adapters` context resolution + permission check) and the
 * `./service` crossing are mocked — proving the permission each action
 * gates on and the exact service call it makes.
 */

const {
  mockLoadCtx,
  mockCheckPerm,
  assignAppRoleFn,
  updateAppRoleFn,
  updateAppCustomRoleFn,
  revokeAppRoleFn,
  setAppScopedFn,
  listAppRolesFn,
  listAppsFn,
  getAppScopedStatusFn,
} = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  assignAppRoleFn: vi.fn(),
  updateAppRoleFn: vi.fn(),
  updateAppCustomRoleFn: vi.fn(),
  revokeAppRoleFn: vi.fn(),
  setAppScopedFn: vi.fn(),
  listAppRolesFn: vi.fn(),
  listAppsFn: vi.fn(),
  getAppScopedStatusFn: vi.fn(),
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

vi.mock("./service", () => ({
  assignAppRole: assignAppRoleFn,
  updateAppRole: updateAppRoleFn,
  updateAppCustomRole: updateAppCustomRoleFn,
  revokeAppRole: revokeAppRoleFn,
  setAppScoped: setAppScopedFn,
  listAppRoles: listAppRolesFn,
  listApps: listAppsFn,
  getAppScopedStatus: getAppScopedStatusFn,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  assignAppRoleAction,
  updateAppRoleAction,
  updateAppCustomRoleAction,
  revokeAppRoleAction,
  setAppScopedAction,
  listAppRolesAction,
  listAppsForDropdownAction,
  getAppScopedStatusAction,
} from "./actions";

const ACTOR = { userId: "user-1", role: "admin" };
const CTX = { db: {}, tenantId: "tenant-1", actor: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe("mutation actions — permission gate + service delegation", () => {
  it.each([
    [
      "assignAppRoleAction",
      () => assignAppRoleAction({ membershipId: "m", appId: "p", role: "read" }),
      "app_member_role.insert",
      assignAppRoleFn,
      ["tenant-1", "user-1", "m", "p", "read"],
    ],
    [
      "updateAppRoleAction",
      () => updateAppRoleAction({ appMemberRoleId: "a", role: "write" }),
      "app_member_role.update",
      updateAppRoleFn,
      ["tenant-1", "user-1", "a", "write"],
    ],
    [
      "updateAppCustomRoleAction",
      () => updateAppCustomRoleAction({ appMemberRoleId: "a", customRoleId: "cr-1" }),
      "app_member_role.update",
      updateAppCustomRoleFn,
      ["tenant-1", "user-1", "a", "cr-1"],
    ],
    [
      "revokeAppRoleAction",
      () => revokeAppRoleAction({ appMemberRoleId: "a" }),
      "app_member_role.delete",
      revokeAppRoleFn,
      ["tenant-1", "user-1", "a"],
    ],
    [
      "setAppScopedAction",
      () => setAppScopedAction({ membershipId: "m", isAppScoped: true }),
      "app_member_role.update",
      setAppScopedFn,
      ["tenant-1", "user-1", "m", true],
    ],
  ])("%s gates on %s and forwards ctx + input to the service", async (_name, invoke, expectedPermission, fn, expectedArgs) => {
    fn.mockResolvedValue({ success: true, data: {} });

    const result = await invoke();

    expect(result).toEqual({ ok: true, data: { success: true, data: {} } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, expectedPermission, undefined);
    expect(fn).toHaveBeenCalledWith(...expectedArgs);
  });

  it.each([
    ["assignAppRoleAction", () => assignAppRoleAction({ membershipId: "m", appId: "p", role: "read" }), assignAppRoleFn],
    ["updateAppRoleAction", () => updateAppRoleAction({ appMemberRoleId: "a", role: "write" }), updateAppRoleFn],
    ["revokeAppRoleAction", () => revokeAppRoleAction({ appMemberRoleId: "a" }), revokeAppRoleFn],
    ["setAppScopedAction", () => setAppScopedAction({ membershipId: "m", isAppScoped: true }), setAppScopedFn],
  ])("%s denies without calling the service when the actor lacks the permission", async (_name, invoke, fn) => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await invoke();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(fn).not.toHaveBeenCalled();
  });

  it("surfaces an entitlement_denied failure unchanged, without revalidating", async () => {
    const { revalidatePath } = await import("next/cache");
    const denied = {
      success: false,
      error: "entitlement_denied",
      entitlement: { featureKey: "app_level_roles", requiredTier: "enterprise" },
    };
    assignAppRoleFn.mockResolvedValue(denied);

    const result = await assignAppRoleAction({ membershipId: "m", appId: "p", role: "read" });

    expect(result).toEqual({ ok: true, data: denied });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("assignAppRoleAction returns the raw app_member_role row unchanged — the shape the dialog reads .id from to seed the new rowId", async () => {
    const row = {
      id: "amr-1",
      membership_id: "m",
      app_id: "p",
      tenant_id: "tenant-1",
      role: "read",
      custom_role_id: null,
      created_at: "2026-01-01T00:00:00Z",
      created_by: "user-1",
      updated_at: null,
      updated_by: null,
    };
    assignAppRoleFn.mockResolvedValue({ success: true, data: row });

    const result = await assignAppRoleAction({ membershipId: "m", appId: "p", role: "read" });

    expect(result).toEqual({ ok: true, data: { success: true, data: row } });
  });

  it("assignAppRoleAction passes a null role through unmapped (no camelCase/coercion transform)", async () => {
    const row = {
      id: "amr-2",
      membership_id: "m",
      app_id: "p",
      tenant_id: "tenant-1",
      role: null,
      custom_role_id: "cr-1",
      created_at: "2026-01-01T00:00:00Z",
      created_by: "user-1",
      updated_at: null,
      updated_by: null,
    };
    assignAppRoleFn.mockResolvedValue({ success: true, data: row });

    const result = await assignAppRoleAction({ membershipId: "m", appId: "p", role: "read" });

    expect(result).toEqual({ ok: true, data: { success: true, data: row } });
    if (result.ok && result.data.success) expect(result.data.data.role).toBeNull();
  });
});

describe("read actions — permission gate + service delegation", () => {
  it("listAppRolesAction gates on app_member_role.read and forwards the filters", async () => {
    listAppRolesFn.mockResolvedValue({ data: [] });

    const result = await listAppRolesAction({ membershipId: "m" });

    expect(result).toEqual({ ok: true, data: { data: [] } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "app_member_role.read", undefined);
    expect(listAppRolesFn).toHaveBeenCalledWith("tenant-1", { membershipId: "m" });
  });

  it("listAppsForDropdownAction gates on app.read", async () => {
    listAppsFn.mockResolvedValue({ data: [] });

    const result = await listAppsForDropdownAction({});

    expect(result).toEqual({ ok: true, data: { data: [] } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "app.read", undefined);
    expect(listAppsFn).toHaveBeenCalledWith("tenant-1");
  });

  it("getAppScopedStatusAction gates on app_member_role.read and forwards the membershipId", async () => {
    getAppScopedStatusFn.mockResolvedValue({ data: { isAppScoped: true } });

    const result = await getAppScopedStatusAction({ membershipId: "m" });

    expect(result).toEqual({ ok: true, data: { data: { isAppScoped: true } } });
    expect(getAppScopedStatusFn).toHaveBeenCalledWith("tenant-1", "m");
  });
});
