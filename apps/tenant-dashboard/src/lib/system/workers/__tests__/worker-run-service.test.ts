/**
 * WorkerRunService — the DB surface. Persistence runs through MSW worker_run;
 * these pin the non-obvious query semantics: the cancel guard (only from a
 * non-terminal state) and the active-count / minutes-sum aggregation inputs to
 * the entitlement gate.
 */

import { createClient } from "@supabase/supabase-js";
import { WorkerRunService } from "../worker-run-service";
import { seedWorkerRunMswState, getWorkerRunMswState } from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";

function service() {
  return new WorkerRunService(createClient(SUPABASE_URL, ANON));
}
function row(over: Record<string, unknown>) {
  return {
    id: "r",
    tenant_id: "tenant-1",
    app_id: "app-1",
    agent: "claude-code",
    task_prompt: "x",
    base_branch: "",
    status: "running",
    dispatch: "local",
    wall_clock_cap_s: 1800,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe("WorkerRunService.cancel", () => {
  it("cancels a running run and returns the row", async () => {
    seedWorkerRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    const cancelled = await service().cancel("app-1", "r1");
    expect(cancelled?.status).toBe("cancelled");
    expect(getWorkerRunMswState().find((r) => r.id === "r1")?.completed_at).toEqual(expect.any(String));
  });

  it("is a no-op returning null when the run is already terminal (completion race)", async () => {
    seedWorkerRunMswState({ rows: [row({ id: "r1", status: "completed" })] });
    const cancelled = await service().cancel("app-1", "r1");
    expect(cancelled).toBeNull();
    expect(getWorkerRunMswState().find((r) => r.id === "r1")?.status).toBe("completed");
  });
});

describe("WorkerRunService aggregation inputs", () => {
  it("counts only non-terminal runs for the tenant", async () => {
    seedWorkerRunMswState({
      rows: [
        row({ id: "a", status: "queued" }),
        row({ id: "b", status: "running" }),
        row({ id: "c", status: "completed" }),
        row({ id: "d", status: "cancelled" }),
        row({ id: "e", tenant_id: "other", status: "running" }),
      ],
    });
    expect(await service().countActiveForTenant("tenant-1")).toBe(2);
  });

  it("sums duration_ms for the tenant since a cutoff", async () => {
    seedWorkerRunMswState({
      rows: [
        row({ id: "a", duration_ms: 60_000, created_at: "2026-07-05T00:00:00Z" }),
        row({ id: "b", duration_ms: 120_000, created_at: "2026-07-10T00:00:00Z" }),
        row({ id: "old", duration_ms: 999_000, created_at: "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(await service().sumDurationMsForTenantSince("tenant-1", "2026-07-01T00:00:00Z")).toBe(180_000);
  });
});

describe("WorkerRunService.isTerminal", () => {
  it("classifies terminal vs in-flight states", () => {
    expect(WorkerRunService.isTerminal("completed")).toBe(true);
    expect(WorkerRunService.isTerminal("timed_out")).toBe(true);
    expect(WorkerRunService.isTerminal("running")).toBe(false);
    expect(WorkerRunService.isTerminal("provisioning")).toBe(false);
  });
});

const createInput = {
  appId: "app-1",
  tenantId: "tenant-1",
  agent: "claude-code",
  taskPrompt: "do the thing",
  baseBranch: "main",
  dispatch: "local" as const,
  wallClockCapS: 1800,
};

// Each DB call carries an `if (error) throw new Error(`<op> failed: ${msg}`)`
// guard. Forcing a 500 on the matching PostgREST verb proves the guard fires
// AND that its message is the method-specific one (kills the string-literal
// mutant), not a swallowed error (kills the conditional mutant → the method
// would otherwise return a default like null/0/[]).
describe("WorkerRunService error guards surface the DB error per method", () => {
  it("create → 'create worker_run failed: <msg>' on an insert error", async () => {
    seedWorkerRunMswState({ forceInsertError: { message: "boom" } });
    await expect(service().create(createInput)).rejects.toThrow("create worker_run failed: boom");
  });

  it("get → 'get worker_run failed: <msg>' on a select error", async () => {
    seedWorkerRunMswState({ forceSelectError: { message: "boom" } });
    await expect(service().get("app-1", "r1")).rejects.toThrow("get worker_run failed: boom");
  });

  it("list → 'list worker_run failed: <msg>' on a select error", async () => {
    seedWorkerRunMswState({ forceSelectError: { message: "boom" } });
    await expect(service().list("app-1")).rejects.toThrow("list worker_run failed: boom");
  });

  it("listByEnvironment → 'list environment turns failed: <msg>' on a select error", async () => {
    seedWorkerRunMswState({ forceSelectError: { message: "boom" } });
    await expect(service().listByEnvironment("app-1", "env-1")).rejects.toThrow(
      "list environment turns failed: boom",
    );
  });

  it("countActiveForTenant → 'count worker_run failed' on a count error", async () => {
    seedWorkerRunMswState({ forceCountError: { message: "boom" } });
    await expect(service().countActiveForTenant("tenant-1")).rejects.toThrow("count worker_run failed");
  });

  it("sumDurationMsForTenantSince → 'sum worker_run duration failed: <msg>' on a select error", async () => {
    seedWorkerRunMswState({ forceSelectError: { message: "boom" } });
    await expect(
      service().sumDurationMsForTenantSince("tenant-1", "2026-07-01T00:00:00Z"),
    ).rejects.toThrow("sum worker_run duration failed: boom");
  });

  it("cancel → 'cancel worker_run failed: <msg>' on an update error", async () => {
    seedWorkerRunMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().cancel("app-1", "r1")).rejects.toThrow("cancel worker_run failed: boom");
  });

  it("patch (markProvisioning) → 'update worker_run failed: <msg>' on an update error", async () => {
    seedWorkerRunMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().markProvisioning("app-1", "r1", "machine-1")).rejects.toThrow(
      "update worker_run failed: boom",
    );
  });
});

describe("WorkerRunService.fail", () => {
  it("truncates the error message to exactly 2000 chars and records the failure", async () => {
    seedWorkerRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    await service().fail("app-1", "r1", "dispatch_failed", "x".repeat(3000));

    const stored = getWorkerRunMswState().find((r) => r.id === "r1");
    expect(stored?.error_message?.length).toBe(2000);
    expect(stored?.status).toBe("failed");
    expect(stored?.failure_code).toBe("dispatch_failed");
    expect(stored?.completed_at).toEqual(expect.any(String));
  });

  it("stores a short message unchanged", async () => {
    seedWorkerRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    await service().fail("app-1", "r1", "environment_busy", "brief");
    expect(getWorkerRunMswState().find((r) => r.id === "r1")?.error_message).toBe("brief");
  });
});
