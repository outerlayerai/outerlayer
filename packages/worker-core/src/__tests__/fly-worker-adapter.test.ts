/**
 * FlyWorkerAdapter: pins the WorkerDispatchAdapter contract for the Fly
 * implementation — and the machine-config security invariant: the
 * only values that ride in config.env are WORKER_TOKEN / WORKER_RUN_ID /
 * DASHBOARD_URL; everything sensitive stays behind the Vault handshake.
 */

import {
  FLY_MACHINES_API_BASE,
  FlyWorkerAdapter,
  destroyWorkerMachine,
  type FlyWorkerAdapterDeps,
} from "../fly-worker-adapter";
import { WorkerDispatchError, isWorkerDispatchError } from "../worker-adapter";
import type { Logger, SupabaseClientType } from "../types";
import { createNoopLogger, createWorkerTestSupabase } from "./test-supabase";

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PAYLOAD = { task_prompt: "do things", repo_token: "sekrit-token" };

function createDeps(
  overrides?: Partial<FlyWorkerAdapterDeps>,
  db = createWorkerTestSupabase(),
): { deps: FlyWorkerAdapterDeps; db: ReturnType<typeof createWorkerTestSupabase> } {
  return {
    deps: {
      supabase: db.client as SupabaseClientType,
      logger: createNoopLogger() as unknown as Logger,
      flyApiToken: "fly-token-abc",
      workerApp: "agentmark-workers-test",
      appUrl: "http://localhost:4000",
      ...overrides,
    },
    db,
  };
}

function stubFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ id: "machine-123" }),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FlyWorkerAdapter.triggerWorker", () => {
  it("stashes {token, payload} in Vault and creates a machine whose env carries ONLY the three boot keys", async () => {
    const fetchMock = stubFetchOnce({});
    const { deps, db } = createDeps();

    const result = await new FlyWorkerAdapter(deps).triggerWorker({
      workerRunId: RUN_ID,
      appId: "app-1",
      workerPayload: PAYLOAD,
    });

    expect(result.machineId).toBe("machine-123");
    expect(typeof result.dispatchId).toBe("string");

    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0]!.fn).toBe("insert_secret");
    const rpcParams = db.rpcs[0]!.params as { name: string; secret: string };
    expect(rpcParams.name).toBe(`worker_token_${RUN_ID}`);
    const stored = JSON.parse(rpcParams.secret);
    expect(stored.payload).toEqual(PAYLOAD);
    expect(typeof stored.token).toBe("string");

    expect(fetchMock).toHaveBeenCalledWith(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer fly-token-abc",
          "Content-Type": "application/json",
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      name: `worker-${RUN_ID.slice(0, 8)}`,
      config: {
        image: "registry.fly.io/agentmark-workers-test:latest",
        env: {
          WORKER_TOKEN: stored.token,
          WORKER_RUN_ID: RUN_ID,
          DASHBOARD_URL: "http://localhost:4000",
        },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
        auto_destroy: true,
        restart: { policy: "no" },
      },
    });
    // The secret payload must never leak into the machine config.
    expect(fetchMock.mock.calls[0]![1]!.body as string).not.toContain("sekrit-token");
  });

  it("throws misconfigured (without naming env vars) when the Fly token is absent, before any side effect", async () => {
    const fetchMock = stubFetchOnce({});
    const { deps, db } = createDeps({ flyApiToken: undefined });

    const promise = new FlyWorkerAdapter(deps).triggerWorker({
      workerRunId: RUN_ID,
      appId: "app-1",
      workerPayload: PAYLOAD,
    });

    await expect(promise).rejects.toSatisfy(
      (e: unknown) => isWorkerDispatchError(e) && e.kind === "misconfigured",
    );
    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
      }),
    ).rejects.not.toThrow(/FLY_API_TOKEN/);
    expect(db.rpcs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws dispatch-failed and never calls Fly when the Vault stash fails", async () => {
    const fetchMock = stubFetchOnce({});
    const db = createWorkerTestSupabase({}, { rpcError: (fn) => (fn === "insert_secret" ? "vault down" : null) });
    const { deps } = createDeps({}, db);

    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isWorkerDispatchError(e) && e.kind === "dispatch-failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cleans up the staged Vault token when the machine create is rejected", async () => {
    stubFetchOnce({ ok: false, status: 422, text: async () => "no capacity" });
    const { deps, db } = createDeps();

    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isWorkerDispatchError(e) &&
        e.kind === "dispatch-failed" &&
        e.message.includes("422"),
    );
    expect(db.rpcs).toEqual([
      { fn: "insert_secret", params: expect.objectContaining({ name: `worker_token_${RUN_ID}` }) },
      { fn: "delete_secret", params: { secret_name: `worker_token_${RUN_ID}` } },
    ]);
  });

  it("maps a network failure to unavailable and cleans up the staged token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { deps, db } = createDeps();

    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isWorkerDispatchError(e) && e.kind === "unavailable",
    );
    expect(db.rpcs[1]!).toEqual({
      fn: "delete_secret",
      params: { secret_name: `worker_token_${RUN_ID}` },
    });
  });

  it("uses an explicit workerImage and region when provided", async () => {
    const fetchMock = stubFetchOnce({});
    const { deps } = createDeps({ workerImage: "registry.fly.io/custom:v2", region: "sjc" });

    await new FlyWorkerAdapter(deps).triggerWorker({
      workerRunId: RUN_ID,
      appId: "app-1",
      workerPayload: PAYLOAD,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.region).toBe("sjc");
    expect(body.config.image).toBe("registry.fly.io/custom:v2");
  });
});

describe("destroyWorkerMachine", () => {
  it("issues a force DELETE against the machine", async () => {
    const fetchMock = stubFetchOnce({});

    await destroyWorkerMachine({
      flyApiToken: "fly-token-abc",
      workerApp: "agentmark-workers-test",
      machineId: "machine-123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines/machine-123?force=true`,
      { method: "DELETE", headers: { Authorization: "Bearer fly-token-abc" } },
    );
  });

  it("treats 404 as success (auto_destroy already fired)", async () => {
    stubFetchOnce({ ok: false, status: 404 });

    await expect(
      destroyWorkerMachine({
        flyApiToken: "t",
        workerApp: "a",
        machineId: "m",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws on other failures with the status in the message", async () => {
    stubFetchOnce({ ok: false, status: 500, text: async () => "boom" });

    await expect(
      destroyWorkerMachine({ flyApiToken: "t", workerApp: "a", machineId: "m" }),
    ).rejects.toThrow(/500/);
  });
});

describe("WorkerDispatchError", () => {
  it("is identifiable via isWorkerDispatchError and carries kind + runId", () => {
    const err = new WorkerDispatchError("unavailable", "down", RUN_ID);
    expect(isWorkerDispatchError(err)).toBe(true);
    expect(isWorkerDispatchError(new Error("down"))).toBe(false);
    expect(err.kind).toBe("unavailable");
    expect(err.workerRunId).toBe(RUN_ID);
  });
});
