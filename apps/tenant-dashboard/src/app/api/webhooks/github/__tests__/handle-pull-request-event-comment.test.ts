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
 *
 * AC-057-10 — this file covers the webhook half of the criterion's
 * STRUCTURAL claim: the refresh is dispatched by the `pull_request` event
 * itself, with no scheduled batch process anywhere in the path. The queue
 * half is covered in `apps/gateway/src/queues/pr-comment-queue.test.ts`.
 * The criterion's p50/p90 latency numbers are an SLO tracked against
 * production telemetry and are deliberately not asserted anywhere — see
 * `acceptance/057-pr-session-comment.md`.
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
// `handlePullRequestEvent` defers the comment refresh to `after()`, which
// throws outside a real request scope. The faithful-enough unit-test stand-in
// runs the callback immediately, so the refresh still lands within the
// awaited `handlePullRequestEvent` call and every assertion below stays
// synchronous.
vi.mock("next/server", () => ({ after: (callback: () => unknown) => callback() }));

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
  it.each(["opened", "reopened", "synchronize", "ready_for_review"])(
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

  it.each(["labeled", "review_requested", "edited"])(
    "does not refresh the comment on '%s'",
    async (action) => {
      seed();
      await handlePullRequestEvent(payload(action) as never);
      expect(m.refreshComment).not.toHaveBeenCalled();
    },
  );

  // The comment updates indefinitely, which is also the only choice that
  // makes the two trigger paths agree: the cron sweep already refreshes
  // merged PRs whose links move late, so excluding `closed` here made
  // post-merge behavior "sometimes frozen" depending on which fired.
  it("refreshes the comment on 'closed' (merged), so the record keeps updating after merge", async () => {
    seed();
    await handlePullRequestEvent(
      payload("closed", { merged: true, closed_at: "2026-07-12T00:00:00Z", merged_at: "2026-07-12T00:00:00Z" }) as never,
    );
    expect(m.refreshComment).toHaveBeenCalledTimes(1);
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
    // Keyed by tenant, not app: the refresh is hoisted out of the
    // per-connection loop precisely because its scope carries no app_id.
    expect(m.logError).toHaveBeenCalledWith(new Error("unexpected boom"), {
      context: "[GitHub Webhook] pr-session comment refresh failed",
      tenant_id: "t-1",
      pr_number: 42,
    });
  });

  // The refresh is keyed by (tenant, repository, prNumber) and carries no
  // app_id, so two apps in ONE tenant sharing a repo must produce ONE call:
  // a second is a full re-read and re-render to reach the hash
  // short-circuit, and on a fresh PR it is a second concurrent create.
  it("refreshes once when two apps in the same tenant share the repo", async () => {
    server.use(
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([
          { app_id: "app-1", tenant_id: "t-1" },
          { app_id: "app-2", tenant_id: "t-1" },
        ]),
      ),
      http.post(`${API}/pull_request`, () => HttpResponse.json([], { status: 201 })),
    );
    await handlePullRequestEvent(payload("opened") as never);
    expect(m.refreshComment).toHaveBeenCalledTimes(1);
    expect(m.refreshComment).toHaveBeenCalledWith({
      tenantId: "t-1",
      repository: "acme/repo",
      prNumber: 42,
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
