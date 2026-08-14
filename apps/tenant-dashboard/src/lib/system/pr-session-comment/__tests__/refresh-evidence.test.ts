/**
 * refreshPrSessionComment × evidence: artifacts read from the `artifact`
 * table and criterion proofs fetched from the PR's changed acceptance files
 * land in the posted body; artifact-less PRs never pay for either.
 */
import { http, HttpResponse } from "msw";
import { getEqParam } from "@repo/test-msw";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { server } from "@/test-helpers/msw-server";
import {
  seedMembershipMswState,
  seedPullRequestSessionMswState,
  seedSupabaseMswState,
  seedArtifactMswRows,
  type ArtifactMswRow,
} from "@/test-helpers/msw-handlers";

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/system/git/github/client", () => ({
  GitHubProvider: { fromContext: vi.fn() },
}));
vi.mock("@/octo-kit", () => ({
  getGithubApp: () => ({ octokitApp: "fake-app" }),
}));

import { refreshPrSessionComment } from "../refresh";
import type { IssueCommentResult } from "@/lib/system/git/github/client";

const SUPABASE_URL = "http://localhost:54321";
const TENANT = "tenant-1";
const REPO = "acme/api";
const PR = 61;

function enableFeature() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, ({ request }) => {
      const url = new URL(request.url);
      if (getEqParam(url, "tenant_id") && getEqParam(url, "tenant_id") !== TENANT) {
        return HttpResponse.json([]);
      }
      return HttpResponse.json([{ app_id: "app-1", repository: REPO, installation_id: null }]);
    }),
  );
  seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: "acme" }] });
}

const chQuery = vi.fn(async (sql: string) => {
  if (sql.includes("agent_session_summary")) {
    return [
      {
        TraceId: "t1",
        Title: "Fix signup allowlist",
        AgentType: "claude-code",
        StartedAt: "2026-07-10 09:00:00.000",
        EndedAt: "2026-07-10 09:41:00.000",
        CostUsd: 3.12,
        Models: ["opus-5"],
        ApiErrorCount: 0,
        ErrorCount: 0,
        AppId: "app-1",
      },
    ];
  }
  return [];
});

const okComment = (id: number): IssueCommentResult => ({
  status: "ok",
  id,
  body: "body",
  htmlUrl: `https://github.com/acme/api/issues/${PR}#issuecomment-${id}`,
});

const artifactRow = (over: Partial<ArtifactMswRow>): ArtifactMswRow => ({
  id: "a1",
  tenant_id: TENANT,
  app_id: "app-1",
  filename: "evidence.png",
  kind: "screenshot",
  caption: "Comment rendered with artifacts",
  criterion_id: "",
  provenance: "session",
  repository: REPO,
  pr_number: PR,
  verification: "confirmed",
  emitted_at: "2026-07-10T09:30:00.000Z",
  ...over,
});

beforeEach(() => {
  seedPullRequestSessionMswState({
    pullRequests: [],
    links: [
      {
        id: "l1",
        tenant_id: TENANT,
        app_id: "app-1",
        pr_number: PR,
        trace_id: "t1",
        session_id: "s-t1",
        method: "pr_link",
        verification: "confirmed",
        git_branch: "",
        first_linked_at: "2026-07-01T00:00:00.000Z",
        last_reconciled_at: "2026-07-01T00:00:00.000Z",
      },
    ],
  });
  enableFeature();
});

