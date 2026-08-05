/**
 * Unit tests for the audit-log actions. Runs the REAL `authorizedAction`
 * wrapper and the REAL action bodies; only the two seams beneath the wrapper
 * (`@/lib/adapters` context resolution + permission check) and the
 * `./service` crossing are mocked — proving the permission each action gates
 * on and the exact service call it makes. `listAuditLogAction` exists for
 * the shared `AuditLogTable`'s own client-driven fetches — the settings
 * page's initial paint calls `listAuditLog` (the plain function) directly.
 */

const {
  mockLoadCtx,
  mockCheckPerm,
  listAuditLogFn,
  getAuditLogDetailFn,
  exportAuditLogFn,
} = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  listAuditLogFn: vi.fn(),
  getAuditLogDetailFn: vi.fn(),
  exportAuditLogFn: vi.fn(),
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

vi.mock("./service", () => ({
  listAuditLog: listAuditLogFn,
  getAuditLogDetail: getAuditLogDetailFn,
  exportAuditLog: exportAuditLogFn,
}));

import { listAuditLogAction, getAuditLogDetailAction, exportAuditLogAction } from "./actions";

const ACTOR = { userId: "user-1", role: "admin" };
const CTX = { db: {}, tenantId: "tenant-1", actor: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
});

describe("actions — permission gate + service delegation", () => {
  it("listAuditLogAction gates on audit_log.read and forwards params + tenantId", async () => {
    listAuditLogFn.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 } });

    const result = await listAuditLogAction({ page: 2, actionType: "member_role_changed" });

    expect(result.ok).toBe(true);
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "audit_log.read", undefined);
    expect(listAuditLogFn).toHaveBeenCalledWith("tenant-1", {
      page: 2,
      pageSize: undefined,
      actionType: "member_role_changed",
      targetType: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it("getAuditLogDetailAction gates on audit_log.read and forwards the logId", async () => {
    getAuditLogDetailFn.mockResolvedValue({ data: { id: "log-1" } });

    const result = await getAuditLogDetailAction({ logId: "log-1" });

    expect(result).toEqual({ ok: true, data: { data: { id: "log-1" } } });
    expect(getAuditLogDetailFn).toHaveBeenCalledWith("tenant-1", "log-1");
  });

  it("exportAuditLogAction gates on audit_log.read and forwards the tenant", async () => {
    exportAuditLogFn.mockResolvedValue({ data: { csv: "...", filename: "audit-log-2026-07-01.csv" } });

    const result = await exportAuditLogAction({});

    expect(result).toEqual({ ok: true, data: { data: { csv: "...", filename: "audit-log-2026-07-01.csv" } } });
    expect(exportAuditLogFn).toHaveBeenCalledWith("tenant-1");
  });

  it.each([
    ["listAuditLogAction", () => listAuditLogAction({}), listAuditLogFn],
    ["getAuditLogDetailAction", () => getAuditLogDetailAction({ logId: "log-1" }), getAuditLogDetailFn],
    ["exportAuditLogAction", () => exportAuditLogAction({}), exportAuditLogFn],
  ])("%s denies without calling the service when the actor lacks audit_log.read", async (_name, invoke, fn) => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await invoke();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(fn).not.toHaveBeenCalled();
  });
});
