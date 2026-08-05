import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { collectEnvVars } from "@/lib/system/collect-env-vars";
import { getGithubApp } from "@/octo-kit";
import { getAgentCredentialKeys } from "@/lib/worker-agents";
import { WORKER_CAPS } from "./worker-config";
import {
  FlyWorkerAdapter,
  workerSecretVaultName,
  type WorkerAttachment,
  type WorkerDispatchAdapter,
  type WorkerParamsPayload,
} from "@repo/worker-core";
import { LocalWorkerAdapter } from "./local-worker-adapter";
import type { FlyWorkerConfig } from "./worker-config";
import { serverLogger } from "@/lib/observability/server-logger";

/**
 * Assembles a worker run's params payload and dispatches it.
 *
 * Secret posture mirrors the managed build:
 *   - the per-run worker_secret (events/callback bearer) is stashed in Vault
 *     (`worker_secret_<runId>`) so the internal routes can verify it without a
 *     shared global secret;
 *   - the FlyWorkerAdapter stages the full params (incl. git token + agent
 *     credential) in Vault behind a one-time token, so the machine config
 *     carries no secret. Local dispatch passes params inline to a child.
 */

export class WorkerPreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerPreflightError";
    this.code = code;
  }
}

interface DispatchWorkerInput {
  adminSupabase: SupabaseClient<Database>;
  appId: string;
  tenantId: string;
  environmentId: string;
  workerRunId: string;
  agent: string;
  /** Resolved model (adapter alias) for the agent CLI; omit for its default. */
  model?: string;
  taskPrompt: string;
  /** User-uploaded files (validated by the route) delivered to the runner. */
  attachments?: WorkerAttachment[];
  baseBranch: string;
  wallClockCapS: number;
  appUrl: string;
  flyConfig: FlyWorkerConfig | null;
  /**
   * Present for a persistent-environment turn: the durable workspace, the
   * work branch to accumulate on, the agent session to resume, and whether
   * this is the environment's first turn (clone) or a follow-up (reuse+resume).
   */
  persistent?: {
    workspacePath: string;
    workBranch: string;
    sessionRef?: string;
    firstTurn: boolean;
    /** Volume-backed HOME for the agent on durable substrates. */
    agentHome?: string;
  };
  /**
   * Durable-machine signal for the dispatch adapter (fly substrate): reuse
   * machineRef when set, else create the environment's machine + volume.
   */
  persistentMachine?: { machineRef: string | null; envId: string };
}

interface DispatchWorkerResult {
  dispatch: "fly" | "local";
  machineId: string | null;
}

interface RepoResolution {
  repoUrl: string;
  repoToken: string;
  provider: "github" | "local";
  branch: string;
}

async function resolveRepo(
  supabase: SupabaseClient<Database>,
  appId: string,
  requestedBranch: string | null,
): Promise<RepoResolution> {
  const { data: connection } = await supabase
    .from("git_connection")
    .select("provider, repository, installation_id")
    .match({ app_id: appId })
    .single();
  if (!connection?.repository) {
    throw new WorkerPreflightError("no_git_connection", "This app has no connected git repository.");
  }

  async function resolveBranch(): Promise<string> {
    if (requestedBranch) return requestedBranch;
    const { data: branchRow } = await supabase
      .from("git_branch")
      .select("branch_name")
      .match({ app_id: appId })
      .single();
    return branchRow?.branch_name ?? "main";
  }

  // Local dev/e2e: an absolute path or file:// URL clones from / lands to a
  // local bare repo — no hosted provider or token.
  if (connection.repository.startsWith("/") || connection.repository.startsWith("file://")) {
    return { repoUrl: connection.repository, repoToken: "local", provider: "local", branch: await resolveBranch() };
  }

  const provider = "github" as const;

  let repoToken: string | null = null;
  if (connection.installation_id) {
    const octokit = await getGithubApp().getInstallationOctokit(Number(connection.installation_id));
    const auth = (await octokit.auth({ type: "installation" })) as { token: string };
    repoToken = auth.token;
  }
  if (!repoToken) {
    throw new WorkerPreflightError("git_token_unavailable", "Could not obtain a git access token for this app.");
  }

  return { repoUrl: connection.repository, repoToken, provider, branch: await resolveBranch() };
}

