/**
 * refreshPrSessionComment: the orchestrator that composes readLinkedSessions,
 * readTopicLabels, renderComment, and the GitHub issue-comment client into
 * one idempotent write, guarded by the `pr_session_comment` identity row.
 *
 * The GitHub client is always injected via `deps.githubClient` — a real
 * installation Octokit client needs a network round-trip to mint, and this
 * module's own installation lookup is skipped entirely once a client is
 * injected (see `refresh.ts`), so these tests never touch `git_connection`
 * for that purpose.
 *
 * `REPO` is seeded in `git_connection.repository`'s own `owner/repo` format
 * — the format the `pull_request` webhook and the cron sweep pass. A
 * separate test below covers the queue path's host-qualified
 * `github.com/owner/repo` form to pin the canonicalization at the top of
 * `refreshPrSessionComment`.
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
const REPO = "acme/api";
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
    /** The existence probe behind the staleness escape hatch. */
    getIssueComment: vi.fn<(repo: string, commentId: number) => Promise<IssueCommentResult>>(),
  };
}

/** An `ok` issue-comment result for the given id. */
function okComment(id: number): IssueCommentResult {
  return {
    status: "ok",
    id,
    body: "body",
    htmlUrl: `https://github.com/acme/api/issues/812#issuecomment-${id}`,
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
    // The create claim row exists (it is taken BEFORE the POST, which is
    // what keeps two triggers from both creating), but no comment identity
    // was persisted: nothing was posted, so there is nothing to edit later,
    // and the row is re-claimable once its TTL lapses.
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: null, last_body_hash: "" }),
    ]);
    // Visibility surface for the rollout: the missing-permission path is
    // routed through `serverLogger.info`, not a bare `console.warn`, so it reaches
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

  // Fix for the queue path silently no-op'ing in production: git_connection
  // stores "acme/api", but the queue delivers ClickHouse's host-qualified
  // GitRepo join key ("github.com/acme/api"). Every downstream read/write
  // must key off the canonical "acme/api" form regardless of which format
  // arrived in `params.repository`.
  it("canonicalizes a github.com/-prefixed repository (the queue's delivery format) before every downstream call", async () => {
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

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: `github.com/${REPO}`, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 555 });
    expect(githubClient.createIssueComment).toHaveBeenCalledWith(REPO, PR, expect.any(String));
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ repository: REPO, tenant_id: TENANT, pr_number: PR }),
    ]);
  });

  // A repository this feature cannot address must fail loudly rather than
  // key off a half-parsed string — a mis-parsed key is a SECOND comment on
  // the PR, which AC-057-02 forbids.
  it("fails loudly on a repository that is not a GitHub owner/repo", async () => {
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: "git.acme-enterprise.com/acme/api", prNumber: PR },
      { chQuery: fakeChQuery([]), githubClient },
    );

    expect(result.status).toBe("failed");
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(getPrSessionCommentRows()).toEqual([]);
  });

  // The hash short-circuit must not hide a comment that was never posted:
  // a row can carry a matching hash with no comment id (a claim, or a create
  // that failed), and short-circuiting there means the PR never gets one.
  it("still posts when the body hash matches but no comment was ever posted", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(777));

    // First pass renders and posts; capture the hash it stored.
    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    const storedHash = getPrSessionCommentRows()[0]!.last_body_hash;

    // Same hash, but the comment id was never persisted.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: null,
        last_body_hash: storedHash,
        last_posted_at: null,
      },
    ]);
    githubClient.createIssueComment.mockClear();
    githubClient.createIssueComment.mockResolvedValue(okComment(778));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 778 });
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
  });

  // Without the staleness probe, a hand-deleted comment is hidden forever:
  // the body never changes, so the hash always matches and GitHub is never
  // called again. The `gone` recovery path is unreachable in that state.
  it("re-posts a hand-deleted comment even though the rendered body is unchanged", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(900));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    const storedHash = getPrSessionCommentRows()[0]!.last_body_hash;

    // Same body, same hash, but last posted long enough ago that the id is
    // no longer trusted — and the comment is gone from GitHub.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: 900,
        last_body_hash: storedHash,
        last_posted_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    githubClient.getIssueComment.mockResolvedValue({ status: "gone" });
    githubClient.createIssueComment.mockClear();
    githubClient.createIssueComment.mockResolvedValue(okComment(901));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(githubClient.getIssueComment).toHaveBeenCalledWith(REPO, 900);
    expect(result).toEqual({ status: "created", commentId: 901 });
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: 901 }),
    ]);
  });

  it("does not re-post when the staleness probe finds the comment still there", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(910));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    const storedHash = getPrSessionCommentRows()[0]!.last_body_hash;

    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: 910,
        last_body_hash: storedHash,
        last_posted_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    githubClient.getIssueComment.mockResolvedValue(okComment(910));
    githubClient.createIssueComment.mockClear();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "unchanged", commentId: 910 });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(githubClient.updateIssueComment).not.toHaveBeenCalled();
  });

  // AC-057-02, the create/create race: the webhook, the queue consumer and
  // the cron sweep can all be in `refreshPrSessionComment` at once. The
  // claim — not the null id read moments earlier — is what decides who
  // POSTs, so a caller that loses it must back off rather than post a second
  // comment GitHub would then carry forever.
  it("backs off instead of posting a second comment when another caller holds the create claim", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    // A live claim: row exists, nothing posted yet, taken just now.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: null,
        last_body_hash: "",
        last_posted_at: null,
        updated_at: new Date().toISOString(),
      },
    ]);
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result.status).toBe("failed");
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
  });

  it("edits the winner's comment when the claim was already completed by another caller", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    // Another caller finished first: the row now carries their comment id,
    // and a hash that doesn't match what we're about to render.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: 321,
        last_body_hash: "some-other-hash",
        last_posted_at: new Date().toISOString(),
      },
    ]);
    const githubClient = fakeGithubClient();
    githubClient.updateIssueComment.mockResolvedValue(okComment(321));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "updated", commentId: 321 });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
  });

  // A tenant UUID in the /orgs/<...> segment makes every link in the comment
  // 404 — on a public PR. Better a missing comment (the sweep retries) than
  // a comment full of dead links.
  it("fails rather than rendering links with a tenant id in place of the org name", async () => {
    seedGitConnections([
      { tenant_id: TENANT, app_id: "app-1", repository: REPO, pr_comments_enabled: true },
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedMembershipMswState({ tenants: [] });
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result.status).toBe("failed");
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
  });
});
