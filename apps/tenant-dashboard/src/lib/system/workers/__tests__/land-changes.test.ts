/**
 * createWorkerLandChanges / createWorkerEnsurePr — the git-delivery hooks
 * injected into applyWorkerCallback.
 *
 * Boundary posture: the repo + tracked-branch lookups (git_connection,
 * git_branch) are HTTP → MSW. The git provider and the local-repo lander are
 * seams this file *calls* with stable signatures → vi.mock. The assertions pin
 * the wire→git operation mapping (write→create/update by existence, delete),
 * the base64→utf8 decode, the commit message + PR options, and the result
 * shaping — the parts a runner's diff actually rides through.
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type {
  LandChangesContext,
  EnsurePullRequestContext,
} from "@repo/worker-core";
import { createWorkerLandChanges, createWorkerEnsurePr } from "../land-changes";
import {
  seedManagedDeploymentTablesState,
  seedApiKeysMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { mockCreateProvider, mockIsLocalRepo, mockLandLocal } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
  mockIsLocalRepo: vi.fn(),
  mockLandLocal: vi.fn(),
}));

vi.mock("@/lib/system/git", () => ({ createGitProviderForApp: mockCreateProvider }));
vi.mock("../local-git-lander", () => ({
  isLocalRepo: mockIsLocalRepo,
  landChangesToLocalRepo: mockLandLocal,
}));

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";
const APP_ID = "app-1";

function supabase(): SupabaseClient<Database> {
  return createClient(SUPABASE_URL, ANON) as unknown as SupabaseClient<Database>;
}

/** Seed the git_connection repository and the tracked branch. */
function seedRepo(repository: string, branch: string | null) {
  seedManagedDeploymentTablesState({
    gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: null, repository }],
  });
  seedApiKeysMswState({
    gitBranches: branch ? [{ id: "b1", app_id: APP_ID, branch_name: branch }] : [],
  });
}

function landCtx(over: Partial<LandChangesContext> = {}): LandChangesContext {
  return {
    appId: APP_ID,
    workerRunId: "run-42",
    taskPrompt: "add a thing",
    changes: [],
    branchSlug: "my-slug",
    ...over,
  };
}

describe("createWorkerLandChanges — repo/branch resolution", () => {
  it("rejects when the app has no git connection", async () => {
    // Nothing seeded → git_connection returns no row.
    await expect(createWorkerLandChanges(supabase())(landCtx())).rejects.toThrow(
      "app has no git connection",
    );
  });

  it("rejects when the git connection has no tracked branch", async () => {
    seedRepo("owner/repo", null);
    await expect(createWorkerLandChanges(supabase())(landCtx())).rejects.toThrow(
      "no tracked branch",
    );
  });
});

describe("createWorkerLandChanges — local repo path", () => {
  it("delegates to landChangesToLocalRepo with the override branch and returns its result", async () => {
    seedRepo("/tmp/repo.git", "main");
    mockIsLocalRepo.mockReturnValue(true);
    const landed = { branchName: "outerlayer/worker/my-slug", prUrl: "file:///tmp/repo.git#x", prNumber: null };
    mockLandLocal.mockResolvedValue(landed);

    const ctx = landCtx();
    const result = await createWorkerLandChanges(supabase(), { baseBranchOverride: "feature-x" })(ctx);

    // baseBranchOverride wins over the tracked 'main'.
    expect(mockLandLocal).toHaveBeenCalledWith("/tmp/repo.git", "feature-x", ctx);
    expect(result).toBe(landed);
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });
});

