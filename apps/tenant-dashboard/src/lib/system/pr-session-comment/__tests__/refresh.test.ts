/**
 * refreshPrSessionComment: the orchestrator that composes readLinkedSessions
 * (PR 3), readTopicLabels (PR 4), renderComment (PR 5), and the GitHub
 * issue-comment client (PR 6) into one idempotent write, guarded by the
 * `pr_session_comment` identity row.
 *
 * The GitHub client is always injected via `deps.githubClient` — a real
 * installation Octokit client needs a network round-trip to mint, and this
 * module's own installation lookup is skipped entirely once a client is
 * injected (see `refresh.ts`), so these tests never touch `git_connection`
 * for that purpose.
 */
import { http, HttpResponse } from "msw";
import { getEqParam } from "@repo/test-msw";
import { describe, it, expect, vi } from "vitest";

import { server } from "@/test-helpers/msw-server";
import {
  seedMembershipMswState,
  seedPullRequestSessionMswState,
  seedSupabaseMswState,
  seedPrSessionCommentMswState,
  getPrSessionCommentRows,
  type PullRequestSessionMswRow,
} from "@/test-helpers/msw-handlers";

const mockLoggerInfo = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));

import { refreshPrSessionComment } from "../refresh";
import type { IssueCommentResult } from "@/lib/system/git/github/client";

const SUPABASE_URL = "http://localhost:54321";

const TENANT = "tenant-1";
const REPO = "github.com/acme/api";
const PR = 812;

interface GitConnectionSeedRow {
  tenant_id: string;
  app_id: string;
  repository: string;
  pr_comments_enabled: boolean;
}

/** Local override, matching `read.test.ts`'s: the shared handlers don't
 * emulate the `tenant_id` / `pr_comments_enabled` filters `readLinkedSessions`
 * actually sends. */
function seedGitConnections(rows: GitConnectionSeedRow[]) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
      const url = new URL(request.url);
      const tenantId = getEqParam(url, "tenant_id");
      const repository = getEqParam(url, "repository");
      const prCommentsEnabled = getEqParam(url, "pr_comments_enabled");
      const matched = rows.filter(
        (r) =>
          (!tenantId || r.tenant_id === tenantId) &&
          (!repository || r.repository === repository) &&
          (!prCommentsEnabled || String(r.pr_comments_enabled) === prCommentsEnabled),
      );
      return HttpResponse.json(matched.map((r) => ({ app_id: r.app_id })));
    }),
  );
}

function enableFeature() {
  seedGitConnections([{ tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true }]);
  seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: "acme" }] });
}

const link = (
  over: Partial<PullRequestSessionMswRow> &
    Pick<PullRequestSessionMswRow, "id" | "app_id" | "trace_id" | "method" | "verification">,
): PullRequestSessionMswRow => ({
  tenant_id: TENANT,
  pr_number: PR,
  session_id: `s-${over.trace_id}`,
  git_branch: "",
  first_linked_at: "2026-07-01T00:00:00.000Z",
  last_reconciled_at: "2026-07-01T00:00:00.000Z",
  ...over,
});

function chRow(over: Record<string, unknown>) {
  return {
    TraceId: "t1",
    Title: "Fix flaky auth test",
    StartedAt: "2026-07-10 09:00:00.000",
    EndedAt: "2026-07-10 09:41:00.000",
    CostUsd: 3.12,
    Models: ["opus-5"],
    ApiErrorCount: 0,
    ErrorCount: 0,
    AppId: "app-1",
    ...over,
  };
}

/** ChQueryFn fake that answers the session query (`agent_session_summary`)
 * and the topics query (`trace_facets`) from separate row sets, dispatched
 * by a substring check on the SQL — the same seam `readLinkedSessions` and
 * `readTopicLabels` are independently tested against. */
function fakeChQuery(sessionRows: Record<string, unknown>[], topicRows: Record<string, unknown>[] = []) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("agent_session_summary")) return sessionRows;
    if (sql.includes("trace_facets")) return topicRows;
    return [];
  });
}

function fakeGithubClient() {
  return {
    createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(),
    updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(),
  };
}

