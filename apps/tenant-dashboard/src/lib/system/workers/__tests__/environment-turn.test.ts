/**
 * dispatchEnvironmentTurn — one turn against a persistent worker environment.
 *
 * Boundary posture: persistence (worker_run + worker_workspace) runs for real
 * over MSW so the turn-index computation, the environment lock, and the
 * failure/lock-release side effects are exercised end to end. The only mocked
 * seams are the modules this file *calls* with stable signatures:
 *   - ./worker-dispatch (dispatchWorkerRun) — the dispatch itself; the real
 *     WorkerPreflightError class is preserved so `instanceof` in the catch works.
 *   - ./worker-config (flyWorkerFromEnv) — env-reading Fly config resolver.
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import * as os from "node:os";
import * as path from "node:path";
import {
  dispatchEnvironmentTurn,
  localWorkspacePath,
  EnvironmentBusyError,
} from "../environment-turn";
import { WorkerPreflightError } from "../worker-dispatch";
import type { WorkerEnvironmentRow } from "../worker-environment-service";
import {
  seedWorkerRunMswState,
  getWorkerRunMswState,
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { mockDispatch, mockFly } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockFly: vi.fn(),
}));

vi.mock("../worker-dispatch", async (importActual) => {
  const actual = await importActual<typeof import("../worker-dispatch")>();
  return { ...actual, dispatchWorkerRun: mockDispatch };
});
vi.mock("../worker-config", async (importActual) => {
  const actual = await importActual<typeof import("../worker-config")>();
  return { ...actual, flyWorkerFromEnv: mockFly };
});

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";

function admin(): SupabaseClient<Database> {
  return createClient(SUPABASE_URL, ANON) as unknown as SupabaseClient<Database>;
}

function envRow(over: Partial<WorkerEnvironmentRow> = {}): WorkerEnvironmentRow {
  return {
    id: "env-abc12345",
    tenant_id: "tenant-1",
    app_id: "app-1",
    environment_id: null,
    agent: "claude-code",
    model: null,
    base_branch: "main",
    work_branch: null,
    substrate: "local",
    machine_ref: null,
    workspace_ref: null,
    session_ref: null,
    status: "active",
    current_run_id: null,
    idle_ttl_s: 1800,
    last_active_at: null,
    failure_reason: null,
    created_at: new Date().toISOString(),
    created_by: null,
    updated_at: null,
    ...over,
  };
}

/** Seed the environment into the worker_workspace MSW state and return the
 *  same object to pass into dispatchEnvironmentTurn (keeps them consistent). */
function seedEnv(over: Partial<WorkerEnvironmentRow> = {}): WorkerEnvironmentRow {
  const env = envRow(over);
  seedWorkerEnvironmentMswState({ rows: [{ ...env }] });
  return env;
}

const OPTS = { taskPrompt: "add a feature", createdBy: "user-1", tenantId: "tenant-1" };

beforeEach(() => {
  mockDispatch.mockResolvedValue({ dispatch: "local", machineId: null });
  mockFly.mockReturnValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("dispatchEnvironmentTurn — first turn", () => {
  it("creates turn 0 linked to the environment, dispatches local, and holds the lock", async () => {
    const env = seedEnv({ work_branch: null, workspace_ref: null, session_ref: null });

    const result = await dispatchEnvironmentTurn(admin(), env, OPTS);

    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.task_prompt).toBe("add a feature");
    expect(run!.turn_index).toBe(0);
    expect(run!.dispatch).toBe("local");
    // markProvisioning ran after a successful dispatch.
    expect(run!.status).toBe("provisioning");

    expect(result).toEqual({ runId: run!.id, turnIndex: 0 });

    // The persistent block: first turn, generated work branch (env.work_branch
    // null), workspace path derived from the env id (workspace_ref null).
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: env.app_id,
        workerRunId: run!.id,
        flyConfig: null,
        persistent: expect.objectContaining({
          firstTurn: true,
          workBranch: expect.stringMatching(/^outerlayer\/worker\/env-/),
          workspacePath: expect.stringContaining(env.id),
        }),
      }),
    );
    // The substrate is resolved from current config every turn (not the stored
    // value), so the Fly resolver is always consulted; here it returns null.
    expect(mockFly).toHaveBeenCalledTimes(1);

    // Lock stays held on success (released later by the callback), no machine.
    const stored = getWorkerEnvironmentMswState().find((e) => e.id === env.id);
    expect(stored?.current_run_id).toBe(run!.id);
    expect(stored?.machine_ref ?? null).toBeNull();
  });
});

