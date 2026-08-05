/**
 * The workers live-poll read helpers resolve the per-request ServiceContext and
 * return each surface through the real service query (MSW-backed) — the seam the
 * canonical `/api/orgs/…/workers/*` endpoints call. A missing run/workspace
 * resolves to null so the endpoint can answer 404 without an oracle.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedWorkerRunMswState,
  seedWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { loadCtxMock } = vi.hoisted(() => ({ loadCtxMock: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ loadRequestServiceContext: loadCtxMock }));

import {
  loadWorkerRuns,
  loadWorkerRun,
  loadWorkerWorkspaces,
  loadWorkerWorkspace,
} from "./read";

const APP_ID = "app-1";

function run(overrides: { id: string } & Record<string, unknown>) {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    agent: "claude-code",
    task_prompt: "task",
    base_branch: "",
    status: "running",
    dispatch: "local",
    wall_clock_cap_s: 1800,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function env(overrides: { id: string } & Record<string, unknown>) {
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

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  } satisfies ServiceContext);
});

it("loadWorkerRuns resolves the request context and returns the app's runs newest-first", async () => {
  seedWorkerRunMswState({
    rows: [
      run({ id: "old", created_at: "2026-01-01T00:00:00.000Z" }),
      run({ id: "new", created_at: "2026-02-01T00:00:00.000Z" }),
    ],
  });

  const runs = await loadWorkerRuns(APP_ID);
  expect(loadCtxMock).toHaveBeenCalledTimes(1);
  expect(runs.map((r) => r.id)).toEqual(["new", "old"]);
});

it("loadWorkerRun returns the run with events after the given seq, null when absent", async () => {
  seedWorkerRunMswState({
    rows: [run({ id: "r-1" })],
    events: [
      { id: "e1", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 1, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:01.000Z" },
      { id: "e2", worker_run_id: "r-1", tenant_id: "tenant-1", app_id: APP_ID, seq: 2, event_type: "log", payload: {}, created_at: "2026-01-01T00:00:02.000Z" },
    ],
  });

  const found = await loadWorkerRun(APP_ID, "r-1", 1);
  expect(found?.run.id).toBe("r-1");
  expect(found?.events.map((e) => e.seq)).toEqual([2]);

  const missing = await loadWorkerRun(APP_ID, "nope", -1);
  expect(missing).toBeNull();
});

it("loadWorkerWorkspaces returns the app's live workspaces", async () => {
  seedWorkerEnvironmentMswState({
    rows: [env({ id: "w-1" }), env({ id: "w-gone", status: "destroyed" })],
  });

  const workspaces = await loadWorkerWorkspaces(APP_ID);
  expect(workspaces.map((w) => w.id)).toEqual(["w-1"]);
});

it("loadWorkerWorkspace returns the workspace with its turns, null when absent", async () => {
  seedWorkerEnvironmentMswState({ rows: [env({ id: "w-1" })] });
  seedWorkerRunMswState({
    rows: [
      run({ id: "t1", workspace_id: "w-1", turn_index: 1 }),
      run({ id: "t0", workspace_id: "w-1", turn_index: 0 }),
    ],
  });

  const found = await loadWorkerWorkspace(APP_ID, "w-1");
  expect(found?.environment.id).toBe("w-1");
  expect(found?.turns.map((t) => t.id)).toEqual(["t0", "t1"]);

  const missing = await loadWorkerWorkspace(APP_ID, "nope");
  expect(missing).toBeNull();
});
