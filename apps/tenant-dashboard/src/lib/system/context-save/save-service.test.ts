/**
 * Port-injected unit tests for the context save-path service. No Supabase
 * mocks — every dependency is a hand-built port per `save-service.ts`'s
 * exported port interfaces; `@repo/context-core` runs for real (it's a pure
 * library, no I/O) so validation-error assertions pin its actual output.
 */

import type { GitProvider } from "../git/git-provider.interface";
import type { Commit, CommitWithFallbackResult, FileContent, FileEntry } from "../git/types";
import { FileNotFoundError } from "../git/errors";
import {
  APP_CONNECTION_COMMIT_AUTHOR,
  commitContextChanges,
  enumerateSkillDeletion,
  saveContextFile,
  type GitConnectionPort,
  type MirrorReadPort,
  type PolicyPort,
  type SaveServicePorts,
} from "./save-service";

const APP_ID = "app-1";
const REPOSITORY = "acme/widgets";
const BRANCH = "main";
const ACTOR = { name: "Test User", email: "test@example.com" };

function fakeCommit(sha: string): Commit {
  return { sha, message: "x", author: APP_CONNECTION_COMMIT_AUTHOR, timestamp: "2026-07-10T00:00:00Z", url: `https://example.com/${sha}` };
}

function createMockProvider(overrides?: {
  fileShas?: Record<string, string>;
  commitResult?: CommitWithFallbackResult;
  /** dirPath -> entries at that one tree level, for the `walkDirectoryFiles` fallback. */
  directoryTree?: Record<string, FileEntry[]>;
  /** When set, `listTree` resolves with these blobs instead of throwing. */
  treeBlobs?: Array<{ path: string; sha: string; size: number }>;
}): GitProvider {
  const fileShas = overrides?.fileShas ?? {};
  const directoryTree = overrides?.directoryTree ?? {};
  return {
    type: "github",
    getFileContent: vi.fn(async (_repo: string, path: string): Promise<FileContent> => {
      const sha = fileShas[path];
      if (sha === undefined) throw new FileNotFoundError("github", REPOSITORY, path);
      return { path, content: "", sha, size: 0, encoding: "utf-8" };
    }),
    createCommitWithFallback: vi.fn(
      async (): Promise<CommitWithFallbackResult> =>
        overrides?.commitResult ?? { landed: "branch", commit: fakeCommit("new-sha") },
    ),
    getFileRaw: vi.fn(),
    listDirectory: vi.fn(async (_repo: string, path: string): Promise<FileEntry[]> => directoryTree[path] ?? []),
    listTree: vi.fn(async () => {
      if (overrides?.treeBlobs) return overrides.treeBlobs;
      throw new Error("tree too large");
    }),
    listRepositories: vi.fn(),
    listBranches: vi.fn(),
    getLatestCommitSha: vi.fn(),
    createCommit: vi.fn(),
    compareCommits: vi.fn(),
    getCommitHistory: vi.fn(),
    registerWebhook: vi.fn(),
    removeWebhook: vi.fn(),
    verifyWebhookSignature: vi.fn(),
  } as unknown as GitProvider;
}

function createPorts(opts: {
  provider: GitProvider;
  requirePullRequest?: boolean;
  snapshotPaths?: string[];
}): SaveServicePorts {
  const connection: GitConnectionPort = {
    loadForApp: vi.fn(async () => ({ provider: opts.provider, repository: REPOSITORY, branch: BRANCH })),
  };
  const policy: PolicyPort = {
    loadForApp: vi.fn(async () => ({ requirePullRequest: opts.requirePullRequest ?? false })),
  };
  const mirror: MirrorReadPort = {
    headBlobSha: vi.fn(async () => null),
    snapshotPaths: vi.fn(async () => opts.snapshotPaths ?? []),
  };
  return { connection, policy, mirror };
}