describe("dispatchEnvironmentTurn — attachments", () => {
  it("hands attachment content to dispatch and stores only metadata on the turn's run", async () => {
    const env = seedEnv();
    const content = Buffer.from("spec-bytes").toString("base64"); // 10 bytes decoded
    const attachments = [{ name: "spec.pdf", mime: "application/pdf", content }];

    await dispatchEnvironmentTurn(admin(), env, { ...OPTS, attachments });

    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.attachments).toEqual([
      { name: "spec.pdf", mime: "application/pdf", size_bytes: 10 },
    ]);
    expect(JSON.stringify(run)).not.toContain(content);
  });
});

describe("dispatchEnvironmentTurn — subsequent turn", () => {
  // proves AC-061-04
  it("records the follow-up turn against the same workspace instead of starting a new one", async () => {
    const env = seedEnv({ work_branch: "keep/branch", session_ref: "sess-1" });
    seedWorkerRunMswState({
      rows: [
        {
          id: "prior-1",
          tenant_id: "tenant-1",
          app_id: env.app_id,
          agent: "claude-code",
          task_prompt: "earlier",
          base_branch: "main",
          status: "completed",
          dispatch: "local",
          wall_clock_cap_s: 1800,
          workspace_id: env.id,
          turn_index: 0,
          created_at: "2026-07-10T00:00:00Z",
        },
      ],
    });

    const result = await dispatchEnvironmentTurn(admin(), env, OPTS);

    const created = getWorkerRunMswState().find(
      (r) => r.workspace_id === env.id && r.turn_index === 1,
    );
    expect(created?.task_prompt).toBe("add a feature");
    expect(result).toEqual({ runId: created!.id, turnIndex: 1 });

    // The new turn is a second worker_run row on the SAME workspace — no
    // second workspace row is created for the follow-up turn.
    expect(getWorkerRunMswState().filter((r) => r.workspace_id === env.id)).toHaveLength(2);
    expect(getWorkerEnvironmentMswState()).toHaveLength(1);
    expect(getWorkerEnvironmentMswState()[0]?.id).toBe(env.id);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: expect.objectContaining({
          firstTurn: false,
          workBranch: "keep/branch",
          sessionRef: "sess-1",
        }),
      }),
    );
  });
});

