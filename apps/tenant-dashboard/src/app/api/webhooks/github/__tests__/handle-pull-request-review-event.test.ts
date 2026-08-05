/**
 * handlePullRequestReviewEvent — review milestones for decomposed cycle time.
 *
 * Pins the rules: only `submitted` actions count; self-reviews never count;
 * first-occurrence timestamps are monotone (an earlier event can move them
 * back, a later one can't); an EXISTING row gets only its review columns
 * updated (lifecycle stays owned by `pull_request` events — a late review
 * delivery must not regress state); a MISSING row is created whole from the
 * embedded PR object. Supabase runs through MSW (no client mocks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test-helpers/msw-server";

const m = vi.hoisted(() => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { error: m.logError, info: m.logInfo },
}));

import { handlePullRequestReviewEvent } from "../handle-pull-request-review-event";

const API = "http://localhost:54321/rest/v1";

function reviewPayload(
  action: string,
  opts: {
    reviewState?: string;
    submittedAt?: string | null;
    reviewUserId?: number;
    reviewUserType?: string;
    prUserId?: number;
    prState?: string;
    mergedAt?: string | null;
    closedAt?: string | null;
  } = {}
) {
  return {
    action,
    review: {
      state: opts.reviewState ?? "commented",
      submitted_at:
        opts.submittedAt === undefined ? "2026-07-02T10:00:00Z" : opts.submittedAt,
      user: { id: opts.reviewUserId ?? 777, type: opts.reviewUserType ?? "User" },
    },
    pull_request: {
      number: 5,
      html_url: "https://github.com/acme/repo/pull/5",
      state: opts.prState ?? "open",
      user: { id: opts.prUserId ?? 501 },
      created_at: "2026-07-01T09:00:00Z",
      closed_at: opts.closedAt ?? null,
      merged_at: opts.mergedAt ?? null,
      head: { ref: "agent/feat-x", sha: "head-sha" },
      base: { ref: "main" },
    },
    repository: { full_name: "acme/repo" },
  };
}

describe("handlePullRequestReviewEvent", () => {
  let writes: Array<{ method: string; body: unknown; search: URLSearchParams }>;
  /** null → the GET returns no row (PR untracked). */
  let existingRow: {
    first_review_at: string | null;
    first_approved_at: string | null;
  } | null;

  beforeEach(() => {
    m.logError.mockReset();
    m.logInfo.mockReset();
    writes = [];
    existingRow = null;
    server.use(
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([{ app_id: "app-1", tenant_id: "t-1" }])
      ),
      http.get(`${API}/pull_request`, () =>
        HttpResponse.json(existingRow ? [existingRow] : [])
      ),
      http.post(`${API}/pull_request`, async ({ request }) => {
        writes.push({
          method: "POST",
          body: await request.json(),
          search: new URL(request.url).searchParams,
        });
        return HttpResponse.json([{}], { status: 201 });
      }),
      http.patch(`${API}/pull_request`, async ({ request }) => {
        writes.push({
          method: "PATCH",
          body: await request.json(),
          search: new URL(request.url).searchParams,
        });
        return HttpResponse.json([{}]);
      })
    );
  });

  it("updates ONLY review columns on an existing row (a review never regresses lifecycle)", async () => {
    existingRow = { first_review_at: null, first_approved_at: null };

    await handlePullRequestReviewEvent(
      reviewPayload("submitted", { reviewState: "changes_requested" })
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("PATCH");
    expect(writes[0]!.body).toEqual({
      first_review_at: "2026-07-02T10:00:00Z",
      first_approved_at: null,
    });
    expect(writes[0]!.search.get("app_id")).toBe("eq.app-1");
    expect(writes[0]!.search.get("pr_number")).toBe("eq.5");
  });

  it("an approval sets both milestones", async () => {
    existingRow = { first_review_at: null, first_approved_at: null };

    await handlePullRequestReviewEvent(
      reviewPayload("submitted", { reviewState: "approved" })
    );

    expect(writes[0]!.body).toEqual({
      first_review_at: "2026-07-02T10:00:00Z",
      first_approved_at: "2026-07-02T10:00:00Z",
    });
  });

  it("milestones are monotone: a later review never moves them, an earlier one does", async () => {
    existingRow = {
      first_review_at: "2026-07-02T10:00:00Z",
      first_approved_at: "2026-07-03T10:00:00Z",
    };

    // Later review — both keep their existing values.
    await handlePullRequestReviewEvent(
      reviewPayload("submitted", {
        reviewState: "approved",
        submittedAt: "2026-07-04T10:00:00Z",
      })
    );
    expect(writes[0]!.body).toEqual({
      first_review_at: "2026-07-02T10:00:00Z",
      first_approved_at: "2026-07-03T10:00:00Z",
    });

    // Earlier approval (out-of-order delivery) — both move back.
    await handlePullRequestReviewEvent(
      reviewPayload("submitted", {
        reviewState: "approved",
        submittedAt: "2026-07-01T12:00:00Z",
      })
    );
    expect(writes[1]!.body).toEqual({
      first_review_at: "2026-07-01T12:00:00Z",
      first_approved_at: "2026-07-01T12:00:00Z",
    });
  });

  it("creates the full row (healing) when the PR is untracked, lifecycle from the embedded PR", async () => {
    existingRow = null;

    await handlePullRequestReviewEvent(
      reviewPayload("submitted", {
        reviewState: "approved",
        prState: "closed",
        mergedAt: "2026-07-03T08:00:00Z",
        closedAt: "2026-07-03T08:00:00Z",
      })
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("POST");
    expect(writes[0]!.search.get("on_conflict")).toBe("app_id,pr_number");
    expect(writes[0]!.body).toEqual({
      app_id: "app-1",
      tenant_id: "t-1",
      provider: "github",
      pr_number: 5,
      head_branch: "agent/feat-x",
      head_sha: "head-sha",
      base_branch: "main",
      state: "merged",
      url: "https://github.com/acme/repo/pull/5",
      opened_at: "2026-07-01T09:00:00Z",
      closed_at: "2026-07-03T08:00:00Z",
      merged_at: "2026-07-03T08:00:00Z",
      first_review_at: "2026-07-02T10:00:00Z",
      first_approved_at: "2026-07-02T10:00:00Z",
    });
  });

  it("ignores self-reviews entirely (no read, no write)", async () => {
    await handlePullRequestReviewEvent(
      reviewPayload("submitted", { reviewUserId: 501, prUserId: 501 })
    );
    expect(writes).toHaveLength(0);
  });

  it("ignores bot reviews — an instant bot approval must not zero out pickup time", async () => {
    existingRow = { first_review_at: null, first_approved_at: null };
    await handlePullRequestReviewEvent(
      reviewPayload("submitted", { reviewState: "approved", reviewUserType: "Bot" })
    );
    expect(writes).toHaveLength(0);
  });

  it("ignores non-submitted actions (edited, dismissed)", async () => {
    await handlePullRequestReviewEvent(reviewPayload("dismissed"));
    await handlePullRequestReviewEvent(reviewPayload("edited"));
    expect(writes).toHaveLength(0);
  });

  it("does nothing when the repo has no connections", async () => {
    server.use(http.get(`${API}/git_connection`, () => HttpResponse.json([])));
    await handlePullRequestReviewEvent(reviewPayload("submitted"));
    expect(writes).toHaveLength(0);
  });

  it("logs (not throws) when the write fails", async () => {
    existingRow = { first_review_at: null, first_approved_at: null };
    server.use(
      http.patch(`${API}/pull_request`, () =>
        HttpResponse.json({ message: "permission denied" }, { status: 403 })
      )
    );

    await expect(
      handlePullRequestReviewEvent(reviewPayload("submitted"))
    ).resolves.toBeUndefined();
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "permission denied" }),
      {
        context: "[GitHub Webhook] review milestone upsert failed",
        app_id: "app-1",
        pr_number: 5,
      }
    );
  });
});
