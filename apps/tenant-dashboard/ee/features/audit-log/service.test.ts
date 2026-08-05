/**
 * `ee/features/audit-log/service.ts` — the crossing to the `lib/adapters`
 * audit-log/entitlement bridge (the legacy `AuditLogViewerService` stays
 * shared, unmodified, with the platform-admin viewer) plus the shared
 * Enterprise `audit_log` entitlement gate every read (list, detail, export)
 * goes through first. `@/lib/adapters` is mocked; this pins the gate
 * short-circuit, the params each export forwards, and the CSV export's
 * filename/body assembly.
 */

const { getEntitlementFn, listEntriesFn, getEntryDetailFn, listForExportFn, csvFn } = vi.hoisted(() => ({
  getEntitlementFn: vi.fn(),
  listEntriesFn: vi.fn(),
  getEntryDetailFn: vi.fn(),
  listForExportFn: vi.fn(),
  csvFn: vi.fn(() => "timestamp_utc,action\r\n2026-07-01T00:00:00.000Z,member_role_changed\r\n"),
}));

vi.mock("@/lib/adapters", () => ({
  getEntitlement: getEntitlementFn,
  listAuditLogEntries: listEntriesFn,
  getAuditLogEntryDetail: getEntryDetailFn,
  listAuditLogEntriesForExport: listForExportFn,
  auditLogRowsToCsv: csvFn,
}));

import { listAuditLog, getAuditLogDetail, exportAuditLog } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
  getEntitlementFn.mockResolvedValue(true);
});

describe("entitlement gate", () => {
  it.each([
    ["listAuditLog", () => listAuditLog("tenant-1", {}), listEntriesFn],
    ["getAuditLogDetail", () => getAuditLogDetail("tenant-1", "log-1"), getEntryDetailFn],
    ["exportAuditLog", () => exportAuditLog("tenant-1"), listForExportFn],
  ])("%s denies without calling the service when the tenant lacks the audit_log entitlement", async (_name, invoke, fn) => {
    getEntitlementFn.mockResolvedValue(false);

    const result = await invoke();

    expect(result).toEqual({ error: "The audit log requires an Enterprise plan" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("checks the audit_log entitlement key for the given tenant", async () => {
    listEntriesFn.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 } });

    await listAuditLog("tenant-1", {});

    expect(getEntitlementFn).toHaveBeenCalledWith("tenant-1", "audit_log");
  });
});

describe("listAuditLog", () => {
  it("defaults page/pageSize and forwards filters + tenantId", async () => {
    listEntriesFn.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 } });

    await listAuditLog("tenant-1", { actionType: "member_role_changed", targetType: "membership" });

    expect(listEntriesFn).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      actionType: "member_role_changed",
      targetType: "membership",
      startDate: undefined,
      endDate: undefined,
      tenantId: "tenant-1",
    });
  });

  it("forwards explicit page/pageSize and date bounds unchanged", async () => {
    listEntriesFn.mockResolvedValue({ data: { items: [], total: 0, page: 2, pageSize: 10, totalPages: 0 } });

    await listAuditLog("tenant-1", {
      page: 2,
      pageSize: 10,
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-08T23:59:59.999Z",
    });

    expect(listEntriesFn).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 10, startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-07-08T23:59:59.999Z" })
    );
  });
});

describe("getAuditLogDetail", () => {
  it("scopes the detail read to the tenant", async () => {
    getEntryDetailFn.mockResolvedValue({ data: { id: "log-1" } });

    const result = await getAuditLogDetail("tenant-1", "log-1");

    expect(getEntryDetailFn).toHaveBeenCalledWith("log-1", { tenantId: "tenant-1" });
    expect(result).toEqual({ data: { id: "log-1" } });
  });
});

describe("exportAuditLog", () => {
  it("builds the CSV and a date-stamped filename from the export rows", async () => {
    listForExportFn.mockResolvedValue({ data: [{ id: "log-1" }] });

    const result = await exportAuditLog("tenant-1");

    expect(listForExportFn).toHaveBeenCalledWith("tenant-1");
    expect(csvFn).toHaveBeenCalledWith([{ id: "log-1" }]);
    expect(result.data?.csv).toContain("member_role_changed");
    expect(result.data?.filename).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("surfaces the export-read error instead of building a CSV", async () => {
    listForExportFn.mockResolvedValue({ error: "db unavailable" });

    const result = await exportAuditLog("tenant-1");

    expect(result).toEqual({ error: "db unavailable" });
    expect(csvFn).not.toHaveBeenCalled();
  });
});
