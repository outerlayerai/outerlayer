import "server-only";

import type { WorkerAttachment } from "@repo/worker-core";
import {
  destroyWorkerMachine,
  stopWorkerMachine,
  workerSecretVaultName,
  workerTokenVaultName,
} from "@repo/worker-core";

import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { APP_URL } from "@/config-global";
import { serverLogger } from "@/lib/observability/server-logger";
import { WorkerRunService } from "@/lib/system/workers/worker-run-service";
import { WorkerEnvironmentService } from "@/lib/system/workers/worker-environment-service";
import { dispatchWorkerRun as dispatchLegacyWorkerRun, WorkerPreflightError } from "@/lib/system/workers/worker-dispatch";
import { dispatchEnvironmentTurn, EnvironmentBusyError, localWorkspacePath } from "@/lib/system/workers/environment-turn";
import { flyWorkerFromEnv, FLY_WORKER_WORKSPACE_PATH } from "@/lib/system/workers/worker-config";

/**
 * The single sanctioned crossing from the workers feature to the worker dispatch
 * machine plane. That plane — Vault secret staging, Fly machine lifecycle, git
 * provider / env-var resolution — is service-role work coupled to the legacy git,
 * env-var, and logger services and is consumed by machine routes outside the
 * workers slice (the internal callback, transcript, and PR webhooks), so it stays
 * in the legacy tree rather than moving into the feature. The feature's mutation
 * actions reach it only through the named functions here; nothing else in
 * features/** imports the legacy dispatch modules directly. Each function builds
 * the RLS-bypassing admin client itself, because dispatch preflight touches rows
 * the acting user cannot see under RLS.
 *
 * Expected dispatch outcomes (preflight failure, a busy workspace) come back as
 * `{ ok: false, code }` so the action can surface them to the user; only truly
 * unexpected faults throw.
 */

/**
 * Which compute a run dispatches to, decided by the machine's env config: a Fly
 * machine when cloud workers are configured, otherwise a local child process.
 * The run/workspace row records this at create time.
 */
export function workerDispatchKind(): "fly" | "local" {
  return flyWorkerFromEnv() ? "fly" : "local";
}

type Ok<T> = { ok: true } & T;
type MachineFailure = { ok: false; code: string; message: string };

type DispatchRunResult = Ok<{ dispatch: "fly" | "local"; machineId: string | null }> | MachineFailure;
type WorkspaceTurnResult = Ok<{ runId: string; turnIndex: number }> | MachineFailure;

interface DispatchRunInput {
  appId: string;
  tenantId: string;
  environmentId: string;
  runId: string;
  agent: string;
  model?: string;
  taskPrompt: string;
  attachments?: WorkerAttachment[];
  baseBranch: string;
  wallClockCapS: number;
}

/**
 * Dispatch a one-shot run to compute. On any dispatch failure the run is marked
 * failed (so it never hangs in `queued`) and the failure code is returned.
 */
export async function dispatchWorkerRun(input: DispatchRunInput): Promise<DispatchRunResult> {
  const admin = createSupabaseAdminClient();
  try {
    const result = await dispatchLegacyWorkerRun({
      adminSupabase: admin,
      appId: input.appId,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      workerRunId: input.runId,
      agent: input.agent,
      model: input.model,
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      baseBranch: input.baseBranch,
      wallClockCapS: input.wallClockCapS,
      appUrl: APP_URL,
      flyConfig: flyWorkerFromEnv(),
    });
    await new WorkerRunService(admin).markProvisioning(input.appId, input.runId, result.machineId);
    return { ok: true, dispatch: result.dispatch, machineId: result.machineId };
  } catch (err) {
    const code = err instanceof WorkerPreflightError ? err.code : "dispatch_failed";
    const message = err instanceof Error ? err.message : String(err);
    await new WorkerRunService(admin).fail(input.appId, input.runId, code, message);
    return { ok: false, code, message };
  }
}

interface StartWorkspaceInput {
  appId: string;
  workspaceId: string;
  taskPrompt: string;
  attachments?: WorkerAttachment[];
  createdBy: string | null;
  tenantId: string;
}

/**
 * Run the first turn of a freshly created workspace: set its durable paths (now
 * that the id exists), then dispatch. If the turn never starts, the workspace is
 * destroyed so it doesn't count against the environment cap.
 */
