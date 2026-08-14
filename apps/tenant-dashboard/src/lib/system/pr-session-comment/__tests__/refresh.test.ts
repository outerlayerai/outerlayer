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
  seedPrSessionCommentUpsertErrors,
  getPrSessionCommentRows,
  getPrEvidenceEvaluationRows,
  type PullRequestSessionMswRow,
} from "@/test-helpers/msw-handlers";

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

// The installation → client hop is the one seam these tests can't reach for
// real: `GitHubProvider.fromContext` mints an installation Octokit over the
// network. Stubbed here (rather than skipped) so the tests below can drive
// `refreshPrSessionComment` WITHOUT `deps.githubClient` and exercise the
// production lookup in `resolveInstallationId` — the path every real caller
// takes and no test previously entered.
const mockFromContext = vi.fn();
vi.mock("@/lib/system/git/github/client", () => ({
  GitHubProvider: {
    fromContext: (...args: unknown[]) => mockFromContext(...args),
  },
}));
vi.mock("@/octo-kit", () => ({
  getGithubApp: () => ({ octokitApp: "fake-app" }),
}));

import { refreshPrSessionComment } from "../refresh";
import type {
  IssueCommentListResult,
  IssueCommentResult,
  PullRequestCommitListResult,
  PullRequestFileListResult,
} from "@/lib/system/git/github/client";
import { PR_SESSION_COMMENT_MARKER } from "../render";

const SUPABASE_URL = "http://localhost:54321";

const TENANT = "tenant-1";
const REPO = "acme/api";
const PR = 812;

interface GitConnectionSeedRow {
  tenant_id: string;
  app_id: string;
  repository: string;
  pr_comments_enabled: boolean;
  /** Only the installation-lookup tests care; the rest inject a client and
   * never reach `resolveInstallationId`. */
  installation_id?: number | null;
  /** Defaults to "github"; set it to prove the provider gate bites. */
  provider?: string;
}

/** Local override, matching `read.test.ts`'s: the shared handlers don't
 * emulate the `tenant_id` / `pr_comments_enabled` / `provider` filters
 * `readLinkedSessions` actually sends. */
function seedGitConnections(rows: GitConnectionSeedRow[]) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
      const url = new URL(request.url);
      const tenantId = getEqParam(url, "tenant_id");
      const repository = getEqParam(url, "repository");
      const prCommentsEnabled = getEqParam(url, "pr_comments_enabled");
      const provider = getEqParam(url, "provider");
      const matched = rows.filter(
        (r) =>
          (!tenantId || r.tenant_id === tenantId) &&
          (!repository || r.repository === repository) &&
          (!provider || (r.provider ?? "github") === provider) &&
          (!prCommentsEnabled || String(r.pr_comments_enabled) === prCommentsEnabled),
      );
      return HttpResponse.json(
        matched.map((r) => ({
          app_id: r.app_id,
          repository: r.repository,
          installation_id: r.installation_id ?? null,
        })),
      );
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
    AgentType: "claude-code",
    OutcomeCommitShas: [],
    ...over,
  };
}

/** ChQueryFn fake that answers the session query (`agent_session_summary`)
 * and the topics query (`trace_facets`) from separate row sets, dispatched
 * by a substring check on the SQL — the same seam `readLinkedSessions` and
 * `readTopicLabels` are independently tested against. */
function fakeChQuery(
  sessionRows: Record<string, unknown>[],
  topicRows: Record<string, unknown>[] = [],
  spanRows: Record<string, unknown>[] = [],
) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("agent_session_summary")) return sessionRows;
    if (sql.includes("trace_facets")) return topicRows;
    if (sql.includes("otel_traces")) return spanRows;
    return [];
  });
}

/** A tool-call span row as `readVerificationSpans` reads it — Input carries
 * the ingest envelope whose content is the agent's own tool input (for Bash,
 * itself JSON with a `command` key). */
function spanRow(
  traceId: string,
  turnIndex: number,
  tool: { command?: string; file?: string; status?: string; output?: string },
) {
  const metadata: Record<string, string> = {
    turnIndex: String(turnIndex),
    toolName: tool.file ? "Edit" : "Bash",
    toolStatus: tool.status ?? "ok",
    ...(tool.file ? { isEdit: "1", file: tool.file } : {}),
  };
  return {
    TraceId: traceId,
    SpanName: `agent.tool.${metadata["toolName"]}`,
    StatusMessage: tool.status === "error" ? "assertion failed" : "",
    Input: tool.command
      ? JSON.stringify([{ role: "user", content: JSON.stringify({ command: tool.command }) }])
      : "",
    Output: tool.output ?? "",
    Metadata: metadata,
  };
}

