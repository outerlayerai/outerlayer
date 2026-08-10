/**
 * GET /api/cron/pr-session-reconcile — the sweep trigger.
 *
 * The route is thin: authenticate the cron bearer, clamp the windows,
 * delegate to runPrSessionSweep then runOutcomeScoresSweep (mocked seams —
 * their logic is tested in reconciler.test.ts / emit.test.ts), refresh the
 * GitHub comment for each PR the sweep's `changed` set names (the
 * gap-repair path — refreshPrSessionComment is mocked here too, its own
 * logic is tested in refresh.test.ts), and map the results to a status. Pins the
 * auth gate, the clamp bounds, the reconcile-before-emit order, the skipped
 * paths, the error → 500 map, and that an unchanged sweep refreshes nothing.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

beforeAll(() => {
  if (typeof Response.json !== "function") {
    (Response as unknown as Record<string, unknown>).json = (data: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(data), {
        ...init,
        headers: { ...((init as Record<string, unknown>)?.["headers"] ?? {}), "content-type": "application/json" },
      });
  }
});

const mockSweep = vi.hoisted(() => vi.fn());
const mockOutcomeSweep = vi.hoisted(() => vi.fn());
const mockRefreshComment = vi.hoisted(() => vi.fn());

vi.mock("@/config-global.server", () => ({
  CRON_SECRET: "test-cron-secret",
}));

vi.mock("@/lib/system/pr-session-reconciler", () => ({
  runPrSessionSweep: mockSweep,
}));

vi.mock("@/lib/system/outcome-scores", () => ({
  runOutcomeScoresSweep: mockOutcomeSweep,
}));

vi.mock("@/lib/system/pr-session-comment", () => ({
  refreshPrSessionComment: mockRefreshComment,
}));

/**
 * In-memory stand-in for the `pr_session_comment` backlog table.
 *
 * The route reads flagged rows, flags whatever it defers or fails, and clears
 * what it refreshed — the durable half of "a deferred PR is delayed, not
 * dropped". Only the three query shapes the route issues are supported, and
 * each write is recorded so a test can assert on the backlog itself rather
 * than on the response body alone.
 */
const backlog = vi.hoisted(() => ({
  rows: [] as { id: string; tenant_id: string; repository: string; pr_number: number }[],
  upserted: [] as Record<string, unknown>[][],
  cleared: [] as string[][],
  readError: null as { message: string } | null,
}));

const mockAdmin = vi.hoisted(() => ({
  from: () => ({
    select: () => {
      const builder = {
        eq: () => builder,
        order: () => builder,
        limit: async () => ({
          data: backlog.readError ? null : backlog.rows,
          error: backlog.readError,
        }),
      };
      return builder;
    },
    upsert: async (rows: Record<string, unknown>[]) => {
      backlog.upserted.push(rows);
      return { error: null };
    },
    update: () => ({
      in: async (_column: string, ids: string[]) => {
        backlog.cleared.push(ids);
        return { error: null };
      },
    }),
  }),
}));

vi.mock("@/lib/system/admin-client", () => ({
  getAdminDataClient: () => mockAdmin,
}));

const mockLoggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: mockLoggerError, info: vi.fn() },
}));

import { GET } from "../route";

const COUNTS = { candidates: 3, linked: 2, confirmed: 1, pending: 1, unmatched: 0 };
const OUTCOME_COUNTS = { skipped: false, apps: 1, prs: 2, scoreRows: 6 };
const CHANGED = [{ tenantId: "tenant-1", repository: "acme/api", prNumber: 42 }];

function cronRequest(query = "", token = "test-cron-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/pr-session-reconcile${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backlog.rows = [];
  backlog.upserted = [];
  backlog.cleared = [];
  backlog.readError = null;
  mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: [] });
  mockOutcomeSweep.mockResolvedValue(OUTCOME_COUNTS);
  mockRefreshComment.mockResolvedValue({ status: "unchanged", commentId: 1 });
});