describe("refreshPrSessionComment", () => {
  it("no-ops cleanly when no app has pr_comments_enabled for this repo", async () => {
    seedGitConnections([{ tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: false }]);
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([]), githubClient },
    );

    expect(result).toEqual({ status: "skipped-disabled" });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(githubClient.updateIssueComment).not.toHaveBeenCalled();
  });

  it("never throws — a read failure resolves to a failed result", async () => {
    // No git_connection handler override — the shared handlers hit PostgREST
    // with an unmocked error status for this path, exercising the module's
    // own error path instead of `readLinkedSessions` throwing cleanly.
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_connection`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([]), githubClient },
    );

    expect(result.status).toBe("failed");
  });

  // AC-057-02: the comment is created once, then edited in place when a
  // later session syncs onto the same PR — never a second comment.
  it("AC-057-02: creates once, then edits the existing comment in place when a later session syncs", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue({
      status: "ok",
      id: 555,
      body: "first body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-555",
    });

    const firstResult = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(firstResult).toEqual({ status: "created", commentId: 555 });
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: 555,
      }),
    ]);

    // A second session links the same PR later.
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-1", trace_id: "t2", method: "pr_link", verification: "confirmed" }),
      ],
    });
    githubClient.updateIssueComment.mockResolvedValue({
      status: "ok",
      id: 555,
      body: "second body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-555",
    });

    const secondResult = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery([
          chRow({ TraceId: "t1" }),
          chRow({ TraceId: "t2", Title: "Address review feedback" }),
        ]),
        githubClient,
      },
    );

    expect(secondResult).toEqual({ status: "updated", commentId: 555 });
    // Never a second comment: createIssueComment is still called exactly
    // once across both refreshes; the second refresh only ever edits.
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(githubClient.updateIssueComment).toHaveBeenCalledTimes(1);
    const [repoArg, commentIdArg, bodyArg] = githubClient.updateIssueComment.mock.calls[0]!;
    expect(repoArg).toBe(REPO);
    expect(commentIdArg).toBe(555);
    expect(bodyArg).toContain("Address review feedback");
    // Still exactly one row for (tenant, repository, pr_number).
    expect(getPrSessionCommentRows()).toHaveLength(1);
  });

  // AC-057-03: a listed session accruing more work updates its row and the
  // header totals on the next edit — the comment renders present state, not
  // a first-sight snapshot.
  it("AC-057-03: the next edit reflects the session's current duration and cost, not the first-sight values", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue({
      status: "ok",
      id: 555,
      body: "first body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-555",
    });

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery([
          chRow({
            TraceId: "t1",
            StartedAt: "2026-07-10 09:00:00.000",
            EndedAt: "2026-07-10 09:10:00.000",
            CostUsd: 3.0,
          }),
        ]),
        githubClient,
      },
    );
    const firstBody = githubClient.createIssueComment.mock.calls[0]![2] as string;
    expect(firstBody).toContain("$3.00");

    // The same session accrues more work: longer duration, higher cost.
    githubClient.updateIssueComment.mockResolvedValue({
      status: "ok",
      id: 555,
      body: "second body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-555",
    });
    const secondResult = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery([
          chRow({
            TraceId: "t1",
            StartedAt: "2026-07-10 09:00:00.000",
            EndedAt: "2026-07-10 10:10:00.000",
            CostUsd: 20.5,
          }),
        ]),
        githubClient,
      },
    );

    expect(secondResult).toEqual({ status: "updated", commentId: 555 });
    const secondBody = githubClient.updateIssueComment.mock.calls[0]![2] as string;
    expect(secondBody).toContain("$20.50");
    expect(secondBody).not.toContain("$3.00");
    expect(secondBody).not.toEqual(firstBody);
  });

  // Risk R4: three trigger paths hit one comment and queue delivery is
  // at-least-once, so an unchanged body must never reach GitHub.
  it("short-circuits on an unchanged body hash without calling GitHub again", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue({
      status: "ok",
      id: 555,
      body: "body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-555",
    });
    const rowFactory = () => [chRow({ TraceId: "t1" })];

    const first = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery(rowFactory()), githubClient },
    );
    expect(first).toEqual({ status: "created", commentId: 555 });

    // Simulates one of the two other trigger paths delivering the same
    // event again (at-least-once queue semantics) — nothing changed.
    const second = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery(rowFactory()), githubClient },
    );

    expect(second).toEqual({ status: "unchanged", commentId: 555 });
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(githubClient.updateIssueComment).not.toHaveBeenCalled();
  });

  it("recreates the comment and overwrites the stored id when the existing one is gone (404)", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: 111,
        last_body_hash: "stale-hash-that-never-matches",
        last_posted_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const githubClient = fakeGithubClient();
    githubClient.updateIssueComment.mockResolvedValue({ status: "gone" });
    githubClient.createIssueComment.mockResolvedValue({
      status: "ok",
      id: 999,
      body: "fresh body",
      htmlUrl: "https://github.com/acme/api/issues/812#issuecomment-999",
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 999 });
    expect(githubClient.updateIssueComment).toHaveBeenCalledWith(REPO, 111, expect.any(String));
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: 999 }),
    ]);
  });

  it("stays silent on not_permitted: no throw, no persisted row", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue({ status: "not_permitted" });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "not-permitted" });
    expect(getPrSessionCommentRows()).toEqual([]);
    // Visibility surface (PR 15): the missing-permission path is routed
    // through `serverLogger.info`, not a bare `console.warn`, so it reaches
    // Logtail in production and is queryable there — see
    // docs/pr-session-comment-permission-rollout.md. `.info`, not `.error`:
    // this is expected steady-state while an installation is pending admin
    // approval, not an incident.
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[pr-session-comment] refresh blocked: issues:write not permitted",
      expect.objectContaining({
        event: "pr_session_comment.not_permitted",
        tenantId: TENANT,
        repository: REPO,
        prNumber: PR,
      }),
    );
  });
});
