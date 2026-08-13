/**
 * `ee/features/app-access/service.ts` — the crossing to `AppMemberRoleService`
 * plus the three `lib/system` admin reads. `AppMemberRoleService` and the
 * admin-client factory are mocked; this pins the wiring — which service
 * method each mutation calls, with the confined `lib/system` admin client
 * and the acting user's id threaded through so `rbac_audit_log` rows carry
 * actor attribution — and which `lib/system` read function each read export
 * delegates to.
 */

const {
  mockCtorArgs,
  assignFn,
  updateRoleFn,
  assignCustomRoleFn,
  updateCustomRoleFn,
  revokeFn,
  setAppScopedFn,
  bulkAssignFn,
  ADMIN_CLIENT,
  listAppMemberRolesFn,
  listAppsForDropdownFn,
  getMembershipAppScopedFn,
} = vi.hoisted(() => ({
  mockCtorArgs: vi.fn(),
  assignFn: vi.fn(),
  updateRoleFn: vi.fn(),
  assignCustomRoleFn: vi.fn(),
  updateCustomRoleFn: vi.fn(),
  revokeFn: vi.fn(),
  setAppScopedFn: vi.fn(),
  bulkAssignFn: vi.fn(),
  ADMIN_CLIENT: { from: vi.fn(), __marker: "admin" },
  listAppMemberRolesFn: vi.fn(),
  listAppsForDropdownFn: vi.fn(),
  getMembershipAppScopedFn: vi.fn(),
}));

vi.mock("./app-member-role-service", () => ({
  AppMemberRoleService: vi.fn().mockImplementation(function (args: unknown) {
    mockCtorArgs(args);
    return {
      assign: assignFn,
      updateRole: updateRoleFn,
      assignCustomRole: assignCustomRoleFn,
      updateCustomRole: updateCustomRoleFn,
      revoke: revokeFn,
      setAppScoped: setAppScopedFn,
      bulkAssign: bulkAssignFn,
    };
  }),
}));

vi.mock("@/lib/system/admin-client", () => ({
  getAdminDataClient: vi.fn(() => ADMIN_CLIENT),
}));

vi.mock("@/lib/system", () => ({
  listAppMemberRoles: listAppMemberRolesFn,
  listAppsForDropdown: listAppsForDropdownFn,
  getMembershipAppScoped: getMembershipAppScopedFn,
}));

import {
  assignAppRole,
  updateAppRole,
  assignAppCustomRole,
  updateAppCustomRole,
  revokeAppRole,
  setAppScoped,
  bulkAssignAppRoles,
  listAppRoles,
  listApps,
  getAppScopedStatus,
} from "./service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mutations", () => {
  it("assignAppRole threads the actor id into the service constructor and calls assign", async () => {
    assignFn.mockResolvedValue({ success: true, data: {} });

    await assignAppRole("tenant-1", "user-1", "m", "p", "read");

    expect(mockCtorArgs).toHaveBeenCalledWith({ db: ADMIN_CLIENT, actorId: "user-1" });
    expect(assignFn).toHaveBeenCalledWith("tenant-1", { membershipId: "m", appId: "p", role: "read" });
  });

  it("updateAppRole calls updateRole", async () => {
    updateRoleFn.mockResolvedValue({ success: true, data: {} });

    await updateAppRole("tenant-1", "user-1", "a", "write");

    expect(updateRoleFn).toHaveBeenCalledWith("tenant-1", "a", "write");
  });

  // proves AC-074-04
  it("assignAppCustomRole calls assignCustomRole with the built-in role defaulted to read", async () => {
    assignCustomRoleFn.mockResolvedValue({ success: true, data: {} });

    await assignAppCustomRole("tenant-1", "user-1", "m", "p", "cr-1");

    expect(assignCustomRoleFn).toHaveBeenCalledWith("tenant-1", {
      membershipId: "m",
      appId: "p",
      role: "read",
      customRoleId: "cr-1",
    });
  });

  it("updateAppCustomRole calls updateCustomRole", async () => {
    updateCustomRoleFn.mockResolvedValue({ success: true, data: {} });

    await updateAppCustomRole("tenant-1", "user-1", "a", "cr-1");

    expect(updateCustomRoleFn).toHaveBeenCalledWith("tenant-1", "a", "cr-1");
  });

  it("revokeAppRole calls revoke", async () => {
    revokeFn.mockResolvedValue({ success: true, data: { success: true } });

    await revokeAppRole("tenant-1", "user-1", "a");

    expect(revokeFn).toHaveBeenCalledWith("tenant-1", "a");
  });

  // proves AC-074-07
  it("setAppScoped calls setAppScoped", async () => {
    setAppScopedFn.mockResolvedValue({ success: true, data: { isAppScoped: true } });

    await setAppScoped("tenant-1", "user-1", "m", true);

    expect(setAppScopedFn).toHaveBeenCalledWith("tenant-1", "m", true);
  });

  it("bulkAssignAppRoles calls bulkAssign", async () => {
    bulkAssignFn.mockResolvedValue({ success: true, data: { created: 1, errors: [] } });

    await bulkAssignAppRoles("tenant-1", "user-1", "m", [{ appId: "p", role: "read" }]);

    expect(bulkAssignFn).toHaveBeenCalledWith("tenant-1", { membershipId: "m", assignments: [{ appId: "p", role: "read" }] });
  });
});

describe("reads", () => {
  it("listAppRoles delegates to lib/system's listAppMemberRoles", async () => {
    listAppMemberRolesFn.mockResolvedValue({ data: [] });

    await listAppRoles("tenant-1", { appId: "p" });

    expect(listAppMemberRolesFn).toHaveBeenCalledWith("tenant-1", { appId: "p" });
  });

  it("listApps delegates to lib/system's listAppsForDropdown", async () => {
    listAppsForDropdownFn.mockResolvedValue({ data: [] });

    await listApps("tenant-1");

    expect(listAppsForDropdownFn).toHaveBeenCalledWith("tenant-1");
  });

  it("getAppScopedStatus delegates to lib/system's getMembershipAppScoped", async () => {
    getMembershipAppScopedFn.mockResolvedValue({ data: { isAppScoped: false } });

    await getAppScopedStatus("tenant-1", "m");

    expect(getMembershipAppScopedFn).toHaveBeenCalledWith("tenant-1", "m");
  });
});
