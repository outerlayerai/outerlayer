/**
 * createAppAction / renameAppAction / deleteAppAction — the glue around
 * `authorizedAction`: each validates its input, authorizes the declared
 * permission BEFORE any gateway call, then delegates to the server-side
 * gateway client and maps its envelope into the action's own result shape.
 * The context + permission seams are mocked; the gateway client is a seam
 * here (its own tests own the HTTP mapping).
 */

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("next/server", () => ({ after: afterMock }));
async function flushAfterCallbacks() {
  for (const [callback] of afterMock.mock.calls) {
    await (callback as () => Promise<void>)();
  }
}

const {
  createAppFromServerMock,
  updateAppFromServerMock,
  deleteAppFromServerMock,
  listGitRepositoriesFromServerMock,
  listGitBranchesFromServerMock,
  linkAppRepositoryFromServerMock,
  AppsApiErrorMock,
} = vi.hoisted(() => {
  class AppsApiError extends Error {
    status: number;
    code: string;
    field?: string;
    extras: Record<string, unknown>;
    constructor(status: number, code: string, message: string, field?: string, extras: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.field = field;
      this.extras = extras;
    }
  }
  return {
    createAppFromServerMock: vi.fn(),
    updateAppFromServerMock: vi.fn(),
    deleteAppFromServerMock: vi.fn(),
    listGitRepositoriesFromServerMock: vi.fn(),
    listGitBranchesFromServerMock: vi.fn(),
    linkAppRepositoryFromServerMock: vi.fn(),
    AppsApiErrorMock: AppsApiError,
  };
});
vi.mock("@/lib/apps/server-client", () => ({
  AppsApiError: AppsApiErrorMock,
  createAppFromServer: createAppFromServerMock,
  updateAppFromServer: updateAppFromServerMock,
  deleteAppFromServer: deleteAppFromServerMock,
  listGitRepositoriesFromServer: listGitRepositoriesFromServerMock,
  listGitBranchesFromServer: listGitBranchesFromServerMock,
  linkAppRepositoryFromServer: linkAppRepositoryFromServerMock,
}));

const { resolveAppGitProviderMock, runContextMirrorInitialSyncMock, runPullRequestBackfillMock, runPullRequestEnrichmentMock } = vi.hoisted(() => ({
  resolveAppGitProviderMock: vi.fn(),
  runContextMirrorInitialSyncMock: vi.fn(),
  runPullRequestBackfillMock: vi.fn(),
  runPullRequestEnrichmentMock: vi.fn(),
}));
vi.mock("@/lib/system/resolve-app-git-provider", () => ({
  resolveAppGitProvider: resolveAppGitProviderMock,
}));
vi.mock("@/lib/adapters/link-side-effects", () => ({
  runContextMirrorInitialSync: runContextMirrorInitialSyncMock,
  runPullRequestBackfill: runPullRequestBackfillMock,
  runPullRequestEnrichment: runPullRequestEnrichmentMock,
}));

import {
  createAppAction,
  deleteAppAction,
  fetchBranchesForRepository,
  fetchRepositoriesForApp,
  linkRepositoryAction,
  renameAppAction,
  setAppPolicyAction,
} from "./actions";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const APPS_LIST_PATH = "/orgs/[orgName]/apps";

function ctxDb() {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnValue({ eq });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ delete: del, update });
  return { from, del, update, eq };
}

let db: ReturnType<typeof ctxDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = ctxDb();
  loadCtxMock.mockResolvedValue({
    db,
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

describe("createAppAction", () => {
  it("authorizes app.insert, creates via the gateway, and revalidates the apps list", async () => {
    createAppFromServerMock.mockResolvedValue({ id: APP_ID, name: "acme-app", display_name: "Acme" });

    const res = await createAppAction({ name: "acme-app", displayName: "Acme" });

    expect(res).toEqual({
      ok: true,
      data: { ok: true, app: { id: APP_ID, name: "acme-app", display_name: "Acme" } },
    });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "app.insert",
      undefined,
    );
    expect(createAppFromServerMock).toHaveBeenCalledWith({ name: "acme-app", display_name: "Acme" });
    expect(revalidateMock).toHaveBeenCalledWith(APPS_LIST_PATH, "page");
  });

  it("refuses a caller without app.insert before any gateway call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await createAppAction({ name: "acme-app" });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(createAppFromServerMock).not.toHaveBeenCalled();
  });

  it("maps a 409 duplicate_app_name into a field-shaped failure, not a thrown error", async () => {
    createAppFromServerMock.mockRejectedValue(
      new AppsApiErrorMock(409, "duplicate_app_name", "That name is taken", "name"),
    );

    const res = await createAppAction({ name: "acme-app" });

    expect(res).toEqual({
      ok: true,
      data: { ok: false, errorCode: "duplicate_app_name", message: "That name is taken", field: "name", entitlement: undefined, limit: undefined, current: undefined },
    });
  });

  it("maps a 402 entitlement_required into the entitlement/limit/current shape", async () => {
    createAppFromServerMock.mockRejectedValue(
      new AppsApiErrorMock(402, "entitlement_required", "Upgrade required", undefined, {
        entitlement: "max_apps",
        limit: 3,
        current: 3,
      }),
    );

    const res = await createAppAction({ name: "acme-app" });

    expect(res).toEqual({
      ok: true,
      data: {
        ok: false,
        errorCode: "entitlement_required",
        message: "Upgrade required",
        field: undefined,
        entitlement: "max_apps",
        limit: 3,
        current: 3,
      },
    });
  });
});