describe("refreshPrSessionComment — evidence", () => {
  // proves AC-084-11
  it("posts a body whose Evidence block lists the PR's artifacts and criterion proofs", async () => {
    seedArtifactMswRows([
      artifactRow({ id: "a1", criterion_id: "AC-084-11" }),
      artifactRow({
        id: "a2",
        filename: "run.log",
        kind: "log",
        caption: "gate output",
        provenance: "ci",
        emitted_at: "2026-07-10T09:45:00.000Z",
      }),
    ]);
    const githubClient = {
      createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9001)),
      updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9001)),
      listPullRequestFiles: vi.fn(async () => ({
        status: "ok" as const,
        files: [{ filename: "acceptance/082-artifacts.md", changeStatus: "added" }],
      })),
      getFileContent: vi.fn(async () => ({
        content: "1. `AC-084-11` (proof: screenshot) **Given** x, **Then** y.",
      })),
    };

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient },
    );

    expect(result.status).toBe("created");
    expect(githubClient.listPullRequestFiles).toHaveBeenCalledWith(REPO, PR);
    expect(githubClient.getFileContent).toHaveBeenCalledWith(
      REPO,
      "acceptance/082-artifacts.md",
      `refs/pull/${PR}/head`,
    );
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("**Evidence** · 2 artifacts");
    expect(body).toContain("| `AC-084-11` | [screenshot · evidence.png](");
    expect(body).toContain("[log · run.log](");
    expect(body).toContain("`ci`");
    expect(body).toContain("gate output");
  });

  it("skips the criteria content reads when the PR touches no acceptance files", async () => {
    const githubClient = {
      createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9002)),
      updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9002)),
      // The verification facts still read the changed-file list; a diff
      // with no acceptance files must add no content fetches on top —
      // criteria reads no longer require artifacts (a `proof: test`
      // criterion surfaces without any), so the cost boundary is the
      // acceptance-file filter itself.
      listPullRequestFiles: vi.fn(async () => ({
        status: "ok" as const,
        files: [{ filename: "src/lib/system/verdict/custom.ts", changeStatus: "modified" }],
      })),
      getFileContent: vi.fn(),
    };

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient },
    );

    expect(result.status).toBe("created");
    expect(githubClient.getFileContent).not.toHaveBeenCalled();
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).not.toContain("**Evidence**");
  });

  it("degrades to artifacts-without-criteria when the criteria content read fails", async () => {
    seedArtifactMswRows([artifactRow({ id: "a1" })]);
    const githubClient = {
      createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9003)),
      updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9003)),
      listPullRequestFiles: vi.fn(async () => ({
        status: "ok" as const,
        files: [{ filename: "acceptance/082-artifacts.md", changeStatus: "added" }],
      })),
      getFileContent: vi.fn(async () => {
        throw new Error("github unavailable");
      }),
    };

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient },
    );

    expect(result.status).toBe("created");
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("**Evidence** · 1 artifact");
    expect(body).not.toContain("| Criterion | Proof |");
  });

  it("posts an evidence-only comment for a PR whose only anchor is a CI artifact, and skips when there is nothing at all", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    const bare = {
      createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9004)),
      updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9004)),
    };

    const skipped = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient: bare },
    );
    expect(skipped).toEqual({ status: "skipped-no-links" });
    expect(bare.createIssueComment).not.toHaveBeenCalled();

    seedArtifactMswRows([
      artifactRow({ id: "ci-only", provenance: "ci", filename: "gate.log", kind: "log" }),
    ]);
    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient: bare },
    );

    expect(result.status).toBe("created");
    const body = bare.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("**Evidence** · 1 artifact");
    expect(body).toContain("[log · gate.log](");
    expect(body).not.toContain("Waiting for session evidence");
  });

  it("fetches the changed-file list only when a consumer needs it — never for an artifact-only PR without a content reader", async () => {
    seedPullRequestSessionMswState({ pullRequests: [], links: [] });
    seedArtifactMswRows([
      artifactRow({ id: "ci-only-2", provenance: "ci", filename: "gate.log", kind: "log" }),
    ]);
    // No sessions (the facts consumer is off) and no getFileContent (the
    // criteria consumer is off): the one remaining method must stay uncalled.
    const githubClient = {
      createIssueComment: vi.fn<(repo: string, issueNumber: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9005)),
      updateIssueComment: vi.fn<(repo: string, commentId: number, body: string) => Promise<IssueCommentResult>>(async () => okComment(9005)),
      listPullRequestFiles: vi.fn(async () => ({
        status: "ok" as const,
        files: [{ filename: "acceptance/082-artifacts.md", changeStatus: "added" }],
      })),
    };

    const result = await refreshPrSessionComment(
      { tenantId: TENANT, repository: REPO, prNumber: PR },
      { chQuery, githubClient },
    );

    expect(result.status).toBe("created");
    expect(githubClient.listPullRequestFiles).not.toHaveBeenCalled();
    const body = githubClient.createIssueComment.mock.calls[0]![2];
    expect(body).toContain("**Evidence** · 1 artifact");
    expect(body).not.toContain("| Criterion | Proof |");
  });
});
