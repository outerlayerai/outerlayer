/**
 * GET /api/cron/worker-reaper — the scheduled reaper trigger.
 *
 * The route is thin: authenticate the cron bearer, delegate to
 * WorkerReaperService (mocked seam — its sweep logic is tested in
 * worker-reaper-service.test.ts), and map the result to a status code. We pin
 * the auth gate and the failed-only → 500 mapping.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

beforeAll(() => {
  if (typeof Response.json !== "function") {
    (Response as unknown as Record<string, unknown>).json = (data: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(data), {
        ...init,
        headers: { ...((init as Record<string, unknown>)?.["headers"] ?? {}), "content-type": "application/json" },
      });
  }
});

const mockReap = vi.hoisted(() => vi.fn());
const mockReapEnvs = vi.hoisted(() => vi.fn());

vi.mock("@/config-global.server", () => ({
  CRON_SECRET: "test-cron-secret",
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

vi.mock("@/lib/system/workers/worker-reaper-service", () => ({
  WorkerReaperService: class {
    reapOverdueRuns = mockReap;
    reapIdleEnvironments = mockReapEnvs;
  },
}));

import { GET } from "../route";

function cronRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = token;
  return new NextRequest("http://localhost/api/cron/worker-reaper", { method: "GET", headers });
}

const NO_ENVS = { suspended: [], destroyed: [], failed: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mockReapEnvs.mockResolvedValue(NO_ENVS);
});

describe("GET /api/cron/worker-reaper", () => {
  it("401s with no authorization header", async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
    expect(mockReap).not.toHaveBeenCalled();
  });

  it("401s with the wrong bearer token", async () => {
    const res = await GET(cronRequest("Bearer nope"));
    expect(res.status).toBe(401);
    expect(mockReap).not.toHaveBeenCalled();
  });

  it("200s and returns runs + environments in the sweep result", async () => {
    mockReap.mockResolvedValue({ reaped: ["run-a", "run-b"], failed: [] });
    mockReapEnvs.mockResolvedValue({ suspended: ["env-1"], destroyed: ["env-2"], failed: [] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reaped: ["run-a", "run-b"],
      failed: [],
      environments: { suspended: ["env-1"], destroyed: ["env-2"], failed: [] },
    });
  });

  it("200s when nothing was overdue (no reaps, no failures)", async () => {
    mockReap.mockResolvedValue({ reaped: [], failed: [] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
  });

  it("500s only when there were failures and zero progress anywhere", async () => {
    mockReap.mockResolvedValue({ reaped: [], failed: ["run-x"] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reaped: [], failed: ["run-x"], environments: NO_ENVS });
  });

  it("200s when runs failed but the environment sweep made progress", async () => {
    mockReap.mockResolvedValue({ reaped: [], failed: ["run-x"] });
    mockReapEnvs.mockResolvedValue({ suspended: ["env-1"], destroyed: [], failed: [] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
  });

  it("500s when only the environment sweep failed and nothing progressed", async () => {
    mockReap.mockResolvedValue({ reaped: [], failed: [] });
    mockReapEnvs.mockResolvedValue({ suspended: [], destroyed: [], failed: [{ id: "env-9", error: "boom" }] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
  });

  it("200s on a partial sweep (some reaped, some failed) — not 500", async () => {
    // Kills the &&→|| mutant: a failure alongside a success must stay 200.
    mockReap.mockResolvedValue({ reaped: ["run-a"], failed: ["run-x"] });
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
  });

  it("500s with an error body when the sweep throws", async () => {
    mockReap.mockRejectedValue(new Error("db exploded"));
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db exploded" });
  });

  it("500s with a stringified body when the sweep rejects with a non-Error", async () => {
    mockReap.mockRejectedValue("catastrophe");
    const res = await GET(cronRequest("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "catastrophe" });
  });
});
