/**
 * Action-layer tests: permission gating (`context.read`) + the real Supabase
 * query against `pull_request`, exercised through MSW (a true HTTP boundary —
 * `apps/tenant-dashboard/CLAUDE.md`) rather than a mocked query chain. The
 * action-kit seams (`@/lib/adapters`) are mocked; the real `authorizedAction`
 * wrapper runs, with `ctx.db` a real Supabase client pointed at the
 * MSW-intercepted REST endpoint.
 */

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

import { checkPendingPullRequestsAction } from "../action-adapters";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedPullRequestSessionMswState,
  resetPullRequestSessionMswState,
  type PullRequestMswRow,
} from "@/test-helpers/msw-handlers/pull-request-session";

const APP_ID = "app-1";
const fakeDb = createMswRestClient();

function prRow(overrides: Partial<PullRequestMswRow>): PullRequestMswRow {
  return {
    pr_number: 1,
    app_id: APP_ID,
    head_branch: "outerlayer/context/main",
    opened_at: "2026-07-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    state: "open",
    ...overrides,
  };
}

beforeEach(() => {
  resetPullRequestSessionMswState();
  mockLoadCtx.mockReset();
  mockCheckPerm.mockReset();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-1", actor: { userId: "user-1", role: "admin" } });
  mockCheckPerm.mockResolvedValue(true);
});

describe("checkPendingPullRequestsAction", () => {
  it("returns no decided PRs without querying anything when the input list is empty", async () => {
    const result = await checkPendingPullRequestsAction(APP_ID, []);
    expect(result).toEqual({ data: { decided: [] } });
    expect(mockLoadCtx).not.toHaveBeenCalled();
  });

  it("denies the check and never reaches the table when the user lacks context.read", async () => {
    mockCheckPerm.mockResolvedValue(false);
    seedPullRequestSessionMswState({ pullRequests: [prRow({ pr_number: 7, state: "merged" })] });

    const result = await checkPendingPullRequestsAction(APP_ID, [7]);
    expect(result).toEqual({ error: "Permission denied: context.read" });
    expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.read", APP_ID);
  });

  it("reports a merged PR as decided, and leaves a still-open one out", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [
        prRow({ pr_number: 5, state: "merged", merged_at: "2026-07-10T00:00:00Z" }),
        prRow({ pr_number: 6, state: "open" }),
      ],
    });

    const result = await checkPendingPullRequestsAction(APP_ID, [5, 6]);
    expect(result).toEqual({ data: { decided: [5] } });
  });

  it("reports a closed-without-merging PR as decided too — it's no longer pending either way", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [prRow({ pr_number: 9, state: "closed", closed_at: "2026-07-11T00:00:00Z" })],
    });

    const result = await checkPendingPullRequestsAction(APP_ID, [9]);
    expect(result).toEqual({ data: { decided: [9] } });
  });

  it("never reports a PR belonging to a different app, even with the same number", async () => {
    seedPullRequestSessionMswState({
      pullRequests: [prRow({ pr_number: 3, app_id: "app-other", state: "merged" })],
    });

    const result = await checkPendingPullRequestsAction(APP_ID, [3]);
    expect(result).toEqual({ data: { decided: [] } });
  });
});
