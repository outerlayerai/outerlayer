/**
 * WorkerReaperService — the deadline logic (isOverdue) and the reap sweep.
 * Persistence runs through MSW worker_run; a frozen clock drives the
 * overdue math so the boundaries are exact.
 */

import { createClient } from "@supabase/supabase-js";
import { WorkerReaperService } from "../worker-reaper-service";
import {
  seedWorkerRunMswState,
  getWorkerRunMswState,
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { mockDestroy, mockStop, mockDestroyEnv, mockFly } = vi.hoisted(() => ({
  mockDestroy: vi.fn(),
  mockStop: vi.fn(),
  mockDestroyEnv: vi.fn(),
  mockFly: vi.fn(),
}));
vi.mock("@repo/worker-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/worker-core")>();
  return {
    ...actual,
    destroyWorkerMachine: mockDestroy,
    stopWorkerMachine: mockStop,
    destroyPersistentWorkerEnvironment: mockDestroyEnv,
  };
});
vi.mock("../worker-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-config")>();
  return { ...actual, flyWorkerFromEnv: mockFly };
});

beforeEach(() => {
  mockDestroy.mockResolvedValue(undefined);
  mockStop.mockResolvedValue(undefined);
  mockDestroyEnv.mockResolvedValue(undefined);
  mockFly.mockReturnValue({ flyApiToken: "fly-t", workerApp: "workers-app" });
});
afterEach(() => vi.clearAllMocks());

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";
const NOW = Date.parse("2026-07-11T12:00:00Z");

function service() {
  return new WorkerReaperService(createClient(SUPABASE_URL, ANON), () => NOW);
}

function run(over: Record<string, unknown>) {
  return {
    id: "r",
    tenant_id: "tenant-1",
    app_id: "app-1",
    agent: "claude-code",
    task_prompt: "x",
    base_branch: "",
    status: "running",
    dispatch: "local",
    machine_id: null,
    wall_clock_cap_s: 1800,
    started_at: null,
    created_at: "2026-07-11T11:00:00Z",
    ...over,
  };
}

describe("WorkerReaperService.isOverdue", () => {
  it("a running run is overdue once started_at + cap + 10min grace has passed", () => {
    // started 40 min ago, cap 1800s (30m) + grace 600s (10m) = 40m → exactly at the edge.
    const justPast = run({ status: "running", started_at: "2026-07-11T11:19:59Z", wall_clock_cap_s: 1800 });
    const notYet = run({ status: "running", started_at: "2026-07-11T11:21:00Z", wall_clock_cap_s: 1800 });
    expect(WorkerReaperService.isOverdue(justPast as never, NOW)).toBe(true);
    expect(WorkerReaperService.isOverdue(notYet as never, NOW)).toBe(false);
  });

  it("a never-started run is overdue after the provisioning grace (15min)", () => {
    const stuck = run({ status: "provisioning", started_at: null, created_at: "2026-07-11T11:40:00Z" });
    const fresh = run({ status: "queued", started_at: null, created_at: "2026-07-11T11:50:00Z" });
    expect(WorkerReaperService.isOverdue(stuck as never, NOW)).toBe(true);
    expect(WorkerReaperService.isOverdue(fresh as never, NOW)).toBe(false);
  });
});