describe("saveContextFile", () => {
  it("commits a direct update with the exact createCommitWithFallback args", async () => {
    const provider = createMockProvider({
      fileShas: { ".outerlayer/docs/setup.md": "base-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("new-sha-123") },
    });
    const ports = createPorts({ provider, requirePullRequest: false });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/setup.md",
      content: "# Setup\n\nSteps.",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: { landed: "branch", commitSha: "new-sha-123", branch: BRANCH },
      warnings: [],
    });

    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [{ path: ".outerlayer/docs/setup.md", content: "# Setup\n\nSteps.", operation: "update" }],
      "context: update reference setup\n\nSaved-by: Test User <test@example.com>",
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: false,
        headBranchName: "outerlayer/context/main",
        pullRequestTitle: "Context changes for main",
      },
    );
  });

  it("forces PR mode when the app's publish policy requires it, and maps PR fields exactly", async () => {
    const provider = createMockProvider({
      fileShas: { ".outerlayer/docs/setup.md": "base-sha" },
      commitResult: {
        landed: "pull_request",
        commit: fakeCommit("new-sha-456"),
        pullRequestUrl: "https://github.com/acme/widgets/pull/5",
        pullRequestNumber: 5,
        pullRequestAction: "created",
        fallbackReason: "forced",
        fallbackBranch: "outerlayer/context/main",
      },
    });
    const ports = createPorts({ provider, requirePullRequest: true });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/setup.md",
      content: "# Setup\n\nSteps.",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: {
        landed: "pull_request",
        commitSha: "new-sha-456",
        pullRequestUrl: "https://github.com/acme/widgets/pull/5",
        pullRequestNumber: 5,
        prAction: "created",
        reason: "config",
        branch: BRANCH,
      },
      warnings: [],
    });
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      expect.any(Array),
      expect.any(String),
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: true,
        headBranchName: "outerlayer/context/main",
        pullRequestTitle: "Context changes for main",
      },
    );
  });

  it("maps an updated accumulating PR and a protected-branch fallback exactly (prAction/reason)", async () => {
    const provider = createMockProvider({
      fileShas: { ".outerlayer/docs/setup.md": "base-sha" },
      commitResult: {
        landed: "pull_request",
        commit: fakeCommit("acc-sha"),
        pullRequestUrl: "https://github.com/acme/widgets/pull/9",
        pullRequestNumber: 9,
        pullRequestAction: "updated",
        fallbackReason: "protected_branch",
        fallbackBranch: "outerlayer/context/main",
      },
    });
    // Policy did NOT force a PR — the provider fell back because the branch is
    // protected. The mapped reason must reflect the fallback, not the policy.
    const ports = createPorts({ provider, requirePullRequest: false });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/setup.md",
      content: "# Setup\n\nSteps.",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: {
        landed: "pull_request",
        commitSha: "acc-sha",
        pullRequestUrl: "https://github.com/acme/widgets/pull/9",
        pullRequestNumber: 9,
        prAction: "updated",
        reason: "protected_branch",
        branch: BRANCH,
      },
      warnings: [],
    });
  });

  it("sanitizes a slashed, uppercased target branch into the stable head branch name", async () => {
    const provider = createMockProvider({
      fileShas: { ".outerlayer/docs/setup.md": "base-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("s1") },
    });
    const ports: SaveServicePorts = {
      connection: {
        loadForApp: vi.fn(async () => ({
          provider,
          repository: REPOSITORY,
          branch: "Feature/New Docs",
        })),
      },
      policy: { loadForApp: vi.fn(async () => ({ requirePullRequest: false })) },
      mirror: { headBlobSha: vi.fn(async () => null), snapshotPaths: vi.fn(async () => []) },
    };

    await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/setup.md",
      content: "# Setup\n\nSteps.",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      expect.any(Array),
      expect.any(String),
      "Feature/New Docs",
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: false,
        headBranchName: "outerlayer/context/feature/new-docs",
        pullRequestTitle: "Context changes for Feature/New Docs",
      },
    );
  });

  it("rejects a save against a stale base blob sha as a typed conflict, without committing", async () => {
    const provider = createMockProvider({ fileShas: { ".outerlayer/docs/setup.md": "remote-sha" } });
    const ports = createPorts({ provider });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/setup.md",
      content: "changed",
      baseBlobSha: "stale-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "conflict",
      path: ".outerlayer/docs/setup.md",
      remoteSha: "remote-sha",
      reason: "modified",
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a create when the path already exists at head, without committing", async () => {
    const provider = createMockProvider({ fileShas: { ".outerlayer/docs/new.md": "existing-sha" } });
    const ports = createPorts({ provider });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/docs/new.md",
      content: "new content",
      baseBlobSha: null,
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "conflict",
      path: ".outerlayer/docs/new.md",
      remoteSha: "existing-sha",
      reason: "exists",
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a crafted `..` path as a validation error, never loading the connection or calling git", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/../secret/evil.md",
      content: "# evil\n",
      baseBlobSha: null,
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      errors: [{ path: "(path)", code: "path_traversal", message: '".outerlayer/../secret/evil.md" must not contain a ".." path segment' }],
    });
    expect(ports.connection.loadForApp).not.toHaveBeenCalled();
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("blocks AGENTS.md frontmatter with the exact FieldIssue, never calling git", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/AGENTS.md",
      content: "---\nfoo: bar\n---\nBody",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      errors: [
        { path: "(frontmatter)", code: "frontmatter_forbidden", message: "AGENTS.md must not have frontmatter" },
      ],
    });
    expect(ports.connection.loadForApp).not.toHaveBeenCalled();
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("blocks a literal secret value in mcp.json with the exact FieldIssue, never calling git", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const content = JSON.stringify({
      mcpServers: { foo: { command: "run-server", env: { API_KEY: "sk-abcdef1234567890" } } },
    });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path: ".outerlayer/mcp.json",
      content,
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      errors: [
        {
          path: "mcpServers.foo.env.API_KEY",
          code: "secret-literal",
          message: '"API_KEY" looks like a literal secret (known-secret-prefix); use ${VAR} instead',
        },
      ],
    });
    expect(ports.connection.loadForApp).not.toHaveBeenCalled();
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a CREATE whose path has an over-64-char segment, before any git work", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });
    const path = `.outerlayer/skills/${"a".repeat(65)}/SKILL.md`;

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path,
      content: "# anything\n",
      baseBlobSha: null,
      actor: ACTOR,
    });

    expect(outcome.status).toBe("validation_error");
    const errors = (outcome as { errors: { code: string; message: string }[] }).errors;
    expect(errors[0]?.code).toBe("path_too_long");
    expect(errors[0]?.message).toContain("64-character");
    expect(ports.connection.loadForApp).not.toHaveBeenCalled();
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a CREATE whose full path exceeds 180 chars even with in-cap segments", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });
    // 12 + 64 + 1 + 64 + 1 + 39 = 181, every segment ≤ 64.
    const path = `.outerlayer/${"a".repeat(64)}/${"a".repeat(64)}/${"a".repeat(39)}`;
    expect(path.length).toBe(181);

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path,
      content: "# anything\n",
      baseBlobSha: null,
      actor: ACTOR,
    });

    expect(outcome.status).toBe("validation_error");
    const errors = (outcome as { errors: { code: string; message: string }[] }).errors;
    expect(errors[0]?.code).toBe("path_too_long");
    expect(errors[0]?.message).toContain("180-character");
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("never length-checks an UPDATE — a pre-existing over-length path is not rejected for length", async () => {
    const path = `.outerlayer/docs/${"a".repeat(64)}/${"a".repeat(64)}/${"a".repeat(39)}.md`;
    expect(path.length).toBeGreaterThan(180);
    const provider = createMockProvider({
      fileShas: { [path]: "base-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("upd-sha") },
    });
    const ports = createPorts({ provider });

    const outcome = await saveContextFile(ports, {
      appId: APP_ID,
      path,
      content: "# Doc body\n",
      baseBlobSha: "base-sha",
      actor: ACTOR,
    });

    // The length gate is create-only; an edit of a long-path file must never
    // surface a path_too_long error (it either commits or fails for another
    // reason, but never for length).
    if (outcome.status === "validation_error") {
      const errors = (outcome as { errors: { code: string }[] }).errors;
      expect(errors.every((e) => e.code !== "path_too_long")).toBe(true);
    } else {
      expect(outcome.status).toBe("saved");
    }
  });
});

