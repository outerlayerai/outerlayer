/**
 * WorkersService reads, exercised through the real PostgREST query path against
 * the MSW `worker_run` / `worker_run_event` / `worker_workspace` tables (no
 * query-chain mocks). The service takes a per-request `ctx`; the client comes in
 * as `ctx.db`, so these assert the query shape (app scoping, ordering, the
 * seq/after filter, the destroyed exclusion) the deleted route tests covered,
 * now at the service seam.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedWorkerRunMswState,
  seedWorkerEnvironmentMswState,
  getWorkerRunMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

import { workersService, attachmentMetaFrom } from "./service";

const APP_ID = "app-1";

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: "tenant-1", actor: { userId: "user-1", role: "owner" } };
}

function runRow(overrides: { id: string; app_id?: string } & Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    agent: "claude-code",
    task_prompt: "do the thing",
    base_branch: "",
    status: "running",
    dispatch: "local",
    wall_clock_cap_s: 1800,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function envRow(overrides: { id: string; app_id?: string } & Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    agent: "claude-code",
    base_branch: "main",
    substrate: "local",
    status: "active",
    idle_ttl_s: 1800,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("WorkersService.listRuns", () => {
  it("returns the app's runs newest-first, scoped to the app", async () => {
    seedWorkerRunMswState({
      rows: [
        runRow({ id: "old", created_at: "2026-01-01T00:00:00.000Z", status: "completed" }),
        runRow({ id: "new", created_at: "2026-02-01T00:00:00.000Z" }),
        runRow({ id: "foreign", app_id: "other-app", created_at: "2026-03-01T00:00:00.000Z" }),
      ],
    });

    const runs = await workersService.listRuns(ctx(), APP_ID);
    expect(runs.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("WorkersService.getRun", () => {
  it("returns one run's detail for a visible id", async () => {
    seedWorkerRunMswState({
      rows: [runRow({ id: "r-1", base_branch: "main", cost_usd: 0.5, num_turns: 3 })],
    });

    const run = await workersService.getRun(ctx(), APP_ID, "r-1");
    expect(run?.id).toBe("r-1");
    expect(run?.base_branch).toBe("main");
    expect(run?.cost_usd).toBe(0.5);
    expect(run?.num_turns).toBe(3);
  });

  it("returns null for a foreign-app row — unknown id and foreign tenant are indistinguishable", async () => {
    seedWorkerRunMswState({ rows: [runRow({ id: "r-foreign", app_id: "other-app" })] });

    const run = await workersService.getRun(ctx(), APP_ID, "r-foreign");
    expect(run).toBeNull();
  });
});

describe("WorkersService.getRunEvents", () => {
  it("returns events after the given seq, ascending", async () => {
    seedWorkerRunMswState({
      rows: [runRow({ id: "r-1" })],
      events: [
        { id: "e2", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 2, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:02.000Z" },
        { id: "e1", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 1, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:01.000Z" },
        { id: "e3", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 3, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:03.000Z" },
      ],
    });

    const events = await workersService.getRunEvents(ctx(), "r-1", 1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns all events when afterSeq is -1", async () => {
    seedWorkerRunMswState({
      rows: [runRow({ id: "r-1" })],
      events: [
        { id: "e1", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 1, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:01.000Z" },
      ],
    });

    const events = await workersService.getRunEvents(ctx(), "r-1", -1);
    expect(events.map((e) => e.seq)).toEqual([1]);
  });
});

describe("WorkersService.listWorkspaces", () => {
  it("excludes destroyed workspaces and returns newest-first", async () => {
    seedWorkerEnvironmentMswState({
      rows: [
        envRow({ id: "w-old", created_at: "2026-01-01T00:00:00.000Z" }),
        envRow({ id: "w-new", created_at: "2026-02-01T00:00:00.000Z" }),
        envRow({ id: "w-gone", status: "destroyed", created_at: "2026-03-01T00:00:00.000Z" }),
      ],
    });

    const workspaces = await workersService.listWorkspaces(ctx(), APP_ID);
    expect(workspaces.map((w) => w.id)).toEqual(["w-new", "w-old"]);
  });
});

describe("WorkersService.getWorkspace", () => {
  it("returns the workspace for a visible id", async () => {
    seedWorkerEnvironmentMswState({ rows: [envRow({ id: "w-1", work_branch: "outerlayer/worker/env-1" })] });

    const ws = await workersService.getWorkspace(ctx(), APP_ID, "w-1");
    expect(ws?.id).toBe("w-1");
    expect(ws?.work_branch).toBe("outerlayer/worker/env-1");
  });

  it("returns null for a foreign-app workspace", async () => {
    seedWorkerEnvironmentMswState({ rows: [envRow({ id: "w-foreign", app_id: "other-app" })] });

    const ws = await workersService.getWorkspace(ctx(), APP_ID, "w-foreign");
    expect(ws).toBeNull();
  });
});

describe("WorkersService.listRunsByWorkspace", () => {
  it("returns a workspace's turns oldest-first by turn_index, scoped to the workspace", async () => {
    seedWorkerRunMswState({
      rows: [
        runRow({ id: "t2", workspace_id: "w-1", turn_index: 2 }),
        runRow({ id: "t0", workspace_id: "w-1", turn_index: 0 }),
        runRow({ id: "t1", workspace_id: "w-1", turn_index: 1 }),
        runRow({ id: "other-ws", workspace_id: "w-2", turn_index: 0 }),
      ],
    });

    const turns = await workersService.listRunsByWorkspace(ctx(), APP_ID, "w-1");
    expect(turns.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
  });
});

describe("attachmentMetaFrom", () => {
  it("keeps name/mime and decodes the base64 byte size for each padding case", () => {
    expect(
      attachmentMetaFrom([
        { name: "none", mime: "text/plain", content: "AAAAAAAA" }, // 8 chars, 0 pad
        { name: "one", mime: "image/png", content: "AAAAAAA=" }, //  8 chars, 1 pad
        { name: "two", mime: "application/pdf", content: "AAAAAA==" }, // 8 chars, 2 pad
      ]),
    ).toEqual([
      { name: "none", mime: "text/plain", size_bytes: 6 },
      { name: "one", mime: "image/png", size_bytes: 5 },
      { name: "two", mime: "application/pdf", size_bytes: 4 },
    ]);
  });

  it("returns [] for both undefined and an empty list", () => {
    expect(attachmentMetaFrom(undefined)).toEqual([]);
    expect(attachmentMetaFrom([])).toEqual([]);
  });
});

describe("WorkersService.createRun", () => {
  const input = {
    appId: APP_ID,
    environmentId: "env-1",
    createdBy: "user-1",
    agent: "claude-code",
    model: "sonnet",
    taskPrompt: "go",
    attachments: [],
    baseBranch: "main",
    dispatch: "local" as const,
    wallClockCapS: 1800,
  };

  it("inserts a queued run stamped with the request tenant and returns id/status/dispatch", async () => {
    const created = await workersService.createRun(ctx(), input);

    const rows = getWorkerRunMswState();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      app_id: APP_ID,
      tenant_id: "tenant-1",
      environment_id: "env-1",
      created_by: "user-1",
      agent: "claude-code",
      model: "sonnet",
      task_prompt: "go",
      base_branch: "main",
      dispatch: "local",
      wall_clock_cap_s: 1800,
      status: "queued",
    });
    expect(created.id).toBe(rows[0]!.id);
    expect(created.status).toBe("queued");
    expect(created.dispatch).toBe("local");
  });

  it("throws with the DB message when the insert fails", async () => {
    seedWorkerRunMswState({ forceInsertError: { message: "insert boom" } });
    await expect(workersService.createRun(ctx(), input)).rejects.toThrow(
      "worker_run create failed: insert boom",
    );
  });
});

describe("WorkersService.createWorkspace", () => {
  const input = {
    appId: APP_ID,
    environmentId: "env-1",
    createdBy: "user-1",
    agent: "claude-code",
    model: null,
    baseBranch: "main",
    substrate: "fly" as const,
  };

  it("inserts a creating workspace stamped with the tenant and returns id/substrate", async () => {
    const created = await workersService.createWorkspace(ctx(), input);

    const rows = getWorkerEnvironmentMswState();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      app_id: APP_ID,
      tenant_id: "tenant-1",
      environment_id: "env-1",
      agent: "claude-code",
      substrate: "fly",
      status: "creating",
    });
    expect(created.id).toBe(rows[0]!.id);
    expect(created.substrate).toBe("fly");
  });
});

describe("WorkersService.cancelRun", () => {
  it("cancels a non-terminal run and returns the teardown fields", async () => {
    seedWorkerRunMswState({
      rows: [runRow({ id: "r-1", status: "running", dispatch: "fly", machine_id: "m-1", workspace_id: null })],
    });

    const cancelled = await workersService.cancelRun(ctx(), APP_ID, "r-1");

    expect(cancelled).not.toBeNull();
    expect(cancelled!.id).toBe("r-1");
    expect(cancelled!.dispatch).toBe("fly");
    expect(cancelled!.machine_id).toBe("m-1");
    expect(cancelled!.workspace_id).toBeNull();
    expect(getWorkerRunMswState().find((r) => r.id === "r-1")?.status).toBe("cancelled");
  });

  it("is a no-op returning null for an already-terminal run", async () => {
    seedWorkerRunMswState({ rows: [runRow({ id: "r-done", status: "completed" })] });

    const cancelled = await workersService.cancelRun(ctx(), APP_ID, "r-done");

    expect(cancelled).toBeNull();
    expect(getWorkerRunMswState().find((r) => r.id === "r-done")?.status).toBe("completed");
  });
});

describe("WorkersService counts", () => {
  it("counts only the tenant's non-terminal runs, and 0 when there are none", async () => {
    expect(await workersService.countActiveRuns(ctx())).toBe(0);

    seedWorkerRunMswState({
      rows: [
        runRow({ id: "a", status: "running" }),
        runRow({ id: "b", status: "queued" }),
        runRow({ id: "c", status: "completed" }),
        runRow({ id: "d", status: "running", tenant_id: "other-tenant" }),
      ],
    });

    expect(await workersService.countActiveRuns(ctx())).toBe(2);
  });

  it("counts only the tenant's live workspaces, excluding destroyed", async () => {
    seedWorkerEnvironmentMswState({
      rows: [
        envRow({ id: "w-1", status: "active" }),
        envRow({ id: "w-2", status: "suspended" }),
        envRow({ id: "w-3", status: "destroyed" }),
      ],
    });

    expect(await workersService.countActiveWorkspaces(ctx())).toBe(2);
  });
});

describe("WorkersService.sumRunDurationMsSince", () => {
  it("sums duration_ms of the tenant's runs since the cutoff, counting null as 0", async () => {
    seedWorkerRunMswState({
      rows: [
        runRow({ id: "a", created_at: "2026-02-01T00:00:00.000Z", duration_ms: 60_000 }),
        runRow({ id: "b", created_at: "2026-02-02T00:00:00.000Z", duration_ms: 120_000 }),
        runRow({ id: "c", created_at: "2026-02-03T00:00:00.000Z", duration_ms: null }),
        runRow({ id: "old", created_at: "2026-01-01T00:00:00.000Z", duration_ms: 999_000 }),
      ],
    });

    const total = await workersService.sumRunDurationMsSince(ctx(), "2026-02-01T00:00:00.000Z");
    expect(total).toBe(180_000);
  });
});

describe("WorkersService read error paths", () => {
  it("listRuns throws with the DB message", async () => {
    seedWorkerRunMswState({ forceSelectError: { message: "select boom" } });
    await expect(workersService.listRuns(ctx(), APP_ID)).rejects.toThrow(
      "worker_run list failed: select boom",
    );
  });

  it("countActiveRuns throws with the DB message", async () => {
    seedWorkerRunMswState({ forceCountError: { message: "count boom" } });
    await expect(workersService.countActiveRuns(ctx())).rejects.toThrow(
      "worker_run active count failed: count boom",
    );
  });

  it("cancelRun throws with the DB message", async () => {
    seedWorkerRunMswState({ forceUpdateError: { message: "update boom" } });
    await expect(workersService.cancelRun(ctx(), APP_ID, "r-1")).rejects.toThrow(
      "worker_run cancel failed: update boom",
    );
  });
});