describe("WorkerReaperService.reapOverdueRuns", () => {
  it("marks overdue runs timed_out with callback_missing and leaves fresh runs untouched", async () => {
    seedWorkerRunMswState({
      rows: [
        run({ id: "overdue", status: "running", started_at: "2026-07-11T10:00:00Z" }),
        run({ id: "fresh", status: "running", started_at: "2026-07-11T11:55:00Z" }),
        run({ id: "done", status: "completed", started_at: "2026-07-11T10:00:00Z" }),
      ],
    });

    const result = await service().reapOverdueRuns();

    expect(result.reaped).toEqual(["overdue"]);
    const rows = getWorkerRunMswState();
    expect(rows.find((r) => r.id === "overdue")?.status).toBe("timed_out");
    expect(rows.find((r) => r.id === "overdue")?.failure_code).toBe("callback_missing");
    expect(rows.find((r) => r.id === "fresh")?.status).toBe("running");
    // A terminal run is never rescanned (the .in filter excludes it) and stays put.
    expect(rows.find((r) => r.id === "done")?.status).toBe("completed");
  });

  it("cleans up Vault secrets for a reaped run", async () => {
    seedWorkerRunMswState({ rows: [run({ id: "overdue", status: "running", started_at: "2026-07-11T10:00:00Z" })] });
    // The MSW vault handler accepts delete_secret; we assert the run transitioned,
    // which only happens after the delete calls resolve without throwing.
    const result = await service().reapOverdueRuns();
    expect(result.reaped).toEqual(["overdue"]);
    expect(result.failed).toEqual([]);
  });

  it("returns an empty result when nothing is overdue", async () => {
    seedWorkerRunMswState({ rows: [run({ id: "fresh", status: "running", started_at: "2026-07-11T11:59:00Z" })] });
    expect(await service().reapOverdueRuns()).toEqual({ reaped: [], failed: [] });
  });
});


function env(over: Record<string, unknown>) {
  return {
    id: "e",
    tenant_id: "tenant-1",
    app_id: "app-1",
    agent: "claude-code",
    base_branch: "",
    substrate: "fly",
    status: "active",
    machine_ref: "m-1",
    current_run_id: null,
    idle_ttl_s: 1800,
    last_active_at: "2026-07-11T11:00:00Z",
    created_at: "2026-07-11T10:00:00Z",
    ...over,
  };
}

