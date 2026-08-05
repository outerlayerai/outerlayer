/**
 * handlePullRequestEvent → outcome-score emission wiring.
 *
 * The webhook is the real-time converge trigger. Pins: the exact emission
 * input (app scope, event PR plus revert target), that emission is SKIPPED
 * when ClickHouse is unconfigured, that it still converges from last
 * persisted state when the upsert fails (the converge reads DB truth, so
 * stale-trigger emission is safe), and that an emission failure is logged
 * without failing the webhook. Supabase runs through MSW; the emitter is a
 * mocked seam (its converge logic is tested in emit.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test-helpers/msw-server";

const API = "http://localhost:54321/rest/v1";

const m = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  reconcile: vi.fn(),
  tenantChQuery: vi.fn(),
  emit: vi.fn(),
  scoresInsertFn: vi.fn(),
  insertFn: vi.fn(),
}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: m.logError, info: m.logInfo },
}));
vi.mock("@/lib/system/pr-session-reconciler", () => ({
  reconcilePullRequest: m.reconcile,
  tenantChQuery: m.tenantChQuery,
}));
vi.mock("@/lib/system/outcome-scores", () => ({
  emitOutcomeScoresForPrs: m.emit,
  scoresInsertFn: m.scoresInsertFn,
}));

import { handlePullRequestEvent } from "../handle-pull-request-event";

function mergedPayload({ body }: { body?: string } = {}) {
  return {
    action: "closed",
    pull_request: {
      number: 42,
      html_url: "https://github.com/acme/repo/pull/42",
      body: body ?? null,
      merged: true,
      created_at: "2026-07-10T00:00:00Z",
      closed_at: "2026-07-12T00:00:00Z",
      merged_at: "2026-07-12T00:00:00Z",
      head: { ref: "feat/x", sha: "head-sha" },
      base: { ref: "main", sha: "base-sha" },
    },
    repository: { full_name: "acme/repo" },
    installation: { id: 99 },
  };
}

function seed({ upsertStatus = 201 }: { upsertStatus?: number } = {}) {
  server.use(
    http.get(`${API}/git_connection`, () =>
      HttpResponse.json([{ app_id: "app-1", tenant_id: "t-1" }]),
    ),
    http.post(`${API}/pull_request`, () =>
      upsertStatus === 201
        ? HttpResponse.json([], { status: 201 })
        : HttpResponse.json({ message: "boom" }, { status: upsertStatus }),
    ),
    http.patch(`${API}/pull_request`, () => HttpResponse.json([], { status: 200 })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.tenantChQuery.mockReturnValue(null);
  m.scoresInsertFn.mockReturnValue(m.insertFn);
  m.emit.mockResolvedValue({ prs: 1, links: 1, scoreRows: 2 });
});

describe("handlePullRequestEvent → outcome-score wiring", () => {
  it("converges the event's PR through the insert seam after the upsert", async () => {
    seed();
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.emit).toHaveBeenCalledTimes(1);
    const [, insertScores, input] = m.emit.mock.calls[0]!;
    expect(insertScores).toBe(m.insertFn);
    expect(input).toEqual({ appId: "app-1", prNumbers: [42] });
  });

  it("includes the revert target so its durability flip emits in the same pass", async () => {
    seed();
    await handlePullRequestEvent(mergedPayload({ body: "Reverts acme/repo#41" }) as never);
    expect(m.emit).toHaveBeenCalledTimes(1);
    expect(m.emit.mock.calls[0]![2]).toEqual({ appId: "app-1", prNumbers: [42, 41] });
  });

  it("skips emission when ClickHouse is not configured", async () => {
    seed();
    m.scoresInsertFn.mockReturnValue(null);
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("still converges from last persisted state when the upsert fails", async () => {
    seed({ upsertStatus: 500 });
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.emit).toHaveBeenCalledTimes(1);
    expect(m.emit.mock.calls[0]![2]).toEqual({ appId: "app-1", prNumbers: [42] });
  });

  it("logs an emission failure without failing the webhook", async () => {
    seed();
    m.emit.mockRejectedValue(new Error("ch down"));
    await expect(handlePullRequestEvent(mergedPayload() as never)).resolves.toBeUndefined();
    expect(m.logError).toHaveBeenCalledWith(new Error("ch down"), {
      context: "[GitHub Webhook] outcome-score emission failed",
      app_id: "app-1",
      pr_number: 42,
    });
  });
});
