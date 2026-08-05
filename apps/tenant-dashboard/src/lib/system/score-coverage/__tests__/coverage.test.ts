/**
 * Outcome-score coverage reconciliation. Supabase runs through MSW (no
 * client mocks); the ClickHouse read is the injected `ChQueryFn` seam. Pins:
 * only confirmed links behind a TERMINAL PR count; coverage is checked at
 * the exact (app, trace, PR, name) grain via the recomputed `Id` — NOT by
 * trace alone, since a session linked to multiple PRs would otherwise mark
 * every one of its PRs "covered" the instant ANY of them got a score; the
 * missing/covered-sample lists and their caps; the appId/prNumber filters;
 * and the truncated flag.
 */
import { describe, it, expect, vi } from "vitest";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedPullRequestSessionMswState,
  type PullRequestMswRow,
  type PullRequestSessionMswRow,
} from "../../../../test-helpers/msw-handlers";
import { computeScoreCoverage } from "../coverage";
import { outcomeScoreId } from "../../outcome-scores/score-rows";

const APP = "app-1";

const pr = (
  over: Partial<PullRequestMswRow> & Pick<PullRequestMswRow, "pr_number">,
): PullRequestMswRow => ({
  app_id: APP,
  head_branch: "",
  opened_at: "2026-07-08T09:00:00.000Z",
  closed_at: "2026-07-12T00:00:00.000Z",
  merged_at: "2026-07-12T00:00:00.000Z",
  state: "merged",
  ...over,
});

const link = (
  over: Partial<PullRequestSessionMswRow> &
    Pick<PullRequestSessionMswRow, "id" | "pr_number" | "trace_id">,
): PullRequestSessionMswRow => ({
  tenant_id: "t-1",
  app_id: APP,
  session_id: "",
  method: "pr_link",
  verification: "confirmed",
  git_branch: "",
  first_linked_at: "2026-07-08T09:00:00.000Z",
  last_reconciled_at: "2026-07-08T09:00:00.000Z",
  ...over,
});

/** A row shaped exactly like the real `SELECT Id, Score, Label` query
 * returns — Id computed the SAME way the writer computes it, so a stub row
 * only "counts" for the (appId, traceId, prNumber, name) it actually claims. */
function chScoreRow(
  appId: string,
  traceId: string,
  prNumber: number,
  name: string,
  score: number,
  label: string,
) {
  return { Id: outcomeScoreId(appId, traceId, prNumber, name), Score: score, Label: label };
}

function stubChQuery(rows: Array<{ Id: string; Score: number; Label: string }>) {
  return vi.fn(async () => rows);
}

