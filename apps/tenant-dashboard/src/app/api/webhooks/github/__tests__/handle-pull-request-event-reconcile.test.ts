/**
 * handlePullRequestEvent → PR-session reconciliation wiring.
 *
 * The webhook is the PR-side reconcile trigger. Pins: the exact reconcile
 * input (scope, number, branch, host-qualified repo key, lifecycle window),
 * that reconciliation is SKIPPED when the upsert failed or ClickHouse is
 * unconfigured, and that a reconcile failure is logged without failing the
 * webhook. Supabase runs through MSW; the reconciler is a mocked seam
 * (its matching logic is tested in reconciler.test.ts).
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
  chQueryFn: vi.fn(),
}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: m.logError, info: m.logInfo },
}));
vi.mock("@/lib/system/pr-session-reconciler", () => ({
  reconcilePullRequest: m.reconcile,
  tenantChQuery: m.tenantChQuery,
}));

import { handlePullRequestEvent } from "../handle-pull-request-event";

function mergedPayload() {
  return {
    action: "closed",
    pull_request: {
      number: 42,
      html_url: "https://github.com/acme/repo/pull/42",
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
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.tenantChQuery.mockReturnValue(m.chQueryFn);
  m.reconcile.mockResolvedValue({ candidates: 0, linked: 0, confirmed: 0, pending: 0, unmatched: 0 });
});

describe("handlePullRequestEvent → reconcile wiring", () => {
  it("reconciles the PR after a successful upsert, with the exact scope and lifecycle window", async () => {
    seed();
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.tenantChQuery).toHaveBeenCalledWith({ tenantId: "t-1", appId: "app-1" });
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    const [, chQuery, input] = m.reconcile.mock.calls[0]!;
    expect(chQuery).toBe(m.chQueryFn);
    expect(input).toEqual({
      tenantId: "t-1",
      appId: "app-1",
      prNumber: 42,
      headBranch: "feat/x",
      repo: "github.com/acme/repo",
      openedAt: "2026-07-10T00:00:00Z",
      decidedAt: "2026-07-12T00:00:00Z",
    });
  });

  it("skips reconciliation when ClickHouse is not configured", async () => {
    seed();
    m.tenantChQuery.mockReturnValue(null);
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.reconcile).not.toHaveBeenCalled();
  });

  it("skips reconciliation when the pull_request upsert failed", async () => {
    seed({ upsertStatus: 500 });
    await handlePullRequestEvent(mergedPayload() as never);
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ context: "[GitHub Webhook] pull_request upsert failed" }),
    );
  });

  it("logs a reconcile failure without failing the webhook", async () => {
    seed();
    m.reconcile.mockRejectedValue(new Error("ch down"));
    await expect(handlePullRequestEvent(mergedPayload() as never)).resolves.toBeUndefined();
    expect(m.logError).toHaveBeenCalledWith(
      expect.any(Error),
      { context: "[GitHub Webhook] pr-session reconcile failed", app_id: "app-1", pr_number: 42 },
    );
  });
});
