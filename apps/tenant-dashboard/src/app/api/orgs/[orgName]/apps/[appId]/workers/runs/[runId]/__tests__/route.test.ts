/**
 * Route-layer contract for the worker-run poll: after_seq parsing (absent and
 * malformed values both mean "from the beginning"), the loader receiving
 * exactly the path/query inputs, the 404 body for an invisible run, and the
 * 200 body being the loader result passed through unshaped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadWorkerRun } = vi.hoisted(() => ({ mockLoadWorkerRun: vi.fn() }));

vi.mock("@/features/workers/read", () => ({ loadWorkerRun: mockLoadWorkerRun }));

import { GET } from "../route";

const params = { orgName: "acme", appId: "app-1", runId: "run-1" };
const context = { params: Promise.resolve(params) };
const url = (query = "") => new Request(`http://test.local/api/orgs/acme/apps/app-1/workers/runs/run-1${query}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET workers/runs/[runId]", () => {
  it("defaults after_seq to -1 when the query param is absent", async () => {
    mockLoadWorkerRun.mockResolvedValue({ run: { id: "run-1" }, events: [] });
    const res = await GET(url(), context);
    expect(res.status).toBe(200);
    expect(mockLoadWorkerRun).toHaveBeenCalledWith("app-1", "run-1", -1);
  });

  it("passes a numeric after_seq through exactly", async () => {
    mockLoadWorkerRun.mockResolvedValue({ run: { id: "run-1" }, events: [] });
    await GET(url("?after_seq=7"), context);
    expect(mockLoadWorkerRun).toHaveBeenCalledWith("app-1", "run-1", 7);
  });

  it("treats a non-numeric after_seq as -1 rather than NaN", async () => {
    mockLoadWorkerRun.mockResolvedValue({ run: { id: "run-1" }, events: [] });
    await GET(url("?after_seq=abc"), context);
    expect(mockLoadWorkerRun).toHaveBeenCalledWith("app-1", "run-1", -1);
  });

  it("treats after_seq=0 as 0, not as the missing-param default", async () => {
    mockLoadWorkerRun.mockResolvedValue({ run: { id: "run-1" }, events: [] });
    await GET(url("?after_seq=0"), context);
    expect(mockLoadWorkerRun).toHaveBeenCalledWith("app-1", "run-1", 0);
  });

  it("404s with the exact error body when the loader sees no run", async () => {
    mockLoadWorkerRun.mockResolvedValue(null);
    const res = await GET(url(), context);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Run not found" });
  });

  it("returns the loader result unaltered as the 200 body", async () => {
    const payload = { run: { id: "run-1", status: "running" }, events: [{ seq: 3 }] };
    mockLoadWorkerRun.mockResolvedValue(payload);
    const res = await GET(url("?after_seq=2"), context);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });
});