describe("dispatchEnvironmentTurn — busy environment", () => {
  it("fails the created run 'environment_busy' and throws without dispatching", async () => {
    const env = seedEnv({ current_run_id: "other-run" });

    await expect(dispatchEnvironmentTurn(admin(), env, OPTS)).rejects.toBeInstanceOf(
      EnvironmentBusyError,
    );

    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.status).toBe("failed");
    expect(run?.failure_code).toBe("environment_busy");
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("dispatchEnvironmentTurn — dispatch failure releases the lock", () => {
  it("records the preflight code, releases the environment, and re-throws on WorkerPreflightError", async () => {
    const env = seedEnv();
    mockDispatch.mockRejectedValue(new WorkerPreflightError("no_git_connection", "no repo"));

    await expect(dispatchEnvironmentTurn(admin(), env, OPTS)).rejects.toThrow("no repo");

    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.status).toBe("failed");
    expect(run?.failure_code).toBe("no_git_connection");
    // Lock released so the environment isn't wedged.
    expect(getWorkerEnvironmentMswState().find((e) => e.id === env.id)?.current_run_id).toBeNull();
  });

  it("uses failure_code 'dispatch_failed' for a generic Error", async () => {
    const env = seedEnv();
    mockDispatch.mockRejectedValue(new Error("kaboom"));

    await expect(dispatchEnvironmentTurn(admin(), env, OPTS)).rejects.toThrow("kaboom");

    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.status).toBe("failed");
    expect(run?.failure_code).toBe("dispatch_failed");
    expect(run?.error_message).toBe("kaboom");
    expect(getWorkerEnvironmentMswState().find((e) => e.id === env.id)?.current_run_id).toBeNull();
  });
});

describe("dispatchEnvironmentTurn — fly substrate", () => {
  it("resolves the Fly config, dispatches 'fly', and records the machine ref", async () => {
    const flyConfig = { flyApiToken: "tok", workerApp: "worker-app" };
    mockFly.mockReturnValue(flyConfig);
    mockDispatch.mockResolvedValue({ dispatch: "fly", machineId: "machine-xyz" });
    const env = seedEnv({ substrate: "fly" });

    await dispatchEnvironmentTurn(admin(), env, OPTS);

    expect(mockFly).toHaveBeenCalledTimes(1);
    const run = getWorkerRunMswState().find((r) => r.workspace_id === env.id);
    expect(run?.dispatch).toBe("fly");
    expect(run?.machine_id).toBe("machine-xyz");
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ flyConfig }));
    // machineId present → the environment's machine ref is persisted.
    expect(getWorkerEnvironmentMswState().find((e) => e.id === env.id)?.machine_ref).toBe(
      "machine-xyz",
    );
  });
});

describe("localWorkspacePath", () => {
  it("is a stable per-env path under the OS temp dir", () => {
    expect(localWorkspacePath("env-xyz")).toBe(
      path.join(os.tmpdir(), "outerlayer-worker-env", "env-xyz"),
    );
    expect(localWorkspacePath("env-xyz").startsWith(os.tmpdir())).toBe(true);
    expect(localWorkspacePath("env-xyz")).toContain("env-xyz");
  });
});


describe("dispatchEnvironmentTurn — fly substrate threading", () => {
  it("passes the volume agent HOME and the durable-machine signal to dispatch", async () => {
    mockFly.mockReturnValue({ flyApiToken: "t", workerApp: "app" });
    mockDispatch.mockResolvedValue({ dispatch: "fly", machineId: "m-new" });
    const env = seedEnv({
      substrate: "fly",
      machine_ref: null,
      workspace_ref: "/data/workspace",
      work_branch: "keep/branch",
      session_ref: null,
    });

    await dispatchEnvironmentTurn(admin(), env, OPTS);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: expect.objectContaining({
          workspacePath: "/data/workspace",
          agentHome: "/data/home",
        }),
        persistentMachine: { machineRef: null, envId: env.id },
      }),
    );
    // The returned machine id is recorded on the environment for reuse.
    const stored = getWorkerEnvironmentMswState().find((e) => e.id === env.id);
    expect(stored?.machine_ref).toBe("m-new");
  });

  it("reuses the recorded machine ref on later turns", async () => {
    mockFly.mockReturnValue({ flyApiToken: "t", workerApp: "app" });
    mockDispatch.mockResolvedValue({ dispatch: "fly", machineId: "m-1" });
    const env = seedEnv({ substrate: "fly", machine_ref: "m-1", workspace_ref: "/data/workspace" });

    await dispatchEnvironmentTurn(admin(), env, OPTS);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ persistentMachine: { machineRef: "m-1", envId: env.id } }),
    );
  });

  it("local substrate sends neither agentHome nor a machine signal", async () => {
    const env = seedEnv({ substrate: "local" });
    await dispatchEnvironmentTurn(admin(), env, OPTS);
    const input = mockDispatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.persistentMachine).toBeUndefined();
    expect((input.persistent as Record<string, unknown>).agentHome).toBeUndefined();
  });
});
