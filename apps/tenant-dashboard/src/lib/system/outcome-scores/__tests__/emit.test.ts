/**
 * Convergent outcome-score emission. Supabase runs through MSW (no client
 * mocks); the ClickHouse insert is the captured seam. Pins the confirmed-only
 * gate (pending/unmatched links never reach a row), arrival-order
 * independence (fate-then-link ≡ link-then-fate), re-emission idempotency
 * (same collapse key, only the replacing version moves), and the sweep's
 * three change feeds (updated rows, fresh inserts, late link confirmations)
 * with stale rows excluded.
 */
import { describe, it, expect, vi } from "vitest";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedPullRequestSessionMswState,
  type PullRequestMswRow,
  type PullRequestSessionMswRow,
} from "../../../../test-helpers/msw-handlers";
import { emitOutcomeScoresForPrs, sweepOutcomeScores } from "../emit";
import { outcomeScoreId, type OutcomeScoreRow } from "../score-rows";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const RECENT = "2026-07-17T06:00:00.000Z";
const STALE = "2026-07-10T00:00:00.000Z";
const OPENED_AT = "2026-07-08T09:00:00.000Z";
const TENANT = "t-1";
const APP = "app-1";

const pr = (
  over: Partial<PullRequestMswRow> & Pick<PullRequestMswRow, "pr_number">,
): PullRequestMswRow => ({
  app_id: APP,
  tenant_id: TENANT,
  head_branch: "",
  state: "merged",
  opened_at: OPENED_AT,
  closed_at: "2026-07-12T00:00:00.000Z",
  merged_at: "2026-07-12T00:00:00.000Z",
  reverted_at: null,
  first_ci_status: null,
  created_at: STALE,
  updated_at: null,
  ...over,
});

const link = (
  over: Partial<PullRequestSessionMswRow> &
    Pick<PullRequestSessionMswRow, "id" | "pr_number" | "trace_id">,
): PullRequestSessionMswRow => ({
  tenant_id: TENANT,
  app_id: APP,
  session_id: "",
  method: "pr_link",
  verification: "confirmed",
  git_branch: "",
  first_linked_at: STALE,
  last_reconciled_at: STALE,
  ...over,
});

function captureInsert() {
  const batches: OutcomeScoreRow[][] = [];
  const fn = vi.fn(async (rows: OutcomeScoreRow[]) => {
    batches.push(rows);
  });
  return { fn, batches, all: () => batches.flat() };
}