export async function startWorkspaceFirstTurn(input: StartWorkspaceInput): Promise<WorkspaceTurnResult> {
  const admin = createSupabaseAdminClient();
  const envService = new WorkerEnvironmentService(admin);
  const workspace = await envService.get(input.appId, input.workspaceId);
  if (!workspace) return { ok: false, code: "workspace_missing", message: "Workspace not found." };

  const workBranch = `outerlayer/worker/env-${workspace.id.slice(0, 8)}`;
  const workspaceRef =
    workspace.substrate === "fly" ? FLY_WORKER_WORKSPACE_PATH : localWorkspacePath(workspace.id);
  await admin
    .from("worker_workspace")
    .update({ work_branch: workBranch, workspace_ref: workspaceRef })
    .eq("id", workspace.id);
  const env = { ...workspace, work_branch: workBranch, workspace_ref: workspaceRef };

  try {
    const { runId, turnIndex } = await dispatchEnvironmentTurn(admin, env, {
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      createdBy: input.createdBy,
      tenantId: input.tenantId,
    });
    return { ok: true, runId, turnIndex };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await envService.destroy(env.id, message);
    return { ok: false, code: "dispatch_failed", message };
  }
}

interface WorkspaceTurnInput {
  appId: string;
  envId: string;
  taskPrompt: string;
  attachments?: WorkerAttachment[];
  createdBy: string | null;
  tenantId: string;
}

/**
 * Run a follow-up turn against an existing warm workspace with the agent session
 * resumed. A workspace already running a turn yields `code: "busy"`.
 */
export async function runWorkspaceTurn(input: WorkspaceTurnInput): Promise<WorkspaceTurnResult> {
  const admin = createSupabaseAdminClient();
  const env = await new WorkerEnvironmentService(admin).get(input.appId, input.envId);
  if (!env) return { ok: false, code: "workspace_missing", message: "Environment not found." };
  if (env.status === "destroyed") {
    return { ok: false, code: "workspace_destroyed", message: "Environment has been destroyed." };
  }

  try {
    const { runId, turnIndex } = await dispatchEnvironmentTurn(admin, env, {
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      createdBy: input.createdBy,
      tenantId: input.tenantId,
    });
    return { ok: true, runId, turnIndex };
  } catch (err) {
    if (err instanceof EnvironmentBusyError) {
      return { ok: false, code: "busy", message: err.message };
    }
    return { ok: false, code: "dispatch_failed", message: err instanceof Error ? err.message : String(err) };
  }
}

interface TeardownInput {
  runId: string;
  dispatch: "fly" | "local";
  machineId: string | null;
  workspaceId: string | null;
}

/**
 * Best-effort machine + secret teardown for a cancelled run. A persistent
 * workspace's machine is durable compute — STOP it; a one-shot machine is
 * destroyed. The workspace's single-turn lock is released only if this run still
 * holds it, and both per-run Vault secrets are removed so in-flight callbacks
 * fail closed. Never throws — a cancel is already recorded.
 */
export async function teardownCancelledRun(input: TeardownInput): Promise<void> {
  const admin = createSupabaseAdminClient();
  const flyConfig = flyWorkerFromEnv();

  if (input.dispatch === "fly" && input.machineId && flyConfig) {
    try {
      const opts = { flyApiToken: flyConfig.flyApiToken, workerApp: flyConfig.workerApp, machineId: input.machineId };
      if (input.workspaceId) await stopWorkerMachine(opts);
      else await destroyWorkerMachine(opts);
    } catch (err) {
      await serverLogger.error(
        new Error(`worker machine teardown on cancel failed: ${err instanceof Error ? err.message : String(err)}`),
        { runId: input.runId },
      );
    }
  }

  if (input.workspaceId) {
    await admin
      .from("worker_workspace")
      .update({ current_run_id: null, last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", input.workspaceId)
      .eq("current_run_id", input.runId);
  }

  await admin.rpc("delete_secret", { secret_name: workerSecretVaultName(input.runId) }).then(
    () => undefined,
    () => undefined,
  );
  await admin.rpc("delete_secret", { secret_name: workerTokenVaultName(input.runId) }).then(
    () => undefined,
    () => undefined,
  );
}
