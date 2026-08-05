/**
 * FlyWorkerAdapter — persistent-environment surface (fly substrate):
 * first turn creates volume + durable machine (auto_destroy OFF, volume
 * mounted), later turns refresh the one-time env on the stopped machine and
 * start it, and the stop/teardown helpers are idempotent against
 * already-gone resources.
 */

import {
  FLY_MACHINES_API_BASE,
  FlyWorkerAdapter,
  WORKER_MACHINE_GUEST,
  WORKER_VOLUME_MOUNT_PATH,
  WORKER_VOLUME_SIZE_GB,
  destroyPersistentWorkerEnvironment,
  stopWorkerMachine,
  workerEnvMachineName,
  workerEnvVolumeName,
  type FlyWorkerAdapterDeps,
} from "../fly-worker-adapter";
import type { Logger, SupabaseClientType } from "../types";
import { createNoopLogger, createWorkerTestSupabase } from "./test-supabase";

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENV_ID = "12345678-9abc-def0-1234-56789abcdef0";
const PAYLOAD = { task_prompt: "keep going", repo_token: "sekrit" };

function createDeps(overrides?: Partial<FlyWorkerAdapterDeps>) {
  const db = createWorkerTestSupabase();
  const deps: FlyWorkerAdapterDeps = {
    supabase: db.client as SupabaseClientType,
    logger: createNoopLogger() as unknown as Logger,
    flyApiToken: "fly-token-abc",
    workerApp: "agentmark-workers-test",
    appUrl: "http://localhost:4000",
    ...overrides,
  };
  return { deps, db };
}

