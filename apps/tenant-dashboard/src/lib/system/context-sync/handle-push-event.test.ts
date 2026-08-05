/**
 * Unit tests for the provider-agnostic push core. Every external boundary is
 * mocked so these pin the ORCHESTRATION: routing → per-app pointer advance →
 * mirror sync → aggregate check-run. The router, sync algorithm, and pointer
 * helper have their own tests; here we prove the core wires them in the right
 * order with the right args and stays best-effort (never throws), including
 * every best-effort catch's exact log payload (check-start failure, per-app
 * sync failure, routing failure, check-complete failure).
 *
 * The GitHub route goes through this same provider-agnostic core (only
 * verify/normalize differs there, tested separately).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedPushEvent } from "../git/types";
import type { SyncOutcome } from "@repo/context-sync";
import type { CheckRunner } from "../git/check-runner";

const mockResolveWatchingApps = vi.fn();
vi.mock("./resolve-watching-apps", () => ({
  resolveWatchingApps: (...args: unknown[]) => mockResolveWatchingApps(...args),
}));

const mockSyncOnPush = vi.fn();
const mockBuildContextSync = vi.fn((..._args: unknown[]) => ({ syncOnPush: mockSyncOnPush }));
vi.mock("@repo/context-sync", () => ({
  buildContextSync: (...args: unknown[]) => mockBuildContextSync(...args),
}));

vi.mock("./mirror-port", () => ({
  createSupabaseContextMirrorPort: vi.fn(() => ({ __mirrorPort: true })),
}));

const mockAdvanceCommitPointers = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/system/git/commit-pointers", () => ({
  advanceCommitPointers: (...args: unknown[]) => mockAdvanceCommitPointers(...args),
}));

// The real admin client constructs lazily and is never queried here (the
// router, mirror port, sync, and pointer helper are all mocked), so there's no
// Supabase boundary to stub — it stays real per the no-supabase-mocks rule.

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    withAppId: (appId: string) => ({
      error: (...args: unknown[]) => mockLoggerError(appId, ...args),
    }),
  },
}));

import { handlePushEvent } from "./handle-push-event";

const PUSH_SHA = "c".repeat(40);
const PROVIDER = { __gitProvider: true };

function makePush(overrides: Partial<NormalizedPushEvent> = {}): NormalizedPushEvent {
  return {
    provider: "github",
    repository: "acme/prompts",
    branch: "main",
    commitSha: PUSH_SHA,
    beforeSha: "b".repeat(40),
    commitMessage: "fix: the thing",
    commits: [],
    sender: { username: "octocat" },
    timestamp: "2026-07-13T00:00:00Z",
    raw: {},
    ...overrides,
  };
}

function makeCheckRunner() {
  return {
    start: vi.fn().mockResolvedValue({ id: 7 }),
    complete: vi.fn().mockResolvedValue(undefined),
  } satisfies CheckRunner;
}

function synced(commitSha: string, kind: SyncOutcome["kind"] = "snapshotted"): SyncOutcome {
  return { kind, commitSha, snapshotId: "snap-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdvanceCommitPointers.mockResolvedValue(undefined);
});

describe("handlePushEvent", () => {
  it("advances pointers BEFORE syncing each watching app and passes the exact sync args", async () => {
    const callOrder: string[] = [];
    mockResolveWatchingApps.mockResolvedValue([
      { appId: "app-1", appName: "acme-app", tenantId: "tenant-1", branch: "main" },
    ]);
    mockAdvanceCommitPointers.mockImplementation(async () => {
      callOrder.push("advance");
    });
    mockSyncOnPush.mockImplementation(async () => {
      callOrder.push("sync");
      return synced(PUSH_SHA);
    });

    const runner = makeCheckRunner();
    await handlePushEvent({
      push: makePush(),
      provider: PROVIDER as never,
      checkRunner: runner,
      source: "GitHub Webhook",
    });

    // Routing runs with the exact push coordinates, not a partial/empty object.
    expect(mockResolveWatchingApps).toHaveBeenCalledWith(expect.anything(), {
      repository: "acme/prompts",
      branch: "main",
    });
    // The sync algorithm is built from the real mirror port + the push's git
    // provider — not an empty stub.
    expect(mockBuildContextSync).toHaveBeenCalledWith({
      db: { __mirrorPort: true },
      git: PROVIDER,
    });
    // Pointer advance uses the push HEAD sha and runs before the sync.
    expect(mockAdvanceCommitPointers).toHaveBeenCalledWith(
      expect.anything(),
      { appId: "app-1", commitSha: PUSH_SHA },
    );
    expect(callOrder).toEqual(["advance", "sync"]);
    // Sync gets the app's routing context + the head commit message.
    expect(mockSyncOnPush).toHaveBeenCalledWith({
      appId: "app-1",
      tenantId: "tenant-1",
      repo: "acme/prompts",
      branch: "main",
      beforeSha: "b".repeat(40),
      afterSha: PUSH_SHA,
      commitMessage: "fix: the thing",
    });
  });

  it("completes the check as success with a per-app summary when every app synced", async () => {
    mockResolveWatchingApps.mockResolvedValue([
      { appId: "app-1", appName: "one", tenantId: "t", branch: "main" },
      { appId: "app-2", appName: "two", tenantId: "t", branch: "main" },
    ]);
    mockSyncOnPush
      .mockResolvedValueOnce(synced("1234567abc"))
      .mockResolvedValueOnce(synced("89abcdef01"));

    const runner = makeCheckRunner();
    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: runner,
      source: "GitHub Webhook",
    });

    expect(runner.start).toHaveBeenCalledWith(PUSH_SHA);
    expect(runner.complete).toHaveBeenCalledWith({
      ref: { id: 7 },
      conclusion: "success",
      summary: "✓ one: synced 1234567\n✓ two: synced 89abcde",
    });
    // No app failed, so the per-app error log never fires.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("completes the check as failure and surfaces the per-app error when any app fails", async () => {
    mockResolveWatchingApps.mockResolvedValue([
      { appId: "app-1", appName: "one", tenantId: "t", branch: "main" },
      { appId: "app-2", appName: "two", tenantId: "t", branch: "main" },
    ]);
    mockSyncOnPush
      .mockResolvedValueOnce(synced("1234567abc"))
      .mockResolvedValueOnce({ kind: "failed", error: "clone timed out" } satisfies SyncOutcome);

    const runner = makeCheckRunner();
    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: runner,
      source: "GitHub Webhook",
    });

    expect(runner.complete).toHaveBeenCalledWith({
      ref: { id: 7 },
      conclusion: "failure",
      summary: "✓ one: synced 1234567\n✕ two: clone timed out",
    });
    // The failed app (and only that app) gets its own error log entry.
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "app-2",
      expect.objectContaining({ message: "[GitHub Webhook] clone timed out" }),
    );
  });

  it("advances pointers even when the sync fails (traces must stamp the true HEAD)", async () => {
    mockResolveWatchingApps.mockResolvedValue([
      { appId: "app-1", appName: "one", tenantId: "t", branch: "main" },
    ]);
    mockSyncOnPush.mockResolvedValue({ kind: "failed", error: "boom" } satisfies SyncOutcome);

    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: null,
      source: "GitHub Webhook",
    });

    expect(mockAdvanceCommitPointers).toHaveBeenCalledWith(
      expect.anything(),
      { appId: "app-1", commitSha: PUSH_SHA },
    );
  });

  it("posts a neutral check and does no sync when no app watches the branch", async () => {
    mockResolveWatchingApps.mockResolvedValue([]);

    const runner = makeCheckRunner();
    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: runner,
      source: "GitHub Webhook",
    });

    expect(mockSyncOnPush).not.toHaveBeenCalled();
    expect(mockAdvanceCommitPointers).not.toHaveBeenCalled();
    expect(runner.complete).toHaveBeenCalledWith({
      ref: { id: 7 },
      conclusion: "neutral",
      summary: undefined,
    });
  });

  it("never throws and completes the check as failure when routing throws", async () => {
    mockResolveWatchingApps.mockRejectedValue(new Error("db down"));

    const runner = makeCheckRunner();
    await expect(
      handlePushEvent({
        push: makePush(),
        provider: {} as never,
        checkRunner: runner,
        source: "GitHub Webhook",
      }),
    ).resolves.toBeUndefined();

    expect(runner.complete).toHaveBeenCalledWith({
      ref: { id: 7 },
      conclusion: "failure",
      summary: "db down",
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith("[GitHub Webhook] push handling failed", {
      err: "db down",
    });
  });

  it("runs the sync even when the check runner is absent (branch deletion / no coords)", async () => {
    mockResolveWatchingApps.mockResolvedValue([
      { appId: "app-1", appName: "one", tenantId: "t", branch: "main" },
    ]);
    mockSyncOnPush.mockResolvedValue(synced(PUSH_SHA));

    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: null,
      source: "GitHub Webhook",
    });

    expect(mockSyncOnPush).toHaveBeenCalledTimes(1);
    // No checkRunner means neither the start-failure nor the complete-failure
    // best-effort catches ever fire.
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("continues without a check (best-effort) and logs the exact error when checkRunner.start rejects", async () => {
    mockResolveWatchingApps.mockResolvedValue([]);
    const runner = makeCheckRunner();
    runner.start.mockRejectedValue(new Error("status API down"));

    await handlePushEvent({
      push: makePush(),
      provider: {} as never,
      checkRunner: runner,
      source: "GitHub Webhook",
    });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[GitHub Webhook] check start failed; continuing without check",
      { err: "status API down" },
    );
    // No checkRef was obtained, so completing the check never even attempted.
    expect(runner.complete).not.toHaveBeenCalled();
  });

  it("leaves the check open (best-effort) and logs the exact error when checkRunner.complete rejects", async () => {
    mockResolveWatchingApps.mockResolvedValue([]);
    const runner = makeCheckRunner();
    runner.complete.mockRejectedValue(new Error("status API down"));

    await expect(
      handlePushEvent({
        push: makePush(),
        provider: {} as never,
        checkRunner: runner,
        source: "GitHub Webhook",
      }),
    ).resolves.toBeUndefined();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[GitHub Webhook] check complete failed; check left open",
      { err: "status API down" },
    );
  });
});
