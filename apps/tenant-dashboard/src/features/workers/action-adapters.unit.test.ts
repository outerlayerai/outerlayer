/**
 * Branch-exhaustive unit coverage of the action adapters' envelope flattening.
 * The sibling integration suite proves the adapters against the real actions;
 * this file seams the actions so every ActionResult variant — including ones
 * the integration harness cannot cheaply produce — maps to its exact flat
 * shape. Each assertion is a full-object toEqual so a dropped, renamed, or
 * cross-wired field fails the test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLaunch, mockCreate, mockTurn, mockCancel } = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockCreate: vi.fn(),
  mockTurn: vi.fn(),
  mockCancel: vi.fn(),
}));

vi.mock("./actions", () => ({
  launchWorkerAction: mockLaunch,
  createEnvironmentAction: mockCreate,
  runEnvironmentTurnAction: mockTurn,
  cancelWorkerAction: mockCancel,
}));

import { cancelWorker, createEnvironment, launchWorker, runEnvironmentTurn } from "./action-adapters";

const denied = { flag: "workers", limit: "max_concurrent_worker_runs", current: 3, max: 3 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("launchWorker", () => {
  it("maps an envelope failure to only the error message", async () => {
    mockLaunch.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "denied by policy" } });
    await expect(launchWorker({ appId: "a" })).resolves.toEqual({ error: "denied by policy" });
    expect(mockLaunch).toHaveBeenCalledWith({ appId: "a" });
  });

  it("maps invalid to only the validation message", async () => {
    mockLaunch.mockResolvedValue({ ok: true, data: { kind: "invalid", message: "appId must be a uuid" } });
    await expect(launchWorker({})).resolves.toEqual({ error: "appId must be a uuid" });
  });

  it("maps entitlement to only the denial payload", async () => {
    mockLaunch.mockResolvedValue({ ok: true, data: { kind: "entitlement", denied } });
    await expect(launchWorker({})).resolves.toEqual({ entitlement: denied });
  });

  it("maps dispatch_failed to the run id, failed status, and message", async () => {
    mockLaunch.mockResolvedValue({
      ok: true,
      data: { kind: "dispatch_failed", runId: "run-9", message: "no machine" },
    });
    await expect(launchWorker({})).resolves.toEqual({ runId: "run-9", status: "failed", error: "no machine" });
  });

  it("maps ok to the run id, live status, and dispatch mode", async () => {
    mockLaunch.mockResolvedValue({
      ok: true,
      data: { kind: "ok", runId: "run-1", status: "queued", dispatch: "fly" },
    });
    await expect(launchWorker({})).resolves.toEqual({ runId: "run-1", status: "queued", dispatch: "fly" });
  });
});

describe("createEnvironment", () => {
  it("maps an envelope failure to only the error message", async () => {
    mockCreate.mockResolvedValue({ ok: false, error: { code: "internal", message: "boom" } });
    await expect(createEnvironment({ appId: "a" })).resolves.toEqual({ error: "boom" });
    expect(mockCreate).toHaveBeenCalledWith({ appId: "a" });
  });

  it("maps invalid to only the validation message", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { kind: "invalid", message: "prompt required" } });
    await expect(createEnvironment({})).resolves.toEqual({ error: "prompt required" });
  });

  it("maps entitlement to only the denial payload", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { kind: "entitlement", denied } });
    await expect(createEnvironment({})).resolves.toEqual({ entitlement: denied });
  });

  it("maps dispatch_failed to the environment id and message without a run", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      data: { kind: "dispatch_failed", environmentId: "env-4", message: "first turn failed" },
    });
    await expect(createEnvironment({})).resolves.toEqual({ environmentId: "env-4", error: "first turn failed" });
  });

  it("maps ok to the environment id, run id, and status", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      data: { kind: "ok", environmentId: "env-1", runId: "run-2", status: "queued" },
    });
    await expect(createEnvironment({})).resolves.toEqual({ environmentId: "env-1", runId: "run-2", status: "queued" });
  });
});

describe("runEnvironmentTurn", () => {
  it("maps an envelope failure to only the error message", async () => {
    mockTurn.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "not yours" } });
    await expect(runEnvironmentTurn({ envId: "e" })).resolves.toEqual({ error: "not yours" });
    expect(mockTurn).toHaveBeenCalledWith({ envId: "e" });
  });

  it("maps failed with the busy flag preserved exactly", async () => {
    mockTurn.mockResolvedValue({ ok: true, data: { kind: "failed", busy: true, message: "environment busy" } });
    await expect(runEnvironmentTurn({})).resolves.toEqual({ busy: true, error: "environment busy" });
  });

  it("maps failed with busy false, not dropped", async () => {
    mockTurn.mockResolvedValue({ ok: true, data: { kind: "failed", busy: false, message: "gone" } });
    await expect(runEnvironmentTurn({})).resolves.toEqual({ busy: false, error: "gone" });
  });

  it("maps ok to the run id and turn index", async () => {
    mockTurn.mockResolvedValue({ ok: true, data: { kind: "ok", runId: "run-3", turnIndex: 2 } });
    await expect(runEnvironmentTurn({})).resolves.toEqual({ runId: "run-3", turnIndex: 2 });
  });
});

describe("cancelWorker", () => {
  it("maps an envelope failure to cancelled false plus the message", async () => {
    mockCancel.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "nope" } });
    await expect(cancelWorker({ runId: "r" })).resolves.toEqual({ cancelled: false, error: "nope" });
    expect(mockCancel).toHaveBeenCalledWith({ runId: "r" });
  });

  it("maps not_found to cancelled false with the fixed message", async () => {
    mockCancel.mockResolvedValue({ ok: true, data: { kind: "not_found" } });
    await expect(cancelWorker({})).resolves.toEqual({ cancelled: false, error: "Run not found" });
  });

  it("maps noop to cancelled false carrying the terminal status", async () => {
    mockCancel.mockResolvedValue({ ok: true, data: { kind: "noop", status: "succeeded" } });
    await expect(cancelWorker({})).resolves.toEqual({ cancelled: false, status: "succeeded" });
  });

  it("maps ok to cancelled true with the cancelled status", async () => {
    mockCancel.mockResolvedValue({ ok: true, data: { kind: "ok" } });
    await expect(cancelWorker({})).resolves.toEqual({ cancelled: true, status: "cancelled" });
  });
});
