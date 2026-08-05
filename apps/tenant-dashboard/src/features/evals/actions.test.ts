/**
 * launchEvalRun — the glue around `authorizedAction`: it validates the launch
 * input, authorizes the app-scoped eval_run.insert, and only then delegates to
 * the single dispatch call, re-seeding the benchmarks React Server Component
 * (RSC) via revalidatePath.
 * The behavior under test: a read-only actor is refused BEFORE any dispatch
 * (secret read / credential mint) runs. The context + permission seams are
 * mocked; dispatch is a seam here (its own tests own the orchestration).
 */

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const { dispatchMock, listMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  listMock: vi.fn(),
}));
vi.mock("./service", () => ({ evalsService: { dispatch: dispatchMock, list: listMock } }));

import { launchEvalRun, refreshEvalRuns } from "./actions";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ENV_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const BENCHMARKS_PATH = "/orgs/[orgName]/apps/[appName]/env/[envName]/benchmarks";

const CONFIGS = [
  { id: "opus", launcher: "claude-code", model: "claude-opus-4-8" },
  { id: "glm", launcher: "claude-code", model: "glm-5.2" },
];
const validInput = () => ({
  appId: APP_ID,
  environmentId: ENV_ID,
  repoLabel: "acme/x",
  taskCount: 5,
  trialsPerTask: 1,
  budgetUsd: 0,
  configs: CONFIGS,
});

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: {},
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
  dispatchMock.mockResolvedValue({ runId: "run-1", status: "running" });
});

it("authorizes eval_run.insert on the target app, dispatches once, and revalidates", async () => {
  const res = await launchEvalRun(validInput());

  expect(res).toEqual({ ok: true, data: { runId: "run-1", status: "running" } });
  expect(checkPermMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user-1" }),
    "eval_run.insert",
    APP_ID,
  );
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  expect(dispatchMock).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: "tenant-1" }),
    expect.objectContaining({ appId: APP_ID, environmentId: ENV_ID, configs: CONFIGS }),
  );
  expect(revalidateMock).toHaveBeenCalledWith(BENCHMARKS_PATH, "page");
});

it("refuses a read-only actor before any dispatch — no secret read, no mint, no revalidate", async () => {
  checkPermMock.mockResolvedValue(false);

  const res = await launchEvalRun(validInput());

  expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(revalidateMock).not.toHaveBeenCalled();
});

it("rejects a launch without exactly two configs at the validation seam — before authorize or dispatch", async () => {
  const res = await launchEvalRun({ ...validInput(), configs: [CONFIGS[0]] });

  expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(checkPermMock).not.toHaveBeenCalled();
  expect(dispatchMock).not.toHaveBeenCalled();
});

describe("refreshEvalRuns", () => {
  const RUNS = [{ id: "run-1", status: "succeeded" }];

  it("authorizes eval_run.read on the target app and returns the list verbatim", async () => {
    listMock.mockResolvedValue(RUNS);

    const res = await refreshEvalRuns({ appId: APP_ID });

    expect(res).toEqual({ ok: true, data: RUNS });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "eval_run.read",
      APP_ID,
    );
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1" }), APP_ID);
  });

  it("refuses an actor without eval_run.read — no list call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await refreshEvalRuns({ appId: APP_ID });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(listMock).not.toHaveBeenCalled();
  });
});
