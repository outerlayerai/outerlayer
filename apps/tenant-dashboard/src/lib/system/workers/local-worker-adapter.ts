import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkerDispatchError,
  type WorkerDispatchAdapter,
  type WorkerDispatchParams,
  type WorkerDispatchResult,
} from "@repo/worker-core";
import type { Logger } from "@repo/worker-core";

/**
 * LocalWorkerAdapter — the Node-only WorkerDispatchAdapter.
 *
 * Spawns the worker runner (apps/worker) as a local child process with the
 * full params handed over via a single-use file (WORKER_PARAMS_FILE) — the
 * dev/CI counterpart to the Fly ephemeral machine, and the path the local e2e
 * exercises. A file, not an env var: params carry base64 attachments, and one
 * env entry caps out around 128 KB on Linux. The runner deletes the file after
 * reading it. Fire-and-forget: the child clones, runs the agent, and POSTs
 * events + callback to localhost. Never imported by the Workers gateway (uses
 * node:child_process).
 */
interface LocalWorkerAdapterDeps {
  logger: Logger;
}

export class LocalWorkerAdapter implements WorkerDispatchAdapter {
  constructor(private readonly deps: LocalWorkerAdapterDeps) {}

  async triggerWorker(params: WorkerDispatchParams): Promise<WorkerDispatchResult> {
    const { workerRunId, appId, workerPayload } = params;
    const dispatchId = crypto.randomUUID();
    const appLogger = this.deps.logger.withAppId(appId);

    // process.cwd() is apps/tenant-dashboard/ — the monorepo root is two up.
    const monorepoRoot = path.resolve(process.cwd(), "../..");

    let paramsFile: string;
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "worker-params-"));
      paramsFile = path.join(dir, "params.json");
      await writeFile(paramsFile, JSON.stringify(workerPayload), { mode: 0o600 });
    } catch (error) {
      throw new WorkerDispatchError(
        "dispatch-failed",
        `Failed to stage local worker params: ${error instanceof Error ? error.message : String(error)}`,
        workerRunId,
      );
    }

    try {
      const child = spawn("npx", ["tsx", "apps/worker/src/index.ts"], {
        cwd: monorepoRoot,
        env: {
          ...process.env,
          WORKER_PARAMS_FILE: paramsFile,
          WORKER_RUN_ID: workerRunId,
        },
        stdio: "pipe",
        detached: false,
      });
      child.on("error", (err: Error) => {
        void rm(path.dirname(paramsFile), { recursive: true, force: true }).catch(() => undefined);
        void appLogger.error(new Error(`Local worker process failed to start: ${err.message}`), {
          workerRunId,
        });
      });
      child.on("exit", (code: number | null) => {
        // The runner deletes the file on read; this sweeps the crash-early case.
        void rm(path.dirname(paramsFile), { recursive: true, force: true }).catch(() => undefined);
        if (code !== 0) {
          void appLogger.error(new Error(`Local worker process exited with code ${code}`), {
            workerRunId,
          });
        }
      });
      child.unref();
    } catch (error) {
      await rm(path.dirname(paramsFile), { recursive: true, force: true }).catch(() => undefined);
      throw new WorkerDispatchError(
        "dispatch-failed",
        `Failed to spawn local worker: ${error instanceof Error ? error.message : String(error)}`,
        workerRunId,
      );
    }

    // Local dispatch has no machine to destroy.
    return { dispatchId };
  }
}