type StubResponse = { ok?: boolean; status?: number; body?: unknown; text?: string };
function sequencedFetch(responses: StubResponse[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.text ?? "",
      json: async () => r.body ?? {},
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callOf(fetchMock: ReturnType<typeof vi.fn>, i: number) {
  const [url, init] = fetchMock.mock.calls[i]! as [string, RequestInit];
  return { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("persistent first turn (machineRef null)", () => {
  it("creates the volume then the durable machine mounted on it", async () => {
    const { deps } = createDeps({ region: "iad" });
    const fetchMock = sequencedFetch([
      { body: { id: "vol_123" } }, // volume create
      { body: { id: "machine-env-1" } }, // machine create
    ]);

    const result = await new FlyWorkerAdapter(deps).triggerWorker({
      workerRunId: RUN_ID,
      appId: "app-1",
      workerPayload: PAYLOAD,
      persistentMachine: { machineRef: null, envId: ENV_ID },
    });
    expect(result.machineId).toBe("machine-env-1");

    const volume = callOf(fetchMock, 0);
    expect(volume.url).toBe(`${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/volumes`);
    expect(volume.method).toBe("POST");
    expect(volume.body).toEqual({
      name: workerEnvVolumeName(ENV_ID),
      size_gb: WORKER_VOLUME_SIZE_GB,
      region: "iad",
    });

    const machine = callOf(fetchMock, 1);
    expect(machine.url).toBe(`${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines`);
    expect(machine.body.name).toBe(workerEnvMachineName(ENV_ID));
    expect(machine.body.config).toEqual({
      image: "registry.fly.io/agentmark-workers-test:latest",
      env: {
        WORKER_TOKEN: expect.any(String),
        WORKER_RUN_ID: RUN_ID,
        DASHBOARD_URL: "http://localhost:4000",
      },
      guest: WORKER_MACHINE_GUEST,
      auto_destroy: false,
      restart: { policy: "no" },
      mounts: [{ volume: "vol_123", path: WORKER_VOLUME_MOUNT_PATH }],
    });
    // The security invariant holds on the durable path too: nothing from the
    // payload rides in config.env.
    expect(JSON.stringify(machine.body)).not.toContain("sekrit");
  });

  it("deletes the fresh volume when the machine create fails (no leak)", async () => {
    const { deps } = createDeps();
    const fetchMock = sequencedFetch([
      { body: { id: "vol_123" } },
      { ok: false, status: 422, text: "machine invalid" }, // machine create fails
      {}, // volume delete (best effort)
    ]);

    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
        persistentMachine: { machineRef: null, envId: ENV_ID },
      }),
    ).rejects.toMatchObject({ kind: "dispatch-failed" });

    const cleanup = callOf(fetchMock, 2);
    expect(cleanup.method).toBe("DELETE");
    expect(cleanup.url).toBe(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/volumes/vol_123`,
    );
  });
});

describe("persistent follow-up turn (machineRef set)", () => {
  it("refreshes the per-turn env on the stopped machine, then starts it", async () => {
    const { deps } = createDeps();
    const fetchMock = sequencedFetch([
      // GET current machine config
      { body: { config: { image: "img", env: { WORKER_TOKEN: "old", KEEP: "me" }, guest: {} } } },
      {}, // POST update
      {}, // POST start
    ]);

    const result = await new FlyWorkerAdapter(deps).triggerWorker({
      workerRunId: RUN_ID,
      appId: "app-1",
      workerPayload: PAYLOAD,
      persistentMachine: { machineRef: "machine-env-1", envId: ENV_ID },
    });
    expect(result.machineId).toBe("machine-env-1");

    const get = callOf(fetchMock, 0);
    expect(get.method).toBe("GET");
    expect(get.url).toBe(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines/machine-env-1`,
    );

    const update = callOf(fetchMock, 1);
    expect(update.method).toBe("POST");
    expect(update.url).toBe(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines/machine-env-1`,
    );
    // Old config survives; only the turn trio is refreshed (new token != old).
    expect(update.body.config.image).toBe("img");
    expect(update.body.config.env.KEEP).toBe("me");
    expect(update.body.config.env.WORKER_RUN_ID).toBe(RUN_ID);
    expect(update.body.config.env.WORKER_TOKEN).not.toBe("old");

    const start = callOf(fetchMock, 2);
    expect(start.method).toBe("POST");
    expect(start.url).toBe(
      `${FLY_MACHINES_API_BASE}/apps/agentmark-workers-test/machines/machine-env-1/start`,
    );
  });

  it("fails dispatch when the machine has no config to update", async () => {
    const { deps } = createDeps();
    sequencedFetch([{ body: {} }]);
    await expect(
      new FlyWorkerAdapter(deps).triggerWorker({
        workerRunId: RUN_ID,
        appId: "app-1",
        workerPayload: PAYLOAD,
        persistentMachine: { machineRef: "machine-env-1", envId: ENV_ID },
      }),
    ).rejects.toMatchObject({ kind: "dispatch-failed" });
  });
});

describe("stopWorkerMachine", () => {
  const OPTS = { flyApiToken: "t", workerApp: "app", machineId: "m1" };

  it("POSTs the stop endpoint", async () => {
    const fetchMock = sequencedFetch([{}]);
    await stopWorkerMachine(OPTS);
    const call = callOf(fetchMock, 0);
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${FLY_MACHINES_API_BASE}/apps/app/machines/m1/stop`);
  });

  it.each([
    [404, "not found"],
    [400, "machine already stopped"],
  ])("treats %s '%s' as success", async (status, text) => {
    sequencedFetch([{ ok: false, status, text }]);
    await expect(stopWorkerMachine(OPTS)).resolves.toBeUndefined();
  });

  it("throws on any other failure", async () => {
    sequencedFetch([{ ok: false, status: 500, text: "boom" }]);
    await expect(stopWorkerMachine(OPTS)).rejects.toThrow("Worker machine stop failed (500): boom");
  });
});

describe("destroyPersistentWorkerEnvironment", () => {
  const OPTS = { flyApiToken: "t", workerApp: "app", envId: ENV_ID };

  it("destroys the recorded machine, then the env's volume by name", async () => {
    const fetchMock = sequencedFetch([
      {}, // DELETE machine
      { body: [{ id: "vol_a", name: "other" }, { id: "vol_b", name: workerEnvVolumeName(ENV_ID) }] },
      {}, // DELETE volume
    ]);
    await destroyPersistentWorkerEnvironment({ ...OPTS, machineId: "m1" });

    expect(callOf(fetchMock, 0)).toMatchObject({
      method: "DELETE",
      url: `${FLY_MACHINES_API_BASE}/apps/app/machines/m1?force=true`,
    });
    expect(callOf(fetchMock, 1).method).toBe("GET");
    expect(callOf(fetchMock, 2)).toMatchObject({
      method: "DELETE",
      url: `${FLY_MACHINES_API_BASE}/apps/app/volumes/vol_b`,
    });
  });

  it("finds a machine with a lost ref by its deterministic name", async () => {
    const fetchMock = sequencedFetch([
      { body: [{ id: "m9", name: workerEnvMachineName(ENV_ID) }, { id: "mx", name: "worker-env-ffffffff" }] },
      {}, // DELETE machine m9
      { body: [] }, // volumes: none
    ]);
    await destroyPersistentWorkerEnvironment(OPTS);
    expect(callOf(fetchMock, 1).url).toBe(
      `${FLY_MACHINES_API_BASE}/apps/app/machines/m9?force=true`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when neither machine nor volume exists", async () => {
    const fetchMock = sequencedFetch([
      { body: [] }, // machines list: nothing
      { body: [] }, // volumes list: nothing
    ]);
    await expect(destroyPersistentWorkerEnvironment(OPTS)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a volume delete failure", async () => {
    sequencedFetch([
      {}, // DELETE machine
      { body: [{ id: "vol_b", name: workerEnvVolumeName(ENV_ID) }] },
      { ok: false, status: 500, text: "cannot" },
    ]);
    await expect(
      destroyPersistentWorkerEnvironment({ ...OPTS, machineId: "m1" }),
    ).rejects.toThrow("Worker volume destroy failed (500): cannot");
  });
});
