/**
 * `ee/features/custom-roles/service.ts` — the crossing to `CustomRoleService`.
 * `CustomRoleService` and the admin-client factory are mocked; this pins the
 * wiring — which service method each export calls, with the RLS-scoped
 * `ctx.db`, the confined `lib/system` admin client, and (for mutations) the
 * acting user's id threaded through, so `rbac_audit_log` rows carry actor
 * attribution.
 */

const { mockCtorArgs, getAllFn, getByIdFn, createFn, updateFn, deleteFn } = vi.hoisted(() => ({
  mockCtorArgs: vi.fn(),
  getAllFn: vi.fn(),
  getByIdFn: vi.fn(),
  createFn: vi.fn(),
  updateFn: vi.fn(),
  deleteFn: vi.fn(),
}));

vi.mock("./custom-role-service", () => ({
  CustomRoleService: vi.fn().mockImplementation(function (args: unknown) {
    mockCtorArgs(args);
    return { getAll: getAllFn, getById: getByIdFn, create: createFn, update: updateFn, delete: deleteFn };
  }),
}));

const ADMIN_CLIENT = { from: vi.fn(), __marker: "admin" };
vi.mock("@/lib/system/admin-client", () => ({
  getAdminDataClient: vi.fn(() => ADMIN_CLIENT),
}));

import {
  listCustomRoles,
  getCustomRole,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
} from "./service";

const DB = { from: vi.fn(), __marker: "rls-scoped" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCustomRoles", () => {
  it("constructs the service with ctx.db + the admin client, no actorId, and calls getAll", async () => {
    getAllFn.mockResolvedValue({ success: true, data: [] });

    await listCustomRoles(DB, "tenant-1");

    expect(mockCtorArgs).toHaveBeenCalledWith({ db: DB, adminDb: ADMIN_CLIENT, actorId: undefined });
    expect(getAllFn).toHaveBeenCalledWith("tenant-1");
  });
});

describe("getCustomRole", () => {
  it("calls getById with the tenant and role id", async () => {
    getByIdFn.mockResolvedValue({ success: true, data: { id: "cr-1" } });

    await getCustomRole(DB, "tenant-1", "cr-1");

    expect(getByIdFn).toHaveBeenCalledWith("tenant-1", "cr-1");
  });
});

describe("createCustomRole", () => {
  it("threads the actor id into the service constructor so audit rows attribute it", async () => {
    createFn.mockResolvedValue({ success: true, data: { id: "cr-new" } });

    await createCustomRole(DB, "tenant-1", "user-1", { name: "Reviewer", permissions: ["app.read"] });

    expect(mockCtorArgs).toHaveBeenCalledWith({ db: DB, adminDb: ADMIN_CLIENT, actorId: "user-1" });
    expect(createFn).toHaveBeenCalledWith("tenant-1", { name: "Reviewer", permissions: ["app.read"] });
  });
});

describe("updateCustomRole", () => {
  it("threads the actor id and forwards the role id + partial input", async () => {
    updateFn.mockResolvedValue({ success: true, data: {} });

    await updateCustomRole(DB, "tenant-1", "user-1", "cr-1", { name: "Reviewer" });

    expect(mockCtorArgs).toHaveBeenCalledWith({ db: DB, adminDb: ADMIN_CLIENT, actorId: "user-1" });
    expect(updateFn).toHaveBeenCalledWith("tenant-1", "cr-1", { name: "Reviewer" });
  });
});

describe("deleteCustomRole", () => {
  it("threads the actor id and forwards the role id + fallback role", async () => {
    deleteFn.mockResolvedValue({ success: true, data: {} });

    await deleteCustomRole(DB, "tenant-1", "user-1", "cr-1", "read");

    expect(mockCtorArgs).toHaveBeenCalledWith({ db: DB, adminDb: ADMIN_CLIENT, actorId: "user-1" });
    expect(deleteFn).toHaveBeenCalledWith("tenant-1", "cr-1", "read");
  });
});