describe("reapOverdueRuns — persistent turns", () => {
  it("STOPS (never destroys) the durable machine and releases the env lock", async () => {
    seedWorkerRunMswState({
      rows: [
        run({
          id: "turn-1",
          status: "running",
          dispatch: "fly",
          machine_id: "m-1",
          workspace_id: "env-1",
          started_at: "2026-07-11T10:00:00Z",
        }),
      ],
    });
    seedWorkerEnvironmentMswState({
      rows: [env({ id: "env-1", current_run_id: "turn-1" })],
    });

    const result = await service().reapOverdueRuns();

    expect(result.reaped).toEqual(["turn-1"]);
    expect(mockStop).toHaveBeenCalledWith({
      flyApiToken: "fly-t",
      workerApp: "workers-app",
      machineId: "m-1",
    });
    expect(mockDestroy).not.toHaveBeenCalled();
    const stored = getWorkerEnvironmentMswState().find((e) => e.id === "env-1");
    expect(stored?.current_run_id).toBeNull();
    expect(stored?.last_active_at).toEqual(expect.any(String));
  });

  it("destroys the machine of an overdue ONE-SHOT fly run (no workspace_id)", async () => {
    seedWorkerRunMswState({
      rows: [
        run({
          id: "oneshot",
          status: "running",
          dispatch: "fly",
          machine_id: "m-9",
          workspace_id: null,
          started_at: "2026-07-11T10:00:00Z",
        }),
      ],
    });
    const result = await service().reapOverdueRuns();
    expect(result.reaped).toEqual(["oneshot"]);
    expect(mockDestroy).toHaveBeenCalledWith({
      flyApiToken: "fly-t",
      workerApp: "workers-app",
      machineId: "m-9",
    });
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe("environment idle lifecycle predicates", () => {
  it("isIdlePastTtl: active + free + past its per-env TTL only", () => {
    const past = env({ last_active_at: "2026-07-11T11:29:59Z" }); // ttl 1800s → 11:30 cutoff
    const notYet = env({ last_active_at: "2026-07-11T11:31:00Z" });
    const busy = env({ last_active_at: "2026-07-11T11:00:00Z", current_run_id: "r1" });
    const suspended = env({ status: "suspended", last_active_at: "2026-07-11T11:00:00Z" });
    expect(WorkerReaperService.isIdlePastTtl(past as never, NOW)).toBe(true);
    expect(WorkerReaperService.isIdlePastTtl(notYet as never, NOW)).toBe(false);
    expect(WorkerReaperService.isIdlePastTtl(busy as never, NOW)).toBe(false);
    expect(WorkerReaperService.isIdlePastTtl(suspended as never, NOW)).toBe(false);
  });

  it("falls back to created_at when a turn-0 env never recorded activity", () => {
    const stale = env({ last_active_at: null, created_at: "2026-07-11T11:00:00Z" });
    expect(WorkerReaperService.isIdlePastTtl(stale as never, NOW)).toBe(true);
  });

  it("isPastDestroyWindow: free + inactive for 7 days, active or suspended", () => {
    const old = env({ status: "suspended", last_active_at: "2026-07-04T11:59:00Z" });
    const recent = env({ status: "suspended", last_active_at: "2026-07-05T12:01:00Z" });
    const busy = env({ status: "suspended", last_active_at: "2026-07-01T00:00:00Z", current_run_id: "r1" });
    expect(WorkerReaperService.isPastDestroyWindow(old as never, NOW)).toBe(true);
    expect(WorkerReaperService.isPastDestroyWindow(recent as never, NOW)).toBe(false);
    expect(WorkerReaperService.isPastDestroyWindow(busy as never, NOW)).toBe(false);
  });
});

describe("reapIdleEnvironments", () => {
  it("suspends idle-past-TTL envs and destroys week-dead ones (machine+volume via fly)", async () => {
    seedWorkerEnvironmentMswState({
      rows: [
        env({ id: "idle", last_active_at: "2026-07-11T11:00:00Z" }), // past 1800s TTL
        env({ id: "fresh", last_active_at: "2026-07-11T11:55:00Z" }),
        env({ id: "dead", status: "suspended", machine_ref: "m-dead", last_active_at: "2026-07-01T00:00:00Z" }),
        env({ id: "busy", current_run_id: "r1", last_active_at: "2026-07-01T00:00:00Z" }),
      ],
    });

    const result = await service().reapIdleEnvironments();

    expect(result.suspended).toEqual(["idle"]);
    expect(result.destroyed).toEqual(["dead"]);
    expect(result.failed).toEqual([]);
    expect(mockDestroyEnv).toHaveBeenCalledWith({
      flyApiToken: "fly-t",
      workerApp: "workers-app",
      envId: "dead",
      machineId: "m-dead",
    });

    const rows = getWorkerEnvironmentMswState();
    expect(rows.find((e) => e.id === "idle")?.status).toBe("suspended");
    expect(rows.find((e) => e.id === "fresh")?.status).toBe("active");
    expect(rows.find((e) => e.id === "dead")?.status).toBe("destroyed");
    expect(rows.find((e) => e.id === "busy")?.status).toBe("active");
  });

  it("skips fly teardown for a local-substrate env but still marks it destroyed", async () => {
    seedWorkerEnvironmentMswState({
      rows: [env({ id: "loc", substrate: "local", machine_ref: null, status: "suspended", last_active_at: "2026-07-01T00:00:00Z" })],
    });
    const result = await service().reapIdleEnvironments();
    expect(result.destroyed).toEqual(["loc"]);
    expect(mockDestroyEnv).not.toHaveBeenCalled();
  });

  it("records a per-env failure without aborting the sweep", async () => {
    mockDestroyEnv.mockRejectedValueOnce(new Error("fly down"));
    seedWorkerEnvironmentMswState({
      rows: [
        env({ id: "dead1", status: "suspended", last_active_at: "2026-07-01T00:00:00Z" }),
        env({ id: "idle2", last_active_at: "2026-07-11T11:00:00Z" }),
      ],
    });
    const result = await service().reapIdleEnvironments();
    expect(result.failed).toEqual([{ id: "dead1", error: "fly down" }]);
    expect(result.suspended).toEqual(["idle2"]);
  });
});
