/**
 * Per-session PR-outcome read. Supabase runs through MSW (no client mocks);
 * the ClickHouse read is the injected `ChQueryFn` seam. Pins: outcomes are
 * grouped by PR (a session touching two PRs yields two distinct rows, not one
 * ambiguous pile — the scores row has no PR column, so this recomputes the
 * writer's per-(trace, PR, name) Id); only confirmed links count; a PR with no
 * scores yet is absent; and each score maps to its own field with its label.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, expect, vi } from "vitest";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedPullRequestSessionMswState,
  type PullRequestSessionMswRow,
  type PullRequestMswRow,
} from "../../../../test-helpers/msw-handlers";
import { fetchSessionOutcomeScores, fetchOutcomesForTraces } from "../session-outcome-read";
import { outcomeScoreId } from "../score-rows";

/** A minimal chainable Supabase query-builder fake, keyed by table name, for
 * pinning the two `if (error) throw ...` paths and the `data ?? []` null-data
 * fallback — cases the MSW fixture (which always answers 200 with a real
 * array) cannot produce. Every builder method returns the same thenable, so
 * any `.from(table).select(...).eq(...)....` chain resolves to that table's
 * configured result. */
function supabaseWithTableResults(
  results: Record<string, { data: unknown; error: { message: string } | null }>,
): SupabaseClient {
  return {
    from: (table: string) => {
      const result = results[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => builder,
        then: (resolve: (v: typeof result) => unknown) => resolve(result),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TENANT = "t-1";
const APP = "app-1";
const TRACE = "trace-1";

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

/** A row shaped like the real `SELECT Id, Score, Label` — Id computed the same
 * way the writer does, so it only "counts" for the (app, trace, pr, name) it
 * claims. */
function chScoreRow(prNumber: number, name: string, score: number, label: string) {
  return { Id: outcomeScoreId(APP, TRACE, prNumber, name), Score: score, Label: label };
}

function stubChQuery(rows: Array<{ Id: string; Score: number; Label: string }>) {
  return vi.fn(async (_sql: string, params: Record<string, unknown>) => {
    const ids = params.ids as string[] | undefined;
    return rows.filter((r) => ids === undefined || ids.includes(r.Id));
  });
}

describe("fetchSessionOutcomeScores", () => {
  it("returns the three outcome facts, each in its own field with its label, for a single-PR session", async () => {
    seedPullRequestSessionMswState({ links: [link({ id: "l1", pr_number: 7, trace_id: TRACE })] });
    const chQuery = stubChQuery([
      chScoreRow(7, "worker.ci_green", 1, "success"),
      chScoreRow(7, "worker.merged", 1, "merged"),
      chScoreRow(7, "worker.reverted", 0, "standing"),
    ]);

    const result = await fetchSessionOutcomeScores(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([
      {
        prNumber: 7,
        prUrl: null,
        ciGreen: { score: 1, label: "success" },
        merged: { score: 1, label: "merged" },
        reverted: { score: 0, label: "standing" },
      },
    ]);
  });

  it("groups outcomes by PR — a session linked to two PRs yields two distinct rows, never a collapsed one", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 21, trace_id: TRACE }),
        link({ id: "l2", pr_number: 22, trace_id: TRACE }),
      ],
    });
    // PR 21 merged clean; PR 22 closed unmerged — DIFFERENT fates on the same trace.
    const chQuery = stubChQuery([
      chScoreRow(21, "worker.merged", 1, "merged"),
      chScoreRow(22, "worker.merged", 0, "closed"),
    ]);

    const result = await fetchSessionOutcomeScores(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([
      { prNumber: 21, prUrl: null, ciGreen: null, merged: { score: 1, label: "merged" }, reverted: null },
      { prNumber: 22, prUrl: null, ciGreen: null, merged: { score: 0, label: "closed" }, reverted: null },
    ]);
  });

  it("omits a linked PR that has no outcome score yet — a still-open PR contributes nothing to show", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 7, trace_id: TRACE }),
        link({ id: "l2", pr_number: 8, trace_id: TRACE }),
      ],
    });
    // Only PR 7 has any score; PR 8 is linked but unscored (still open).
    const chQuery = stubChQuery([chScoreRow(7, "worker.ci_green", 1, "success")]);

    const result = await fetchSessionOutcomeScores(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([
      { prNumber: 7, prUrl: null, ciGreen: { score: 1, label: "success" }, merged: null, reverted: null },
    ]);
  });

  it("returns empty and never queries ClickHouse when the session has no confirmed PR link", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 7, trace_id: TRACE, verification: "pending" })],
    });
    const chQuery = stubChQuery([]);

    const result = await fetchSessionOutcomeScores(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("does not attribute another session's score to this one — a matching PR number but a different trace has a different Id", async () => {
    seedPullRequestSessionMswState({ links: [link({ id: "l1", pr_number: 7, trace_id: TRACE })] });
    // A score for PR 7 but written against a DIFFERENT trace — its Id won't
    // match this trace's recomputed candidate, so it must be ignored.
    const otherTraceRow = { Id: outcomeScoreId(APP, "other-trace", 7, "worker.merged"), Score: 1, Label: "merged" };
    const chQuery = stubChQuery([otherTraceRow]);

    const result = await fetchSessionOutcomeScores(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([]);
  });

  it("surfaces a named error when the confirmed-links read fails, instead of treating it as no links", async () => {
    const supabase = supabaseWithTableResults({
      pull_request_session: { data: null, error: { message: "connection reset" } },
    });
    const chQuery = stubChQuery([]);

    await expect(
      fetchSessionOutcomeScores(supabase, chQuery, { tenantId: TENANT, appId: APP, traceId: TRACE }),
    ).rejects.toThrow("pull_request_session read failed: connection reset");
  });

  it("treats a null (not empty-array) confirmed-links response as no links, and never queries ClickHouse", async () => {
    const supabase = supabaseWithTableResults({
      pull_request_session: { data: null, error: null },
    });
    const chQuery = vi.fn(async () => []);

    const result = await fetchSessionOutcomeScores(supabase, chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceId: TRACE,
    });

    expect(result).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("surfaces a named error when the PR-url read fails, instead of silently dropping every url", async () => {
    const supabase = supabaseWithTableResults({
      pull_request_session: { data: [{ trace_id: TRACE, pr_number: 7 }], error: null },
      pull_request: { data: null, error: { message: "connection reset" } },
    });
    const chQuery = stubChQuery([chScoreRow(7, "worker.ci_green", 1, "success")]);

    await expect(
      fetchSessionOutcomeScores(supabase, chQuery, { tenantId: TENANT, appId: APP, traceId: TRACE }),
    ).rejects.toThrow("pull_request url read failed: connection reset");
  });
});

describe("fetchOutcomesForTraces (batched, for the Sessions list)", () => {
  /** Id keyed to an EXPLICIT trace (the single-session helper hardcodes TRACE). */
  const row = (traceId: string, prNumber: number, name: string, score: number, label: string) => ({
    Id: outcomeScoreId(APP, traceId, prNumber, name),
    Score: score,
    Label: label,
  });

  const pr = (over: Partial<PullRequestMswRow> & Pick<PullRequestMswRow, "pr_number">): PullRequestMswRow => ({
    app_id: APP,
    tenant_id: TENANT,
    head_branch: "",
    opened_at: null,
    closed_at: null,
    merged_at: null,
    ...over,
  });

  it("attaches the provider PR url so the number can link out — and leaves prUrl null when no url was captured", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        pr({ pr_number: 41, url: "https://github.com/acme/app/pull/41" }),
        pr({ pr_number: 42, url: null }), // linked but no url captured
        pr({ pr_number: 43, url: "" }), // empty string is not a link either
      ],
      links: [
        link({ id: "l1", pr_number: 41, trace_id: "trace-a" }),
        link({ id: "l2", pr_number: 42, trace_id: "trace-a" }),
        link({ id: "l3", pr_number: 43, trace_id: "trace-a" }),
      ],
    });
    const chQuery = stubChQuery([
      row("trace-a", 41, "worker.merged", 1, "merged"),
      row("trace-a", 42, "worker.merged", 1, "merged"),
      row("trace-a", 43, "worker.merged", 1, "merged"),
    ]);

    const result = await fetchOutcomesForTraces(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ["trace-a"],
    });

    // A real url links out; both null AND empty-string collapse to null (no
    // dead links) — the writer never invents a URL it doesn't have.
    expect(result.get("trace-a")!.map((p) => [p.prNumber, p.prUrl])).toEqual([
      [41, "https://github.com/acme/app/pull/41"],
      [42, null],
      [43, null],
    ]);
  });

  it("attributes each PR's outcome to the RIGHT session — one query, keyed by trace, never cross-contaminated", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 10, trace_id: "trace-a" }),
        link({ id: "l2", pr_number: 20, trace_id: "trace-b" }),
        link({ id: "l3", pr_number: 21, trace_id: "trace-b" }),
      ],
    });
    // trace-a: PR 10 merged. trace-b: PR 20 merged, PR 21 reverted.
    const chQuery = stubChQuery([
      row("trace-a", 10, "worker.merged", 1, "merged"),
      row("trace-b", 20, "worker.merged", 1, "merged"),
      row("trace-b", 21, "worker.merged", 1, "merged"),
      row("trace-b", 21, "worker.reverted", 1, "reverted"),
    ]);

    const result = await fetchOutcomesForTraces(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ["trace-a", "trace-b"],
    });

    expect(result.get("trace-a")).toEqual([
      { prNumber: 10, prUrl: null, ciGreen: null, merged: { score: 1, label: "merged" }, reverted: null },
    ]);
    expect(result.get("trace-b")).toEqual([
      { prNumber: 20, prUrl: null, ciGreen: null, merged: { score: 1, label: "merged" }, reverted: null },
      { prNumber: 21, prUrl: null, ciGreen: null, merged: { score: 1, label: "merged" }, reverted: { score: 1, label: "reverted" } },
    ]);
  });

  it("returns each trace's PRs sorted ascending by PR number, regardless of link/score order", async () => {
    // Link + score the HIGHER PR first, so an unsorted result would come back
    // [30, 12] — the ascending sort is what makes it [12, 30].
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 30, trace_id: "trace-a" }),
        link({ id: "l2", pr_number: 12, trace_id: "trace-a" }),
      ],
    });
    const chQuery = stubChQuery([
      row("trace-a", 30, "worker.merged", 1, "merged"),
      row("trace-a", 12, "worker.merged", 0, "closed"),
    ]);

    const result = await fetchOutcomesForTraces(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ["trace-a"],
    });

    expect(result.get("trace-a")!.map((p) => p.prNumber)).toEqual([12, 30]);
  });

  it("omits a trace with no scored PR from the map entirely", async () => {
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", pr_number: 10, trace_id: "trace-a" }),
        link({ id: "l2", pr_number: 20, trace_id: "trace-b" }),
      ],
    });
    // Only trace-a is scored; trace-b's PR is linked but unscored (still open).
    const chQuery = stubChQuery([row("trace-a", 10, "worker.merged", 1, "merged")]);

    const result = await fetchOutcomesForTraces(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ["trace-a", "trace-b"],
    });

    expect([...result.keys()]).toEqual(["trace-a"]);
    expect(result.has("trace-b")).toBe(false);
  });

  it("returns an empty map and never queries ClickHouse when no trace has a confirmed link", async () => {
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", pr_number: 10, trace_id: "trace-a", verification: "pending" })],
    });
    const chQuery = stubChQuery([]);

    const result = await fetchOutcomesForTraces(getAdminDataClient(), chQuery, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ["trace-a"],
    });

    expect(result.size).toBe(0);
    expect(chQuery).not.toHaveBeenCalled();
  });
});
