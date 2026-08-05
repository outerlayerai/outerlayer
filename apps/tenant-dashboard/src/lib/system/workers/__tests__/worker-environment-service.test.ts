/**
 * WorkerEnvironmentService — the persistent-environment surface. The
 * single-turn lock (acquireForTurn) is the correctness property under test:
 * two turns must never run against one environment concurrently.
 */

import { createClient } from "@supabase/supabase-js";
import { WorkerEnvironmentService } from "../worker-environment-service";
import {
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";

function service() {
  return new WorkerEnvironmentService(createClient(SUPABASE_URL, ANON));
}
function env(over: Record<string, unknown>) {
  return {
    id: "env-1",
    tenant_id: "tenant-1",
    app_id: "app-1",
    agent: "claude-code",
    base_branch: "main",
    substrate: "local",
    status: "active",
    current_run_id: null,
    idle_ttl_s: 1800,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe("acquireForTurn (single-turn lock)", () => {
  it("acquires a free environment and reflects the holding run", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "env-1", current_run_id: null })] });
    const got = await service().acquireForTurn("app-1", "env-1", "run-A");
    expect(got?.current_run_id).toBe("run-A");
    expect(getWorkerEnvironmentMswState().find((e) => e.id === "env-1")?.current_run_id).toBe("run-A");
  });

  it("refuses to acquire an environment already holding a turn (serialization)", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "env-1", current_run_id: "run-A" })] });
    const second = await service().acquireForTurn("app-1", "env-1", "run-B");
    expect(second).toBeNull();
    // The original holder is untouched.
    expect(getWorkerEnvironmentMswState().find((e) => e.id === "env-1")?.current_run_id).toBe("run-A");
  });

  it("refuses to acquire a destroyed environment", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "env-1", status: "destroyed", current_run_id: null })] });
    expect(await service().acquireForTurn("app-1", "env-1", "run-B")).toBeNull();
  });
});

describe("completeTurn", () => {
  it("releases the lock and persists the new session handle", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "env-1", current_run_id: "run-A", session_ref: "old" })] });
    await service().completeTurn("env-1", "new-session");
    const row = getWorkerEnvironmentMswState().find((e) => e.id === "env-1")!;
    expect(row.current_run_id).toBeNull();
    expect(row.session_ref).toBe("new-session");
    expect(row.last_active_at).toEqual(expect.any(String));
  });

  it("keeps the prior session handle when the turn surfaced none", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "env-1", current_run_id: "run-A", session_ref: "keep" })] });
    await service().completeTurn("env-1", null);
    expect(getWorkerEnvironmentMswState().find((e) => e.id === "env-1")?.session_ref).toBe("keep");
  });
});

describe("countActiveForTenant", () => {
  it("counts non-destroyed environments only", async () => {
    seedWorkerEnvironmentMswState({
      rows: [
        env({ id: "a", status: "active" }),
        env({ id: "b", status: "suspended" }),
        env({ id: "c", status: "destroyed" }),
        env({ id: "d", tenant_id: "other", status: "active" }),
      ],
    });
    expect(await service().countActiveForTenant("tenant-1")).toBe(2);
  });
});

const createInput = {
  appId: "app-1",
  tenantId: "tenant-1",
  agent: "claude-code",
  baseBranch: "main",
  workBranch: "outerlayer/worker/env-x",
  substrate: "local" as const,
  workspaceRef: "/tmp/ws",
};

// Every DB call has an `if (error) throw new Error(`<op> failed: ${msg}`)`
// guard. Forcing a 500 on the matching verb proves the guard fires with its
// method-specific message (kills the string-literal mutant) rather than
// swallowing the error and returning a default (kills the conditional mutant).
describe("WorkerEnvironmentService error guards surface the DB error per method", () => {
  it("create → 'create worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceInsertError: { message: "boom" } });
    await expect(service().create(createInput)).rejects.toThrow(
      "create worker_workspace failed: boom",
    );
  });

  it("get → 'get worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceSelectError: { message: "boom" } });
    await expect(service().get("app-1", "env-1")).rejects.toThrow(
      "get worker_workspace failed: boom",
    );
  });

  it("list → 'list worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceSelectError: { message: "boom" } });
    await expect(service().list("app-1")).rejects.toThrow("list worker_workspace failed: boom");
  });

  it("countActiveForTenant → 'count worker_workspace failed'", async () => {
    seedWorkerEnvironmentMswState({ forceCountError: { message: "boom" } });
    await expect(service().countActiveForTenant("tenant-1")).rejects.toThrow(
      "count worker_workspace failed",
    );
  });

  it("acquireForTurn → 'acquire worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().acquireForTurn("app-1", "env-1", "run-A")).rejects.toThrow(
      "acquire worker_workspace failed: boom",
    );
  });

  it("completeTurn → 'complete worker_workspace turn failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().completeTurn("env-1", "sess")).rejects.toThrow(
      "complete worker_workspace turn failed: boom",
    );
  });

  it("markMachine → 'mark worker_workspace machine failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().markMachine("env-1", "machine-1")).rejects.toThrow(
      "mark worker_workspace machine failed: boom",
    );
  });

  it("destroy → 'destroy worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().destroy("env-1", "reason")).rejects.toThrow(
      "destroy worker_workspace failed: boom",
    );
  });

  it("fail → 'fail worker_workspace failed: <msg>'", async () => {
    seedWorkerEnvironmentMswState({ forceUpdateError: { message: "boom" } });
    await expect(service().fail("env-1", "reason")).rejects.toThrow(
      "fail worker_workspace failed: boom",
    );
  });
});

describe("WorkerEnvironmentService.fail", () => {
  it("suspends the environment, releases the lock, and truncates the reason to 2000 chars", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "e1", current_run_id: "run-A" })] });
    await service().fail("e1", "y".repeat(2500));

    const stored = getWorkerEnvironmentMswState().find((r) => r.id === "e1");
    expect(stored?.failure_reason?.length).toBe(2000);
    expect(stored?.status).toBe("suspended");
    expect(stored?.current_run_id).toBeNull();
  });
});

describe("WorkerEnvironmentService.destroy", () => {
  it("destroys, releases the lock, and truncates the reason to 2000 chars when given", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "e1", current_run_id: "run-A" })] });
    await service().destroy("e1", "z".repeat(2500));

    const stored = getWorkerEnvironmentMswState().find((r) => r.id === "e1");
    expect(stored?.failure_reason?.length).toBe(2000);
    expect(stored?.status).toBe("destroyed");
    expect(stored?.current_run_id).toBeNull();
  });

  it("sets failure_reason null when no reason is given", async () => {
    seedWorkerEnvironmentMswState({ rows: [env({ id: "e1", current_run_id: "run-A" })] });
    await service().destroy("e1");

    const stored = getWorkerEnvironmentMswState().find((r) => r.id === "e1");
    expect(stored?.failure_reason).toBeNull();
    expect(stored?.status).toBe("destroyed");
    expect(stored?.current_run_id).toBeNull();
  });
});