describe("renameAppAction", () => {
  it("authorizes app.update on the target app and updates display_name", async () => {
    updateAppFromServerMock.mockResolvedValue({ id: APP_ID, display_name: "New Name" });

    const res = await renameAppAction({ appId: APP_ID, displayName: "New Name" });

    expect(res).toEqual({
      ok: true,
      data: { ok: true, app: { id: APP_ID, display_name: "New Name" } },
    });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "app.update",
      APP_ID,
    );
    expect(updateAppFromServerMock).toHaveBeenCalledWith(APP_ID, { display_name: "New Name" });
  });

  it("refuses a caller without app.update on this app, before any gateway call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await renameAppAction({ appId: APP_ID, displayName: "X" });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(updateAppFromServerMock).not.toHaveBeenCalled();
  });
});

describe("deleteAppAction", () => {
  it("authorizes app.delete, deletes via the gateway, sweeps api_key on ctx.db, and revalidates", async () => {
    deleteAppFromServerMock.mockResolvedValue(undefined);

    const res = await deleteAppAction({ appId: APP_ID });

    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "app.delete",
      APP_ID,
    );
    expect(deleteAppFromServerMock).toHaveBeenCalledWith(APP_ID);
    // The sweep runs on ctx.db — the caller's RLS-scoped, request-tenant
    // client — never a re-derived tenant param.
    expect(db.from).toHaveBeenCalledWith("api_key");
    expect(db.eq).toHaveBeenCalledWith("app_id", APP_ID);
    expect(revalidateMock).toHaveBeenCalledWith(APPS_LIST_PATH, "page");
  });

  it("propagates a gateway failure without sweeping api_key", async () => {
    deleteAppFromServerMock.mockRejectedValue(new AppsApiErrorMock(500, "internal_error", "boom"));

    const res = await deleteAppAction({ appId: APP_ID });

    expect(res).toEqual({
      ok: true,
      data: { ok: false, errorCode: "internal_error", message: "boom", field: undefined, entitlement: undefined, limit: undefined, current: undefined },
    });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("refuses a caller without app.delete on this app, before any gateway call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await deleteAppAction({ appId: APP_ID });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(deleteAppFromServerMock).not.toHaveBeenCalled();
  });
});

describe("fetchRepositoriesForApp", () => {
  it("authorizes app.read and returns the repository full_names", async () => {
    listGitRepositoriesFromServerMock.mockResolvedValue([
      { full_name: "acme/triage", name: "triage", default_branch: "main" },
      { full_name: "acme/billing", name: "billing", default_branch: "main" },
    ]);

    const res = await fetchRepositoriesForApp({ appId: APP_ID });

    expect(res).toEqual({
      ok: true,
      data: { ok: true, repositories: ["acme/triage", "acme/billing"] },
    });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "app.read",
      APP_ID,
    );
  });

  it("maps a 409 unsupported_git_provider to the reconnect-with-GitHub message", async () => {
    listGitRepositoriesFromServerMock.mockRejectedValue(
      new AppsApiErrorMock(409, "unsupported_git_provider", "gitlab is not supported", undefined, {
        provider: "gitlab",
      }),
    );

    const res = await fetchRepositoriesForApp({ appId: APP_ID });

    expect(res).toEqual({
      ok: true,
      data: {
        ok: false,
        errorCode: "unsupported_git_provider",
        message: expect.stringMatching(/reconnect with github/i),
      },
    });
  });
});

describe("fetchBranchesForRepository", () => {
  it("authorizes app.read and returns the branch names", async () => {
    listGitBranchesFromServerMock.mockResolvedValue(["main", "develop"]);

    const res = await fetchBranchesForRepository({ appId: APP_ID, repository: "acme/triage" });

    expect(res).toEqual({ ok: true, data: { ok: true, branches: ["main", "develop"] } });
    expect(listGitBranchesFromServerMock).toHaveBeenCalledWith(APP_ID, "acme/triage");
  });
});