const SKILL_DIR = ".outerlayer/skills/my-skill";
const SKILL_MD = ".outerlayer/skills/my-skill/SKILL.md";

describe("enumerateSkillDeletion", () => {
  it("merges mirrored content paths with a live git walk, surfacing non-mirrored assets separately", async () => {
    const scriptPy = `${SKILL_DIR}/scripts/run.py`;
    const provider = createMockProvider({
      directoryTree: {
        [SKILL_DIR]: [
          { path: SKILL_MD, name: "SKILL.md", type: "file", sha: "sha-skill" },
          { path: `${SKILL_DIR}/scripts`, name: "scripts", type: "dir" },
        ],
        [`${SKILL_DIR}/scripts`]: [{ path: scriptPy, name: "run.py", type: "file", sha: "sha-script" }],
      },
    });
    const ports = createPorts({ provider, snapshotPaths: [SKILL_MD] });

    const outcome = await enumerateSkillDeletion(ports, APP_ID, SKILL_DIR);

    expect(outcome).toEqual({
      status: "ok",
      enumeration: {
        paths: [SKILL_MD, scriptPy],
        assetPaths: [scriptPy],
        shas: { [SKILL_MD]: "sha-skill", [scriptPy]: "sha-script" },
      },
    });
  });

  it("omits a path from `shas` when the provider's live listing carries no sha for it", async () => {
    const provider = createMockProvider({
      directoryTree: {
        [SKILL_DIR]: [{ path: SKILL_MD, name: "SKILL.md", type: "file" }],
      },
    });
    const ports = createPorts({ provider, snapshotPaths: [SKILL_MD] });

    const outcome = await enumerateSkillDeletion(ports, APP_ID, SKILL_DIR);

    expect(outcome).toEqual({
      status: "ok",
      enumeration: { paths: [SKILL_MD], assetPaths: [], shas: {} },
    });
  });

  it("enumerates via one bulk listTree call filtered by the directory prefix, never calling listDirectory", async () => {
    const scriptPy = `${SKILL_DIR}/scripts/run.py`;
    const outsidePath = ".outerlayer/skills/other-skill/SKILL.md";
    // A sibling whose NAME merely starts with the same string
    // (`my-skill-notes` starts with `my-skill`) — without a trailing "/" on
    // the filter prefix this would wrongly match too.
    const siblingPrefixPath = ".outerlayer/skills/my-skill-notes/SKILL.md";
    const provider = createMockProvider({
      treeBlobs: [
        { path: SKILL_MD, sha: "sha-skill", size: 10 },
        { path: scriptPy, sha: "sha-script", size: 20 },
        { path: outsidePath, sha: "sha-other", size: 5 },
        { path: siblingPrefixPath, sha: "sha-sibling", size: 5 },
      ],
    });
    const ports = createPorts({ provider, snapshotPaths: [SKILL_MD] });

    const outcome = await enumerateSkillDeletion(ports, APP_ID, SKILL_DIR);

    expect(outcome).toEqual({
      status: "ok",
      enumeration: {
        paths: [SKILL_MD, scriptPy],
        assetPaths: [scriptPy],
        shas: { [SKILL_MD]: "sha-skill", [scriptPy]: "sha-script" },
      },
    });
    expect(provider.listTree).toHaveBeenCalledTimes(1);
    expect(provider.listTree).toHaveBeenCalledWith(REPOSITORY, BRANCH);
    expect(provider.listDirectory).not.toHaveBeenCalled();
  });

  it("falls back to the walkDirectoryFiles recursion when listTree throws past the provider's tree cap", async () => {
    const scriptPy = `${SKILL_DIR}/scripts/run.py`;
    const provider = createMockProvider({
      directoryTree: {
        [SKILL_DIR]: [
          { path: SKILL_MD, name: "SKILL.md", type: "file", sha: "sha-skill" },
          { path: `${SKILL_DIR}/scripts`, name: "scripts", type: "dir" },
        ],
        [`${SKILL_DIR}/scripts`]: [{ path: scriptPy, name: "run.py", type: "file", sha: "sha-script" }],
      },
    });
    const ports = createPorts({ provider, snapshotPaths: [SKILL_MD] });

    const outcome = await enumerateSkillDeletion(ports, APP_ID, SKILL_DIR);

    expect(outcome).toEqual({
      status: "ok",
      enumeration: {
        paths: [SKILL_MD, scriptPy],
        assetPaths: [scriptPy],
        shas: { [SKILL_MD]: "sha-skill", [scriptPy]: "sha-script" },
      },
    });
    expect(provider.listTree).toHaveBeenCalledTimes(1);
    expect(provider.listDirectory).toHaveBeenCalledWith(REPOSITORY, SKILL_DIR, BRANCH);
  });
});