describe("computeScoreCoverage", () => {
  it("counts a confirmed link behind a terminal PR as covered when its own score row exists", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 1, state: "merged" })],
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-covered" })],
    });
    const chQuery = stubChQuery([chScoreRow(APP, "trace-covered", 1, "worker.merged", 1, "merged")]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result).toEqual({
      confirmedLinks: 1,
      covered: 1,
      missing: 0,
      missingSamples: [],
      coveredSamples: [
        {
          appId: APP,
          prNumber: 1,
          traceId: "trace-covered",
          scores: [{ name: "worker.merged", score: 1, label: "merged" }],
        },
      ],
      truncated: false,
    });
  });

  it("collects every score row for a covered link, not just the first", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 1, state: "merged" })],
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-covered" })],
    });
    const chQuery = stubChQuery([
      chScoreRow(APP, "trace-covered", 1, "worker.ci_green", 1, "success"),
      chScoreRow(APP, "trace-covered", 1, "worker.merged", 1, "merged"),
      chScoreRow(APP, "trace-covered", 1, "worker.reverted", 0, "standing"),
    ]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.coveredSamples[0]?.scores).toEqual([
      { name: "worker.ci_green", score: 1, label: "success" },
      { name: "worker.merged", score: 1, label: "merged" },
      { name: "worker.reverted", score: 0, label: "standing" },
    ]);
  });

  it("does NOT mark a PR covered just because a DIFFERENT PR sharing its trace has a score (the bug this rewrite fixes)", async () => {
    // One session (trace-shared) linked to two PRs. Only PR 21 actually has a
    // score row; PR 22's own row is genuinely missing.
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 21, state: "merged" }), pr({ pr_number: 22, state: "merged" })],
      links: [
        link({ id: "l21", pr_number: 21, trace_id: "trace-shared" }),
        link({ id: "l22", pr_number: 22, trace_id: "trace-shared" }),
      ],
    });
    const chQuery = stubChQuery([chScoreRow(APP, "trace-shared", 21, "worker.merged", 1, "merged")]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.confirmedLinks).toBe(2);
    expect(result.covered).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.missingSamples).toEqual([{ appId: APP, prNumber: 22, traceId: "trace-shared" }]);
    expect(result.coveredSamples).toEqual([
      {
        appId: APP,
        prNumber: 21,
        traceId: "trace-shared",
        scores: [{ name: "worker.merged", score: 1, label: "merged" }],
      },
    ]);
  });

  it("reports a confirmed link with no outcome score row as missing, with its identifying info", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 2, state: "closed" })],
      links: [link({ id: "l2", pr_number: 2, trace_id: "trace-missing" })],
    });
    const chQuery = stubChQuery([]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result).toEqual({
      confirmedLinks: 1,
      covered: 0,
      missing: 1,
      missingSamples: [{ appId: APP, prNumber: 2, traceId: "trace-missing" }],
      coveredSamples: [],
      truncated: false,
    });
  });

  it("excludes links behind an OPEN pr — no fate to score yet, not a coverage gap", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 3, state: "open" })],
      links: [link({ id: "l3", pr_number: 3, trace_id: "trace-open" })],
    });
    const chQuery = stubChQuery([]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.confirmedLinks).toBe(0);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("excludes pending and unmatched links even behind a terminal PR", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 4, state: "merged" })],
      links: [
        link({ id: "l4a", pr_number: 4, trace_id: "trace-pending", verification: "pending" }),
        link({ id: "l4b", pr_number: 4, trace_id: "trace-unmatched", verification: "unmatched" }),
      ],
    });
    const chQuery = stubChQuery([]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.confirmedLinks).toBe(0);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("filters to the given appId when provided", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        pr({ pr_number: 5, app_id: "app-1", state: "merged" }),
        pr({ pr_number: 5, app_id: "app-2", state: "merged" }),
      ],
      links: [
        link({ id: "l5a", pr_number: 5, app_id: "app-1", trace_id: "trace-a1" }),
        link({ id: "l5b", pr_number: 5, app_id: "app-2", trace_id: "trace-a2" }),
      ],
    });
    const chQuery = stubChQuery([]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery, {
      appId: "app-1",
    });

    expect(result.confirmedLinks).toBe(1);
    expect(result.missingSamples).toEqual([{ appId: "app-1", prNumber: 5, traceId: "trace-a1" }]);
  });

  it("filters to one specific PR when prNumber is given — a targeted lookup, not the arbitrary-order sample", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [pr({ pr_number: 10, state: "merged" }), pr({ pr_number: 11, state: "merged" })],
      links: [
        link({ id: "l10", pr_number: 10, trace_id: "trace-10" }),
        link({ id: "l11", pr_number: 11, trace_id: "trace-11" }),
      ],
    });
    const chQuery = stubChQuery([chScoreRow(APP, "trace-10", 10, "worker.reverted", 1, "reverted")]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery, { prNumber: 10 });

    expect(result.confirmedLinks).toBe(1);
    expect(result.coveredSamples).toEqual([
      { appId: APP, prNumber: 10, traceId: "trace-10", scores: [{ name: "worker.reverted", score: 1, label: "reverted" }] },
    ]);
  });

  it("caps the missing-sample list without dropping the true missing count", async () => {
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    seedPullRequestSessionMswState({
      pullRequests: many.map((n) => pr({ pr_number: n, state: "merged" })),
      links: many.map((n) =>
        link({ id: `l${n}`, pr_number: n, trace_id: `trace-${n}` }),
      ),
    });
    const chQuery = stubChQuery([]);

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.confirmedLinks).toBe(30);
    expect(result.missing).toBe(30);
    expect(result.missingSamples).toHaveLength(25);
  });

  it("caps the covered-sample list (ground-truth audit) without dropping the true covered count", async () => {
    const many = Array.from({ length: 20 }, (_, i) => i + 1);
    seedPullRequestSessionMswState({
      pullRequests: many.map((n) => pr({ pr_number: n, state: "merged" })),
      links: many.map((n) => link({ id: `l${n}`, pr_number: n, trace_id: `trace-${n}` })),
    });
    const chQuery = stubChQuery(
      many.map((n) => chScoreRow(APP, `trace-${n}`, n, "worker.merged", 1, "merged")),
    );

    const result = await computeScoreCoverage(getAdminDataClient(), chQuery);

    expect(result.covered).toBe(20);
    expect(result.coveredSamples).toHaveLength(15);
  });
});
