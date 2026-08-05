/**
 * Two-sided PR↔session reconciler. Supabase runs through MSW (no client
 * mocks); ClickHouse is the injected query seam. Pins the exact link rows
 * written (method tier, verification, conflict-key merge), the
 * never-downgrade rules (pr_link stays pr_link, confirmed stays confirmed),
 * the branch-tier activity-window guard, and pending-link aging.
 */
import { describe, it, expect, vi } from "vitest";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedPullRequestSessionMswState,
  getPullRequestSessionLinks,
  type PullRequestMswRow,
  type PullRequestSessionMswRow,
} from "../../../../test-helpers/msw-handlers";
import {
  reconcilePullRequest,
  reconcileRecentSessions,
  BRANCH_LINK_LOOKBACK_DAYS,
} from "../reconciler";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const TENANT = "tenant-1";
const APP = "app-1";
const REPO = "github.com/acme/api";

const link = (
  over: Partial<PullRequestSessionMswRow> & Pick<PullRequestSessionMswRow, "id" | "pr_number" | "trace_id">,
): PullRequestSessionMswRow => ({
  tenant_id: TENANT,
  app_id: APP,
  session_id: "",
  git_branch: "",
  method: "pr_link",
  verification: "pending",
  first_linked_at: NOW.toISOString(),
  last_reconciled_at: NOW.toISOString(),
  ...over,
});

const pr = (over: Partial<PullRequestMswRow> & Pick<PullRequestMswRow, "pr_number">): PullRequestMswRow => ({
  app_id: APP,
  head_branch: "",
  opened_at: null,
  closed_at: null,
  merged_at: null,
  ...over,
});

describe("reconcilePullRequest (PR side)", () => {
  it("links explicit and branch-tier sessions as confirmed, with the evidence tier per session", async () => {
    const chQuery = vi.fn().mockResolvedValue([
      { TraceId: "t-explicit", SessionId: "s-explicit", GitBranch: "feat/x", explicit: 1 },
      { TraceId: "t-branch", SessionId: "s-branch", GitBranch: "feat/x", explicit: 0 },
    ]);
    const counts = await reconcilePullRequest(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      prNumber: 42,
      headBranch: "feat/x",
      repo: REPO,
      openedAt: "2026-07-10T00:00:00.000Z",
      decidedAt: "2026-07-12T00:00:00.000Z",
      now: NOW,
    });
    expect(counts).toEqual({ candidates: 2, linked: 2, confirmed: 2, pending: 0, unmatched: 0 });
    expect(getPullRequestSessionLinks().map((l) => [l.pr_number, l.trace_id, l.method, l.verification])).toEqual([
      [42, "t-explicit", "pr_link", "confirmed"],
      [42, "t-branch", "branch", "confirmed"],
    ]);
    // The ClickHouse query carries the scope, the array∪scalar union, and the
    // branch activity window derived from the PR's lifecycle.
    const [sql, params] = chQuery.mock.calls[0]!;
    expect(sql).toContain("arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers)");
    expect(sql).toContain("agent_session_summary FINAL");
    expect(BRANCH_LINK_LOOKBACK_DAYS).toBe(14);
    expect(params).toEqual({
      tenantId: TENANT,
      appId: APP,
      repo: REPO,
      pr: 42,
      branch: "feat/x",
      // opened_at (07-10) minus the 14-day lookback; end = decided_at.
      windowStart: "2026-06-26 00:00:00.000",
      windowEnd: "2026-07-12 00:00:00.000",
    });
  });

  it("never downgrades an explicit pr_link to branch on re-reconcile", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "L1", pr_number: 42, trace_id: "t1", method: "pr_link", verification: "confirmed" }),
      ],
    });
    const chQuery = vi
      .fn()
      .mockResolvedValue([{ TraceId: "t1", SessionId: "s1", GitBranch: "feat/x", explicit: 0 }]);
    await reconcilePullRequest(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      prNumber: 42,
      headBranch: "feat/x",
      repo: REPO,
      now: NOW,
    });
    expect(getPullRequestSessionLinks().map((l) => [l.trace_id, l.method, l.verification])).toEqual([
      ["t1", "pr_link", "confirmed"],
    ]);
  });
});

describe("reconcileRecentSessions (sweep side)", () => {
  const sweepRow = (over: Record<string, unknown>) => ({
    TenantId: TENANT,
    AppId: APP,
    SessionId: "s",
    GitBranch: "",
    StartedAt: "2026-07-11 09:00:00.000",
    EndedAt: "2026-07-11 10:00:00.000",
    sessionPrs: [],
    ...over,
  });

  it("confirms claims with a provider record, holds unknown claims pending, and branch-links only inside the activity window", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        pr({ pr_number: 12, head_branch: "feat/x", opened_at: "2026-07-10T00:00:00.000Z", merged_at: "2026-07-12T00:00:00.000Z" }),
      ],
    });
    const chQuery = vi.fn().mockResolvedValue([
      sweepRow({ TraceId: "t-claim", sessionPrs: [12, 999] }),
      sweepRow({ TraceId: "t-branch-in", GitBranch: "feat/x" }),
      sweepRow({
        TraceId: "t-branch-out",
        GitBranch: "feat/x",
        StartedAt: "2026-07-13 09:00:00.000",
        EndedAt: "2026-07-13 10:00:00.000",
      }),
    ]);
    const counts = await reconcileRecentSessions(getAdminDataClient(), chQuery, {
      sinceHours: 48,
      now: NOW,
    });
    expect(getPullRequestSessionLinks().map((l) => [l.pr_number, l.trace_id, l.method, l.verification])).toEqual([
      [12, "t-claim", "pr_link", "confirmed"],
      [999, "t-claim", "pr_link", "pending"],
      [12, "t-branch-in", "branch", "confirmed"],
    ]);
    expect(counts.candidates).toBe(3);
    expect(counts.confirmed).toBe(2);
    expect(counts.pending).toBe(1);
    expect(chQuery.mock.calls[0]![1]).toEqual({ sinceHours: 48 });
  });

  it("ages pending links: past-grace with no record → unmatched, record-appeared → confirmed, fresh → untouched", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 7, head_branch: "b" })],
      links: [
        link({ id: "L-old-ghost", pr_number: 999, trace_id: "t1", first_linked_at: "2026-06-01T00:00:00.000Z" }),
        link({ id: "L-found", pr_number: 7, trace_id: "t2", first_linked_at: "2026-06-01T00:00:00.000Z" }),
        link({ id: "L-fresh", pr_number: 998, trace_id: "t3", first_linked_at: "2026-07-16T00:00:00.000Z" }),
      ],
    });
    const counts = await reconcileRecentSessions(getAdminDataClient(), vi.fn().mockResolvedValue([]), {
      now: NOW,
    });
    const byId = new Map(getPullRequestSessionLinks().map((l) => [l.id, l.verification]));
    expect(byId.get("L-old-ghost")).toBe("unmatched");
    expect(byId.get("L-found")).toBe("confirmed");
    expect(byId.get("L-fresh")).toBe("pending");
    expect(counts.unmatched).toBe(1);
  });
});
