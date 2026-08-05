/**
 * Predictor-score verdicts by PR. Supabase runs through MSW (no client
 * mocks); the ClickHouse read is the injected `ChQueryFn` seam. Pins:
 * anti-circularity enforced by NAME (fate-derived scores are refused with an
 * error; `worker.ci_green` is allowed despite sharing their `Source`), one
 * trace's verdict applying to EVERY PR
 * it's confirmed-linked to (no PR-number column on `scores`), "failure
 * sticky" when a PR has multiple confirmed sessions with disagreeing
 * verdicts, "newest row wins" across a re-emitted score, and that a PR with
 * no verdict is absent from the map (never defaulted to fail).
 */
import { describe, it, expect, vi } from "vitest";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedPullRequestSessionMswState,
  type PullRequestSessionMswRow,
} from "../../../../test-helpers/msw-handlers";
import { fetchPredictorScoreVerdictsByPr } from "../predictor-scores";

const TENANT = "t-1";
const APP = "app-1";
const SCORE_NAME = "judge.task_alignment";

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
  first_linked_at: "2026-07-08T09:00:00.000Z",
  last_reconciled_at: "2026-07-08T09:00:00.000Z",
  ...over,
});

function chRow(resourceId: string, score: number, createdAt: string, source = "assertion") {
  return { ResourceId: resourceId, Score: score, CreatedAt: createdAt, Source: source };
}

function stubChQuery(rows: Array<Record<string, unknown>>) {
  return vi.fn(async () => rows);
}

describe("fetchPredictorScoreVerdictsByPr", () => {
  it("maps a passing score (>= 1) on a trace to that trace's confirmed PR", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1" })],
    });
    const chQuery = stubChQuery([chRow("trace-1", 1, "2026-07-08T10:00:00Z")]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map([[1, true]]));
  });

  it("maps a failing score (< 1) to false", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1" })],
    });
    const chQuery = stubChQuery([chRow("trace-1", 0, "2026-07-08T10:00:00Z")]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map([[1, false]]));
  });

  it("applies one trace's verdict to EVERY PR it is confirmed-linked to — scores carry no PR-number column", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 21, trace_id: "trace-shared" }),
        link({ id: "l2", pr_number: 22, trace_id: "trace-shared" }),
      ],
    });
    const chQuery = stubChQuery([chRow("trace-shared", 1, "2026-07-08T10:00:00Z")]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(
      new Map([
        [21, true],
        [22, true],
      ]),
    );
  });

  it('is "failure sticky": a PR with two confirmed sessions whose verdicts disagree resolves to fail', async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 1, trace_id: "trace-pass" }),
        link({ id: "l2", pr_number: 1, trace_id: "trace-fail" }),
      ],
    });
    const chQuery = stubChQuery([
      chRow("trace-pass", 1, "2026-07-08T10:00:00Z"),
      chRow("trace-fail", 0, "2026-07-08T10:00:00Z"),
    ]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map([[1, false]]));
  });

  it("keeps only the NEWEST row per trace when a score was re-emitted", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1" })],
    });
    const chQuery = stubChQuery([
      chRow("trace-1", 0, "2026-07-08T10:00:00Z"),
      chRow("trace-1", 1, "2026-07-09T10:00:00Z"),
    ]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map([[1, true]]));
  });

  it("excludes a confirmed PR whose linked trace never emitted this score — absent, not defaulted to fail", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1" })],
    });
    const chQuery = stubChQuery([]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map());
  });

  it.each(["worker.merged", "worker.reverted"])(
    "refuses %s outright — correlating a PR's own fate against itself is circular, and failing loudly beats silently matching nothing",
    async (fateName) => {
      seedPullRequestSessionMswState({
        links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1" })],
      });
      const chQuery = stubChQuery([]);

      await expect(
        fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
          tenantId: TENANT,
          appId: APP,
          scoreName: fateName,
        }),
      ).rejects.toThrow(/not a predictor/);
      expect(chQuery).not.toHaveBeenCalled();
    },
  );

  it("ALLOWS worker.ci_green — its verdict is fixed before the PR is decided, so it predicts rather than restates the outcome", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 7, trace_id: "trace-ci" })],
    });
    const chQuery = stubChQuery([chRow("trace-ci", 1, "2026-07-08T10:00:00Z", "outcome")]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: "worker.ci_green",
    });

    // Shares Source 'outcome' with the banned names — proof the guard keys on
    // the NAME, not on provenance.
    expect(result).toEqual(new Map([[7, true]]));
    expect(chQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: "worker.ci_green" }),
    );
  });

  it("skips the ClickHouse query entirely when there are no confirmed links", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 1, trace_id: "trace-1", verification: "pending" })],
    });
    const chQuery = stubChQuery([]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map());
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("scopes links to the given tenant and app", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 1, trace_id: "trace-a1", app_id: "app-1" }),
        link({ id: "l2", pr_number: 1, trace_id: "trace-a2", app_id: "app-2" }),
      ],
    });
    const chQuery = stubChQuery([
      chRow("trace-a1", 1, "2026-07-08T10:00:00Z"),
      chRow("trace-a2", 0, "2026-07-08T10:00:00Z"),
    ]);

    const result = await fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: "app-1",
      scoreName: SCORE_NAME,
    });

    expect(result).toEqual(new Map([[1, true]]));
  });
});
