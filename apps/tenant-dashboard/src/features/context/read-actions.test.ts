/**
 * Unit tests for the context read actions — the `// live:` revalidation door the
 * SWR hooks call after first paint. These run the REAL `authorizedAction`
 * wrapper and the REAL action bodies; only the two seams beneath the wrapper
 * (`@/lib/adapters` context resolution + permission check) and the service layer
 * (`./service`) are mocked. That proves the wiring each action owns: the app-id
 * it narrows the permission check to, the exact service call it makes, and the
 * result envelope the wrapper returns for allow / deny / throw / invalid-input.
 */
import { getSkillAdoption, getSkillDrilldown, getMcpAdoption, getMcpDrilldown } from "./service";

const { mockLoadCtx, mockCheckPerm, treeFn, fileFn, syncHistoryFn, ctorArgs } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  treeFn: vi.fn(),
  fileFn: vi.fn(),
  syncHistoryFn: vi.fn(),
  ctorArgs: [] as unknown[],
}));

vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

// The service is the layer BELOW these actions — mocked so each action's call
// (args + which method) is assertable; the mirror/ClickHouse reads themselves
// are covered by service.test.ts.
vi.mock("./service", () => ({
  ContextReadService: class {
    getTree = treeFn;
    getFile = fileFn;
    getSyncHistory = syncHistoryFn;
    constructor(db: unknown) {
      ctorArgs.push(db);
    }
  },
  getSkillAdoption: vi.fn(),
  getSkillDrilldown: vi.fn(),
  getMcpAdoption: vi.fn(),
  getMcpDrilldown: vi.fn(),
}));

import {
  getContextTree,
  getContextFile,
  getContextSkillAdoption,
  getContextSkillDrilldown,
  getContextMcpAdoption,
  getContextMcpDrilldown,
  getContextSyncHistory,
} from "./read-actions";

// Sentinel context: `db` is an opaque object the mocked service records but
// never queries; `actor` and `tenantId` are what the actions must pass through.
const DB = { from: () => ({}) };
const ACTOR = { userId: "user-1", role: "admin" };
const CTX = { db: DB, tenantId: "tenant-1", actor: ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  ctorArgs.length = 0;
  mockLoadCtx.mockResolvedValue(CTX);
  mockCheckPerm.mockResolvedValue(true);
  treeFn.mockResolvedValue({ tree: true });
  fileFn.mockResolvedValue({ file: true });
  syncHistoryFn.mockResolvedValue({ rows: [], total: 0 });
  vi.mocked(getSkillAdoption).mockResolvedValue({ skills: [], recentDays: 14, lookbackDays: 90 });
  vi.mocked(getSkillDrilldown).mockResolvedValue({ trend: [], sessions: [], topics: [], lookbackDays: 90 });
  vi.mocked(getMcpAdoption).mockResolvedValue({ servers: [], recentDays: 14, lookbackDays: 90 });
  vi.mocked(getMcpDrilldown).mockResolvedValue({ tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 });
});

describe("getContextTree", () => {
  it("gates on context.read for the input app and returns the service tree wrapped in ok", async () => {
    const result = await getContextTree({ appId: "app-1", snapshotId: "snap-9" });

    expect(result).toEqual({ ok: true, data: { tree: true } });
    // The permission check is narrowed to the input app id (the appId extractor).
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    // The service runs on the resolved request client, with the parsed args.
    expect(ctorArgs).toEqual([DB]);
    expect(treeFn).toHaveBeenCalledWith("app-1", "snap-9");
  });
});

