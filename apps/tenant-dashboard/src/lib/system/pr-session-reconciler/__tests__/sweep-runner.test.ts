/**
 * runPrSessionSweep — the service-layer cron entry. Pins the skip contract
 * (no ClickHouse → skipped, no reconcile attempted) and the pass-through
 * (admin client + window into reconcileRecentSessions, counts back out).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  sweepChQuery: vi.fn(),
  reconcileRecentSessions: vi.fn(),
  chQueryFn: vi.fn(),
}));

vi.mock("../ch-query", () => ({
  sweepChQuery: m.sweepChQuery,
  tenantChQuery: vi.fn(),
}));
vi.mock("../reconciler", () => ({
  reconcileRecentSessions: m.reconcileRecentSessions,
  reconcilePullRequest: vi.fn(),
}));

import { runPrSessionSweep } from "../sweep-runner";

const COUNTS = { candidates: 5, linked: 4, confirmed: 3, pending: 1, unmatched: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  m.reconcileRecentSessions.mockResolvedValue(COUNTS);
});

describe("runPrSessionSweep", () => {
  it("skips without touching the reconciler when ClickHouse is unconfigured", async () => {
    m.sweepChQuery.mockReturnValue(null);
    expect(await runPrSessionSweep({ sinceHours: 24 })).toEqual({ skipped: true });
    expect(m.reconcileRecentSessions).not.toHaveBeenCalled();
  });

  it("runs the sweep with the admin client and the exact window, returning its counts", async () => {
    m.sweepChQuery.mockReturnValue(m.chQueryFn);
    const result = await runPrSessionSweep({ sinceHours: 72 });
    expect(m.reconcileRecentSessions).toHaveBeenCalledTimes(1);
    const [supabase, chQuery, input] = m.reconcileRecentSessions.mock.calls[0]!;
    // The real admin client (MSW-backed in tests) — pin the seam identity of
    // the other two args exactly.
    expect(typeof supabase.from).toBe("function");
    expect(chQuery).toBe(m.chQueryFn);
    expect(input).toEqual({ sinceHours: 72 });
    expect(result).toEqual({ skipped: false, counts: COUNTS });
  });
});