/** Preflight: the agent credential must be present in the env's Vault-backed vars. */
async function assertAgentCredential(
  envVars: Record<string, string>,
  agent: string,
): Promise<void> {
  const keys = getAgentCredentialKeys(agent);
  if (!keys) {
    throw new WorkerPreflightError("unknown_agent", `Unknown agent: ${agent}`);
  }
  const hasCredential = keys.some(
    (k: string) => typeof envVars[k] === "string" && envVars[k]!.length > 0,
  );
  if (!hasCredential) {
    throw new WorkerPreflightError(
      "missing_agent_credential",
      `This agent needs one of these env vars set for the environment: ${keys.join(", ")}.`,
    );
  }
}

export async function dispatchWorkerRun(input: DispatchWorkerInput): Promise<DispatchWorkerResult> {
  const { adminSupabase, appId, environmentId, workerRunId } = input;

  // 1. Resolve repo + short-lived clone token (fails preflight → no machine).
  const repo = await resolveRepo(adminSupabase, appId, input.baseBranch || null);

  // 2. Collect env vars (Vault-resolved) and require the agent credential.
  const envVars = await collectEnvVars(appId, environmentId);
  await assertAgentCredential(envVars, input.agent);

  // 3. Stage the per-run worker secret (events/callback bearer).
  const workerSecret = crypto.randomUUID();
  const secretVaultName = workerSecretVaultName(workerRunId);
  await adminSupabase.rpc("delete_secret", { secret_name: secretVaultName });
  const { error: secretError } = await adminSupabase.rpc("insert_secret", {
    name: secretVaultName,
    secret: workerSecret,
  });
  if (secretError) {
    throw new WorkerPreflightError("secret_stage_failed", `Failed to stage worker secret: ${secretError.message}`);
  }

  // 4. Assemble the params payload. Reserved AgentMark keys are scrubbed by the
  //    runner before the agent runs; we do not inject them here.
  const payload: WorkerParamsPayload = {
    worker_run_id: workerRunId,
    app_id: appId,
    tenant_id: input.tenantId,
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
    task_prompt: input.taskPrompt,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    repo_url: repo.repoUrl,
    repo_token: repo.repoToken,
    git_provider: repo.provider,
    base_branch: repo.branch,
    env_vars: envVars,
    events_url: `${input.appUrl}/api/internal/worker-events`,
    callback_url: `${input.appUrl}/api/internal/worker-callback`,
    transcript_url: `${input.appUrl}/api/internal/worker-transcript`,
    worker_secret: workerSecret,
    wall_clock_cap_s: input.wallClockCapS,
    caps: WORKER_CAPS,
    ...(input.persistent
      ? {
          persistent: {
            workspace_path: input.persistent.workspacePath,
            work_branch: input.persistent.workBranch,
            session_ref: input.persistent.sessionRef,
            first_turn: input.persistent.firstTurn,
            agent_home: input.persistent.agentHome,
          },
        }
      : {}),
  };

  // 5. Pick the adapter: Fly when configured, else local child process.
  //    Local dispatch spawns a child (apps/worker via tsx) and only works on a
  //    real host — local dev or CI. A hosted serverless deploy (Vercel) has no
  //    such runtime: the child exits immediately and the run would sit in
  //    `provisioning` until the reaper's backstop times it out ~15 min later.
  //    Refuse it up front so the caller fails the run with an actionable
  //    reason. Reaching here without flyConfig on Vercel means the environment
  //    has no cloud-worker compute — either CLOUD_WORKER_APP / FLY_API_TOKEN
  //    are unset, or the environment was created as a `local` substrate before
  //    they were.
  let adapter: WorkerDispatchAdapter;
  let dispatch: "fly" | "local";
  if (input.flyConfig) {
    adapter = new FlyWorkerAdapter({
      supabase: adminSupabase as unknown as ConstructorParameters<typeof FlyWorkerAdapter>[0]["supabase"],
      logger: serverLogger,
      flyApiToken: input.flyConfig.flyApiToken,
      workerApp: input.flyConfig.workerApp,
      workerImage: input.flyConfig.workerImage,
      appUrl: input.appUrl,
      region: input.flyConfig.region,
    });
    dispatch = "fly";
  } else if (process.env.VERCEL) {
    throw new WorkerPreflightError(
      "cloud_worker_unconfigured",
      "Cloud workers are not available for this deployment. Configure CLOUD_WORKER_APP + FLY_API_TOKEN and recreate this environment.",
    );
  } else {
    adapter = new LocalWorkerAdapter({ logger: serverLogger });
    dispatch = "local";
  }

  const result = await adapter.triggerWorker({
    workerRunId,
    appId,
    workerPayload: payload,
    ...(input.persistentMachine ? { persistentMachine: input.persistentMachine } : {}),
  });
  return { dispatch, machineId: result.machineId ?? null };
}
