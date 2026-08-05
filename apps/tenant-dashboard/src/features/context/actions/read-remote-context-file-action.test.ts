/**
 * Tests for `readRemoteContextFileAction` — the live-remote-head read backing
 * the editor's staleness re-check and the conflict dialog's "reload remote".
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md):
 *  - The `git_connection` / `context_head` / `git_branch` lookups run under the
 *    request-tenant client (`ctx.db`) and are Supabase HTTP → MSW
 *    (`seedManagedDeploymentTablesState`, `seedContextSaveMswState`,
 *    `seedApiKeysMswState`), never client mocks. `ctx.db` is a real
 *    supabase-js client from the shared MSW test-helper, not the legacy admin
 *    client — the feature tree's admin-client rail keeps `createClient`/
 *    `createSupabaseAdminClient` out of feature files.
 *  - The action-kit seams (`loadRequestServiceContext`, `checkRequestPermission`)
 *    and the `lib/system` provider resolver (`resolveAppGitProvider`) — the one
 *    admin bypass — are `vi.mock` seams.
 */
import { GitProviderError } from "@/lib/adapters/context-git-provider";
import {
  seedApiKeysMswState,
  seedContextSaveMswState,
  seedManagedDeploymentTablesState,
} from "@/test-helpers/msw-handlers";
import { createMswRestClient } from "@/test-helpers/rest-client";

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

const mockResolveAppGitProvider = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/resolve-app-git-provider", () => ({
  resolveAppGitProvider: mockResolveAppGitProvider,
}));

import { readRemoteContextFileAction } from "../action-adapters";

const APP_ID = "app-1";
const PATH = ".outerlayer/AGENTS.md";

function fakeProvider(overrides: Partial<Record<"getLatestCommitSha" | "getFileContent", unknown>> = {}) {
  return {
    getLatestCommitSha: vi.fn(async () => "head-sha"),
    getFileContent: vi.fn(async () => ({ content: "# remote", sha: "blob-sha" })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A real client, so the connection row reads go through the seeded MSW
  // handlers exactly as they would under RLS.
  mockLoadCtx.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "admin" },
  });
  mockCheckPerm.mockResolvedValue(true);
});

describe("readRemoteContextFileAction", () => {
  it("returns the remote content, blob sha, and head commit sha for the connected branch", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "snap-1" }],
    });
    const provider = fakeProvider();
    mockResolveAppGitProvider.mockResolvedValue(provider);

    const res = await readRemoteContextFileAction(APP_ID, PATH);

    expect(res).toEqual({
      data: { content: "# remote", blobSha: "blob-sha", commitSha: "head-sha" },
    });
    // The read targets the CONNECTED branch context is already tracking.
    expect(provider.getLatestCommitSha).toHaveBeenCalledWith("acme/app", "main");
    expect(provider.getFileContent).toHaveBeenCalledWith("acme/app", PATH, "main");
  });

  it("falls back to the tracked deployment branch when context has never synced", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedApiKeysMswState({
      apiKeys: [],
      gitBranches: [{ id: "gb-1", app_id: APP_ID, branch_name: "develop" }],
    });
    const provider = fakeProvider();
    mockResolveAppGitProvider.mockResolvedValue(provider);

    await readRemoteContextFileAction(APP_ID, PATH);

    expect(provider.getFileContent).toHaveBeenCalledWith("acme/app", PATH, "develop");
  });

  it("reports a deleted file (FILE_NOT_FOUND) as null content with the head sha intact", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "snap-1" }],
    });
    mockResolveAppGitProvider.mockResolvedValue(
      fakeProvider({
        getFileContent: vi.fn(async () => {
          throw new GitProviderError("gone", "github", "FILE_NOT_FOUND");
        }),
      }),
    );

    const res = await readRemoteContextFileAction(APP_ID, PATH);

    expect(res).toEqual({ data: { content: null, blobSha: null, commitSha: "head-sha" } });
  });

  it("hands the client a stable generic error for a non-FILE_NOT_FOUND provider failure, logging the raw error", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "snap-1" }],
    });
    const providerError = new GitProviderError("nope", "github", "AUTHENTICATION_FAILED");
    mockResolveAppGitProvider.mockResolvedValue(
      fakeProvider({
        getFileContent: vi.fn(async () => {
          throw providerError;
        }),
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The caller treats an error result the same as a thrown error — its
    // refresh-error branch fires on `res.error` — but the message is a stable
    // generic string, never the raw provider/internal text ("nope").
    const res = await readRemoteContextFileAction(APP_ID, PATH);
    expect(res).toEqual({ error: "remote file read failed" });
    // The full error is preserved for operators in the server log.
    expect(errorSpy).toHaveBeenCalledWith("[context] remote file read failed:", providerError);

    errorSpy.mockRestore();
  });

  it("returns repo_not_connected when the app has no git connection", async () => {
    const res = await readRemoteContextFileAction(APP_ID, PATH);
    expect(res).toEqual({ error: "repo_not_connected" });
    expect(mockResolveAppGitProvider).not.toHaveBeenCalled();
  });

  it("returns no_tracked_branch when neither a context head nor a tracked branch exists", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedApiKeysMswState({ apiKeys: [], gitBranches: [] });

    const res = await readRemoteContextFileAction(APP_ID, PATH);

    expect(res).toEqual({ error: "no_tracked_branch" });
  });

  it("returns git_provider_unavailable when the provider cannot be constructed", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "snap-1" }],
    });
    mockResolveAppGitProvider.mockResolvedValue(null);

    const res = await readRemoteContextFileAction(APP_ID, PATH);

    expect(res).toEqual({ error: "git_provider_unavailable" });
  });

  it("gates on context.read — the wrapper checks that permission for the app", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: APP_ID, provider: "github", installation_id: 1, repository: "acme/app" }],
    });
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "snap-1" }],
    });
    mockResolveAppGitProvider.mockResolvedValue(fakeProvider());

    await readRemoteContextFileAction(APP_ID, PATH);

    expect(mockCheckPerm).toHaveBeenCalledWith(
      { userId: "user-1", role: "admin" },
      "context.read",
      APP_ID,
    );
  });

  it("denies without reading the remote when the user lacks context.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const res = await readRemoteContextFileAction(APP_ID, PATH);

    expect(res).toEqual({ error: "Permission denied: context.read" });
    expect(mockResolveAppGitProvider).not.toHaveBeenCalled();
  });
});
