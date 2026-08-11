/**
 * AgentSessionsService — the adapter wiring itself (`service.ts`), isolated
 * from `@repo/observability-service`'s real span-tree/rollup logic (covered
 * by `service.test.ts`) and from the real PR-outcome/CH-query
 * implementations (covered by their own unit tests). This file pins the
 * shapes this adapter hands downstream: the resolved `SessionAccessPolicy`,
 * the `{tenantId, appId}` context passed to the package's service, and the
 * `PrOutcomeReader` port's branching between the single-trace (detail) and
 * multi-trace (list) PR-outcome read paths.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentSessionsPorts, SessionAccessPolicy } from "@repo/observability-service";

const mockGetSessionDetail = vi.fn(
  async (_ctx?: unknown, _traceId?: unknown, _policy?: unknown, _ports?: unknown) => null,
);
const mockListSessions = vi.fn(
  async (_ctx?: unknown, _query?: unknown, _policy?: unknown, _ports?: unknown) => ({
    sessions: [],
    total: 0,
    scope: "team" as const,
    actorNames: {},
  }),
);

vi.mock("@repo/observability-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@repo/observability-service")>();
  return {
    ...original,
    AgentSessionsService: vi.fn().mockImplementation(function AgentSessionsService(this: unknown) {
      return { getSessionDetail: mockGetSessionDetail, listSessions: mockListSessions };
    }),
  };
});

vi.mock("@/lib/analytics/client", () => ({
  createTenantReadClient: () => ({ marker: "ch-client" }),
}));

const { mockScope } = vi.hoisted(() => ({
  mockScope: { value: { kind: "team" } as { kind: "team" } | { kind: "self"; actorId: string | null } },
}));
vi.mock("./scope", async (importOriginal) => {
  const original = await importOriginal<typeof import("./scope")>();
  return {
    ...original,
    resolveAgentSessionScope: vi.fn(async () => mockScope.value),
  };
});

const mockTenantChQuery = vi.fn((_args: { tenantId: string; appId: string }): { marker: string } | null => ({
  marker: "ch-query",
}));
const mockFetchSessionOutcomeScores = vi.fn(
  async (
    _db: unknown,
    _chQuery: unknown,
    _args: { tenantId: string; appId: string; traceId: string },
  ): Promise<{ prNumber: number }[]> => [{ prNumber: 1 }],
);
const mockGetSessionListOutcomes = vi.fn(
  (_ctx: { tenantId: string; appId: string }, _db: unknown, _traces: { traceId: string }[]) =>
    ((_traceId: string) => ({ marker: "list-outcomes" })) as (traceId: string) => unknown,
);

vi.mock("@/lib/adapters", () => ({
  tenantChQuery: (args: { tenantId: string; appId: string }) => mockTenantChQuery(args),
  fetchSessionOutcomeScores: (
    db: unknown,
    chQuery: unknown,
    args: { tenantId: string; appId: string; traceId: string },
  ) => mockFetchSessionOutcomeScores(db, chQuery, args),
  getSessionListOutcomes: (
    ctx: { tenantId: string; appId: string },
    db: unknown,
    traces: { traceId: string }[],
  ) => mockGetSessionListOutcomes(ctx, db, traces),
}));

import { agentSessionsService, type AgentSessionsContext } from "./service";

const fakeDb = { marker: "supabase-db" } as unknown as SupabaseClient;

function ctx(overrides: { tenantId?: string; appId?: string } = {}): AgentSessionsContext {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    appId: "app-1",
    dataRetentionDays: -1,
    db: fakeDb,
    ...overrides,
  } as unknown as AgentSessionsContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScope.value = { kind: "team" };
  mockGetSessionDetail.mockResolvedValue(null);
  mockTenantChQuery.mockReturnValue({ marker: "ch-query" });
  mockFetchSessionOutcomeScores.mockResolvedValue([{ prNumber: 1 }]);
  mockGetSessionListOutcomes.mockReturnValue((_traceId: string) => ({ marker: "list-outcomes" }));
});

/** The `AgentSessionsPorts` object handed to the package's service on the last call. */
function lastPorts(mock: typeof mockGetSessionDetail | typeof mockListSessions): AgentSessionsPorts {
  const call = mock.mock.calls.at(-1) as [unknown, unknown, unknown, AgentSessionsPorts] | undefined;
  return call![3];
}

describe("resolvePolicy", () => {
  it("resolves team scope to the exact fixed dashboard-member/canSeeTeam policy", async () => {
    mockScope.value = { kind: "team" };
    await agentSessionsService.getSessionDetail(ctx(), "trace-1");
    const policy = mockGetSessionDetail.mock.calls[0]![2] as unknown as SessionAccessPolicy;
    expect(policy).toEqual({ kind: "dashboard-member", membershipId: "", canSeeTeam: true });
  });

  it("resolves self scope to the caller's membershipId with canSeeTeam false", async () => {
    mockScope.value = { kind: "self", actorId: "membership-1" };
    await agentSessionsService.getSessionDetail(ctx(), "trace-1");
    const policy = mockGetSessionDetail.mock.calls[0]![2] as unknown as SessionAccessPolicy;
    expect(policy).toEqual({ kind: "dashboard-member", membershipId: "membership-1", canSeeTeam: false });
  });

  it("resolves self scope with no membership row to the fail-closed sentinel", async () => {
    mockScope.value = { kind: "self", actorId: null };
    await agentSessionsService.getSessionDetail(ctx(), "trace-1");
    const policy = mockGetSessionDetail.mock.calls[0]![2] as unknown as SessionAccessPolicy;
    expect(policy).toEqual({ kind: "dashboard-member", membershipId: "__no_actor__", canSeeTeam: false });
  });
});