describe("GET /api/cron/pr-session-reconcile", () => {
  it("rejects a wrong bearer with 401 before any work", async () => {
    const res = await GET(cronRequest("", "wrong"));
    expect(res.status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("rejects a missing authorization header with 401", async () => {
    const res = await GET(cronRequest("", ""));
    expect(res.status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("defaults the window to 24 ingest-hours and returns both sweeps' counts", async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith({ sinceHours: 24 });
    expect(mockOutcomeSweep).toHaveBeenCalledWith({ sinceHours: 24 });
    expect(await res.json()).toEqual({
      sinceHours: 24,
      ...COUNTS,
      outcomeScores: { emitSinceHours: 24, ...OUTCOME_COUNTS },
      commentRefresh: { attempted: 0, failed: 0, deferred: 0, fromBacklog: 0 },
    });
    // Emission runs AFTER reconciliation so links confirmed this tick emit
    // this tick.
    expect(mockOutcomeSweep.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockSweep.mock.invocationCallOrder[0]!,
    );
  });

  it("clamps emitSinceHours to [1, 8760] independently of the reconcile window", async () => {
    await GET(cronRequest("?emitSinceHours=8760"));
    expect(mockSweep).toHaveBeenLastCalledWith({ sinceHours: 24 });
    expect(mockOutcomeSweep).toHaveBeenLastCalledWith({ sinceHours: 8760 });
    await GET(cronRequest("?emitSinceHours=99999"));
    expect(mockOutcomeSweep).toHaveBeenLastCalledWith({ sinceHours: 8760 });
    await GET(cronRequest("?sinceHours=48"));
    expect(mockOutcomeSweep).toHaveBeenLastCalledWith({ sinceHours: 48 });
  });

  it("reports an outcome-sweep skip without hiding the reconcile counts", async () => {
    mockOutcomeSweep.mockResolvedValue({ skipped: true });
    const res = await GET(cronRequest());
    expect(await res.json()).toEqual({
      sinceHours: 24,
      ...COUNTS,
      outcomeScores: { skipped: true },
      commentRefresh: { attempted: 0, failed: 0, deferred: 0, fromBacklog: 0 },
    });
  });

  it("clamps sinceHours to [1, 720] and treats junk as the default", async () => {
    await GET(cronRequest("?sinceHours=9999"));
    expect(mockSweep).toHaveBeenLastCalledWith({ sinceHours: 720 });
    await GET(cronRequest("?sinceHours=0"));
    expect(mockSweep).toHaveBeenLastCalledWith({ sinceHours: 1 });
    await GET(cronRequest("?sinceHours=72"));
    expect(mockSweep).toHaveBeenLastCalledWith({ sinceHours: 72 });
    await GET(cronRequest("?sinceHours=abc"));
    expect(mockSweep).toHaveBeenLastCalledWith({ sinceHours: 24 });
  });

  it("maps a clickhouse-less deployment to a skipped body and runs no emission", async () => {
    mockSweep.mockResolvedValue({ skipped: true });
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: "clickhouse not configured" });
    expect(mockOutcomeSweep).not.toHaveBeenCalled();
  });

  it("maps a sweep failure to 500 with the message", async () => {
    mockSweep.mockRejectedValue(new Error("boom"));
    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(mockOutcomeSweep).not.toHaveBeenCalled();
  });

  // Scores are best-effort telemetry, and they run BEFORE the comment
  // refresh. A throw there used to take the whole tick down — including the
  // refresh — AFTER the sweep had already persisted the links, and since the
  // sweep's `changed` set is edge-triggered, that tick's refresh work was
  // then gone for good. The failure is reported now, not fatal.
  it("reports an outcome-sweep failure without costing the tick its comment refreshes", async () => {
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: CHANGED });
    mockOutcomeSweep.mockRejectedValue(new Error("insert failed"));

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcomeScores: { error: "insert failed" },
      commentRefresh: { attempted: 1, failed: 0 },
    });
    expect(mockRefreshComment).toHaveBeenCalledWith(CHANGED[0]);
  });

  it("refreshes nothing when the sweep's changed set is empty — an unchanged tick costs zero GitHub reads", async () => {
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: [] });
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(mockRefreshComment).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ commentRefresh: { attempted: 0, failed: 0 } });
  });

  it("refreshes exactly the PRs the sweep's changed set names, with the (tenantId, repository, prNumber) it resolved", async () => {
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: CHANGED });
    const res = await GET(cronRequest());
    expect(mockRefreshComment).toHaveBeenCalledTimes(1);
    expect(mockRefreshComment).toHaveBeenCalledWith(CHANGED[0]);
    expect(await res.json()).toMatchObject({ commentRefresh: { attempted: 1, failed: 0 } });
  });

  it("does not abort the sweep response when a refresh fails or throws", async () => {
    const target2 = { tenantId: "tenant-1", repository: "acme/api", prNumber: 43 };
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: [CHANGED[0]!, target2] });
    mockRefreshComment
      .mockResolvedValueOnce({ status: "failed", reason: "boom" })
      .mockRejectedValueOnce(new Error("unexpected throw"));
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(mockRefreshComment).toHaveBeenCalledTimes(2);
    expect(await res.json()).toMatchObject({ commentRefresh: { attempted: 2, failed: 2 } });
  });

  // The sweep can name more PRs than one tick should spend on GitHub, so the
  // batch is capped. The ORDER it caps by has to be a stable total order —
  // otherwise successive ticks re-attempt an arbitrary prefix and the tail of
  // a large backlog is never reached at all.
  it("caps the tick and works through a deterministic order, reporting the remainder as deferred", async () => {
    // 152 targets over the 150 cap, handed over deliberately shuffled.
    const targets = Array.from({ length: 152 }, (_, i) => ({
      tenantId: i % 2 === 0 ? "tenant-a" : "tenant-b",
      repository: i % 3 === 0 ? "acme/api" : "acme/web",
      prNumber: 1000 + i,
    }));
    const shuffled = [...targets].reverse();
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: shuffled });
    mockRefreshComment.mockResolvedValue({ status: "updated", commentId: 1 });

    const res = await GET(cronRequest());

    expect(await res.json()).toMatchObject({
      commentRefresh: { attempted: 150, failed: 0, deferred: 2 },
    });
    expect(mockRefreshComment).toHaveBeenCalledTimes(150);

    // The 150 attempted are the first 150 of the sorted order — by tenant,
    // then repository, then PR number — regardless of the order the sweep
    // handed them over in.
    const expectedOrder = [...targets].sort(
      (a, b) =>
        a.tenantId.localeCompare(b.tenantId) ||
        a.repository.localeCompare(b.repository) ||
        a.prNumber - b.prNumber,
    );
    const attempted = mockRefreshComment.mock.calls.map((c) => c[0]);
    // Execution is grouped per repository, so compare as sets of keys against
    // the deterministic prefix — the CAP must select those exact 150.
    const key = (t: { tenantId: string; repository: string; prNumber: number }) =>
      `${t.tenantId}|${t.repository}|${t.prNumber}`;
    expect(new Set(attempted.map(key))).toEqual(new Set(expectedOrder.slice(0, 150).map(key)));
    // ...and the two it deferred are the last two of that same order, so the
    // next tick picks up exactly where this one stopped.
    const deferredKeys = expectedOrder.slice(150).map(key);
    for (const k of deferredKeys) {
      expect(attempted.map(key)).not.toContain(k);
    }
  });

  // The cap is only a delay if something REMEMBERS the tail. `changed` is
  // edge-triggered — next tick those links compare equal and vanish from it —
  // so a deferred PR that isn't written down is a PR that never gets its
  // comment.
  it("writes the deferred tail to the backlog instead of dropping it", async () => {
    const targets = Array.from({ length: 152 }, (_, i) => ({
      tenantId: "tenant-a",
      repository: "acme/api",
      prNumber: 1000 + i,
    }));
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: targets });
    mockRefreshComment.mockResolvedValue({ status: "updated", commentId: 1 });

    await GET(cronRequest());

    const flagged = backlog.upserted.flat();
    expect(flagged).toHaveLength(2);
    expect(flagged).toEqual([
      { tenant_id: "tenant-a", repository: "acme/api", pr_number: 1150, needs_refresh: true },
      { tenant_id: "tenant-a", repository: "acme/api", pr_number: 1151, needs_refresh: true },
    ]);
  });

  it("flags a failed refresh for a later tick — the backlog is what repair means", async () => {
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: CHANGED });
    mockRefreshComment.mockResolvedValue({ status: "failed", reason: "boom" });

    await GET(cronRequest());

    expect(backlog.upserted.flat()).toEqual([
      { tenant_id: "tenant-1", repository: "acme/api", pr_number: 42, needs_refresh: true },
    ]);
  });

  it("drains the backlog FIRST, then clears what it refreshed", async () => {
    backlog.rows = [
      { id: "row-1", tenant_id: "tenant-1", repository: "acme/api", pr_number: 7 },
    ];
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: CHANGED });

    const res = await GET(cronRequest());

    const attempted = mockRefreshComment.mock.calls.map((c) => c[0]);
    expect(attempted).toEqual([
      { tenantId: "tenant-1", repository: "acme/api", prNumber: 7 },
      CHANGED[0],
    ]);
    expect(backlog.cleared).toEqual([["row-1"]]);
    expect(await res.json()).toMatchObject({
      commentRefresh: { attempted: 2, fromBacklog: 1, deferred: 0 },
    });
  });

  // A backlog row and a changed target naming the same PR must be ONE
  // refresh. The two arrive spelled differently — the backlog stores the
  // canonical key, the sweep passes `git_connection.repository` verbatim — so
  // deduplication has to happen on the canonical key, not the raw string.
  it("does not refresh a PR twice when the backlog and the changed set name it differently", async () => {
    backlog.rows = [
      { id: "row-1", tenant_id: "tenant-1", repository: "acme/api", pr_number: 42 },
    ];
    mockSweep.mockResolvedValue({
      skipped: false,
      counts: COUNTS,
      changed: [{ tenantId: "tenant-1", repository: "https://github.com/Acme/API.git", prNumber: 42 }],
    });

    await GET(cronRequest());

    expect(mockRefreshComment).toHaveBeenCalledTimes(1);
  });

  it("still refreshes this tick's changed PRs when the backlog read fails", async () => {
    backlog.readError = { message: "backlog unavailable" };
    mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS, changed: CHANGED });

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(mockRefreshComment).toHaveBeenCalledWith(CHANGED[0]);
  });
});
