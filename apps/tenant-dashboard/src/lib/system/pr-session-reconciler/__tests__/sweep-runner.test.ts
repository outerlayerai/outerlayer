/**
 * runPrSessionSweep — the service-layer cron entry. Pins the skip contract
 * (no ClickHouse → skipped, no reconcile attempted), the pass-through
 * (admin client + window into reconcileRecentSessions, counts back out),
 * and that the sweep's `changed` links are resolved to
 * `(tenantId, repository, prNumber)` via `resolveChangedLinkTargets` before
 * reaching the cron route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  sweepChQuery: vi.fn(),
  reconcileRecentSessions: vi.fn(),
  resolveChangedLinkTargets: vi.fn(),
  reconcileArtifacts: vi.fn(),
  chQueryFn: vi.fn(),
}));

vi.mock("../ch-query", () => ({
  sweepChQuery: m.sweepChQuery,
  tenantChQuery: vi.fn(),
}));
vi.mock("../reconciler", () => ({
  reconcileRecentSessions: m.reconcileRecentSessions,
  resolveChangedLinkTargets: m.resolveChangedLinkTargets,
  reconcilePullRequest: vi.fn(),
}));
vi.mock("../artifact-reconcile", () => ({
  reconcileArtifacts: m.reconcileArtifacts,
}));

import { runPrSessionSweep } from "../sweep-runner";

const COUNTS = { candidates: 5, linked: 4, confirmed: 3, pending: 1, unmatched: 0 };
const ARTIFACT_COUNTS = { pending: 2, confirmed: 1, unmatched: 0 };
const CHANGED_LINKS = [{ appId: "app-1", prNumber: 42 }];
const ARTIFACT_CHANGED = [{ appId: "app-1", prNumber: 77 }];
const CHANGED_TARGETS = [{ tenantId: "tenant-1", repository: "github.com/acme/api", prNumber: 42 }];

beforeEach(() => {
  vi.clearAllMocks();
  m.reconcileRecentSessions.mockResolvedValue({ ...COUNTS, changed: CHANGED_LINKS });
  m.reconcileArtifacts.mockResolvedValue({ counts: ARTIFACT_COUNTS, changed: ARTIFACT_CHANGED });
  m.resolveChangedLinkTargets.mockResolvedValue(CHANGED_TARGETS);
});

describe("runPrSessionSweep", () => {
  it("skips without touching the reconciler when ClickHouse is unconfigured", async () => {
    m.sweepChQuery.mockReturnValue(null);
    expect(await runPrSessionSweep({ sinceHours: 24 })).toEqual({ skipped: true });
    expect(m.reconcileRecentSessions).not.toHaveBeenCalled();
    expect(m.reconcileArtifacts).not.toHaveBeenCalled();
    expect(m.resolveChangedLinkTargets).not.toHaveBeenCalled();
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
    expect(result).toEqual({
      skipped: false,
      counts: COUNTS,
      artifactCounts: ARTIFACT_COUNTS,
      changed: CHANGED_TARGETS,
    });
  });

  it("resolves the session sweep's AND the artifact sweep's changed links to refresh targets", async () => {
    m.sweepChQuery.mockReturnValue(m.chQueryFn);
    await runPrSessionSweep({ sinceHours: 24 });
    expect(m.reconcileArtifacts).toHaveBeenCalledTimes(1);
    expect(m.resolveChangedLinkTargets).toHaveBeenCalledTimes(1);
    const [supabase, changed] = m.resolveChangedLinkTargets.mock.calls[0]!;
    expect(typeof supabase.from).toBe("function");
    // Positional: session-changed PRs first, then artifact-changed — both
    // sets must reach the comment refresher.
    expect(changed).toEqual([...CHANGED_LINKS, ...ARTIFACT_CHANGED]);
  });
});