describe("getSessionDetail wiring", () => {
  it("passes exactly {tenantId, appId} — not the whole ctx — as the package service's context arg", async () => {
    await agentSessionsService.getSessionDetail(ctx({ tenantId: "t9", appId: "a9" }), "trace-9");
    expect(mockGetSessionDetail.mock.calls[0]![0]).toEqual({ tenantId: "t9", appId: "a9" });
    expect(mockGetSessionDetail.mock.calls[0]![1]).toBe("trace-9");
  });
});

describe("listSessions wiring", () => {
  it("passes exactly {tenantId, appId} as the package service's context arg", async () => {
    const query = { limit: 25, offset: 0, sort: "startedAt" as const, dir: "desc" as const };
    await agentSessionsService.listSessions(ctx({ tenantId: "t9", appId: "a9" }), query);
    expect(mockListSessions.mock.calls[0]![0]).toEqual({ tenantId: "t9", appId: "a9" });
    expect(mockListSessions.mock.calls[0]![1]).toBe(query);
  });
});

describe("PrOutcomeReader.forSessions (single trace — the detail-page path)", () => {
  it("looks up a CH query scoped to {tenantId, appId} and fetches outcome scores for exactly that one trace", async () => {
    await agentSessionsService.getSessionDetail(ctx({ tenantId: "t1", appId: "a1" }), "trace-1");
    const ports = lastPorts(mockGetSessionDetail);

    const result = await ports.prOutcomes.forSessions(["trace-1"]);

    expect(mockTenantChQuery).toHaveBeenCalledWith({ tenantId: "t1", appId: "a1" });
    expect(mockFetchSessionOutcomeScores).toHaveBeenCalledWith(fakeDb, { marker: "ch-query" }, {
      tenantId: "t1",
      appId: "a1",
      traceId: "trace-1",
    });
    expect(mockGetSessionListOutcomes).not.toHaveBeenCalled();
    // forSessions resolves to a thunk carrying the fetched outcomes, not the
    // outcomes array itself and not undefined.
    expect(typeof result).toBe("function");
    expect(result("trace-1")).toEqual([{ prNumber: 1 }]);
  });

  it("falls back to an empty outcomes list (not a throw) when the outcome-scores fetch rejects", async () => {
    mockFetchSessionOutcomeScores.mockRejectedValueOnce(new Error("clickhouse unavailable"));
    await agentSessionsService.getSessionDetail(ctx(), "trace-1");
    const ports = lastPorts(mockGetSessionDetail);

    const result = await ports.prOutcomes.forSessions(["trace-1"]);
    expect(result("trace-1")).toEqual([]);
  });

  it("skips the outcome-scores fetch entirely and reports no outcomes when no CH query is configured", async () => {
    mockTenantChQuery.mockReturnValueOnce(null);
    await agentSessionsService.getSessionDetail(ctx(), "trace-1");
    const ports = lastPorts(mockGetSessionDetail);

    const result = await ports.prOutcomes.forSessions(["trace-1"]);
    expect(mockFetchSessionOutcomeScores).not.toHaveBeenCalled();
    expect(result("trace-1")).toEqual([]);
  });
});

describe("PrOutcomeReader.forSessions (multiple traces — the list-page path)", () => {
  it("delegates to getSessionListOutcomes with the {tenantId, appId} ctx, db, and one {traceId} entry per trace", async () => {
    const query = { limit: 25, offset: 0, sort: "startedAt" as const, dir: "desc" as const };
    await agentSessionsService.listSessions(ctx({ tenantId: "t2", appId: "a2" }), query);
    const ports = lastPorts(mockListSessions);

    const result = await ports.prOutcomes.forSessions(["trace-a", "trace-b"]);

    expect(mockGetSessionListOutcomes).toHaveBeenCalledWith(
      { tenantId: "t2", appId: "a2" },
      fakeDb,
      [{ traceId: "trace-a" }, { traceId: "trace-b" }],
    );
    expect(mockTenantChQuery).not.toHaveBeenCalled();
    expect(mockFetchSessionOutcomeScores).not.toHaveBeenCalled();
    expect(result("trace-a")).toEqual({ marker: "list-outcomes" });
  });

  it("also takes the multi-trace path for zero traces (never the single-trace CH path)", async () => {
    const query = { limit: 25, offset: 0, sort: "startedAt" as const, dir: "desc" as const };
    await agentSessionsService.listSessions(ctx(), query);
    const ports = lastPorts(mockListSessions);

    await ports.prOutcomes.forSessions([]);
    expect(mockGetSessionListOutcomes).toHaveBeenCalledWith(expect.anything(), fakeDb, []);
    expect(mockTenantChQuery).not.toHaveBeenCalled();
  });
});
