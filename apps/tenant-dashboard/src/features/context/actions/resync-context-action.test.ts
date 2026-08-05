// @vitest-environment node
//
// Pins the resync pointer fix: a manual resync exists to recover after a
// webhook outage, when the mirror AND the trace-stamping pointers have drifted.
// On a synced outcome it must advance the commit pointers to the resynced HEAD;
// on a failed outcome it must not. The Supabase reads (git_connection,
// context_head) go through the shared MSW handlers; only the non-Supabase seams
// (git provider, sync algorithm, pointer helper) are mocked.
//
// Also pins every early-return guard (no repository, no tracked branch, no git
// provider), the git_branch fallback resync uses when context has never
// synced (no context_head row yet), and the `context.read` permission gate
// the action-kit wrapper enforces (app-scoped — not org-scoped).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncOutcome } from "@repo/context-sync";

const mockResync = vi.fn();
const mockAdvance = vi.fn().mockResolvedValue(undefined);
const mockCreateGitProvider = vi.fn(
  async (..._args: unknown[]): Promise<{ __provider: boolean } | null> => ({ __provider: true }),
);
const mockBuildContextSync = vi.fn((..._args: unknown[]) => ({ resync: mockResync }));

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));
vi.mock("@/lib/system/git", () => ({
  createGitProviderForApp: (...args: unknown[]) => mockCreateGitProvider(...args),
}));
vi.mock("@/lib/system/context-sync", () => ({
  buildContextSync: (...args: unknown[]) => mockBuildContextSync(...args),
  createSupabaseContextMirrorPort: vi.fn(() => ({ __port: true })),
}));
vi.mock("@/lib/system/git/commit-pointers", () => ({
  advanceCommitPointers: (...args: unknown[]) => mockAdvance(...args),
}));
// PR-plane heal seams — their internals have their own suites
// (backfill.test.ts, enrichment-backfill.test.ts); resync pins DELEGATION.
const mockPrBackfill = vi.hoisted(() => vi.fn());
const mockEnrich = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/pr-tracking/backfill", () => ({
  backfillPullRequests: mockPrBackfill,
}));
vi.mock("@/lib/system/pr-tracking/enrichment-backfill", () => ({
  ENRICHMENT_LINK_LIMIT: 200,
  enrichPullRequestsForConnection: mockEnrich,
}));
const mockLogger = vi.hoisted(() => {
  const logger = { error: vi.fn(), info: vi.fn(), withAppId: vi.fn() };
  logger.withAppId.mockReturnValue(logger);
  return logger;
});
vi.mock("@/lib/observability/server-logger", () => ({ serverLogger: mockLogger }));

import { runResyncContext } from "./resync-context-action";

const APP_ID = "app-1";

beforeEach(async () => {
  vi.clearAllMocks();
  mockAdvance.mockResolvedValue(undefined);
  mockCreateGitProvider.mockResolvedValue({ __provider: true });
  mockLogger.withAppId.mockReturnValue(mockLogger);
  mockPrBackfill.mockResolvedValue({ upserted: 0 });
  mockEnrich.mockResolvedValue({ examined: 0, diffFilled: 0, ciFilled: 0, errors: [] });
  mockLoadCtx.mockResolvedValue({
    db: { from: vi.fn() },
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "admin" },
  });
  mockCheckPerm.mockResolvedValue(true);
  const { seedManagedDeploymentTablesState, seedContextSaveMswState } = await import(
    "@/test-helpers/msw-handlers"
  );
  seedManagedDeploymentTablesState({
    gitConnections: [
      {
        app_id: APP_ID,
        tenant_id: "tenant-1",
        provider: "github",
        installation_id: 1,
        repository: "acme/app",
      },
    ],
  });
  // Already tracking `main`, so the git_branch fallback isn't reached.
  seedContextSaveMswState({
    contextHeads: [{ app_id: APP_ID, branch: "main", snapshot_id: "s1" }],
  });
});

describe("runResyncContext — permission gate", () => {
  // AC-4: the app-scoped `context.read` check must run before the handler
  // touches anything, and the scope must stay app-scoped — asserting only on
  // the outcome would still pass if the wrapper accidentally dropped `appId`
  // and widened the check to the org-scoped `authorize` RPC.
  it("refuses a caller without context.read on the target app, and never runs the resync", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await runResyncContext({ appId: APP_ID });

    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: context.read" },
    });
    expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.read", APP_ID);
    expect(mockResync).not.toHaveBeenCalled();
  });
});

