/**
 * LocalWorkerAdapter — the Node child-process dispatch path.
 *
 * `node:child_process` is the one true seam here: the adapter's job is to
 * stage the params file, assemble the spawn invocation (command, args, cwd,
 * WORKER_PARAMS_FILE/WORKER_RUN_ID env), and wire the child's error/exit
 * logging + params-file cleanup. We fake `spawn` so nothing is actually
 * launched; the params file is written to the real temp dir and asserted.
 */

import { readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger, WorkerDispatchParams } from "@repo/worker-core";
import { isWorkerDispatchError } from "@repo/worker-core";

vi.mock("server-only", () => ({}));

type ChildHandlers = Record<string, (arg: unknown) => void>;

const { mockSpawn, fakeChild, childHandlers } = vi.hoisted(() => {
  const childHandlers: ChildHandlers = {};
  const fakeChild = {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      childHandlers[event] = cb;
      return fakeChild;
    }),
    unref: vi.fn(),
  };
  const mockSpawn = vi.fn(() => fakeChild);
  return { mockSpawn, fakeChild, childHandlers };
});

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { LocalWorkerAdapter } from "../local-worker-adapter";

const appLogger = { error: vi.fn(), info: vi.fn() };
const logger = { withAppId: vi.fn(() => appLogger) } as unknown as Logger;

function lastLoggedError(): [Error, Record<string, unknown>] {
  const call = appLogger.error.mock.calls.at(-1);
  if (!call) throw new Error("appLogger.error was not called");
  return call as [Error, Record<string, unknown>];
}

const PARAMS: WorkerDispatchParams = {
  workerRunId: "run-1",
  appId: "app-1",
  workerPayload: { worker_run_id: "run-1", task_prompt: "do the thing", secret: "s" },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(childHandlers)) delete childHandlers[key];
});

describe("LocalWorkerAdapter.triggerWorker", () => {
  it("stages a params file and spawns the runner with its path (never inline params) in the env", async () => {
    const result = await new LocalWorkerAdapter({ logger }).triggerWorker(PARAMS);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("npx");
    expect(args).toEqual(["tsx", "apps/worker/src/index.ts"]);
    expect(opts.cwd).toBe(path.resolve(process.cwd(), "../.."));
    expect(opts.stdio).toBe("pipe");
    expect(opts.detached).toBe(false);

    const env = opts.env as Record<string, string>;
    // A file handoff, not an env var: base64 attachments overflow the ~128 KB
    // per-entry env limit on Linux.
    expect(env.WORKER_PARAMS).toBeUndefined();
    expect(env.WORKER_PARAMS_FILE).toEqual(expect.stringContaining(os.tmpdir()));
    expect(await readFile(env.WORKER_PARAMS_FILE!, "utf8")).toBe(JSON.stringify(PARAMS.workerPayload));
    expect(env.WORKER_RUN_ID).toBe("run-1");
    // The ambient process env is carried through (so the child inherits PATH etc.).
    expect(env.PATH).toBe(process.env.PATH);

    // Fire-and-forget: the child is detached from the event loop.
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);

    // A local dispatch has no machine to record; only a correlation id comes back.
    expect(result).toEqual({ dispatchId: expect.any(String) });
    expect(result.dispatchId.length).toBeGreaterThan(0);
    expect((result as { machineId?: string }).machineId).toBeUndefined();
  });

  it("sweeps the staged params directory when the child exits", async () => {
    await new LocalWorkerAdapter({ logger }).triggerWorker(PARAMS);
    const env = (mockSpawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    const paramsFile = env.WORKER_PARAMS_FILE!;
    await expect(access(paramsFile)).resolves.toBeUndefined();

    childHandlers.exit?.(0);
    // The handler's rm is fire-and-forget; poll for the deletion.
    await vi.waitFor(async () => {
      await expect(access(paramsFile)).rejects.toThrow();
    });
  });

  it("scopes the logger to the app id", async () => {
    await new LocalWorkerAdapter({ logger }).triggerWorker(PARAMS);
    expect(logger.withAppId).toHaveBeenCalledWith("app-1");
  });

  it("logs a non-zero child exit but not a clean (code 0) exit", async () => {
    await new LocalWorkerAdapter({ logger }).triggerWorker(PARAMS);

    childHandlers.exit?.(0);
    expect(appLogger.error).not.toHaveBeenCalled();

    childHandlers.exit?.(137);
    expect(appLogger.error).toHaveBeenCalledTimes(1);
    const [loggedExit, exitMeta] = lastLoggedError();
    expect(loggedExit.message).toBe("Local worker process exited with code 137");
    expect(exitMeta).toEqual({ workerRunId: "run-1" });
  });

  it("logs a spawn 'error' event with the underlying message", async () => {
    await new LocalWorkerAdapter({ logger }).triggerWorker(PARAMS);

    childHandlers.error?.(new Error("ENOENT: npx missing"));
    expect(appLogger.error).toHaveBeenCalledTimes(1);
    const [logged, errorMeta] = lastLoggedError();
    expect(logged.message).toBe("Local worker process failed to start: ENOENT: npx missing");
    expect(errorMeta).toEqual({ workerRunId: "run-1" });
  });

  it("throws a WorkerDispatchError('dispatch-failed') when spawn throws synchronously", async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    const err = await new LocalWorkerAdapter({ logger })
      .triggerWorker(PARAMS)
      .catch((e: unknown) => e);

    expect(isWorkerDispatchError(err)).toBe(true);
    const dispatchErr = err as import("@repo/worker-core").WorkerDispatchError;
    expect(dispatchErr.kind).toBe("dispatch-failed");
    expect(dispatchErr.workerRunId).toBe("run-1");
    expect(dispatchErr.message).toBe("Failed to spawn local worker: EACCES");
  });

  it("stringifies a non-Error thrown by spawn in the dispatch error message", async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw "kaboom";
    });
    const err = await new LocalWorkerAdapter({ logger })
      .triggerWorker(PARAMS)
      .catch((e: unknown) => e);
    expect(isWorkerDispatchError(err)).toBe(true);
    expect((err as { message: string }).message).toBe("Failed to spawn local worker: kaboom");
  });
});
