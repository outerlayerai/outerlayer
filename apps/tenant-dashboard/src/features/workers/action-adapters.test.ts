/**
 * The worker mutation actions — the glue around `authorizedAction`: each
 * validates, authorizes on the declared permission, gates on entitlements, runs
 * the RLS write for real against the MSW worker tables, delegates the machine
 * plane to the (mocked) dispatch bridge, and maps the outcome. The context /
 * permission seams and the machine + entitlement bridges are mocked; the DB
 * writes run for real so the query shape is exercised.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedWorkerRunMswState,
  getWorkerRunMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

const { loadCtxMock, checkPermMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));

const machine = vi.hoisted(() => ({
  dispatchWorkerRun: vi.fn(),
  startWorkspaceFirstTurn: vi.fn(),
  runWorkspaceTurn: vi.fn(),
  teardownCancelledRun: vi.fn(),
  workerDispatchKind: vi.fn(() => "local"),
}));
vi.mock("@/lib/adapters/worker-machine", () => machine);

const entitlements = vi.hoisted(() => ({
  checkWorkerLaunchEntitlements: vi.fn(),
  checkWorkerEnvironmentEntitlements: vi.fn(),
}));
vi.mock("@/lib/adapters/worker-entitlements", () => entitlements);

import { launchWorker, createEnvironment, runEnvironmentTurn, cancelWorker } from "./action-adapters";
import { workersService } from "./service";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ENV_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const RUN_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function runRow(overrides: { id: string } & Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    agent: "claude-code",
    task_prompt: "task",
    base_branch: "",
    status: "running",
    dispatch: "fly",
    wall_clock_cap_s: 1800,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
  machine.workerDispatchKind.mockReturnValue("local");
  entitlements.checkWorkerLaunchEntitlements.mockResolvedValue({ allowed: true });
  entitlements.checkWorkerEnvironmentEntitlements.mockResolvedValue({ allowed: true });
});

describe("launchWorker", () => {
  it("persists a queued run under RLS, dispatches, and returns the run id and status", async () => {
    machine.dispatchWorkerRun.mockResolvedValue({ ok: true, dispatch: "local", machineId: "m-1" });

    const res = await launchWorker({
      appId: APP_ID,
      agent: "claude-code",
      taskPrompt: "Fix the login bug",
      environmentId: ENV_ID,
    });

    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "worker_run.insert",
      APP_ID,
    );
    const persisted = getWorkerRunMswState();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe("queued");
    expect(res.status).toBe("provisioning");
    expect(res.dispatch).toBe("local");
    expect(res.runId).toBe(persisted[0]!.id);
    expect(machine.dispatchWorkerRun).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, runId: persisted[0]!.id, environmentId: ENV_ID }),
    );
  });

  it("denies an actor without worker_run.insert and writes nothing", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await launchWorker({ appId: APP_ID, agent: "claude-code", taskPrompt: "x", environmentId: ENV_ID });

    expect(res.error).toMatch(/Permission denied/);
    expect(getWorkerRunMswState()).toHaveLength(0);
    expect(machine.dispatchWorkerRun).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid appId as a validation error before any write", async () => {
    const res = await launchWorker({ appId: "not-a-uuid", agent: "claude-code", taskPrompt: "x" });
    expect(res.error).toBe("Input validation failed");
    expect(getWorkerRunMswState()).toHaveLength(0);
  });

  it("surfaces an entitlement denial without dispatching", async () => {
    const denied = { featureKey: "workers_enabled", featureDisplayName: "Cloud Workers" };
    entitlements.checkWorkerLaunchEntitlements.mockResolvedValue({ allowed: false, denied });

    const res = await launchWorker({ appId: APP_ID, agent: "claude-code", taskPrompt: "x", environmentId: ENV_ID });

    expect(res.entitlement).toEqual(denied);
    expect(getWorkerRunMswState()).toHaveLength(0);
    expect(machine.dispatchWorkerRun).not.toHaveBeenCalled();
  });

  it("marks the run failed shape when dispatch fails, carrying the code's message", async () => {
    machine.dispatchWorkerRun.mockResolvedValue({ ok: false, code: "clone_failed", message: "auth denied" });

    const res = await launchWorker({ appId: APP_ID, agent: "claude-code", taskPrompt: "x", environmentId: ENV_ID });

    expect(res).toEqual({ runId: getWorkerRunMswState()[0]!.id, status: "failed", error: "auth denied" });
  });

  it("rejects an unknown agent before creating a run", async () => {
    const res = await launchWorker({ appId: APP_ID, agent: "nope-agent", taskPrompt: "x", environmentId: ENV_ID });
    expect(res.error).toBe("Unknown agent: nope-agent");
    expect(getWorkerRunMswState()).toHaveLength(0);
  });
});

describe("createEnvironment", () => {
  it("creates a workspace under RLS and runs its first turn", async () => {
    vi.spyOn(workersService, "defaultEnvironmentId").mockResolvedValue(ENV_ID);
    machine.startWorkspaceFirstTurn.mockResolvedValue({ ok: true, runId: "run-t0", turnIndex: 0 });

    const res = await createEnvironment({ appId: APP_ID, agent: "claude-code", taskPrompt: "start" });

    const workspaces = getWorkerEnvironmentMswState();
    expect(workspaces).toHaveLength(1);
    expect(res).toEqual({ environmentId: workspaces[0]!.id, runId: "run-t0", status: "active" });
    expect(machine.startWorkspaceFirstTurn).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, workspaceId: workspaces[0]!.id }),
    );
  });

  it("refuses when the app has no default environment", async () => {
    vi.spyOn(workersService, "defaultEnvironmentId").mockResolvedValue(null);

    const res = await createEnvironment({ appId: APP_ID, agent: "claude-code", taskPrompt: "start" });

    expect(res.error).toBe("This app has no environment to run against.");
    expect(getWorkerEnvironmentMswState()).toHaveLength(0);
    expect(machine.startWorkspaceFirstTurn).not.toHaveBeenCalled();
  });
});

describe("runEnvironmentTurn", () => {
  it("maps a busy workspace to a busy result", async () => {
    machine.runWorkspaceTurn.mockResolvedValue({ ok: false, code: "busy", message: "already running" });

    const res = await runEnvironmentTurn({ appId: APP_ID, envId: ENV_ID, taskPrompt: "again" });

    expect(res.busy).toBe(true);
    expect(res.runId).toBeUndefined();
  });

  it("returns the new turn on success", async () => {
    machine.runWorkspaceTurn.mockResolvedValue({ ok: true, runId: "run-t1", turnIndex: 1 });

    const res = await runEnvironmentTurn({ appId: APP_ID, envId: ENV_ID, taskPrompt: "again" });

    expect(res).toEqual({ runId: "run-t1", turnIndex: 1 });
  });
});

describe("cancelWorker", () => {
  it("cancels a live run under RLS and tears down its machine", async () => {
    seedWorkerRunMswState({
      rows: [runRow({ id: RUN_ID, status: "running", dispatch: "fly", machine_id: "m-9", workspace_id: null })],
    });

    const res = await cancelWorker({ appId: APP_ID, runId: RUN_ID });

    expect(res).toEqual({ cancelled: true, status: "cancelled" });
    expect(getWorkerRunMswState()[0]!.status).toBe("cancelled");
    expect(machine.teardownCancelledRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, dispatch: "fly", machineId: "m-9", workspaceId: null }),
    );
  });

  it("reports not-found for a run RLS can't see, without teardown", async () => {
    const res = await cancelWorker({ appId: APP_ID, runId: RUN_ID });

    expect(res).toEqual({ cancelled: false, error: "Run not found" });
    expect(machine.teardownCancelledRun).not.toHaveBeenCalled();
  });
});