describe("createWorkerLandChanges — hosted provider path", () => {
  it("rejects when no git provider is configured", async () => {
    seedRepo("owner/repo", "main");
    mockIsLocalRepo.mockReturnValue(false);
    mockCreateProvider.mockResolvedValue(null);

    await expect(createWorkerLandChanges(supabase())(landCtx())).rejects.toThrow(
      "no git provider configured",
    );
  });

  it("maps wire changes to git operations, decodes base64, and passes exact commit + PR options", async () => {
    seedRepo("owner/repo", "main");
    mockIsLocalRepo.mockReturnValue(false);

    // getFileContent decides create vs update: object=exists→update,
    // null=missing→create, throw→create.
    const getFileContent = vi.fn(async (_repo: string, path: string) => {
      if (path === "exists.txt") return { path, content: "old", sha: "s", size: 3, encoding: "utf-8" };
      if (path === "missing.txt") return null;
      throw new Error("provider 404");
    });
    const createCommitWithFallback = vi.fn(async () => ({
      landed: "pull_request",
      commit: { sha: "c1", message: "m", author: { name: "a", email: "e" }, timestamp: "t", url: "u" },
      fallbackBranch: "outerlayer/worker/my-slug-ab12",
      pullRequestUrl: "https://github.com/owner/repo/pull/7",
      pullRequestNumber: 7,
    }));
    mockCreateProvider.mockResolvedValue({ getFileContent, createCommitWithFallback } as never);

    const longPrompt =
      "add a really long feature that definitely exceeds the seventy-two character commit limit";
    const ctx = landCtx({
      taskPrompt: longPrompt,
      changes: [
        { path: "exists.txt", operation: "write", content: Buffer.from("hi").toString("base64"), encoding: "base64" },
        { path: "missing.txt", operation: "write", content: "fresh", encoding: "utf8" },
        { path: "throws.txt", operation: "write", content: "boom", encoding: "utf8" },
        { path: "gone.txt", operation: "delete", encoding: "utf8" },
      ] as LandChangesContext["changes"],
    });

    const result = await createWorkerLandChanges(supabase())(ctx);

    const expectedMessage = `agent: ${longPrompt}`.slice(0, 72);
    expect(createCommitWithFallback).toHaveBeenCalledWith(
      "owner/repo",
      [
        { path: "exists.txt", content: "hi", operation: "update" },
        { path: "missing.txt", content: "fresh", operation: "create" },
        { path: "throws.txt", content: "boom", operation: "create" },
        { path: "gone.txt", content: "", operation: "delete" },
      ],
      expectedMessage,
      "main",
      { name: "AgentMark Worker", email: "workers@agentmark.co" },
      {
        forcePullRequest: true,
        headBranchPrefix: "outerlayer/worker",
        headBranchSlug: "my-slug",
        pullRequestBody: `Automated changes from a cloud worker run.\n\n> ${longPrompt}\n\nRun \`run-42\`.`,
      },
    );
    // Message is capped at 72 chars.
    expect(expectedMessage.length).toBe(72);
    // Result maps the PR fields straight through.
    expect(result).toEqual({
      branchName: "outerlayer/worker/my-slug-ab12",
      prUrl: "https://github.com/owner/repo/pull/7",
      prNumber: 7,
    });
  });

  it("defaults the head branch slug to 'task' and falls back to base branch + null PR when the push lands directly", async () => {
    seedRepo("owner/repo", "main");
    mockIsLocalRepo.mockReturnValue(false);
    const createCommitWithFallback = vi.fn(async () => ({
      landed: "branch",
      commit: { sha: "c1", message: "m", author: { name: "a", email: "e" }, timestamp: "t", url: "u" },
    }));
    mockCreateProvider.mockResolvedValue({ getFileContent: vi.fn(), createCommitWithFallback } as never);

    const result = await createWorkerLandChanges(supabase())(landCtx({ branchSlug: undefined, changes: [] }));

    expect(createCommitWithFallback).toHaveBeenCalledWith(
      "owner/repo",
      [],
      expect.any(String),
      "main",
      expect.any(Object),
      expect.objectContaining({ headBranchSlug: "task" }),
    );
    // No fallbackBranch/PR → branch = base, prUrl/prNumber null.
    expect(result).toEqual({ branchName: "main", prUrl: null, prNumber: null });
  });
});

function ensureCtx(over: Partial<EnsurePullRequestContext> = {}): EnsurePullRequestContext {
  return { appId: APP_ID, workerRunId: "run-42", taskPrompt: "add a thing", workBranch: "work/branch", ...over };
}

describe("createWorkerEnsurePr", () => {
  it("returns a file:// compare URL for a local repo (no hosted PR)", async () => {
    seedRepo("/tmp/repo.git", "main");
    mockIsLocalRepo.mockReturnValue(true);

    const result = await createWorkerEnsurePr(supabase())(ensureCtx({ workBranch: "work/branch" }));

    expect(result).toEqual({
      branchName: "work/branch",
      prUrl: "file:///tmp/repo.git#work/branch",
      prNumber: null,
    });
  });

  it("rejects for a hosted repo — persistent PR delivery is not yet wired", async () => {
    seedRepo("owner/repo", "main");
    mockIsLocalRepo.mockReturnValue(false);

    await expect(createWorkerEnsurePr(supabase())(ensureCtx())).rejects.toThrow(
      "hosted persistent-environment PR delivery is not yet wired",
    );
  });
});
