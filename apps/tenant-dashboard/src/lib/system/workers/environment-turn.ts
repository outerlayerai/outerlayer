import "server-only";

import * as os from "node:os";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerAttachment } from "@repo/worker-core";
import type { Database } from "@/types/db";
import { WorkerRunService, attachmentMetaFrom } from "./worker-run-service";
import { WorkerEnvironmentService, type WorkerEnvironmentRow } from "./worker-environment-service";
import { dispatchWorkerRun, WorkerPreflightError } from "./worker-dispatch";
import {
  flyWorkerFromEnv,
  DEFAULT_WALL_CLOCK_CAP_S,
  FLY_WORKER_AGENT_HOME,
  FLY_WORKER_WORKSPACE_PATH,
} from "./worker-config";
import { APP_URL } from "@/config-global";

/** Stable local workspace path for a persistent environment (dev/e2e substrate). */
export function localWorkspacePath(envId: string): string {
  return path.join(os.tmpdir(), "outerlayer-worker-env", envId);
}

export class EnvironmentBusyError extends Error {
  constructor() {
    super("This environment is already running a turn. Wait for it to finish.");
    this.name = "EnvironmentBusyError";
  }
}

interface DispatchTurnResult {
  runId: string;
  turnIndex: number;
}

/**
 * Dispatch one turn against a persistent environment:
 * create the turn's worker_run, acquire the environment's single-turn lock
 * (reject if busy), then dispatch with the persistent params block so the
 * runner reuses the durable workspace and resumes the agent session.
 *
 * On dispatch failure the run is failed and the lock released, so a stuck turn
 * never wedges the environment.
 */
export async function dispatchEnvironmentTurn(
  admin: SupabaseClient<Database>,
  env: WorkerEnvironmentRow,
  opts: {
    taskPrompt: string;
    createdBy: string | null;
    tenantId: string;
    attachments?: WorkerAttachment[];
  },
): Promise<DispatchTurnResult> {
  const runService = new WorkerRunService(admin);
  const envService = new WorkerEnvironmentService(admin);

  // Resolve the substrate against CURRENT compute config, not the value frozen
  // at creation: an environment created before cloud workers were configured
  // runs `local`, but must transparently move to `fly` on its next turn once
  // they are — the stored substrate is a cache, not a pin. When Fly is
  // unavailable it stays `local`, which fails fast on a hosted deploy.
  const flyConfig = flyWorkerFromEnv();
  const substrate: "fly" | "local" = flyConfig ? "fly" : "local";
  // A local→fly move can't carry the local durable state (host tmpdir
  // workspace + session files) onto a fresh Fly volume, so the promoting turn
  // starts clean: new machine + volume, re-clone, no session resume.
  const upgradingToFly = substrate === "fly" && env.substrate !== "fly";

  const priorTurns = await runService.listByEnvironment(env.app_id, env.id);
  const turnIndex = priorTurns.length;
  const firstTurn = turnIndex === 0 || upgradingToFly;

  const run = await runService.create({
    appId: env.app_id,
    tenantId: opts.tenantId,
    environmentId: env.environment_id,
    createdBy: opts.createdBy,
    agent: env.agent,
    model: env.model,
    taskPrompt: opts.taskPrompt,
    attachments: attachmentMetaFrom(opts.attachments),
    baseBranch: env.base_branch,
    dispatch: substrate,
    wallClockCapS: DEFAULT_WALL_CLOCK_CAP_S,
    workspaceId: env.id,
    turnIndex,
  });

  // Acquire the environment for this turn (serializes turns).
  const acquired = await envService.acquireForTurn(env.app_id, env.id, run.id);
  if (!acquired) {
    await runService.fail(env.app_id, run.id, "environment_busy", "Environment was busy with another turn.");
    throw new EnvironmentBusyError();
  }

  try {
    const result = await dispatchWorkerRun({
      adminSupabase: admin,
      appId: env.app_id,
      tenantId: opts.tenantId,
      environmentId: env.environment_id ?? "",
      workerRunId: run.id,
      agent: env.agent,
      model: env.model ?? undefined,
      taskPrompt: opts.taskPrompt,
      attachments: opts.attachments,
      baseBranch: env.base_branch,
      wallClockCapS: DEFAULT_WALL_CLOCK_CAP_S,
      appUrl: APP_URL,
      flyConfig,
      persistent: {
        // A promoting env's stored ref points at the old local path; the fly
        // workspace lives on the volume, so override it. Established envs keep
        // their recorded ref.
        workspacePath: upgradingToFly
          ? FLY_WORKER_WORKSPACE_PATH
          : (env.workspace_ref ?? localWorkspacePath(env.id)),
        workBranch: env.work_branch ?? `outerlayer/worker/env-${env.id.slice(0, 8)}`,
        // A promoting turn drops the local session handle and starts fresh.
        sessionRef: upgradingToFly ? undefined : (env.session_ref ?? undefined),
        firstTurn,
        // On fly the agent's HOME rides the volume so --resume session files
        // survive between turns; local keeps the host HOME.
        agentHome: substrate === "fly" ? FLY_WORKER_AGENT_HOME : undefined,
      },
      // Reuse the environment's durable machine when it exists; a first (or
      // promoting) fly turn has none, so create machine + volume (adapter
      // records nothing — we persist the returned machineId via markMachine).
      persistentMachine:
        substrate === "fly"
          ? { machineRef: upgradingToFly ? null : env.machine_ref, envId: env.id }
          : undefined,
    });
    await runService.markProvisioning(env.app_id, run.id, result.machineId);
    if (result.machineId) await envService.markMachine(env.id, result.machineId);
    // Persist the promotion so subsequent turns reuse the fly machine/volume.
    if (upgradingToFly) await envService.upgradeToFly(env.id, FLY_WORKER_WORKSPACE_PATH);
    return { runId: run.id, turnIndex };
  } catch (err) {
    const code = err instanceof WorkerPreflightError ? err.code : "dispatch_failed";
    const message = err instanceof Error ? err.message : String(err);
    await runService.fail(env.app_id, run.id, code, message);
    await envService.completeTurn(env.id, null); // release the lock
    throw err;
  }
}
