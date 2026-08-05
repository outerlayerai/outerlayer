/**
 * GET /api/cron/pr-session-reconcile — the sweep trigger.
 *
 * The route is thin: authenticate the cron bearer, clamp the windows,
 * delegate to runPrSessionSweep then runOutcomeScoresSweep (mocked seams —
 * their logic is tested in reconciler.test.ts / emit.test.ts), and map the
 * results to a status. Pins the auth gate, the clamp bounds, the
 * reconcile-before-emit order, the skipped paths, and the error → 500 map.
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

vi.mock("@/config-global.server", () => ({
  CRON_SECRET: "test-cron-secret",
}));

vi.mock("@/lib/system/pr-session-reconciler", () => ({
  runPrSessionSweep: mockSweep,
}));

vi.mock("@/lib/system/outcome-scores", () => ({
  runOutcomeScoresSweep: mockOutcomeSweep,
}));

import { GET } from "../route";

const COUNTS = { candidates: 3, linked: 2, confirmed: 1, pending: 1, unmatched: 0 };
const OUTCOME_COUNTS = { skipped: false, apps: 1, prs: 2, scoreRows: 6 };

function cronRequest(query = "", token = "test-cron-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/pr-session-reconcile${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSweep.mockResolvedValue({ skipped: false, counts: COUNTS });
  mockOutcomeSweep.mockResolvedValue(OUTCOME_COUNTS);
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

  it("maps an outcome-sweep failure to 500 with the message", async () => {
    mockOutcomeSweep.mockRejectedValue(new Error("insert failed"));
    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "insert failed" });
  });
});
