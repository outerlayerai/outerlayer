/**
 * The single sanctioned crossing from the workers feature to the dispatch
 * machine plane. These tests pin its branching and the exact hand-off to the
 * machine collaborators: a dispatch failure marks the run failed with the right
 * code, a workspace that can't start is destroyed so it never counts against the
 * cap, a cancel teardown stops-vs-destroys the correct machine, releases the
 * turn lock only when this run still holds it, and always removes both per-run
 * secrets. The machine collaborators (legacy dispatch, Fly machine lifecycle,
 * run/workspace services) are seams with their own suites; the raw worker_workspace
 * writes and secret-delete RPCs run for real against MSW so their query shape is
 * exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "@/test-helpers/msw-server";
import {
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
  resetWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers/worker-environment";

const SUPABASE_URL = "http://localhost:54321";

const h = vi.hoisted(() => ({
  dispatchLegacy: vi.fn(),
  dispatchTurn: vi.fn(),
  flyFromEnv: vi.fn(),
  markProvisioning: vi.fn(),
  fail: vi.fn(),
  getWorkspace: vi.fn(),
  destroyWorkspace: vi.fn(),
  stopMachine: vi.fn(),
  destroyMachine: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/observability/server-logger", () => ({ serverLogger: { error: h.logError } }));

vi.mock("@repo/worker-core", () => ({
  destroyWorkerMachine: h.destroyMachine,
  stopWorkerMachine: h.stopMachine,
  workerSecretVaultName: (runId: string) => `worker_secret_${runId}`,
  workerTokenVaultName: (runId: string) => `worker_token_${runId}`,
}));

vi.mock("@/lib/system/workers/worker-run-service", () => ({
  WorkerRunService: class {
    markProvisioning = h.markProvisioning;
    fail = h.fail;
  },
}));
vi.mock("@/lib/system/workers/worker-environment-service", () => ({
  WorkerEnvironmentService: class {
    get = h.getWorkspace;
    destroy = h.destroyWorkspace;
  },
}));
vi.mock("@/lib/system/workers/worker-dispatch", () => {
  class WorkerPreflightError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { dispatchWorkerRun: h.dispatchLegacy, WorkerPreflightError };
});
vi.mock("@/lib/system/workers/environment-turn", () => {
  class EnvironmentBusyError extends Error {
    constructor() {
      super("environment is busy");
    }
  }
  return {
    dispatchEnvironmentTurn: h.dispatchTurn,
    EnvironmentBusyError,
    localWorkspacePath: (id: string) => `/local/${id}`,
  };
});
vi.mock("@/lib/system/workers/worker-config", () => ({
  flyWorkerFromEnv: h.flyFromEnv,
  FLY_WORKER_WORKSPACE_PATH: "/fly/workspace",
}));

import {
  workerDispatchKind,
  dispatchWorkerRun,
  startWorkspaceFirstTurn,
  runWorkspaceTurn,
  teardownCancelledRun,
} from "../worker-machine";
import { WorkerPreflightError } from "@/lib/system/workers/worker-dispatch";
import { EnvironmentBusyError } from "@/lib/system/workers/environment-turn";
import { APP_URL } from "@/config-global";

const FLY = { flyApiToken: "fly-tok", workerApp: "worker-app", extra: "ignored" };

/** A full worker_workspace row for MSW seeding; override only what a test cares about. */
function wsRow(over: { id: string } & Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    app_id: "app-1",
    agent: "claude-code",
    base_branch: "main",
    substrate: "local",
    status: "active",
    idle_ttl_s: 3600,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** Records the secret_name of each delete_secret RPC. */
function captureSecretDeletes(): string[] {
  const seen: string[] = [];
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/delete_secret`, async ({ request }) => {
      const body = (await request.json()) as { secret_name: string };
      seen.push(body.secret_name);
      return HttpResponse.json(null, { status: 200 });
    }),
  );
  return seen;
}

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  resetWorkerEnvironmentMswState();
});
afterEach(() => server.resetHandlers());

describe("workerDispatchKind", () => {
  it("is fly when the machine env is configured, local otherwise", () => {
    h.flyFromEnv.mockReturnValue(FLY);
    expect(workerDispatchKind()).toBe("fly");
    h.flyFromEnv.mockReturnValue(null);
    expect(workerDispatchKind()).toBe("local");
  });
});

describe("dispatchWorkerRun", () => {
  const input = {
    appId: "app-1",
    tenantId: "tenant-1",
    environmentId: "env-1",
    runId: "run-1",
    agent: "claude-code",
    model: "sonnet",
    taskPrompt: "fix it",
    baseBranch: "main",
    wallClockCapS: 1800,
  };

  it("dispatches, marks the run provisioning with the machine id, and returns the machine result", async () => {
    h.flyFromEnv.mockReturnValue(FLY);
    h.dispatchLegacy.mockResolvedValue({ dispatch: "fly", machineId: "m-9" });

    const res = await dispatchWorkerRun(input);

    expect(res).toEqual({ ok: true, dispatch: "fly", machineId: "m-9" });
    expect(h.dispatchLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "app-1",
        tenantId: "tenant-1",
        environmentId: "env-1",
        workerRunId: "run-1",
        agent: "claude-code",
        model: "sonnet",
        taskPrompt: "fix it",
        baseBranch: "main",
        wallClockCapS: 1800,
        appUrl: APP_URL,
        flyConfig: FLY,
      }),
    );
    expect(h.markProvisioning).toHaveBeenCalledWith("app-1", "run-1", "m-9");
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("maps a WorkerPreflightError to its code and marks the run failed", async () => {
    h.flyFromEnv.mockReturnValue(null);
    h.dispatchLegacy.mockRejectedValue(new WorkerPreflightError("clone_failed", "auth denied"));

    const res = await dispatchWorkerRun(input);

    expect(res).toEqual({ ok: false, code: "clone_failed", message: "auth denied" });
    expect(h.fail).toHaveBeenCalledWith("app-1", "run-1", "clone_failed", "auth denied");
    expect(h.markProvisioning).not.toHaveBeenCalled();
  });

  it("maps an unexpected Error to dispatch_failed", async () => {
    h.flyFromEnv.mockReturnValue(null);
    h.dispatchLegacy.mockRejectedValue(new Error("boom"));

    const res = await dispatchWorkerRun(input);

    expect(res).toEqual({ ok: false, code: "dispatch_failed", message: "boom" });
    expect(h.fail).toHaveBeenCalledWith("app-1", "run-1", "dispatch_failed", "boom");
  });

  it("stringifies a non-Error throw", async () => {
    h.flyFromEnv.mockReturnValue(null);
    h.dispatchLegacy.mockRejectedValue("plain string");

    const res = await dispatchWorkerRun(input);

    expect(res).toEqual({ ok: false, code: "dispatch_failed", message: "plain string" });
  });
});

describe("startWorkspaceFirstTurn", () => {
  const input = {
    appId: "app-1",
    workspaceId: "ws-abcdef12",
    taskPrompt: "start",
    createdBy: "user-1",
    tenantId: "tenant-1",
  };

  it("returns workspace_missing when the workspace is gone", async () => {
    h.getWorkspace.mockResolvedValue(null);

    const res = await startWorkspaceFirstTurn(input);

    expect(res).toEqual({ ok: false, code: "workspace_missing", message: "Workspace not found." });
    expect(h.dispatchTurn).not.toHaveBeenCalled();
  });

  it("sets a local workspace's durable paths, dispatches the turn, and returns it", async () => {
    seedWorkerEnvironmentMswState({
      rows: [wsRow({ id: "ws-abcdef12", substrate: "local", status: "creating", current_run_id: null })],
    });
    h.getWorkspace.mockResolvedValue({ id: "ws-abcdef12", substrate: "local", status: "creating" });
    h.dispatchTurn.mockResolvedValue({ runId: "t0", turnIndex: 0 });

    const res = await startWorkspaceFirstTurn(input);

    expect(res).toEqual({ ok: true, runId: "t0", turnIndex: 0 });
    const row = getWorkerEnvironmentMswState().find((r) => r.id === "ws-abcdef12");
    expect(row?.work_branch).toBe("outerlayer/worker/env-ws-abcde");
    expect(row?.workspace_ref).toBe("/local/ws-abcdef12");
    expect(h.dispatchTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "ws-abcdef12", work_branch: "outerlayer/worker/env-ws-abcde", workspace_ref: "/local/ws-abcdef12" }),
      expect.objectContaining({ taskPrompt: "start", createdBy: "user-1", tenantId: "tenant-1" }),
    );
  });

  it("uses the Fly workspace path for a fly-substrate workspace", async () => {
    seedWorkerEnvironmentMswState({
      rows: [wsRow({ id: "ws-abcdef12", substrate: "fly", status: "creating", current_run_id: null })],
    });
    h.getWorkspace.mockResolvedValue({ id: "ws-abcdef12", substrate: "fly", status: "creating" });
    h.dispatchTurn.mockResolvedValue({ runId: "t0", turnIndex: 0 });

    await startWorkspaceFirstTurn(input);

    const row = getWorkerEnvironmentMswState().find((r) => r.id === "ws-abcdef12");
    expect(row?.workspace_ref).toBe("/fly/workspace");
  });

  it("destroys the workspace and returns dispatch_failed when the first turn throws", async () => {
    seedWorkerEnvironmentMswState({
      rows: [wsRow({ id: "ws-abcdef12", substrate: "local", status: "creating", current_run_id: null })],
    });
    h.getWorkspace.mockResolvedValue({ id: "ws-abcdef12", substrate: "local", status: "creating" });
    h.dispatchTurn.mockRejectedValue(new Error("no capacity"));

    const res = await startWorkspaceFirstTurn(input);

    expect(res).toEqual({ ok: false, code: "dispatch_failed", message: "no capacity" });
    expect(h.destroyWorkspace).toHaveBeenCalledWith("ws-abcdef12", "no capacity");
  });
});

describe("runWorkspaceTurn", () => {
  const input = { appId: "app-1", envId: "env-1", taskPrompt: "again", createdBy: "user-1", tenantId: "tenant-1" };

  it("returns workspace_missing when the environment is gone", async () => {
    h.getWorkspace.mockResolvedValue(null);
    expect(await runWorkspaceTurn(input)).toEqual({
      ok: false,
      code: "workspace_missing",
      message: "Environment not found.",
    });
  });

  it("returns workspace_destroyed for a destroyed environment", async () => {
    h.getWorkspace.mockResolvedValue({ id: "env-1", status: "destroyed" });
    expect(await runWorkspaceTurn(input)).toEqual({
      ok: false,
      code: "workspace_destroyed",
      message: "Environment has been destroyed.",
    });
    expect(h.dispatchTurn).not.toHaveBeenCalled();
  });

  it("dispatches the turn and returns it for a live environment", async () => {
    h.getWorkspace.mockResolvedValue({ id: "env-1", status: "active" });
    h.dispatchTurn.mockResolvedValue({ runId: "t2", turnIndex: 2 });
    expect(await runWorkspaceTurn(input)).toEqual({ ok: true, runId: "t2", turnIndex: 2 });
  });

  it("maps EnvironmentBusyError to code busy", async () => {
    h.getWorkspace.mockResolvedValue({ id: "env-1", status: "active" });
    h.dispatchTurn.mockRejectedValue(new EnvironmentBusyError());
    expect(await runWorkspaceTurn(input)).toEqual({ ok: false, code: "busy", message: "environment is busy" });
  });

  it("maps any other throw to dispatch_failed", async () => {
    h.getWorkspace.mockResolvedValue({ id: "env-1", status: "active" });
    h.dispatchTurn.mockRejectedValue(new Error("kaboom"));
    expect(await runWorkspaceTurn(input)).toEqual({ ok: false, code: "dispatch_failed", message: "kaboom" });
  });
});

describe("teardownCancelledRun", () => {
  it("stops (not destroys) a persistent fly machine and releases the lock this run holds", async () => {
    h.flyFromEnv.mockReturnValue(FLY);
    seedWorkerEnvironmentMswState({
      rows: [wsRow({ id: "ws-1", substrate: "fly", status: "active", current_run_id: "run-1" })],
    });
    const secrets = captureSecretDeletes();

    await teardownCancelledRun({ runId: "run-1", dispatch: "fly", machineId: "m-9", workspaceId: "ws-1" });

    expect(h.stopMachine).toHaveBeenCalledWith({ flyApiToken: "fly-tok", workerApp: "worker-app", machineId: "m-9" });
    expect(h.destroyMachine).not.toHaveBeenCalled();
    expect(getWorkerEnvironmentMswState().find((r) => r.id === "ws-1")?.current_run_id).toBeNull();
    expect(secrets).toEqual(["worker_secret_run-1", "worker_token_run-1"]);
  });

  it("destroys a one-shot fly machine when there is no workspace", async () => {
    h.flyFromEnv.mockReturnValue(FLY);
    captureSecretDeletes();

    await teardownCancelledRun({ runId: "run-2", dispatch: "fly", machineId: "m-1", workspaceId: null });

    expect(h.destroyMachine).toHaveBeenCalledWith({ flyApiToken: "fly-tok", workerApp: "worker-app", machineId: "m-1" });
    expect(h.stopMachine).not.toHaveBeenCalled();
  });

  it("touches no machine for a local dispatch but still deletes both secrets", async () => {
    h.flyFromEnv.mockReturnValue(FLY);
    const secrets = captureSecretDeletes();

    await teardownCancelledRun({ runId: "run-3", dispatch: "local", machineId: null, workspaceId: null });

    expect(h.stopMachine).not.toHaveBeenCalled();
    expect(h.destroyMachine).not.toHaveBeenCalled();
    expect(secrets).toEqual(["worker_secret_run-3", "worker_token_run-3"]);
  });

  it("does not release the lock when another run holds it", async () => {
    h.flyFromEnv.mockReturnValue(null);
    seedWorkerEnvironmentMswState({
      rows: [wsRow({ id: "ws-2", substrate: "fly", status: "active", current_run_id: "other-run" })],
    });
    captureSecretDeletes();

    await teardownCancelledRun({ runId: "run-1", dispatch: "fly", machineId: "m-9", workspaceId: "ws-2" });

    expect(getWorkerEnvironmentMswState().find((r) => r.id === "ws-2")?.current_run_id).toBe("other-run");
  });

  it("swallows a machine-teardown failure and logs it", async () => {
    h.flyFromEnv.mockReturnValue(FLY);
    h.stopMachine.mockRejectedValue(new Error("fly api down"));
    captureSecretDeletes();

    await expect(
      teardownCancelledRun({ runId: "run-4", dispatch: "fly", machineId: "m-2", workspaceId: "ws-x" }),
    ).resolves.toBeUndefined();
    expect(h.logError).toHaveBeenCalledWith(expect.any(Error), { runId: "run-4" });
  });
});
