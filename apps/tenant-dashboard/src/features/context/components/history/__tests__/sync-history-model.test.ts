import { describe, it, expect } from "vitest";
import {
  formatDuration,
  shortSha,
  toSyncHistoryRow,
  toSyncHistoryRows,
  type ContextSyncEventRow,
} from "../sync-history-model";

function makeEvent(overrides: Partial<ContextSyncEventRow> = {}): ContextSyncEventRow {
  return {
    id: "evt-1",
    app_id: "app-1",
    tenant_id: "tenant-1",
    branch: "main",
    commit_sha: "abcdef1234567890",
    commit_message: "Add deploy skill",
    trigger: "push",
    status: "synced",
    error: null,
    duration_ms: 1500,
    snapshot_id: "snap-1",
    created_at: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("toSyncHistoryRow", () => {
  it("projects a synced push row: commit_message primary text, 7-char SHA, no error", () => {
    expect(toSyncHistoryRow(makeEvent())).toEqual({
      id: "evt-1",
      status: "synced",
      trigger: "push",
      primaryText: "Add deploy skill",
      shortSha: "abcdef1",
      branch: "main",
      createdAt: "2026-07-13T10:00:00.000Z",
      durationMs: 1500,
      error: null,
    });
  });

  it("falls back to the short SHA when commit_message is NULL", () => {
    const row = toSyncHistoryRow(
      makeEvent({ commit_message: null, commit_sha: "fedcba9876543210" }),
    );
    expect(row.primaryText).toBe("fedcba9");
    expect(row.shortSha).toBe("fedcba9");
  });

  it("failed-before-HEAD attempt: null SHA and message → placeholder text, error surfaced", () => {
    const row = toSyncHistoryRow(
      makeEvent({
        status: "failed",
        commit_sha: null,
        commit_message: null,
        error: "clone timed out",
        snapshot_id: null,
      }),
    );
    expect(row).toEqual({
      id: "evt-1",
      status: "failed",
      trigger: "push",
      primaryText: "(unknown commit)",
      shortSha: null,
      branch: "main",
      createdAt: "2026-07-13T10:00:00.000Z",
      durationMs: 1500,
      error: "clone timed out",
    });
  });

  it("drops the error on a synced row even if the column is populated", () => {
    expect(toSyncHistoryRow(makeEvent({ status: "synced", error: "stale" })).error).toBeNull();
  });

  it("narrows unknown trigger/status defensively (push / failed)", () => {
    const row = toSyncHistoryRow(makeEvent({ trigger: "mystery", status: "weird" }));
    expect(row.trigger).toBe("push");
    expect(row.status).toBe("failed");
  });
});

describe("toSyncHistoryRows", () => {
  it("preserves input order verbatim (ordering is the query's job, not the mapper's)", () => {
    const rows = toSyncHistoryRows([
      makeEvent({ id: "c", created_at: "2026-07-13T12:00:00.000Z", commit_message: "third" }),
      makeEvent({ id: "b", created_at: "2026-07-13T11:00:00.000Z", commit_message: "second" }),
      makeEvent({ id: "a", created_at: "2026-07-13T10:00:00.000Z", commit_message: "first" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(rows.map((r) => r.primaryText)).toEqual(["third", "second", "first"]);
  });
});

describe("shortSha / formatDuration", () => {
  it("shortSha truncates to 7 and passes null through", () => {
    expect(shortSha("abcdef1234")).toBe("abcdef1");
    expect(shortSha(null)).toBeNull();
  });

  it("formatDuration: ms under a second, one-decimal seconds above, null → null", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(null)).toBeNull();
  });
});
