/**
 * handlePullRequestEvent → PR session comment refresh wiring.
 *
 * The `pull_request` webhook is the trigger that puts the "No agent sessions
 * linked yet" empty-state comment on every PR of a connected repo from the
 * moment it opens — that consistent empty slot is what makes a *missing*
 * comment mean "app not connected". Pins:
 * fires on opened/reopened/synchronize only, runs AFTER reconciliation
 * (so the render picks up the links reconciliation just materialized), and
 * an unexpected rejection out of `refreshPrSessionComment` is caught and
 * logged rather than escaping into the webhook response. Supabase runs
 * through MSW; `refreshPrSessionComment` is a mocked seam (its own behavior
 * is covered by refresh.test.ts).
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
  refreshComment: vi.fn(),
}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: m.logError, info: m.logInfo },
}));
vi.mock("@/lib/system/pr-session-reconciler", () => ({
  reconcilePullRequest: m.reconcile,
  tenantChQuery: m.tenantChQuery,
}));
vi.mock("@/lib/system/pr-session-comment", () => ({
  refreshPrSessionComment: m.refreshComment,
}));

import { handlePullRequestEvent } from "../handle-pull-request-event";

function payload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    pull_request: {
      number: 42,
      html_url: "https://github.com/acme/repo/pull/42",
      merged: false,
      created_at: "2026-07-10T00:00:00Z",
      closed_at: null,
      merged_at: null,
      head: { ref: "feat/x", sha: "head-sha" },
      base: { ref: "main", sha: "base-sha" },
      ...overrides,
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
  m.tenantChQuery.mockReturnValue(m.chQueryFn);
  m.reconcile.mockResolvedValue({ candidates: 0, linked: 0, confirmed: 0, pending: 0, unmatched: 0 });
  m.refreshComment.mockResolvedValue({ status: "skipped-disabled" });
});

describe("handlePullRequestEvent → pr-session comment wiring", () => {
  it.each(["opened", "reopened", "synchronize"])(
    "refreshes the comment on '%s' with the tenant/repo/PR scope",
    async (action) => {
      seed();
      await handlePullRequestEvent(payload(action) as never);
      expect(m.refreshComment).toHaveBeenCalledTimes(1);
      expect(m.refreshComment).toHaveBeenCalledWith({
        tenantId: "t-1",
        repository: "acme/repo",
        prNumber: 42,
      });
    },
  );

  it.each(["labeled", "review_requested", "ready_for_review", "edited"])(
    "does not refresh the comment on '%s'",
    async (action) => {
      seed();
      await handlePullRequestEvent(payload(action) as never);
      expect(m.refreshComment).not.toHaveBeenCalled();
    },
  );

  it("does not refresh the comment on 'closed' (merged) even though the PR is decided", async () => {
    seed();
    await handlePullRequestEvent(
      payload("closed", { merged: true, closed_at: "2026-07-12T00:00:00Z", merged_at: "2026-07-12T00:00:00Z" }) as never,
    );
    expect(m.refreshComment).not.toHaveBeenCalled();
  });

  it("calls refreshPrSessionComment AFTER reconciliation completes", async () => {
    seed();
    const order: string[] = [];
    m.reconcile.mockImplementation(async () => {
      order.push("reconcile");
      return { candidates: 0, linked: 0, confirmed: 0, pending: 0, unmatched: 0 };
    });
    m.refreshComment.mockImplementation(async () => {
      order.push("refresh-comment");
      return { status: "skipped-disabled" };
    });
    await handlePullRequestEvent(payload("opened") as never);
    expect(order).toEqual(["reconcile", "refresh-comment"]);
  });

  it("refreshes the comment even when reconciliation fails, so the empty state still posts", async () => {
    seed();
    m.reconcile.mockRejectedValue(new Error("ch down"));
    await handlePullRequestEvent(payload("opened") as never);
    expect(m.refreshComment).toHaveBeenCalledTimes(1);
    expect(m.refreshComment).toHaveBeenCalledWith({
      tenantId: "t-1",
      repository: "acme/repo",
      prNumber: 42,
    });
  });

  it("does not refresh the comment when the pull_request upsert failed", async () => {
    seed({ upsertStatus: 500 });
    await handlePullRequestEvent(payload("opened") as never);
    expect(m.refreshComment).not.toHaveBeenCalled();
  });

  it("swallows an unexpected rejection from refreshPrSessionComment without failing the webhook", async () => {
    seed();
    m.refreshComment.mockRejectedValue(new Error("unexpected boom"));
    await expect(handlePullRequestEvent(payload("opened") as never)).resolves.toBeUndefined();
    expect(m.logError).toHaveBeenCalledWith(new Error("unexpected boom"), {
      context: "[GitHub Webhook] pr-session comment refresh failed",
      app_id: "app-1",
      pr_number: 42,
    });
  });

  it("posts the comment refresh for every connected app on a multi-app repo", async () => {
    server.use(
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([
          { app_id: "app-1", tenant_id: "t-1" },
          { app_id: "app-2", tenant_id: "t-2" },
        ]),
      ),
      http.post(`${API}/pull_request`, () => HttpResponse.json([], { status: 201 })),
    );
    await handlePullRequestEvent(payload("opened") as never);
    expect(m.refreshComment).toHaveBeenCalledTimes(2);
    expect(m.refreshComment).toHaveBeenCalledWith({
      tenantId: "t-1",
      repository: "acme/repo",
      prNumber: 42,
    });
    expect(m.refreshComment).toHaveBeenCalledWith({
      tenantId: "t-2",
      repository: "acme/repo",
      prNumber: 42,
    });
  });
});