function fakeGithubClient() {
  return {
    createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(),
    updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(),
    /** The existence probe behind the staleness escape hatch. */
    getIssueComment: vi.fn<(repo: string, commentId: number) => Promise<IssueCommentResult>>(),
    /** The recovery scan a claim takeover runs before creating. Defaults to
     * an empty thread — the common case, where nothing was orphaned. */
    listIssueComments:
      vi.fn<(repo: string, issueNumber: number) => Promise<IssueCommentListResult>>(
        async () => ({ status: "ok", comments: [] }),
      ),
    /** The provenance fact's input. Defaults to zero commits, which omits
     * the fact entirely — tests that exercise the fact seed real shas. */
    listPullRequestCommits:
      vi.fn<(repo: string, prNumber: number) => Promise<PullRequestCommitListResult>>(
        async () => ({ status: "ok", commits: [] }),
      ),
    /** Red-then-green's diff gate. Defaults to an empty file list — no test
     * files added, so the rule stays conservatively quiet unless a test
     * seeds real files. */
    listPullRequestFiles:
      vi.fn<(repo: string, prNumber: number) => Promise<PullRequestFileListResult>>(
        async () => ({ status: "ok", files: [] }),
      ),
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

  // Defense in depth: new GitLab connections can't be created, but the schema
  // still permits legacy `provider='gitlab'` rows. This writer posts through
  // the GitHub App only, so such a row must read as "not connected" rather
  // than as a repo we'll fail to post to in silence.
  it("treats a non-GitHub connection as no connection at all", async () => {
    seedGitConnections([
      {
        tenant_id: TENANT,
        app_id: "app-1",
        repository: REPO,
        pr_comments_enabled: true,
        provider: "gitlab",
        installation_id: 777,
      },
    ]);
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

    // The reason, not just the status: "failed" is reached from half a dozen
    // distinct branches, and a test that only checks the status passes when
    // the call fails for entirely the wrong cause.
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("git_connection read failed"),
    });
  });

  // AC-082-06 + AC-057-04: a human-only PR — no confirmed session, no
  // pending candidate link — gets NO comment. Not an empty-state comment,
  // not an identity row, not a GitHub call.
  it("posts nothing at all for a PR with no candidate session links", async () => {
    enableFeature();
    seedPullRequestSessionMswState({ links: [] });
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([]), githubClient },
    );

    expect(result).toEqual({ status: "skipped-no-links" });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(githubClient.updateIssueComment).not.toHaveBeenCalled();
    expect(getPrSessionCommentRows()).toEqual([]);
    // No evaluation recorded either: there was nothing to evaluate.
    expect(getPrEvidenceEvaluationRows()).toEqual([]);
  });

  // AC-082-05 + AC-057-04: a PR whose links are all pending shows the
  // waiting copy, and upgrades IN PLACE (same comment id, edited, never a
  // second comment) — verdict, provenance fact, and metadata appear without
  // any human action once a link confirms.
  it("posts the waiting state for pending-only links and upgrades it in place when a link confirms", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "pending" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));

    const first = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([]), githubClient },
    );

    expect(first).toEqual({ status: "created", commentId: 4242 });
    const createdBody = githubClient.createIssueComment.mock.calls[0]![2];
    expect(createdBody).toMatch(/waiting for session evidence/i);
    expect(createdBody).not.toContain("| Session | Topics |");

    // The session that built the branch finishes syncing; its link confirms.
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    githubClient.updateIssueComment.mockResolvedValue(okComment(4242));
    githubClient.listPullRequestCommits.mockResolvedValue({
      status: "ok",
      commits: [{ sha: "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d" }],
    });

    const second = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery([
          chRow({ TraceId: "t1", Title: "Fix flaky auth test", OutcomeCommitShas: ["1a2b3c4d"] }),
        ]),
        githubClient,
      },
    );

    expect(second).toEqual({ status: "updated", commentId: 4242 });
    // Edited in place — the create ran exactly once across both passes.
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(githubClient.updateIssueComment).toHaveBeenCalledTimes(1);

    const updatedBody = githubClient.updateIssueComment.mock.calls[0]![2];
    expect(updatedBody).toContain("Everything checks out");
    expect(updatedBody).toContain("1 of 1 commits came from recorded sessions");
    expect(updatedBody).toContain("| Session | Topics |");
    expect(updatedBody).toContain("Fix flaky auth test");
    expect(updatedBody).not.toMatch(/waiting for session evidence/i);
    // Still one identity row for this PR, carrying the original comment id.
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: 4242 }),
    ]);
  });

  // AC-082-08: every evaluation's facts and verdict land in
  // `pr_evidence_evaluation`, keyed by PR — recorded at evaluation time, so
  // "did flagged PRs go bad more often" is answerable from day one.
  it("records the evaluation's verdict and facts per PR", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    githubClient.listPullRequestCommits.mockResolvedValue({
      status: "ok",
      commits: [
        { sha: "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d" },
        { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      ],
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery([chRow({ TraceId: "t1", OutcomeCommitShas: ["1a2b3c4d"] })]),
        githubClient,
      },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    expect(getPrEvidenceEvaluationRows()).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        verdict: "flag",
        pending_link_count: 0,
        facts: [
          {
            id: "commits-from-sessions",
            status: "flag",
            class: "amber",
            matchedCommitCount: 1,
            totalCommitCount: 2,
            unrecordedShas: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
          },
        ],
      }),
    ]);
  });

  // AC-082-08 + AC-082-07: re-evaluating unchanged inputs appends nothing —
  // the stored history is the sequence of DISTINCT evaluations, and a
  // changed verdict appends a new row rather than overwriting the old one.
  it("appends a new evaluation row only when the verdict or facts change", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    githubClient.updateIssueComment.mockResolvedValue(okComment(4242));
    githubClient.listPullRequestCommits.mockResolvedValue({
      status: "ok",
      commits: [{ sha: "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d" }],
    });
    const sessionRows = () => [chRow({ TraceId: "t1", OutcomeCommitShas: ["1a2b3c4d"] })];

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery(sessionRows()), githubClient },
    );
    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery(sessionRows()), githubClient },
    );

    // Identical evaluation twice — one row.
    expect(getPrEvidenceEvaluationRows()).toHaveLength(1);
    expect(getPrEvidenceEvaluationRows()[0]).toMatchObject({ verdict: "pass" });

    // A new commit lands with no recorded session — the verdict flips.
    githubClient.listPullRequestCommits.mockResolvedValue({
      status: "ok",
      commits: [
        { sha: "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d" },
        { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      ],
    });
    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery(sessionRows()), githubClient },
    );

    expect(getPrEvidenceEvaluationRows()).toHaveLength(2);
    expect(getPrEvidenceEvaluationRows()[1]).toMatchObject({ verdict: "flag" });
  });

  // AC-082-08: the record happens at evaluation time, independent of the
  // GitHub write — a verdict on a not-yet-permitted installation still
  // counts for the outcomes measurement.
  it("records the evaluation even when posting is not permitted", async () => {
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
    expect(getPrEvidenceEvaluationRows()).toEqual([
      expect.objectContaining({ verdict: "pass", pr_number: PR }),
    ]);
  });

  // An unreadable commit list (403/404, or an older client with no commits
  // method) must cost the FACT, never the comment.
  it("still posts the comment, with the provenance fact omitted, when the commit list is unreadable", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    githubClient.listPullRequestCommits.mockResolvedValue({ status: "not_permitted" });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("Everything checks out");
    expect(body).not.toContain("commits came from recorded sessions");
  });

  // AC-057-02: the comment is created once, then edited in place when a
  // later session syncs onto the same PR — never a second comment.
  it("creates once, then edits the existing comment in place when a later session syncs", async () => {
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
  it("the next edit reflects the session's current duration and cost, not the first-sight values", async () => {
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

  // Three trigger paths hit one comment and queue delivery is at-least-once,
  // so duplicates are the normal case — an unchanged body must never reach
  // GitHub. This is the whole rate-limit defense.
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

    expect(result).toEqual({
      status: "failed",
      reason: "unparseable repository (expected owner/repo): git.acme-enterprise.com/acme/api",
    });
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
        claimed_at: new Date().toISOString(),
      },
    ]);
    const githubClient = fakeGithubClient();

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    // Specifically the back-off, not any other failure: this test would
    // otherwise still pass if the call died before ever reaching the claim.
    expect(result).toEqual({
      status: "failed",
      reason: "concurrent create in flight for this PR",
    });
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

    expect(result).toEqual({
      status: "failed",
      reason: `no organization_name for tenant ${TENANT}`,
    });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // The production client path: no `deps.githubClient`, so the installation
  // id comes from `git_connection` the way every real caller gets it.
  // ---------------------------------------------------------------------

  // The lookup must read the installation off the connection that has PR
  // comments ENABLED. Keying off a disabled connection that happens to share
  // the repo would post through an installation whose owner opted out.
  it("resolves the installation id from the pr_comments_enabled connection, ignoring disabled ones", async () => {
    seedGitConnections([
      {
        tenant_id: TENANT,
        app_id: "app-1",
        repository: REPO,
        pr_comments_enabled: true,
        installation_id: 111,
      },
      {
        tenant_id: TENANT,
        app_id: "app-2",
        repository: REPO,
        pr_comments_enabled: false,
        installation_id: 222,
      },
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: "acme" }] });
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const createIssueComment = vi.fn().mockResolvedValue(okComment(4242));
    mockFromContext.mockResolvedValue({ createIssueComment, updateIssueComment: vi.fn() });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]) },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    expect(mockFromContext).toHaveBeenCalledWith(
      { provider: "github", installationId: 111 },
      expect.anything(),
    );
    expect(createIssueComment).toHaveBeenCalledWith(REPO, PR, expect.any(String));
  });

  // git_connection.repository is stamped verbatim at link time — a URL-form
  // remote here — so the installation lookup must match it
  // canonical-to-canonical against the already-canonical `repository`
  // rather than by raw equality.
  it("resolves the installation id from a stored URL-form git_connection.repository", async () => {
    seedGitConnections([
      {
        tenant_id: TENANT,
        app_id: "app-1",
        repository: "https://github.com/acme/api.git",
        pr_comments_enabled: true,
        installation_id: 111,
      },
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: "acme" }] });
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const createIssueComment = vi.fn().mockResolvedValue(okComment(4242));
    mockFromContext.mockResolvedValue({ createIssueComment, updateIssueComment: vi.fn() });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]) },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    expect(mockFromContext).toHaveBeenCalledWith(
      { provider: "github", installationId: 111 },
      expect.anything(),
    );
  });

  // An enabled connection with no installation id can't post. Failing here
  // (rather than falling through to a client built from a junk id) is what
  // keeps the cron sweep's retry meaningful.
  it("fails with a named reason when the enabled connection carries no installation id", async () => {
    seedGitConnections([
      {
        tenant_id: TENANT,
        app_id: "app-1",
        repository: REPO,
        pr_comments_enabled: true,
        installation_id: null,
      },
      // Present precisely to prove it is NOT consulted: an opted-out
      // connection on the same repo, with a perfectly usable installation.
      {
        tenant_id: TENANT,
        app_id: "app-2",
        repository: REPO,
        pr_comments_enabled: false,
        installation_id: 999,
      },
    ]);
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: "acme" }] });
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]) },
    );

    expect(result).toEqual({ status: "failed", reason: "no installation id for this repository" });
    expect(mockFromContext).not.toHaveBeenCalled();
    expect(getPrSessionCommentRows()).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Failure branches on the write path
  // ---------------------------------------------------------------------

  // The narrow race the claim can't close: another caller posts while we
  // render, we take the update path onto THEIR id, and it is deleted before
  // our PATCH lands. Posting a replacement here would be a second comment.
  it("does not re-post when the winner's comment disappears between claim and update", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    // A live claim row with nothing posted yet, so our first read finds no
    // comment to edit and we go to the claim.
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
    // The race, staged precisely: the orchestrator's own read sees no
    // comment id, and by the time the LOST claim re-reads the row, the
    // winner has stamped theirs on it.
    let reads = 0;
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/pr_session_comment`, () => {
        reads += 1;
        const row = {
          id: "prc-1",
          tenant_id: TENANT,
          repository: REPO,
          pr_number: PR,
          github_comment_id: reads === 1 ? null : 321,
          last_body_hash: "",
          last_posted_at: null,
          updated_at: new Date().toISOString(),
        };
        return HttpResponse.json(row);
      }),
    );
    const githubClient = fakeGithubClient();
    // ...but their comment is gone by the time we edit it.
    githubClient.updateIssueComment.mockResolvedValue({ status: "gone" });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({
      status: "failed",
      reason: "comment deleted between claim and update",
    });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
  });

  // Defensive: a fresh POST has no prior id to 404 against, so "gone" from
  // `createIssueComment` is a contract violation, not a recoverable state.
  // It must surface as a failure rather than be persisted as an identity.
  it("fails rather than persisting an identity when the create answers 'gone'", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue({ status: "gone" });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({
      status: "failed",
      reason: "unexpected 'gone' result from createIssueComment",
    });
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: null }),
    ]);
  });

  // ---------------------------------------------------------------------
  // Persisting the comment id after a GitHub write (Fix: retry, then alert)
  // ---------------------------------------------------------------------

  // A GitHub write already happened by the time the identity persist runs —
  // losing the id there strands the comment (the claim row stays
  // `github_comment_id = NULL`, and once CREATE_CLAIM_TTL_MS elapses another
  // caller's takeover POSTs a second one). Retrying past a transient
  // Supabase blip is what keeps a single flaky write from causing that.
  it("retries the identity persist past a transient failure and still reports created with exactly one GitHub POST", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    // The first persist attempt fails; the second (of up to three) succeeds.
    seedPrSessionCommentUpsertErrors(1);

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    expect(getPrSessionCommentRows()).toEqual([
      expect.objectContaining({ github_comment_id: 4242 }),
    ]);
    expect(mockLoggerError).not.toHaveBeenCalled();
  }, 10_000);

  it("reports failed and logs an alertable error carrying the comment id when every persist attempt fails", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    // All three attempts fail.
    seedPrSessionCommentUpsertErrors(3);

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("pr_session_comment upsert failed"),
    });
    expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
    // The GitHub write happened and is now orphaned: an operator must be
    // able to find it from this log.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "pr_session_comment.comment_id_unpersisted",
        tenantId: TENANT,
        repository: REPO,
        prNumber: PR,
        commentId: 4242,
      }),
    );
  }, 10_000);

  // The one failure worth alerting on: confirmed links exist and the
  // sessions behind them can't be read. It is the only state in which the
  // empty state could overwrite a populated comment, so it gets its own
  // metric-bearing error event rather than folding into the generic reason.
  it("logs a dedicated metric event when confirmed links exist but are unreadable", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [
        link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" }),
        link({ id: "l2", app_id: "app-1", trace_id: "t2", method: "pr_link", verification: "confirmed" }),
      ],
    });
    const githubClient = fakeGithubClient();

    // `chQuery: null` is the shape an unconfigured/unreachable ClickHouse
    // resolves to — confirmed links, no way to read them.
    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: null, githubClient },
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      reason: expect.stringContaining("pr_session_comment.links_unreadable"),
    });
    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "LinksUnreadableError" }),
      expect.objectContaining({
        event: "pr_session_comment.links_unreadable",
        _metric: true,
        metric_name: "pr_session_comment.links_unreadable",
        metric_value: 1,
        tenantId: TENANT,
        repository: REPO,
        prNumber: PR,
        confirmedLinkCount: 2,
      }),
    );
  });
  // The duplicate-comment hole the persist retry narrows but cannot close: a
  // claimant that POSTed and then DIED leaves a comment nothing points at.
  // Its claim expires, the next caller takes it over — and without a scan it
  // would post a SECOND comment, publicly, with the first unreachable
  // forever.
  it("adopts a comment an abandoned claim already posted instead of posting a second one", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    // An abandoned claim: claimed long ago, never completed.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: null,
        last_body_hash: "",
        last_posted_at: null,
        claimed_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const githubClient = fakeGithubClient();
    githubClient.listIssueComments.mockResolvedValue({
      status: "ok",
      comments: [
        { id: 111, body: "unrelated review chatter" },
        { id: 222, body: `### Agent sessions behind this PR\n\n${PR_SESSION_COMMENT_MARKER}` },
      ],
    });
    githubClient.updateIssueComment.mockResolvedValue(okComment(222));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(githubClient.createIssueComment).not.toHaveBeenCalled();
    expect(githubClient.updateIssueComment).toHaveBeenCalledWith(REPO, 222, expect.any(String));
    expect(result).toEqual({ status: "updated", commentId: 222 });
    // ...and the recovered id is stored, so no later caller has to scan again.
    expect(getPrSessionCommentRows()[0]!.github_comment_id).toBe(222);
  });

  it("posts fresh on a takeover when no comment of ours is on the PR", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: null,
        last_body_hash: "",
        last_posted_at: null,
        claimed_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const githubClient = fakeGithubClient();
    githubClient.listIssueComments.mockResolvedValue({
      status: "ok",
      comments: [{ id: 111, body: "someone else's comment" }],
    });
    githubClient.createIssueComment.mockResolvedValue(okComment(555));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 555 });
  });

  // The scan costs a GitHub read, so it must not become a per-PR tax on the
  // normal path: a clean first claim has nothing to recover.
  it("does not scan the PR's comments on a clean first post", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(githubClient.listIssueComments).not.toHaveBeenCalled();
  });

  // Completing a post is also what takes the PR off the cron sweep's backlog:
  // the row stops looking like work in progress the moment the comment lands.
  it("clears the claim and the backlog flag once the comment id is persisted", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    // A backlog marker: flagged for refresh, never claimed.
    seedPrSessionCommentMswState([
      {
        tenant_id: TENANT,
        repository: REPO,
        pr_number: PR,
        github_comment_id: null,
        last_body_hash: "",
        last_posted_at: null,
        needs_refresh: true,
      },
    ]);
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4646));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 4646 });
    expect(getPrSessionCommentRows()[0]).toMatchObject({
      github_comment_id: 4646,
      claimed_at: null,
      needs_refresh: false,
    });
  });

  // AC-083-11: the full production path — span rows read back through the
  // ClickHouse seam, evaluated by the fact layer, rendered as comment rows
  // with the validator's sentence verbatim and the backing turns.
  it("renders verification rows from session tool-call spans", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [
        { filename: "src/lib/system/verdict/__tests__/evidence.test.ts", changeStatus: "added" },
        { filename: "src/lib/system/verdict/evidence.ts", changeStatus: "modified" },
      ],
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery(
          [chRow({ TraceId: "t1" })],
          [],
          [
            spanRow("t1", 61, { command: "vitest run", status: "error" }),
            spanRow("t1", 62, { file: "src/lib/system/verdict/evidence.ts" }),
            spanRow("t1", 63, { command: "vitest run" }),
          ],
        ),
        githubClient,
      },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("Everything checks out");
    expect(body).toContain("✓ **New tests failed first, then passed** — turns 61 → 63");
  });

  // AC-083-12: a bypassed git command in the session voids the verdict —
  // the comment opens with the red "can't verify" copy, not an amber ask.
  it("derives the unverifiable verdict from a check-bypass span", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(4242));

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery(
          [chRow({ TraceId: "t1" })],
          [],
          [
            spanRow("t1", 12, { file: "src/lib/a.test.ts" }),
            spanRow("t1", 88, { command: "git push --no-verify" }),
          ],
        ),
        githubClient,
      },
    );

    expect(result).toEqual({ status: "created", commentId: 4242 });
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("We can't verify this PR");
    expect(body).toContain("✕ **A git command skipped the repo's checks** — turn 88");
  });

  // The files read is optional and degradable: a client without the method,
  // and a client answering not_permitted, must both suppress red-then-green
  // (no approximation) while the rest of the comment still renders.
  it("suppresses red-then-green when the file list is unavailable, however that happens", async () => {
    const spanRows = [
      spanRow("t1", 61, { command: "vitest run", status: "error" }),
      spanRow("t1", 62, { file: "src/lib/system/verdict/evidence.ts" }),
      spanRow("t1", 63, { command: "vitest run" }),
    ];

    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const noMethod = fakeGithubClient();
    Reflect.deleteProperty(noMethod, "listPullRequestFiles");
    noMethod.createIssueComment.mockResolvedValue(okComment(111));
    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })], [], spanRows), githubClient: noMethod },
    );
    expect(result).toEqual({ status: "created", commentId: 111 });
    expect(noMethod.createIssueComment.mock.calls[0]![2]).not.toContain(
      "New tests failed first, then passed",
    );
  });

  it("suppresses red-then-green when the file list read is not permitted", async () => {
    const spanRows = [
      spanRow("t1", 61, { command: "vitest run", status: "error" }),
      spanRow("t1", 62, { file: "src/lib/system/verdict/evidence.ts" }),
      spanRow("t1", 63, { command: "vitest run" }),
    ];

    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const notPermitted = fakeGithubClient();
    notPermitted.createIssueComment.mockResolvedValue(okComment(222));
    notPermitted.listPullRequestFiles.mockResolvedValue({ status: "not_permitted" });
    const permResult = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })], [], spanRows), githubClient: notPermitted },
    );
    expect(permResult).toEqual({ status: "created", commentId: 222 });
    expect(notPermitted.createIssueComment.mock.calls[0]![2]).not.toContain(
      "New tests failed first, then passed",
    );
  });

  // A PR whose only "test" change is a DELETED test file adds no tests, so
  // the fail→pass pair in the session stays unproven and produces no row.
  it("does not count removed test files as the diff adding tests", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = fakeGithubClient();
    githubClient.createIssueComment.mockResolvedValue(okComment(333));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [{ filename: "src/lib/old.test.ts", changeStatus: "removed" }],
    });

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery(
          [chRow({ TraceId: "t1" })],
          [],
          [
            spanRow("t1", 61, { command: "vitest run", status: "error" }),
            spanRow("t1", 62, { file: "src/lib/system/verdict/evidence.ts" }),
            spanRow("t1", 63, { command: "vitest run" }),
          ],
        ),
        githubClient,
      },
    );

    expect(githubClient.createIssueComment.mock.calls[0]![2]).not.toContain(
      "New tests failed first, then passed",
    );
  });

  /** Policy-read methods for the wiring tests below — the default fake
   * omits them, which turns the policy feature off (built-in defaults). */
  function policyMethods(files: Record<string, string>) {
    return {
      getPullRequestBaseBranch: vi.fn(async () => "main"),
      listDirectory: vi.fn(async (_repo: string, path: string) =>
        Object.keys(files)
          .filter((file) => file.startsWith(`${path}/`))
          .map((file) => ({ path: file, name: file.split("/").pop()!, type: "file" })),
      ),
      getFileContent: vi.fn(async (_repo: string, path: string, ref: string) => {
        const content = files[path];
        if (content === undefined || ref !== "main") throw new Error(`missing ${path}@${ref}`);
        return { content };
      }),
    };
  }

  const MIGRATION_VALIDATOR = `id: migration-must-run
kind: validation
row: "The migration was actually run"
when:
  paths: ["supabase/migrations/**"]
require:
  session.ran: { command: "supabase migration up", status: ok }
`;

  // AC-085-03: the full production path — policy files at the base branch,
  // a scoped custom, and the matched run rendered as its proof.
  it("renders a custom validator row from the repo's policy files", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...policyMethods({ ".outerlayer/validators/migration-must-run.yaml": MIGRATION_VALIDATOR }),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(7100));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [{ filename: "supabase/migrations/20260815_add_flag.sql", changeStatus: "added" }],
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery(
          [chRow({ TraceId: "t1" })],
          [],
          [spanRow("t1", 9, { command: "npx supabase migration up" })],
        ),
        githubClient,
      },
    );

    expect(result).toEqual({ status: "created", commentId: 7100 });
    expect(githubClient.getFileContent).toHaveBeenCalledWith(
      REPO,
      ".outerlayer/validators/migration-must-run.yaml",
      "main",
    );
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("✓ **The migration was actually run** — turn 9");
  });

  // AC-085-01: `off` in the policy removes a built-in row entirely.
  it("removes a built-in row the policy levels off", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...policyMethods({
        ".outerlayer/policy.yaml": "validators:\n  red-then-green: off\n",
      }),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(7200));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [{ filename: "src/lib/a.test.ts", changeStatus: "added" }],
    });

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      {
        chQuery: fakeChQuery(
          [chRow({ TraceId: "t1" })],
          [],
          [
            spanRow("t1", 61, { command: "vitest run", status: "error" }),
            spanRow("t1", 62, { file: "src/lib/a.ts" }),
            spanRow("t1", 63, { command: "vitest run" }),
          ],
        ),
        githubClient,
      },
    );

    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).not.toContain("New tests failed first, then passed");
    expect(body).toContain("Everything checks out");
  });

  // AC-085-07: a policy that exists but is broken fails loudly as one row
  // while the rest of the comment still renders.
  it("renders a single policy-error row for a broken policy", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...policyMethods({
        ".outerlayer/policy.yaml": "extends: someone-else:strict@v9\nvalidators:\n  ghost: warn\n",
      }),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(7300));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain(
      '⚠ **The policy file has an error** — `.outerlayer/policy.yaml` — unknown preset "someone-else:strict@v9" — this engine ships outerlayer:recommended@v1 (and 1 more)',
    );
    expect(body).toContain("| Session | Topics |");
  });

  it("renders a single-error policy without a remainder count", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...policyMethods({
        ".outerlayer/validators/broken.yaml": "id: Bad_Slug\nrow: r\n",
      }),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(7400));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain(
      "⚠ **The policy file has an error** — `.outerlayer/validators/broken.yaml` — `id` must be a lowercase-dashed slug",
    );
    expect(body).not.toContain("more)");
  });

  function closingIssues(
    issues: Array<{
      number: number;
      title: string;
      body: string;
      labels: string[];
      typeName: string | null;
    }>,
  ) {
    return {
      getPullRequestClosingIssues: vi.fn(async () => ({ status: "ok" as const, issues })),
    };
  }

  const RED_GREEN_SPANS = [
    spanRow("t1", 61, { command: "vitest run", status: "error" }),
    spanRow("t1", 62, { file: "src/lib/a.ts" }),
    spanRow("t1", 63, { command: "vitest run" }),
  ];

  // AC-086-01 + AC-086-02: the comment names its spec and renders the
  // issue's asks as rows, proven by the validators' own results.
  it("names the closing issue and proves its asks end to end", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...closingIssues([
        {
          number: 91,
          title: "Fix the flaky signup",
          body: "### Validation required\n- [ ] red-then-green\n- [ ] screenshot: Settings page renders\n",
          labels: [],
          typeName: null,
        },
      ]),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(8100));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [{ filename: "src/lib/a.test.ts", changeStatus: "added" }],
    });

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })], [], RED_GREEN_SPANS), githubClient },
    );

    expect(result).toEqual({ status: "created", commentId: 8100 });
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("for #91 — Fix the flaky signup");
    expect(body).toContain(
      "✓ **The issue asked for `red-then-green` — proven** · asked in #91 — turns 61 → 63",
    );
    expect(body).toContain(
      "⚠ **Settings page renders — screenshot required, none attached** · asked in #91",
    );
    expect(body).toContain("Look at 1 thing");
  });

  // AC-086-05: an issue-type-scoped custom applies only through the linked
  // issue's context.
  it("applies an issue-scoped custom through the linked issue's type", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      ...policyMethods({
        ".outerlayer/validators/bugs-need-repro.yaml": `id: bugs-need-repro
kind: validation
row: "The bug was reproduced before the fix"
when:
  issue.type: Bug
require:
  validator: red-then-green
`,
      }),
      ...closingIssues([
        { number: 91, title: "Fix the flaky signup", body: "", labels: [], typeName: "Bug" },
      ]),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(8200));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [{ filename: "src/lib/a.test.ts", changeStatus: "added" }],
    });

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })], [], RED_GREEN_SPANS), githubClient },
    );

    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("✓ **The bug was reproduced before the fix** — turns 61 → 63");
  });

  // AC-086-09: a refresh re-reads the issue — an edited block is reflected
  // on the next render.
  it("tracks the issue's current asks across refreshes", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const issue = {
      number: 91,
      title: "Fix the flaky signup",
      body: "### Validation required\n- [ ] screenshot: Settings page renders\n",
      labels: [] as string[],
      typeName: null,
    };
    const githubClient = {
      ...fakeGithubClient(),
      getPullRequestClosingIssues: vi.fn(async () => ({ status: "ok" as const, issues: [issue] })),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(8300));
    githubClient.updateIssueComment.mockResolvedValue(okComment(8300));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    expect(githubClient.createIssueComment.mock.calls[0]![2]).toContain(
      "Settings page renders — screenshot required, none attached",
    );

    issue.body = "### Validation required\n- [ ] video: Full signup flow\n";
    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    const updated = githubClient.updateIssueComment.mock.calls[0]![2];
    expect(updated).toContain("Full signup flow — video required, none attached");
    expect(updated).not.toContain("Settings page renders");
  });

  it("renders without issue context when the closing-issues read is unavailable, and skips it with no confirmed rows", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const githubClient = {
      ...fakeGithubClient(),
      getPullRequestClosingIssues: vi.fn(async () => ({ status: "unavailable" as const })),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(8400));

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );
    expect(githubClient.createIssueComment.mock.calls[0]![2]).not.toMatch(/^for /m);

    // A waiting PR (no confirmed rows) spends no closing-issues read.
    seedPullRequestSessionMswState({
      links: [link({ id: "l2", app_id: "app-1", trace_id: "t2", method: "pr_link", verification: "pending" })],
    });
    const waitingClient = {
      ...fakeGithubClient(),
      ...closingIssues([]),
    };
    waitingClient.createIssueComment.mockResolvedValue(okComment(8401));
    await refreshPrSessionComment(
      { tenantId: TENANT, repository: "acme/waiting", prNumber: 999 },
      { chQuery: fakeChQuery([]), githubClient: waitingClient },
    );
    expect(waitingClient.getPullRequestClosingIssues).not.toHaveBeenCalled();
  });

  // AC-086-08: the citation path end to end — a changed acceptance file
  // declares a test proof, a changed test file cites it, the cell names it.
  it("renders a test-proof criterion's citation through the full refresh", async () => {
    enableFeature();
    seedPullRequestSessionMswState({
      links: [link({ id: "l1", app_id: "app-1", trace_id: "t1", method: "pr_link", verification: "confirmed" })],
    });
    const files: Record<string, string> = {
      "acceptance/090-example.md": "1. `AC-086-08` (proof: test) **Given** x, **Then** y.",
      "src/lib/signup.test.ts": "// AC-086-08\nit(\"proves it\", () => {});",
    };
    const githubClient = {
      ...fakeGithubClient(),
      getFileContent: vi.fn(async (_repo: string, path: string) => {
        const content = files[path];
        if (content === undefined) throw new Error(`missing ${path}`);
        return { content };
      }),
    };
    githubClient.createIssueComment.mockResolvedValue(okComment(8500));
    githubClient.listPullRequestFiles.mockResolvedValue({
      status: "ok",
      files: [
        { filename: "acceptance/090-example.md", changeStatus: "added" },
        { filename: "src/lib/signup.test.ts", changeStatus: "added" },
      ],
    });

    await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery: fakeChQuery([chRow({ TraceId: "t1" })]), githubClient },
    );

    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("| `AC-086-08` | cited by `src/lib/signup.test.ts` |");
  });
});