describe("linkRepositoryAction", () => {
  const gitProvider = { type: "github" };

  beforeEach(() => {
    linkAppRepositoryFromServerMock.mockResolvedValue({
      repository: "acme/triage",
      branch: "main",
      branch_id: "branch-1",
      commit_sha: "abc123",
    });
    resolveAppGitProviderMock.mockResolvedValue(gitProvider);
    runContextMirrorInitialSyncMock.mockResolvedValue(undefined);
    runPullRequestBackfillMock.mockResolvedValue(undefined);
    runPullRequestEnrichmentMock.mockResolvedValue(undefined);
  });

  it("links via the gateway, drives the mirror sync + backfill inline, defers enrichment, and revalidates", async () => {
    const res = await linkRepositoryAction({ appId: APP_ID, repository: "acme/triage", branch: "main" });

    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "git_connection.update",
      APP_ID,
    );
    expect(linkAppRepositoryFromServerMock).toHaveBeenCalledWith(APP_ID, {
      repository: "acme/triage",
      branch: "main",
    });
    // Resolved through the system-layer helper, which takes only the app id:
    // the credential read is confined there, so no RLS client is passed in.
    expect(resolveAppGitProviderMock).toHaveBeenCalledWith(APP_ID);
    expect(runContextMirrorInitialSyncMock).toHaveBeenCalledWith({
      appId: APP_ID,
      tenantId: "tenant-1",
      repo: "acme/triage",
      branch: "main",
      gitProvider,
    });
    expect(runPullRequestBackfillMock).toHaveBeenCalledWith({
      appId: APP_ID,
      tenantId: "tenant-1",
      repository: "acme/triage",
      provider: gitProvider,
    });
    // Enrichment is scheduled, not run inline, ahead of the response.
    expect(runPullRequestEnrichmentMock).not.toHaveBeenCalled();
    await flushAfterCallbacks();
    expect(runPullRequestEnrichmentMock).toHaveBeenCalledWith({
      appId: APP_ID,
      repository: "acme/triage",
      provider: gitProvider,
    });
    expect(revalidateMock).toHaveBeenCalledWith(APPS_LIST_PATH, "page");
  });

  it("maps a 409 unsupported_git_provider from the gateway link call, without touching the mirror", async () => {
    linkAppRepositoryFromServerMock.mockRejectedValue(
      new AppsApiErrorMock(409, "unsupported_git_provider", "gitlab is not supported"),
    );

    const res = await linkRepositoryAction({ appId: APP_ID, repository: "acme/triage", branch: "main" });

    expect(res).toEqual({
      ok: true,
      data: {
        ok: false,
        errorCode: "unsupported_git_provider",
        message: expect.stringMatching(/reconnect with github/i),
      },
    });
    expect(resolveAppGitProviderMock).not.toHaveBeenCalled();
  });

  it("fails cleanly when no git provider resolves after a successful link", async () => {
    resolveAppGitProviderMock.mockResolvedValue(null);

    const res = await linkRepositoryAction({ appId: APP_ID, repository: "acme/triage", branch: "main" });

    expect(res).toEqual({
      ok: true,
      data: {
        ok: false,
        errorCode: "git_provider_unavailable",
        message: "Git connection not found or invalid credentials",
      },
    });
    expect(runContextMirrorInitialSyncMock).not.toHaveBeenCalled();
  });

  it("refuses a caller without git_connection.update on this app, before any gateway call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await linkRepositoryAction({ appId: APP_ID, repository: "acme/triage", branch: "main" });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(linkAppRepositoryFromServerMock).not.toHaveBeenCalled();
  });
});

describe("setAppPolicyAction", () => {
  it("authorizes the app-scoped app_policy.update and PATCHes the named policy column on the target app", async () => {
    const res = await setAppPolicyAction({ appId: APP_ID, policy: "require_pull_request", value: true });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "app_policy.update",
      APP_ID,
    );
    expect(db.from).toHaveBeenCalledWith("app");
    expect(db.update).toHaveBeenCalledWith({ require_pull_request: true });
    expect(db.eq).toHaveBeenCalledWith("id", APP_ID);
  });

  it("writes require_pull_request=false when that value is passed", async () => {
    await setAppPolicyAction({ appId: APP_ID, policy: "require_pull_request", value: false });

    expect(db.update).toHaveBeenCalledWith({ require_pull_request: false });
  });

  it("surfaces a DB error message", async () => {
    db.eq.mockResolvedValueOnce({ error: { message: "update blocked" } });

    const res = await setAppPolicyAction({ appId: APP_ID, policy: "require_pull_request", value: true });

    expect(res).toEqual({ ok: false, error: { code: "internal_error", message: "update blocked" } });
  });

  it("returns a permission error and never touches the DB when app_policy.update is denied", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await setAppPolicyAction({ appId: APP_ID, policy: "require_pull_request", value: true });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden", message: "Permission denied: app_policy.update" } });
    expect(db.update).not.toHaveBeenCalled();
  });
});
