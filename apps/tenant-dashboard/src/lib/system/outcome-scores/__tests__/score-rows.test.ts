/**
 * Pure PR-outcome → score-row mapping. Pins the full row shape (source,
 * type, anchors), the fact-emission rules (unknown never emits as 0), the
 * per-(app, trace, pr, name) id determinism, and the collapse-safety
 * property: every fact anchors CreatedAt to opened_at so a fate flip
 * (close → reopen → merge, late revert) re-emits onto the SAME
 * ReplacingMergeTree sort key instead of duplicating.
 */
import { describe, it, expect } from "vitest";
import {
  outcomeScoreId,
  outcomeScoreRows,
  OUTCOME_SCORE_NAMES,
  type PrFateRow,
} from "../score-rows";

const OPENED_AT = "2026-07-10T08:30:00.000Z";
const ANCHOR_MS = Date.parse(OPENED_AT);
const EMITTED_MS = Date.parse("2026-07-15T12:00:00.000Z");

const basePr = (over: Partial<PrFateRow> = {}): PrFateRow => ({
  tenant_id: "t-1",
  app_id: "app-1",
  pr_number: 42,
  state: "open",
  opened_at: OPENED_AT,
  closed_at: null,
  merged_at: null,
  reverted_at: null,
  first_ci_status: null,
  ...over,
});

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("outcomeScoreRows", () => {
  it("emits the full row set for a merged, reverted, CI-failed PR", () => {
    const pr = basePr({
      state: "merged",
      closed_at: "2026-07-12T00:00:00.000Z",
      merged_at: "2026-07-12T00:00:00.000Z",
      reverted_at: "2026-07-14T00:00:00.000Z",
      first_ci_status: "failure",
    });
    const shared = {
      TenantId: "t-1",
      AppId: "app-1",
      ResourceId: "trace-a",
      Reason: "",
      Type: "pr_outcome",
      Source: "outcome",
      DataType: "boolean",
      UserId: "",
      Environment: "",
      EnvironmentVersion: 0,
      CommitSha: "",
      CreatedAt: ANCHOR_MS,
      UpdatedAt: EMITTED_MS,
      IsDeleted: 0,
    };
    expect(outcomeScoreRows(pr, ["trace-a"], EMITTED_MS)).toEqual([
      {
        ...shared,
        Id: outcomeScoreId("app-1", "trace-a", 42, "worker.ci_green"),
        Name: "worker.ci_green",
        Score: 0,
        Label: "failure",
      },
      {
        ...shared,
        Id: outcomeScoreId("app-1", "trace-a", 42, "worker.merged"),
        Name: "worker.merged",
        Score: 1,
        Label: "merged",
      },
      {
        ...shared,
        Id: outcomeScoreId("app-1", "trace-a", 42, "worker.reverted"),
        Name: "worker.reverted",
        Score: 1,
        Label: "reverted",
      },
    ]);
  });

  it("emits only the CI verdict for an open PR, and nothing without CI", () => {
    const withCi = outcomeScoreRows(basePr({ first_ci_status: "success" }), ["t"], EMITTED_MS);
    expect(withCi.map((r) => [r.Name, r.Score, r.Label])).toEqual([
      ["worker.ci_green", 1, "success"],
    ]);
    expect(outcomeScoreRows(basePr(), ["t"], EMITTED_MS)).toEqual([]);
  });

  it("scores a closed-unmerged PR as merged=0 with no durability row", () => {
    const rows = outcomeScoreRows(
      basePr({ state: "closed", closed_at: "2026-07-12T00:00:00.000Z" }),
      ["t"],
      EMITTED_MS,
    );
    expect(rows.map((r) => [r.Name, r.Score, r.Label])).toEqual([["worker.merged", 0, "closed"]]);
    expect(rows.map((r) => r.Name)).not.toContain(OUTCOME_SCORE_NAMES.reverted);
  });

  it("scores a merged, unreverted PR as standing", () => {
    const rows = outcomeScoreRows(
      basePr({ state: "merged", merged_at: "2026-07-12T00:00:00.000Z" }),
      ["t"],
      EMITTED_MS,
    );
    expect(rows.map((r) => [r.Name, r.Score, r.Label])).toEqual([
      ["worker.merged", 1, "merged"],
      ["worker.reverted", 0, "standing"],
    ]);
  });

  it("emits nothing without a parseable opened_at anchor or without traces", () => {
    const merged: Partial<PrFateRow> = { state: "merged", merged_at: "2026-07-12T00:00:00.000Z" };
    expect(outcomeScoreRows(basePr({ ...merged, opened_at: null }), ["t"], EMITTED_MS)).toEqual([]);
    expect(outcomeScoreRows(basePr({ ...merged, opened_at: "not-a-date" }), ["t"], EMITTED_MS)).toEqual([]);
    expect(outcomeScoreRows(basePr(merged), [], EMITTED_MS)).toEqual([]);
  });

  it("emits nothing for absent fate fields — unknown is never a 0", () => {
    const sparse = {
      tenant_id: "t-1",
      app_id: "app-1",
      pr_number: 42,
      opened_at: OPENED_AT,
    } as unknown as PrFateRow;
    expect(outcomeScoreRows(sparse, ["t"], EMITTED_MS)).toEqual([]);
  });

  it("fans out per trace with ids distinct across trace, pr, and name", () => {
    const pr = basePr({ state: "merged", merged_at: "2026-07-12T00:00:00.000Z" });
    const rows = outcomeScoreRows(pr, ["trace-a", "trace-b"], EMITTED_MS);
    expect(rows.map((r) => [r.ResourceId, r.Name])).toEqual([
      ["trace-a", "worker.merged"],
      ["trace-a", "worker.reverted"],
      ["trace-b", "worker.merged"],
      ["trace-b", "worker.reverted"],
    ]);
    expect(new Set(rows.map((r) => r.Id)).size).toBe(4);
    for (const row of rows) expect(row.Id).toMatch(UUID_SHAPE);
    // Same trace + name under a DIFFERENT PR must be a different id — a
    // session links many PRs, and their outcomes must not replace each other.
    expect(outcomeScoreId("app-1", "trace-a", 43, "worker.merged")).not.toBe(
      outcomeScoreId("app-1", "trace-a", 42, "worker.merged"),
    );
    // Determinism: the same triple always produces the same id.
    expect(outcomeScoreRows(pr, ["trace-a", "trace-b"], EMITTED_MS).map((r) => r.Id)).toEqual(
      rows.map((r) => r.Id),
    );
  });

  it("keeps the collapse key stable across fate flips: a close→merge re-emit shares Id AND CreatedAt", () => {
    const closed = outcomeScoreRows(
      basePr({ state: "closed", closed_at: "2026-07-11T00:00:00.000Z" }),
      ["t"],
      EMITTED_MS,
    );
    const laterMs = Date.parse("2026-07-20T09:00:00.000Z");
    const merged = outcomeScoreRows(
      basePr({ state: "merged", merged_at: "2026-07-19T00:00:00.000Z" }),
      ["t"],
      laterMs,
    );
    const closedRow = closed.find((r) => r.Name === "worker.merged")!;
    const mergedRow = merged.find((r) => r.Name === "worker.merged")!;
    expect(mergedRow.Id).toBe(closedRow.Id);
    expect(mergedRow.CreatedAt).toBe(closedRow.CreatedAt);
    expect([closedRow.Score, mergedRow.Score]).toEqual([0, 1]);
    expect([closedRow.UpdatedAt, mergedRow.UpdatedAt]).toEqual([EMITTED_MS, laterMs]);
  });
});