describe("getContextFile", () => {
  it("passes the path through and wraps the file in ok (snapshotId defaults undefined)", async () => {
    const result = await getContextFile({ appId: "app-1", path: ".outerlayer/AGENTS.md" });

    expect(result).toEqual({ ok: true, data: { file: true } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(fileFn).toHaveBeenCalledWith("app-1", ".outerlayer/AGENTS.md", undefined);
  });

  it("maps a service throw to a non-leaking internal_error result", async () => {
    fileFn.mockRejectedValue(new Error("context file not found in snapshot: gone.md"));

    const result = await getContextFile({ appId: "app-1", path: "gone.md" });

    expect(result).toEqual({
      ok: false,
      error: { code: "internal_error", message: "context file not found in snapshot: gone.md" },
    });
  });
});

describe("getContextSkillAdoption", () => {
  it("reads the skill overlay for the resolved tenant + input app", async () => {
    const overlay = { skills: [{ skillName: "writing", recentActivations: 3, totalActivations: 9, totalSessions: 4, lastActivatedAt: null }], recentDays: 14, lookbackDays: 90 };
    vi.mocked(getSkillAdoption).mockResolvedValue(overlay);

    const result = await getContextSkillAdoption({ appId: "app-1" });

    expect(result).toEqual({ ok: true, data: overlay });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(getSkillAdoption).toHaveBeenCalledWith({ tenantId: "tenant-1", appId: "app-1" });
  });
});

describe("getContextSkillDrilldown", () => {
  it("passes the skill through to the drill-down read, scoped to the resolved tenant", async () => {
    const result = await getContextSkillDrilldown({ appId: "app-1", skill: "writing" });

    expect(result).toEqual({ ok: true, data: { trend: [], sessions: [], topics: [], lookbackDays: 90 } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(getSkillDrilldown).toHaveBeenCalledWith({ tenantId: "tenant-1", appId: "app-1", skill: "writing" });
  });
});

describe("getContextMcpAdoption", () => {
  it("reads the mcp overlay for the resolved tenant + input app", async () => {
    const result = await getContextMcpAdoption({ appId: "app-1" });

    expect(result).toEqual({ ok: true, data: { servers: [], recentDays: 14, lookbackDays: 90 } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(getMcpAdoption).toHaveBeenCalledWith({ tenantId: "tenant-1", appId: "app-1" });
  });
});

describe("getContextMcpDrilldown", () => {
  it("passes the server through to the drill-down read, scoped to the resolved tenant", async () => {
    const result = await getContextMcpDrilldown({ appId: "app-1", server: "playwright" });

    expect(result).toEqual({ ok: true, data: { tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 } });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(getMcpDrilldown).toHaveBeenCalledWith({ tenantId: "tenant-1", appId: "app-1", server: "playwright" });
  });
});

describe("getContextSyncHistory", () => {
  it("gates on context.read for the input app and passes the exact page/pageSize through", async () => {
    const page = { rows: [{ id: "evt-1" }], total: 3 };
    syncHistoryFn.mockResolvedValue(page);

    const result = await getContextSyncHistory({ appId: "app-1", page: 1, pageSize: 20 });

    expect(result).toEqual({ ok: true, data: page });
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, "context.read", "app-1");
    expect(ctorArgs).toEqual([DB]);
    expect(syncHistoryFn).toHaveBeenCalledWith("app-1", 1, 20);
  });

  it("rejects a negative page or a non-positive page size before the service runs", async () => {
    const result = await getContextSyncHistory({ appId: "app-1", page: -1, pageSize: 20 });

    expect(result.ok).toBe(false);
    expect(syncHistoryFn).not.toHaveBeenCalled();
  });
});

describe("fail-closed authorization", () => {
  it("denies with forbidden and never runs the service when the permission check fails", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await getContextTree({ appId: "app-1" });

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: context.read" },
    });
    expect(treeFn).not.toHaveBeenCalled();
  });
});

describe("input validation", () => {
  it("rejects an empty appId as validation_error before resolving context or reading", async () => {
    const result = await getContextTree({ appId: "" });

    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error.code).toBe("validation_error");
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(mockCheckPerm).not.toHaveBeenCalled();
    expect(treeFn).not.toHaveBeenCalled();
  });
});
