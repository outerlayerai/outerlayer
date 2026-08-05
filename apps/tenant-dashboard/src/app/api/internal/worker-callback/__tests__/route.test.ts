/**
 * POST /api/internal/worker-callback — the runner's terminal report.
 *
 * The route owns auth + parse + hook wiring; the DB-apply semantics live in
 * `applyWorkerCallback` (@repo/worker-core, separately tested), so that is a
 * true seam here (mocked) — we assert the route hands it the parsed payload and
 * the git-delivery hooks, and maps its result onto the response. The per-run
 * secret verifier is the other seam. Persistence (the run lookup + the
 * persistent-turn lock release) runs through MSW.
 */

import {
  seedWorkerRunMswState,
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
} from "@/test-helpers/msw-handlers";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("server-only", () => ({}));

const { mockVerify, mockApply } = vi.hoisted(() => ({ mockVerify: vi.fn(), mockApply: vi.fn() }));
vi.mock("@/lib/system/workers/verify-worker-secret", () => ({ verifyWorkerSecret: mockVerify }));
vi.mock("@repo/worker-core", async (importActual) => {
  const actual = await importActual<typeof import("@repo/worker-core")>();
  return { ...actual, applyWorkerCallback: mockApply };
});
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn() },
}));

import { POST } from "../route";
import { serverLogger } from "@/lib/observability/server-logger";
import { WorkerEnvironmentService } from "@/lib/system/workers/worker-environment-service";

const RUN_ID = "worker-run-cb-1";
const APP_ID = "app-1";

function reqBody(body: unknown, auth: string | null = "Bearer secret-1") {
  return {
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth : null) },
  } as unknown as import("next/server").NextRequest;
}

/** A schema-valid succeeded/no_changes callback. */
function payload(over: Record<string, unknown> = {}) {
  return { worker_run_id: RUN_ID, app_id: APP_ID, status: "succeeded", outcome: "no_changes", raw_log: "", duration_ms: 1000, ...over };
}

function seedRun(over: Record<string, unknown> = {}) {
  seedWorkerRunMswState({
    rows: [
      {
        id: RUN_ID,
        tenant_id: "tenant-1",
        app_id: APP_ID,
        agent: "claude-code",
        task_prompt: "x",
        base_branch: "release-1",
        status: "running",
        dispatch: "local",
        wall_clock_cap_s: 1800,
        created_at: new Date().toISOString(),
        ...over,
      },
    ],
  });
}

beforeEach(() => {
  mockVerify.mockResolvedValue(true);
  mockApply.mockResolvedValue({ applied: true, finalStatus: "completed" });
});
afterEach(() => vi.clearAllMocks());

describe("POST /worker-callback", () => {
  it("400s an invalid payload without verifying auth or applying", async () => {
    const res = await POST(reqBody({ worker_run_id: RUN_ID })); // missing status/raw_log/duration_ms
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("400s when the body is not JSON (parse throws → null)", async () => {
    const badReq = {
      json: async () => {
        throw new Error("not json");
      },
      headers: { get: () => "Bearer secret-1" },
    } as unknown as import("next/server").NextRequest;
    const res = await POST(badReq);
    expect(res.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("401s when the per-run secret does not verify, without applying", async () => {
    mockVerify.mockResolvedValue(false);
    const res = await POST(reqBody(payload(), "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("delegates to applyWorkerCallback with the parsed payload + git hooks, and returns its result", async () => {
    seedRun({ workspace_id: null });
    const res = await POST(reqBody(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: true, finalStatus: "completed" });

    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: expect.anything(),
        logger: expect.anything(),
        landChanges: expect.any(Function),
        ensurePullRequest: expect.any(Function),
      }),
      expect.objectContaining({ worker_run_id: RUN_ID, app_id: APP_ID, status: "succeeded", outcome: "no_changes" }),
    );
  });

  it("surfaces applyWorkerCallback's not-applied result at 200 (unknown/terminal run)", async () => {
    seedRun({ workspace_id: null });
    mockApply.mockResolvedValue({ applied: false, reason: "not_found" });

    const res = await POST(reqBody(payload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: false, reason: "not_found" });
  });

  it("releases the environment lock and persists the session handle for a persistent turn", async () => {
    seedRun({ workspace_id: "env-9", base_branch: "main" });
    seedWorkerEnvironmentMswState({
      rows: [
        {
          id: "env-9",
          tenant_id: "tenant-1",
          app_id: APP_ID,
          agent: "claude-code",
          base_branch: "main",
          substrate: "local",
          status: "active",
          current_run_id: RUN_ID,
          session_ref: "old-session",
          idle_ttl_s: 1800,
          created_at: new Date().toISOString(),
        },
      ],
    });

    const res = await POST(reqBody(payload({ session_ref: "new-session" })));
    expect(res.status).toBe(200);

    const env = getWorkerEnvironmentMswState().find((e) => e.id === "env-9");
    expect(env?.current_run_id).toBeNull();
    expect(env?.session_ref).toBe("new-session");
  });
});

describe("POST /worker-callback — workspace-release block", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls completeTurn with the run's workspace id and the callback's session_ref", async () => {
    seedRun({ workspace_id: "env-9" });
    const completeTurn = vi
      .spyOn(WorkerEnvironmentService.prototype, "completeTurn")
      .mockResolvedValue(undefined);

    const res = await POST(reqBody(payload({ session_ref: "sess-abc" })));

    expect(res.status).toBe(200);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledWith("env-9", "sess-abc");
  });

  it("defaults session_ref to null when the callback payload omits it", async () => {
    seedRun({ workspace_id: "env-9" });
    const completeTurn = vi
      .spyOn(WorkerEnvironmentService.prototype, "completeTurn")
      .mockResolvedValue(undefined);

    await POST(reqBody(payload()));

    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledWith("env-9", null);
  });

  it("does not call completeTurn when the run carries no workspace_id", async () => {
    seedRun({ workspace_id: null });
    const completeTurn = vi
      .spyOn(WorkerEnvironmentService.prototype, "completeTurn")
      .mockResolvedValue(undefined);

    await POST(reqBody(payload()));

    expect(completeTurn).not.toHaveBeenCalled();
  });

  it("logs the failure and still returns the callback's success result when completeTurn rejects", async () => {
    seedRun({ workspace_id: "env-9" });
    vi.spyOn(WorkerEnvironmentService.prototype, "completeTurn").mockRejectedValue(
      new Error("db down"),
    );

    const res = await POST(reqBody(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: true, finalStatus: "completed" });
    expect(serverLogger.error).toHaveBeenCalledTimes(1);
    expect(serverLogger.error).toHaveBeenCalledWith(expect.any(Error), {
      workspaceId: "env-9",
    });
  });
});