describe("emitOutcomeScoresForPrs", () => {
  it("emits rows only for confirmed links — pending and unmatched never poison outcomes", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 42 })],
      links: [
        link({ id: "l1", pr_number: 42, trace_id: "trace-confirmed" }),
        link({ id: "l2", pr_number: 42, trace_id: "trace-pending", verification: "pending" }),
        link({ id: "l3", pr_number: 42, trace_id: "trace-unmatched", verification: "unmatched" }),
      ],
    });
    const insert = captureInsert();
    const counts = await emitOutcomeScoresForPrs(getAdminDataClient(), insert.fn, {
      appId: APP,
      prNumbers: [42],
      now: NOW,
    });
    expect(counts).toEqual({ prs: 1, links: 1, scoreRows: 2 });
    expect(insert.all().map((r) => [r.ResourceId, r.Name, r.Score])).toEqual([
      ["trace-confirmed", "worker.merged", 1],
      ["trace-confirmed", "worker.reverted", 0],
    ]);
    expect(JSON.stringify(insert.all())).not.toContain("trace-pending");
    expect(JSON.stringify(insert.all())).not.toContain("trace-unmatched");
  });

  it("converges to identical rows whichever side arrives first", async () => {
    const fateFirst = captureInsert();
    // Fate first: the PR row exists, no confirmed link yet → nothing to score.
    seedPullRequestSessionMswState({ pullRequests: [pr({ pr_number: 7 })], links: [] });
    await emitOutcomeScoresForPrs(getAdminDataClient(), fateFirst.fn, {
      appId: APP,
      prNumbers: [7],
      now: NOW,
    });
    expect(fateFirst.fn).not.toHaveBeenCalled();
    // ...then the link confirms.
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 7, trace_id: "trace-x" })],
    });
    await emitOutcomeScoresForPrs(getAdminDataClient(), fateFirst.fn, {
      appId: APP,
      prNumbers: [7],
      now: NOW,
    });

    const linkFirst = captureInsert();
    // Link first: the session claimed the PR, but no provider row yet.
    seedPullRequestSessionMswState({
      pullRequests: [],
      links: [link({ id: "l1", pr_number: 7, trace_id: "trace-x" })],
    });
    await emitOutcomeScoresForPrs(getAdminDataClient(), linkFirst.fn, {
      appId: APP,
      prNumbers: [7],
      now: NOW,
    });
    expect(linkFirst.fn).not.toHaveBeenCalled();
    // ...then the pull_request row lands.
    seedPullRequestSessionMswState({ pullRequests: [pr({ pr_number: 7 })] });
    await emitOutcomeScoresForPrs(getAdminDataClient(), linkFirst.fn, {
      appId: APP,
      prNumbers: [7],
      now: NOW,
    });

    expect(linkFirst.all()).toEqual(fateFirst.all());
    expect(fateFirst.all().length).toBe(2);
  });

  it("re-emits onto the same collapse key: only the replacing version moves", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 9, first_ci_status: "success" })],
      links: [link({ id: "l1", pr_number: 9, trace_id: "trace-y" })],
    });
    const insert = captureInsert();
    const supabase = getAdminDataClient();
    await emitOutcomeScoresForPrs(supabase, insert.fn, { appId: APP, prNumbers: [9], now: NOW });
    await emitOutcomeScoresForPrs(supabase, insert.fn, { appId: APP, prNumbers: [9], now: NOW });
    expect(insert.batches[1]).toEqual(insert.batches[0]);

    const later = new Date("2026-07-25T12:00:00.000Z");
    await emitOutcomeScoresForPrs(supabase, insert.fn, { appId: APP, prNumbers: [9], now: later });
    const [first, third] = [insert.batches[0]!, insert.batches[2]!];
    expect(third.map((r) => [r.Id, r.CreatedAt, r.Name, r.Score])).toEqual(
      first.map((r) => [r.Id, r.CreatedAt, r.Name, r.Score]),
    );
    expect(third.map((r) => r.UpdatedAt)).toEqual(first.map(() => later.getTime()));
  });

  it("scores multiple PRs with mixed fates in one batch, deduping requested numbers", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        pr({ pr_number: 1 }),
        pr({ pr_number: 2, state: "closed", merged_at: null }),
        pr({ pr_number: 3, state: "open", closed_at: null, merged_at: null, first_ci_status: "failure" }),
        pr({ pr_number: 4, state: "open", closed_at: null, merged_at: null }),
      ],
      links: [
        link({ id: "l1", pr_number: 1, trace_id: "tr-1" }),
        link({ id: "l2", pr_number: 2, trace_id: "tr-2" }),
        link({ id: "l3", pr_number: 3, trace_id: "tr-3" }),
        link({ id: "l4", pr_number: 4, trace_id: "tr-4" }),
      ],
    });
    const insert = captureInsert();
    const counts = await emitOutcomeScoresForPrs(getAdminDataClient(), insert.fn, {
      appId: APP,
      prNumbers: [1, 2, 3, 4, 1, 0, -5],
      now: NOW,
    });
    expect(counts).toEqual({ prs: 4, links: 4, scoreRows: 4 });
    expect(insert.all().map((r) => [r.ResourceId, r.Name, r.Score])).toEqual([
      ["tr-1", "worker.merged", 1],
      ["tr-1", "worker.reverted", 0],
      ["tr-2", "worker.merged", 0],
      ["tr-3", "worker.ci_green", 0],
    ]);
    // The open, CI-less PR (tr-4) emits nothing despite its confirmed link.
    expect(JSON.stringify(insert.all())).not.toContain("tr-4");
    expect(insert.fn).toHaveBeenCalledTimes(1);
  });
});