describe("commitContextChanges", () => {
  const UPDATE_PATH = ".outerlayer/docs/setup.md";
  const CREATE_PATH = ".outerlayer/docs/deploy.md";

  it("commits every file in ONE atomic createCommitWithFallback call, mixing create and update", async () => {
    const provider = createMockProvider({
      fileShas: { [UPDATE_PATH]: "base-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("batch-sha") },
    });
    const ports = createPorts({ provider, requirePullRequest: false });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: UPDATE_PATH, content: "# Setup\n\nUpdated.", baseBlobSha: "base-sha" },
        { path: CREATE_PATH, content: "# Deploy\n\nNew file.", baseBlobSha: null },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: { landed: "branch", commitSha: "batch-sha", branch: BRANCH },
      warnings: [],
    });

    // One commit for both files, with the exact positional FileChange[].
    expect(provider.createCommitWithFallback).toHaveBeenCalledTimes(1);
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [
        { path: UPDATE_PATH, content: "# Setup\n\nUpdated.", operation: "update" },
        { path: CREATE_PATH, content: "# Deploy\n\nNew file.", operation: "create" },
      ],
      "Update context files\n\nSaved-by: Test User <test@example.com>",
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: false,
        headBranchName: "outerlayer/context/main",
        pullRequestTitle: "Context changes for main",
      },
    );
  });

  it("rejects a crafted `..` path in a batch as a validation error, never touching git", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: ".outerlayer/../../x/evil.md", content: "# evil\n", baseBlobSha: null }],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      fileErrors: [
        {
          path: ".outerlayer/../../x/evil.md",
          errors: [{ path: "(path)", code: "path_traversal", message: '".outerlayer/../../x/evil.md" must not contain a ".." path segment' }],
        },
      ],
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a crafted `..` in a .gitkeep folder path (the newly-accepted folder kind)", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: ".outerlayer/../secret/.gitkeep", content: "", baseBlobSha: null }],
      actor: ACTOR,
    });

    expect(outcome.status).toBe("validation_error");
    const failure = outcome as Extract<typeof outcome, { status: "validation_error" }>;
    expect(failure.fileErrors[0]!.errors[0]!.code).toBe("path_traversal");
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("accepts a legitimate .gitkeep folder create (happy-path control) and commits it", async () => {
    const provider = createMockProvider({ commitResult: { landed: "branch", commit: fakeCommit("folder-sha") } });
    const ports = createPorts({ provider, requirePullRequest: false });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: ".outerlayer/docs/guides/.gitkeep", content: "", baseBlobSha: null }],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: { landed: "branch", commitSha: "folder-sha", branch: BRANCH },
      warnings: [],
    });
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [{ path: ".outerlayer/docs/guides/.gitkeep", content: "", operation: "create" }],
      expect.any(String),
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      expect.objectContaining({ headBranchName: "outerlayer/context/main" }),
    );
  });

  it("uses a sanitized single-line user message when one is supplied", async () => {
    const provider = createMockProvider({ fileShas: { [UPDATE_PATH]: "base-sha" } });
    const ports = createPorts({ provider });

    await commitContextChanges(ports, {
      appId: APP_ID,
      message: "Refresh onboarding docs\nignored second line",
      files: [{ path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" }],
      actor: ACTOR,
    });

    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [{ path: UPDATE_PATH, content: "# Setup\n", operation: "update" }],
      "Refresh onboarding docs\n\nSaved-by: Test User <test@example.com>",
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      expect.objectContaining({ headBranchName: "outerlayer/context/main" }),
    );
  });

  it("aggregates every stale-base conflict and never commits when any exist (tri-state: modified/deleted/exists)", async () => {
    // UPDATE_PATH: base 'stale' vs remote 'moved' → modified.
    // MISSING_PATH: update but absent at head → deleted.
    // CREATE_PATH: create but already exists at head → exists.
    const MISSING_PATH = ".outerlayer/docs/gone.md";
    const provider = createMockProvider({
      fileShas: { [UPDATE_PATH]: "moved", [CREATE_PATH]: "already-there" },
    });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "stale" },
        { path: MISSING_PATH, content: "# Gone\n", baseBlobSha: "was-here" },
        { path: CREATE_PATH, content: "# Deploy\n", baseBlobSha: null },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "conflict",
      conflicts: [
        { path: UPDATE_PATH, remoteSha: "moved", reason: "modified" },
        { path: MISSING_PATH, remoteSha: null, reason: "deleted" },
        { path: CREATE_PATH, remoteSha: "already-there", reason: "exists" },
      ],
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("rejects a batch that names the same path twice, before validation or any git call", async () => {
    const provider = createMockProvider({ fileShas: { [UPDATE_PATH]: "base-sha" } });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" },
        { path: UPDATE_PATH, content: "# Setup again\n", baseBlobSha: "base-sha" },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      fileErrors: [
        {
          path: UPDATE_PATH,
          errors: [
            { path: UPDATE_PATH, code: "duplicate_path", message: `"${UPDATE_PATH}" appears more than once in this commit` },
          ],
        },
      ],
    });
    expect(provider.getFileContent).not.toHaveBeenCalled();
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("blocks the whole commit when a single file fails validation (before touching git)", async () => {
    const provider = createMockProvider({ fileShas: { [UPDATE_PATH]: "base-sha" } });
    const ports = createPorts({ provider });
    const badSkill = ".outerlayer/skills/my-skill/SKILL.md"; // unparseable YAML = hard error

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" },
        { path: badSkill, content: "---\nname: [unclosed\n---\n# Body\n", baseBlobSha: null },
      ],
      actor: ACTOR,
    });

    expect(outcome.status).toBe("validation_error");
    const failure = outcome as Extract<typeof outcome, { status: "validation_error" }>;
    expect(failure.fileErrors.map((f) => f.path)).toEqual([badSkill]);
    expect(failure.fileErrors[0]!.errors[0]!.code).toBe("frontmatter_unparseable");
    // Nothing is read from or written to git once a file is invalid.
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
    expect(provider.getFileContent).not.toHaveBeenCalled();
  });

  it("commits a warning-tier file (empty description) — the two-tier gate publishes it", async () => {
    const skillPath = ".outerlayer/skills/my-skill/SKILL.md";
    const provider = createMockProvider({
      commitResult: { landed: "branch", commit: fakeCommit("warn-sha") },
    });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        // Empty description is a WARNING, not a hard error — it must commit.
        { path: skillPath, content: "---\nname: my-skill\ndescription: \n---\n# Body\n", baseBlobSha: null },
      ],
      actor: ACTOR,
    });

    expect(outcome.status).toBe("saved");
    expect(provider.createCommitWithFallback).toHaveBeenCalledTimes(1);
  });

  it("returns not_connected when the app has no git connection", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });
    (ports.connection.loadForApp as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" }],
      actor: ACTOR,
    });

    expect(outcome).toEqual({ status: "not_connected" });
  });

  it("forces the PR path and maps PR fields when the app's publish policy requires it", async () => {
    const provider = createMockProvider({
      fileShas: { [UPDATE_PATH]: "base-sha" },
      commitResult: {
        landed: "pull_request",
        commit: fakeCommit("pr-sha"),
        pullRequestUrl: "https://github.com/acme/widgets/pull/9",
        pullRequestNumber: 9,
      },
    });
    const ports = createPorts({ provider, requirePullRequest: true });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" }],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: {
        landed: "pull_request",
        commitSha: "pr-sha",
        pullRequestUrl: "https://github.com/acme/widgets/pull/9",
        pullRequestNumber: 9,
        prAction: "created",
        reason: "config",
        branch: BRANCH,
      },
      warnings: [],
    });
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      expect.any(Array),
      expect.any(String),
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      expect.objectContaining({ forcePullRequest: true }),
    );
  });

  it("lands directly (no forced PR) when app policy does not require a pull request", async () => {
    const provider = createMockProvider({ fileShas: { [UPDATE_PATH]: "base-sha" } });
    const ports = createPorts({ provider, requirePullRequest: false });

    await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "base-sha" }],
      actor: ACTOR,
    });

    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [{ path: UPDATE_PATH, content: "# Setup\n", operation: "update" }],
      "Update context files\n\nSaved-by: Test User <test@example.com>",
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      { forcePullRequest: false, headBranchName: "outerlayer/context/main", pullRequestTitle: "Context changes for main" },
    );
  });

  const DELETE_PATH = ".outerlayer/docs/old.md";

  it("commits a batch mixing create, update, and delete as ONE atomic call with the exact positional FileChange[]", async () => {
    const provider = createMockProvider({
      fileShas: { [UPDATE_PATH]: "base-sha", [DELETE_PATH]: "del-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("mixed-sha") },
    });
    const ports = createPorts({ provider, requirePullRequest: false });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: UPDATE_PATH, content: "# Setup\n\nUpdated.", baseBlobSha: "base-sha" },
        { path: CREATE_PATH, content: "# Deploy\n\nNew.", baseBlobSha: null },
        { path: DELETE_PATH, content: "", baseBlobSha: "del-sha", delete: true },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "saved",
      result: { landed: "branch", commitSha: "mixed-sha", branch: BRANCH },
      warnings: [],
    });
    expect(provider.createCommitWithFallback).toHaveBeenCalledTimes(1);
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [
        { path: UPDATE_PATH, content: "# Setup\n\nUpdated.", operation: "update" },
        { path: CREATE_PATH, content: "# Deploy\n\nNew.", operation: "create" },
        { path: DELETE_PATH, content: "", operation: "delete" },
      ],
      "Update context files\n\nSaved-by: Test User <test@example.com>",
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      { forcePullRequest: false, headBranchName: "outerlayer/context/main", pullRequestTitle: "Context changes for main" },
    );
  });

  it("conflicts a staged delete whose base drifted (modified) or is already gone (deleted), and never commits", async () => {
    const GONE_PATH = ".outerlayer/docs/gone.md";
    // DELETE_PATH: pinned 'stale' vs remote 'moved' → modified.
    // GONE_PATH: pinned 'was-here' but absent at head → deleted.
    const provider = createMockProvider({ fileShas: { [DELETE_PATH]: "moved" } });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: DELETE_PATH, content: "", baseBlobSha: "stale", delete: true },
        { path: GONE_PATH, content: "", baseBlobSha: "was-here", delete: true },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "conflict",
      conflicts: [
        { path: DELETE_PATH, remoteSha: "moved", reason: "modified" },
        { path: GONE_PATH, remoteSha: null, reason: "deleted" },
      ],
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("stages a delete without validating content — an asset path that can't be classified still commits", async () => {
    const assetPng = ".outerlayer/skills/my-skill/assets/logo.png";
    const provider = createMockProvider({
      fileShas: { [assetPng]: "png-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("asset-del-sha") },
    });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: assetPng, content: "", baseBlobSha: "png-sha", delete: true }],
      actor: ACTOR,
    });

    expect(outcome.status).toBe("saved");
    expect(provider.createCommitWithFallback).toHaveBeenCalledWith(
      REPOSITORY,
      [{ path: assetPng, content: "", operation: "delete" }],
      expect.any(String),
      BRANCH,
      APP_CONNECTION_COMMIT_AUTHOR,
      expect.objectContaining({ headBranchName: "outerlayer/context/main" }),
    );
  });

  it("rejects a staged delete of a path outside every scope's .outerlayer/, without touching git", async () => {
    const provider = createMockProvider({
      fileShas: { "package.json": "pkg-sha", "README.md": "readme-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("should-never-land") },
    });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [
        { path: "package.json", content: "", baseBlobSha: "pkg-sha", delete: true },
        { path: "README.md", content: "", baseBlobSha: "readme-sha", delete: true },
      ],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      fileErrors: [
        {
          path: "package.json",
          errors: [{ path: "(path)", code: "unclassified_path", message: '"package.json" is not a recognized context file path' }],
        },
        {
          path: "README.md",
          errors: [{ path: "(path)", code: "unclassified_path", message: '"README.md" is not a recognized context file path' }],
        },
      ],
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  it("never length-checks a staged delete — a pre-existing over-length path deletes without a path_too_long error", async () => {
    const longPath = `.outerlayer/docs/${"a".repeat(64)}/${"a".repeat(64)}/${"a".repeat(39)}.md`;
    expect(longPath.length).toBeGreaterThan(180);
    const provider = createMockProvider({
      fileShas: { [longPath]: "long-sha" },
      commitResult: { landed: "branch", commit: fakeCommit("long-del-sha") },
    });
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: longPath, content: "", baseBlobSha: "long-sha", delete: true }],
      actor: ACTOR,
    });

    expect(outcome.status).toBe("saved");
  });

  it("rejects a crafted `..` staged-delete path as a validation error, never touching git", async () => {
    const provider = createMockProvider();
    const ports = createPorts({ provider });

    const outcome = await commitContextChanges(ports, {
      appId: APP_ID,
      files: [{ path: ".outerlayer/../../etc/passwd", content: "", baseBlobSha: "x", delete: true }],
      actor: ACTOR,
    });

    expect(outcome).toEqual({
      status: "validation_error",
      fileErrors: [
        {
          path: ".outerlayer/../../etc/passwd",
          errors: [{ path: "(path)", code: "path_traversal", message: '".outerlayer/../../etc/passwd" must not contain a ".." path segment' }],
        },
      ],
    });
    expect(provider.createCommitWithFallback).not.toHaveBeenCalled();
  });

  describe("remote sha resolution — bulk listTree vs bounded-concurrency fallback", () => {
    it("derives the tri-state conflict from ONE bulk listTree call, never reading a file's content", async () => {
      const MISSING_PATH = ".outerlayer/docs/gone.md";
      const provider = createMockProvider({
        treeBlobs: [
          { path: UPDATE_PATH, sha: "moved", size: 10 },
          { path: CREATE_PATH, sha: "already-there", size: 10 },
        ],
      });
      const ports = createPorts({ provider });

      const outcome = await commitContextChanges(ports, {
        appId: APP_ID,
        files: [
          { path: UPDATE_PATH, content: "# Setup\n", baseBlobSha: "stale" },
          { path: MISSING_PATH, content: "# Gone\n", baseBlobSha: "was-here" },
          { path: CREATE_PATH, content: "# Deploy\n", baseBlobSha: null },
        ],
        actor: ACTOR,
      });

      expect(outcome).toEqual({
        status: "conflict",
        conflicts: [
          { path: UPDATE_PATH, remoteSha: "moved", reason: "modified" },
          { path: MISSING_PATH, remoteSha: null, reason: "deleted" },
          { path: CREATE_PATH, remoteSha: "already-there", reason: "exists" },
        ],
      });
      expect(provider.listTree).toHaveBeenCalledTimes(1);
      expect(provider.getFileContent).not.toHaveBeenCalled();
    });

    it("commits a 50-file delete batch via ONE listTree call — zero per-file content reads", async () => {
      const paths = Array.from({ length: 50 }, (_, i) => `.outerlayer/docs/bulk-${i}.md`);
      const provider = createMockProvider({
        treeBlobs: paths.map((path, i) => ({ path, sha: `sha-${i}`, size: 1 })),
        commitResult: { landed: "branch", commit: fakeCommit("bulk-sha") },
      });
      const ports = createPorts({ provider });

      const outcome = await commitContextChanges(ports, {
        appId: APP_ID,
        files: paths.map((path, i) => ({ path, content: "", baseBlobSha: `sha-${i}`, delete: true })),
        actor: ACTOR,
      });

      expect(outcome.status).toBe("saved");
      expect(provider.listTree).toHaveBeenCalledTimes(1);
      expect(provider.getFileContent).not.toHaveBeenCalled();
    });

    it("falls back to per-file reads, never exceeding the concurrency limit, when listTree throws", async () => {
      const paths = Array.from({ length: 25 }, (_, i) => `.outerlayer/docs/wide-${i}.md`);
      let inFlight = 0;
      let maxInFlight = 0;
      const getFileContent = vi.fn(async (_repo: string, path: string): Promise<FileContent> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { path, content: "", sha: "same-sha", size: 0, encoding: "utf-8" };
      });
      const provider: GitProvider = {
        ...createMockProvider(),
        getFileContent,
        listTree: vi.fn(async () => {
          throw new Error("tree too large");
        }),
      };
      const ports = createPorts({ provider });

      const outcome = await commitContextChanges(ports, {
        appId: APP_ID,
        files: paths.map((path) => ({ path, content: "# doc\n", baseBlobSha: "same-sha" })),
        actor: ACTOR,
      });

      expect(outcome.status).toBe("saved");
      expect(getFileContent).toHaveBeenCalledTimes(25);
      // Bounded to the shared concurrency limit, but not serialized to one —
      // proves the fallback is actually concurrent, just capped.
      expect(maxInFlight).toBeLessThanOrEqual(10);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });
});
