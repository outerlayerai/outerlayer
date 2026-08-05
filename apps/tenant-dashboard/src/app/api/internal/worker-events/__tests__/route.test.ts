/**
 * POST /api/internal/worker-events — the runner's transcript batches.
 *
 * Boundary: the per-run secret verifier is a true seam (mocked). Persistence
 * (event inserts + the queued→running transition) runs through MSW; assertions
 * read the stored worker_run + worker_run_event rows.
 */

import {
  seedWorkerRunMswState,
  getWorkerRunMswState,
  getWorkerRunEventMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("server-only", () => ({}));

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));
vi.mock("@/lib/system/workers/verify-worker-secret", () => ({ verifyWorkerSecret: mockVerify }));

import { POST } from "../route";

const RUN_ID = "run-1";
const APP_ID = "app-1";

function reqBody(body: unknown, auth = "Bearer secret-1") {
  return {
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth : null) },
  } as unknown as import("next/server").NextRequest;
}

function seedRun(status = "provisioning") {
  seedWorkerRunMswState({
    rows: [
      { id: RUN_ID, tenant_id: "tenant-1", app_id: APP_ID, agent: "claude-code", task_prompt: "x", base_branch: "", status, dispatch: "local", wall_clock_cap_s: 1800, created_at: new Date().toISOString() },
    ],
    events: [],
  });
}

const BATCH = {
  worker_run_id: RUN_ID,
  events: [
    { seq: 0, event_type: "status", payload: { phase: "started" } },
    { seq: 1, event_type: "agent-message", payload: { text: "working" } },
  ],
};

beforeEach(() => {
  mockVerify.mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("POST /worker-events", () => {
  it("appends events and flips the run queued/provisioning → running on the first batch", async () => {
    seedRun("provisioning");
    const res = await POST(reqBody(BATCH));
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(2);

    const events = getWorkerRunEventMswState();
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]!.event_type).toBe("status");
    expect(events[0]!.tenant_id).toBe("tenant-1");

    const run = getWorkerRunMswState().find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("running");
    expect(run?.started_at).toEqual(expect.any(String));
  });

  it("is idempotent on replay — duplicate (run, seq) rows are not double-inserted", async () => {
    seedRun("running");
    await POST(reqBody(BATCH));
    await POST(reqBody(BATCH));
    expect(getWorkerRunEventMswState()).toHaveLength(2);
  });

  it("401s when the per-run secret does not verify, writing nothing", async () => {
    seedRun("provisioning");
    mockVerify.mockResolvedValue(false);
    const res = await POST(reqBody(BATCH, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(getWorkerRunEventMswState()).toHaveLength(0);
    expect(getWorkerRunMswState().find((r) => r.id === RUN_ID)?.status).toBe("provisioning");
  });

  it("409s when the run is already terminal (a late batch cannot append)", async () => {
    seedRun("completed");
    const res = await POST(reqBody(BATCH));
    expect(res.status).toBe(409);
    expect(getWorkerRunEventMswState()).toHaveLength(0);
  });

  it("404s for an unknown run", async () => {
    const res = await POST(reqBody({ ...BATCH, worker_run_id: "ghost" }));
    expect(res.status).toBe(404);
  });

  it("400s an invalid batch (empty events array)", async () => {
    seedRun("running");
    const res = await POST(reqBody({ worker_run_id: RUN_ID, events: [] }));
    expect(res.status).toBe(400);
  });

  it("does not re-run the started transition when the run is already running", async () => {
    seedRun("running");
    await POST(reqBody(BATCH));
    const run = getWorkerRunMswState().find((r) => r.id === RUN_ID);
    // Stays running; started_at not overwritten by a later batch.
    expect(run?.status).toBe("running");
    expect(run?.started_at ?? null).toBeNull();
  });
});