describe("sweepOutcomeScores", () => {
  it("converges updated rows, fresh inserts, and late link confirmations — never stale rows", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        // Lifecycle changed in-window (e.g. CI verdict landed).
        pr({ pr_number: 1, updated_at: RECENT, first_ci_status: "success" }),
        // Untouched since insert, but inserted in-window.
        pr({ pr_number: 2, app_id: "app-2", created_at: RECENT }),
        // Stale row whose link confirmed in-window (session synced late).
        pr({ pr_number: 3 }),
        // Fully stale: old row, old link. Must not emit.
        pr({ pr_number: 4 }),
      ],
      links: [
        link({ id: "l1", pr_number: 1, trace_id: "tr-1" }),
        link({ id: "l2", pr_number: 2, trace_id: "tr-2", app_id: "app-2" }),
        link({ id: "l3", pr_number: 3, trace_id: "tr-3", last_reconciled_at: RECENT }),
        link({ id: "l4", pr_number: 4, trace_id: "tr-stale" }),
      ],
    });
    const insert = captureInsert();
    const counts = await sweepOutcomeScores(getAdminDataClient(), insert.fn, {
      sinceHours: 24,
      now: NOW,
    });
    expect(counts).toEqual({ apps: 2, prs: 3, scoreRows: 7, truncated: false });
    expect(
      insert
        .all()
        .map((r) => [r.AppId, r.ResourceId, r.Name, r.Score])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      ["app-1", "tr-1", "worker.ci_green", 1],
      ["app-1", "tr-1", "worker.merged", 1],
      ["app-1", "tr-1", "worker.reverted", 0],
      ["app-1", "tr-3", "worker.merged", 1],
      ["app-1", "tr-3", "worker.reverted", 0],
      ["app-2", "tr-2", "worker.merged", 1],
      ["app-2", "tr-2", "worker.reverted", 0],
    ]);
    expect(JSON.stringify(insert.all())).not.toContain("tr-stale");
  });

  it("emits nothing when no lifecycle rows or links changed in the window", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 4 })],
      links: [link({ id: "l4", pr_number: 4, trace_id: "tr-old" })],
    });
    const insert = captureInsert();
    const counts = await sweepOutcomeScores(getAdminDataClient(), insert.fn, {
      sinceHours: 24,
      now: NOW,
    });
    expect(counts).toEqual({ apps: 0, prs: 0, scoreRows: 0, truncated: false });
    expect(insert.fn).not.toHaveBeenCalled();
  });

  it("reports truncated coverage when a change feed hits its scan cap", async () => {
    // 5001 in-window rows against the 5000-row cap: the server returns the
    // capped page, and the sweep must say so instead of implying full
    // coverage — a wide-window backfill reads this flag to know it isn't done.
    seedPullRequestSessionMswState({
      pullRequests: Array.from({ length: 5_001 }, (_, i) =>
        pr({ pr_number: i + 1, updated_at: RECENT }),
      ),
      links: [],
    });
    const insert = captureInsert();
    const counts = await sweepOutcomeScores(getAdminDataClient(), insert.fn, {
      sinceHours: 24,
      now: NOW,
    });
    expect(counts.truncated).toBe(true);
    expect(counts.apps).toBe(1);
    expect(insert.fn).not.toHaveBeenCalled();
  });
});

describe("outcome score identity", () => {
  it("derives ids the collapse key can trust across apps and PRs", () => {
    expect(outcomeScoreId(APP, "tr-1", 1, "worker.merged")).not.toBe(
      outcomeScoreId("app-2", "tr-1", 1, "worker.merged"),
    );
  });
});
