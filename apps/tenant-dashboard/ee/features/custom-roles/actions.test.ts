/**
 * Unit tests for the custom-role actions. Runs the REAL `authorizedAction`
 * wrapper and the REAL action bodies; only the two seams beneath the wrapper
 * (`@/lib/adapters` context resolution + permission check) and the `./service`
 * crossing are mocked — proving the permission each action gates on, the
 * exact service call it makes, and the result envelope the wrapper returns
 * for allow / deny / business failure.
 */

const {
  mockLoadCtx,
  mockCheckPerm,
  listCustomRolesFn,
  getCustomRoleFn,
  createCustomRoleFn,
  updateCustomRoleFn,
  deleteCustomRoleFn,
} = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  listCustomRolesFn: vi.fn(),
  getCustomRoleFn: vi.fn(),
  createCustomRoleFn: vi.fn(),
  updateCustomRoleFn: vi.fn(),
  deleteCustomRoleFn: vi.fn(),
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

vi.mock("./service", () => ({
  listCustomRoles: listCustomRolesFn,
  getCustomRole: getCustomRoleFn,
  createCustomRole: createCustomRoleFn,
  updateCustomRole: updateCustomRoleFn,
  deleteCustomRole: deleteCustomRoleFn,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  listCustomRolesAction,
  getCustomRoleAction,
  createCustomRoleAction,
  updateCustomRoleAction,
  deleteCustomRoleAction,
} from "./actions";

const ACTOR = { userId: "user-1", role: "admin" };
const CTX = { db: {}, tenantId: "tenant-1", actor: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe("listCustomRolesAction", () => {
  it("gates on custom_role.read and forwards ctx.db + tenantId to the service", async () => {
    listCustomRolesFn.mockResolvedValue({ success: true, data: [{ id: "cr-1" }] });

    const result = await listCustomRolesAction({});

    expect(result).toEqual({ ok: true, data: { success: true, data: [{ id: "cr-1" }] } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "custom_role.read", undefined);
    expect(listCustomRolesFn).toHaveBeenCalledWith(CTX.db, "tenant-1");
  });

  it("denies without calling the service when the actor lacks custom_role.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await listCustomRolesAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(listCustomRolesFn).not.toHaveBeenCalled();
  });
});

describe("getCustomRoleAction", () => {
  it("gates on custom_role.read and forwards the roleId", async () => {
    getCustomRoleFn.mockResolvedValue({ success: true, data: { id: "cr-1", name: "Editor" } });

    const result = await getCustomRoleAction({ roleId: "cr-1" });

    expect(result).toEqual({ ok: true, data: { success: true, data: { id: "cr-1", name: "Editor" } } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "custom_role.read", undefined);
    expect(getCustomRoleFn).toHaveBeenCalledWith(CTX.db, "tenant-1", "cr-1");
  });

  it("rejects invalid input before resolving context or calling the service", async () => {
    const result = await getCustomRoleAction({ roleId: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(getCustomRoleFn).not.toHaveBeenCalled();
  });
});

describe("createCustomRoleAction", () => {
  it("gates on custom_role.insert and forwards the actor id + structured input", async () => {
    createCustomRoleFn.mockResolvedValue({ success: true, data: { id: "cr-new" } });

    const result = await createCustomRoleAction({
      name: "Reviewer",
      description: "Can review",
      permissions: ["app.read", "app.update"],
    });

    expect(result).toEqual({ ok: true, data: { success: true, data: { id: "cr-new" } } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "custom_role.insert", undefined);
    expect(createCustomRoleFn).toHaveBeenCalledWith(CTX.db, "tenant-1", "user-1", {
      name: "Reviewer",
      description: "Can review",
      permissions: ["app.read", "app.update"],
    });
  });

  it("surfaces the service error unchanged, without revalidating", async () => {
    const { revalidatePath } = await import("next/cache");
    createCustomRoleFn.mockResolvedValue({ success: false, error: "name taken" });

    const result = await createCustomRoleAction({ name: "Reviewer", permissions: ["app.read"] });

    expect(result).toEqual({ ok: true, data: { success: false, error: "name taken" } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("denies without calling the service when the actor lacks custom_role.insert", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await createCustomRoleAction({ name: "Reviewer", permissions: ["app.read"] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(createCustomRoleFn).not.toHaveBeenCalled();
  });
});

describe("updateCustomRoleAction", () => {
  it("gates on custom_role.update and forwards the roleId + partial input", async () => {
    updateCustomRoleFn.mockResolvedValue({ success: true, data: {} });

    const result = await updateCustomRoleAction({
      roleId: "cr-1",
      name: "Reviewer",
      description: "desc",
      permissions: ["app.read"],
    });

    expect(result).toEqual({ ok: true, data: { success: true, data: {} } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "custom_role.update", undefined);
    expect(updateCustomRoleFn).toHaveBeenCalledWith(CTX.db, "tenant-1", "user-1", "cr-1", {
      name: "Reviewer",
      description: "desc",
      permissions: ["app.read"],
    });
  });

  it("surfaces the service error unchanged", async () => {
    updateCustomRoleFn.mockResolvedValue({ success: false, error: "locked" });

    const result = await updateCustomRoleAction({ roleId: "cr-1" });

    expect(result).toEqual({ ok: true, data: { success: false, error: "locked" } });
  });
});

describe("deleteCustomRoleAction", () => {
  it("gates on custom_role.delete and forwards the roleId + fallback role", async () => {
    deleteCustomRoleFn.mockResolvedValue({ success: true, data: {} });

    const result = await deleteCustomRoleAction({ roleId: "cr-1", fallbackRole: "read" });

    expect(result).toEqual({ ok: true, data: { success: true, data: {} } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "custom_role.delete", undefined);
    expect(deleteCustomRoleFn).toHaveBeenCalledWith(CTX.db, "tenant-1", "user-1", "cr-1", "read");
  });

  it("works without a fallback role (undefined passed through)", async () => {
    deleteCustomRoleFn.mockResolvedValue({ success: true, data: {} });

    await deleteCustomRoleAction({ roleId: "cr-1" });

    expect(deleteCustomRoleFn).toHaveBeenCalledWith(CTX.db, "tenant-1", "user-1", "cr-1", undefined);
  });

  it("surfaces the service error unchanged, without revalidating", async () => {
    const { revalidatePath } = await import("next/cache");
    deleteCustomRoleFn.mockResolvedValue({ success: false, error: "role in use" });

    const result = await deleteCustomRoleAction({ roleId: "cr-1" });

    expect(result).toEqual({ ok: true, data: { success: false, error: "role in use" } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("denies without calling the service when the actor lacks custom_role.delete", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await deleteCustomRoleAction({ roleId: "cr-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(deleteCustomRoleFn).not.toHaveBeenCalled();
  });
});