describe("runResyncContext", () => {
  it("advances the commit pointers to the resynced HEAD on a synced outcome", async () => {
    mockResync.mockResolvedValue({
      kind: "resynced",
      commitSha: "resynced-sha",
      snapshotId: "snap-1",
    } satisfies SyncOutcome);

    const result = await runResyncContext({ appId: APP_ID });

    // Resync runs against the tracked repo + branch resolved from context_head.
    expect(mockResync).toHaveBeenCalledWith({
      appId: APP_ID,
      tenantId: "tenant-1",
      repo: "acme/app",
      branch: "main",
    });
    // The sync algorithm is built from the real mirror port + the resolved git
    // provider — not an empty stub.
    expect(mockBuildContextSync).toHaveBeenCalledWith({
      db: { __port: true },
      git: { __provider: true },
    });
    // Resync must move the trace-stamping pointers, not just the mirror.
    expect(mockAdvance).toHaveBeenCalledWith(
      expect.anything(),
      { appId: APP_ID, commitSha: "resynced-sha" },
    );
    expect(result).toEqual({
      ok: true,
      data: { data: { kind: "resynced", commitSha: "resynced-sha", snapshotId: "snap-1" } },
    });
  });

  it("does NOT advance pointers when the resync fails", async () => {
    mockResync.mockResolvedValue({ kind: "failed", error: "clone failed" } satisfies SyncOutcome);

    const result = await runResyncContext({ appId: APP_ID });

    expect(mockAdvance).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { error: "clone failed" } });
  });

  it("does NOT advance pointers when the outcome carries no commitSha (a wrong-branch ignore)", async () => {
    mockResync.mockResolvedValue({ kind: "ignored" } satisfies SyncOutcome);

    const result = await runResyncContext({ appId: APP_ID });

    expect(mockAdvance).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { data: { kind: "ignored" } } });
  });

  it("returns repo_not_connected when the connected repo has no repository recorded", async () => {
    const { seedManagedDeploymentTablesState } = await import("@/test-helpers/msw-handlers");
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, tenant_id: "tenant-1", provider: "github", installation_id: 1 },
      ],
    });

    const result = await runResyncContext({ appId: APP_ID });

    expect(result).toEqual({ ok: true, data: { error: "repo_not_connected" } });
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("falls back to the tracked git_branch when context has never synced (no context_head row)", async () => {
    const { seedContextSaveMswState, seedApiKeysMswState } = await import(
      "@/test-helpers/msw-handlers"
    );
    seedContextSaveMswState({ contextHeads: [] });
    seedApiKeysMswState({
      gitBranches: [
        { id: "branch-1", app_id: APP_ID, branch_name: "feature/from-git-branch" },
      ],
    });
    mockResync.mockResolvedValue({
      kind: "resynced",
      commitSha: "sha-1",
      snapshotId: "snap-1",
    } satisfies SyncOutcome);

    await runResyncContext({ appId: APP_ID });

    expect(mockResync).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feature/from-git-branch" }),
    );
  });

  it("picks the MOST RECENTLY created branch when more than one is tracked", async () => {
    const { seedContextSaveMswState, seedApiKeysMswState } = await import(
      "@/test-helpers/msw-handlers"
    );
    seedContextSaveMswState({ contextHeads: [] });
    seedApiKeysMswState({
      gitBranches: [
        {
          id: "branch-older",
          app_id: APP_ID,
          branch_name: "feature/older",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "branch-newer",
          app_id: APP_ID,
          branch_name: "feature/newer",
          created_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    mockResync.mockResolvedValue({
      kind: "resynced",
      commitSha: "sha-1",
      snapshotId: "snap-1",
    } satisfies SyncOutcome);

    await runResyncContext({ appId: APP_ID });

    expect(mockResync).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feature/newer" }),
    );
  });

  it("returns no_tracked_branch when neither context_head nor git_branch resolve a branch", async () => {
    const { seedContextSaveMswState, seedApiKeysMswState } = await import(
      "@/test-helpers/msw-handlers"
    );
    seedContextSaveMswState({ contextHeads: [] });
    seedApiKeysMswState({ gitBranches: [] });

    const result = await runResyncContext({ appId: APP_ID });

    expect(result).toEqual({ ok: true, data: { error: "no_tracked_branch" } });
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("returns git_provider_unavailable when no git provider resolves for the app", async () => {
    mockCreateGitProvider.mockResolvedValueOnce(null);

    const result = await runResyncContext({ appId: APP_ID });

    expect(result).toEqual({ ok: true, data: { error: "git_provider_unavailable" } });
    expect(mockResync).not.toHaveBeenCalled();
  });

  // NOT KILLED (accepted survivor, documented for the patch-mutation gate):
  // Stryker's `connection?.repository` -> `connection.repository`
  // (OptionalChaining) mutant. The git_connection GET handler's `.single()`
  // path returns a PGRST116 error for zero rows (real PostgREST behavior), so
  // `connection` is only ever read when a row was actually found (i.e.
  // truthy) — `connectionError` is always set whenever `connection` would be
  // null. The optional chain and a plain `.` access are therefore
  // behaviorally identical on every reachable path; forcing them apart would
  // mean fabricating a `{ data: null, error: null }` response the real
  // Postgrest client never produces for this query shape.
});

describe("resync heals the PR plane", () => {
  it("runs the lifecycle backfill and enrichment for the connection after a successful mirror resync", async () => {
    mockResync.mockResolvedValue({
      kind: "resynced",
      commitSha: "a".repeat(40),
      snapshotId: "snap-1",
    } satisfies SyncOutcome);

    await runResyncContext({ appId: APP_ID });

    expect(mockPrBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, tenantId: "tenant-1", repository: "acme/app" })
    );
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, repository: "acme/app", limit: 200 })
    );
  });

  it("does NOT touch the PR plane when the mirror resync failed (the button's primary job comes first)", async () => {
    mockResync.mockResolvedValue({ kind: "failed", error: "boom" } as SyncOutcome);

    await runResyncContext({ appId: APP_ID });

    expect(mockPrBackfill).not.toHaveBeenCalled();
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("a PR-plane failure never fails the resync (best-effort contract)", async () => {
    mockResync.mockResolvedValue({
      kind: "resynced",
      commitSha: "a".repeat(40),
      snapshotId: "snap-1",
    } satisfies SyncOutcome);
    mockEnrich.mockRejectedValue(new Error("rate limited"));

    const result = await runResyncContext({ appId: APP_ID });

    expect(result).toEqual({
      ok: true,
      data: { data: { kind: "resynced", commitSha: "a".repeat(40), snapshotId: "snap-1" } },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "rate limited" })
    );
  });
});
