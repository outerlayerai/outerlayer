/**
 * Cloud workers on the gateway: the store + dispatch layer
 * behind the /v1/workers routes.
 *
 * Store functions run on the request's scoped Supabase client — gateway-role
 * RLS (95-gateway-rls.sql) owes tenant isolation; the route layer owes the
 * worker_run.* permission checks, matching every other /v1 surface.
 *
 * GatewayWorkerDispatchService mirrors GatewayManagedBuildService: resolve the
 * repo + a short-lived clone token (octokit App), collect the
 * environment's Vault-backed env vars, stage the per-run worker secret, and
 * dispatch through the Workers-safe FlyWorkerAdapter from @repo/worker-core.
 * The runner's events/callback still land on the dashboard's internal routes
 * (DASHBOARD_BASE_URL) — one callback implementation, whichever surface
 * launched the run.
 */

import { App } from 'octokit';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FlyWorkerAdapter,
  workerSecretVaultName,
  type WorkerParamsPayload,
} from '@repo/worker-core';
import {
  envTargetOf,
  envVarEnvVaultName,
  envVarKindVaultName,
  envVarLegacyVaultName,
  resolveEnvVarRows,
  type EnvTargetKind,
  type EnvVarTargetKind,
} from '@repo/env-kind';

/** Candidate env_var row (mirror of the build service's local type). */
type EnvVarScopedRow = {
  key: string;
  target_kind: EnvVarTargetKind | null;
  environment_id: string | null;
};
import type { Env } from '../types';

// worker_run / worker_workspace are not in the generated Database types yet
// (same posture as the dashboard services — the casts collapse once
// `yarn codegen:db` includes them).
type AnyClient = SupabaseClient<any, any, any>;

export const WORKER_DEFAULT_WALL_CLOCK_CAP_S = 1800;
export const WORKER_MAX_WALL_CLOCK_CAP_S = 3600;
export const WORKER_CAPS = {
  max_diff_files: 200,
  max_diff_bytes: 5 * 1024 * 1024,
  max_raw_log_chars: 200_000,
} as const;

/**
 * Agent registry mirror for the /v1 surface (kept in sync with the dashboard
 * registry + runner adapters — the drift test in apps/worker covers the
 * authoritative pair). API keys only: subscription tokens are prohibited for
 * third-party routing (see the 058 credential policy).
 */
export const WORKER_AGENTS = [
  { id: 'claude-code', displayName: 'Claude Code', credentialKeys: ['ANTHROPIC_API_KEY'] },
  { id: 'codex', displayName: 'Codex CLI', credentialKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
  { id: 'cursor', displayName: 'Cursor CLI', credentialKeys: ['CURSOR_API_KEY'] },
  { id: 'opencode', displayName: 'opencode', credentialKeys: ['OPENAI_API_KEY', 'OPENCODE_API_KEY'] },
] as const;

/** Durable paths on a persistent environment's Fly volume (see worker-core). */
export const FLY_WORKER_WORKSPACE_PATH = '/data/workspace';
export const FLY_WORKER_AGENT_HOME = '/data/home';

export interface GatewayWorkerRun {
  id: string;
  app_id: string;
  tenant_id: string;
  environment_id: string | null;
  agent: string;
  task_prompt: string;
  base_branch: string;
  status: string;
  outcome: string | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  failure_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  workspace_id: string | null;
  turn_index: number;
  created_at: string;
}

export interface GatewayWorkerEnvironment {
  id: string;
  app_id: string;
  tenant_id: string;
  environment_id: string | null;
  agent: string;
  base_branch: string;
  work_branch: string | null;
  substrate: string;
  machine_ref: string | null;
  workspace_ref: string | null;
  session_ref: string | null;
  status: string;
  current_run_id: string | null;
  last_active_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Store — scoped-client queries (gateway-role RLS)
// ---------------------------------------------------------------------------

export async function createWorkerRun(
  db: AnyClient,
  input: {
    appId: string;
    tenantId: string;
    environmentId: string | null;
    agent: string;
    taskPrompt: string;
    baseBranch: string;
    dispatch: 'fly' | 'local';
    wallClockCapS: number;
    workspaceId?: string | null;
    turnIndex?: number;
  },
): Promise<GatewayWorkerRun> {
  const { data, error } = await db
    .from('worker_run')
    .insert({
      app_id: input.appId,
      tenant_id: input.tenantId,
      environment_id: input.environmentId,
      // API-launched: the key, not a person, launched it.
      created_by: null,
      agent: input.agent,
      task_prompt: input.taskPrompt,
      base_branch: input.baseBranch,
      dispatch: input.dispatch,
      wall_clock_cap_s: input.wallClockCapS,
      workspace_id: input.workspaceId ?? null,
      turn_index: input.turnIndex ?? 0,
      status: 'queued',
    })
    .select('*')
    .single();
  if (error) throw new Error(`create worker_run failed: ${error.message}`);
  return data as GatewayWorkerRun;
}

export async function getWorkerRun(
  db: AnyClient,
  appId: string,
  runId: string,
): Promise<GatewayWorkerRun | null> {
  const { data, error } = await db
    .from('worker_run')
    .select('*')
    .eq('app_id', appId)
    .eq('id', runId)
    .limit(1);
  if (error) throw new Error(`get worker_run failed: ${error.message}`);
  return ((data as GatewayWorkerRun[])?.[0] as GatewayWorkerRun) ?? null;
}

export async function listEnvironmentTurns(
  db: AnyClient,
  appId: string,
  workspaceId: string,
): Promise<GatewayWorkerRun[]> {
  const { data, error } = await db
    .from('worker_run')
    .select('*')
    .eq('app_id', appId)
    .eq('workspace_id', workspaceId)
    .order('turn_index', { ascending: true });
  if (error) throw new Error(`list environment turns failed: ${error.message}`);
  return (data as GatewayWorkerRun[]) ?? [];
}

export async function countActiveRunsForTenant(db: AnyClient, tenantId: string): Promise<number> {
  const { count, error } = await db
    .from('worker_run')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('status', ['queued', 'provisioning', 'running', 'pushing']);
  if (error) throw new Error(`count worker_run failed: ${error.message}`);
  return count ?? 0;
}

export async function sumRunDurationMsSince(
  db: AnyClient,
  tenantId: string,
  sinceIso: string,
): Promise<number> {
  const { data, error } = await db
    .from('worker_run')
    .select('duration_ms')
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`sum worker_run duration failed: ${error.message}`);
  return ((data as Array<{ duration_ms: number | null }>) ?? []).reduce(
    (acc, r) => acc + (r.duration_ms ?? 0),
    0,
  );
}

export async function markWorkerRunProvisioning(
  db: AnyClient,
  appId: string,
  runId: string,
  machineId: string | null,
): Promise<void> {
  const { error } = await db
    .from('worker_run')
    .update({ status: 'provisioning', machine_id: machineId, updated_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('id', runId);
  if (error) throw new Error(`update worker_run failed: ${error.message}`);
}

export async function failWorkerRun(
  db: AnyClient,
  appId: string,
  runId: string,
  failureCode: string,
  message: string,
): Promise<void> {
  const { error } = await db
    .from('worker_run')
    .update({
      status: 'failed',
      failure_code: failureCode,
      error_message: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('app_id', appId)
    .eq('id', runId);
  if (error) throw new Error(`update worker_run failed: ${error.message}`);
}

export async function createWorkerEnvironment(
  db: AnyClient,
  input: {
    appId: string;
    tenantId: string;
    environmentId: string | null;
    agent: string;
    baseBranch: string;
    substrate: 'fly' | 'local';
  },
): Promise<GatewayWorkerEnvironment> {
  const { data, error } = await db
    .from('worker_workspace')
    .insert({
      app_id: input.appId,
      tenant_id: input.tenantId,
      environment_id: input.environmentId,
      created_by: null,
      agent: input.agent,
      base_branch: input.baseBranch,
      work_branch: 'outerlayer/worker/env',
      substrate: input.substrate,
      workspace_ref: '',
      status: 'creating',
    })
    .select('*')
    .single();
  if (error) throw new Error(`create worker_workspace failed: ${error.message}`);

  // Rewrite the placeholder branch/workspace now that the id is known — the
  // same two-step the dashboard's environments route performs.
  const env = data as GatewayWorkerEnvironment;
  const workBranch = `outerlayer/worker/env-${env.id.slice(0, 8)}`;
  const workspaceRef =
    input.substrate === 'fly' ? FLY_WORKER_WORKSPACE_PATH : `/tmp/outerlayer-worker-env/${env.id}`;
  const { error: updateError } = await db
    .from('worker_workspace')
    .update({ work_branch: workBranch, workspace_ref: workspaceRef })
    .eq('id', env.id);
  if (updateError) throw new Error(`init worker_workspace failed: ${updateError.message}`);
  return { ...env, work_branch: workBranch, workspace_ref: workspaceRef };
}

export async function getWorkerEnvironment(
  db: AnyClient,
  appId: string,
  envId: string,
): Promise<GatewayWorkerEnvironment | null> {
  const { data, error } = await db
    .from('worker_workspace')
    .select('*')
    .eq('app_id', appId)
    .eq('id', envId)
    .limit(1);
  if (error) throw new Error(`get worker_workspace failed: ${error.message}`);
  return ((data as GatewayWorkerEnvironment[])?.[0] as GatewayWorkerEnvironment) ?? null;
}

export async function countActiveEnvironmentsForTenant(
  db: AnyClient,
  tenantId: string,
): Promise<number> {
  const { count, error } = await db
    .from('worker_workspace')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .neq('status', 'destroyed');
  if (error) throw new Error(`count worker_workspace failed: ${error.message}`);
  return count ?? 0;
}

/**
 * The single-turn lock: atomically set current_run_id iff the environment is
 * free and not destroyed. Same guarded UPDATE the dashboard uses — the SQL
 * semantics ARE the contract.
 */
export async function acquireEnvironmentTurn(
  db: AnyClient,
  appId: string,
  envId: string,
  runId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('worker_workspace')
    .update({ current_run_id: runId, status: 'active', updated_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('id', envId)
    .is('current_run_id', null)
    .neq('status', 'destroyed')
    .select('id');
  if (error) throw new Error(`acquire worker_workspace failed: ${error.message}`);
  return ((data as unknown[]) ?? []).length > 0;
}

/** Release the lock after a dispatch failure (guarded on still holding it). */
export async function releaseEnvironmentTurn(
  db: AnyClient,
  envId: string,
  runId: string,
): Promise<void> {
  const { error } = await db
    .from('worker_workspace')
    .update({
      current_run_id: null,
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', envId)
    .eq('current_run_id', runId);
  if (error) throw new Error(`release worker_workspace failed: ${error.message}`);
}

export async function markEnvironmentMachine(
  db: AnyClient,
  envId: string,
  machineRef: string | null,
): Promise<void> {
  const { error } = await db
    .from('worker_workspace')
    .update({ machine_ref: machineRef, updated_at: new Date().toISOString() })
    .eq('id', envId);
  if (error) throw new Error(`mark worker_workspace machine failed: ${error.message}`);
}

/** Terminal teardown after a failed first turn — never leave an orphan on the cap. */
export async function destroyWorkerEnvironmentRow(
  db: AnyClient,
  envId: string,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from('worker_workspace')
    .update({
      status: 'destroyed',
      current_run_id: null,
      failure_reason: reason.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq('id', envId);
  if (error) throw new Error(`destroy worker_workspace failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export class WorkerDispatchUnavailableError extends Error {
  constructor() {
    super('Worker dispatch is not configured on this deployment.');
    this.name = 'WorkerDispatchUnavailableError';
  }
}

export class WorkerPreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerPreflightError';
    this.code = code;
  }
}

export interface GatewayWorkerDispatchDeps {
  /** System-admin client: Vault RPCs, env-var reads, git token lookups. */
  systemSupabase: AnyClient;
  env: Env;
  logger: { info: (msg: string, ctx?: Record<string, unknown>) => unknown; error: (msg: string, ctx?: Record<string, unknown>) => unknown };
}

export interface GatewayWorkerDispatchInput {
  workerRunId: string;
  appId: string;
  tenantId: string;
  environmentId: string;
  agent: string;
  agentCredentialKeys: string[];
  taskPrompt: string;
  baseBranch: string;
  wallClockCapS: number;
  persistent?: {
    workspacePath: string;
    workBranch: string;
    sessionRef?: string;
    firstTurn: boolean;
    agentHome?: string;
  };
  persistentMachine?: { machineRef: string | null; envId: string };
}

/** True when the gateway can dispatch worker machines at all. */
export function workerDispatchConfigured(env: Env): boolean {
  return Boolean(env.CLOUD_WORKER_APP && env.FLY_API_TOKEN);
}

export class GatewayWorkerDispatchService {
  constructor(private readonly deps: GatewayWorkerDispatchDeps) {}

  /**
   * Preflight (repo + credential + secret staging) and dispatch. Throws
   * WorkerPreflightError with a machine-readable code on preflight failures;
   * the route fails the run row and maps to a 502. Mirrors the dashboard's
   * dispatchWorkerRun step for step.
   */
  async dispatch(input: GatewayWorkerDispatchInput): Promise<{ machineId: string | null }> {
    const { env } = this.deps;
    if (!workerDispatchConfigured(env)) throw new WorkerDispatchUnavailableError();

    // 1. Repo + short-lived clone token.
    const repo = await this.resolveRepo(input.appId, input.baseBranch || null);

    // 2. Env vars (Vault-resolved) must include one of the agent's credentials.
    const envVars = await this.collectEnvVars(input.appId, input.environmentId);
    const hasCredential = input.agentCredentialKeys.some(
      (k) => typeof envVars[k] === 'string' && envVars[k]!.length > 0,
    );
    if (!hasCredential) {
      throw new WorkerPreflightError(
        'missing_agent_credential',
        `This agent needs one of these env vars set for the environment: ${input.agentCredentialKeys.join(', ')}.`,
      );
    }

    // 3. Per-run worker secret (events/callback bearer) in Vault.
    const workerSecret = crypto.randomUUID();
    const secretVaultName = workerSecretVaultName(input.workerRunId);
    await this.deps.systemSupabase.rpc('delete_secret', { secret_name: secretVaultName });
    const { error: secretError } = await this.deps.systemSupabase.rpc('insert_secret', {
      name: secretVaultName,
      secret: workerSecret,
    });
    if (secretError) {
      throw new WorkerPreflightError(
        'secret_stage_failed',
        `Failed to stage worker secret: ${secretError.message}`,
      );
    }

    // 4. Payload — the runner's events/callback land on the dashboard's
    //    internal routes, same as dashboard-launched runs.
    const appUrl = env.DASHBOARD_BASE_URL;
    const payload: WorkerParamsPayload = {
      worker_run_id: input.workerRunId,
      app_id: input.appId,
      tenant_id: input.tenantId,
      agent: input.agent,
      task_prompt: input.taskPrompt,
      repo_url: repo.repoUrl,
      repo_token: repo.repoToken,
      git_provider: repo.provider,
      base_branch: repo.branch,
      env_vars: envVars,
      events_url: `${appUrl}/api/internal/worker-events`,
      callback_url: `${appUrl}/api/internal/worker-callback`,
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

    const adapter = new FlyWorkerAdapter({
      supabase: this.deps.systemSupabase as never,
      logger: this.buildAdapterLogger(),
      flyApiToken: env.FLY_API_TOKEN,
      workerApp: env.CLOUD_WORKER_APP!,
      workerImage: env.CLOUD_WORKER_IMAGE,
      appUrl,
      region: env.CLOUD_WORKER_REGION,
    });
    const result = await adapter.triggerWorker({
      workerRunId: input.workerRunId,
      appId: input.appId,
      workerPayload: payload,
      ...(input.persistentMachine ? { persistentMachine: input.persistentMachine } : {}),
    });
    return { machineId: result.machineId ?? null };
  }

  /** worker-core's Logger shape over the injected structured logger. */
  private buildAdapterLogger() {
    const base = this.deps.logger;
    interface AdapterLogger {
      info: (m: string, c?: Record<string, unknown>) => Promise<void>;
      error: (e: Error, c?: Record<string, unknown>) => Promise<void>;
      withAppId: (id: string) => AdapterLogger;
    }
    const make = (): AdapterLogger => ({
      info: async (m, c) => void base.info(m, c),
      error: async (e, c) => void base.error(e.message, c),
      withAppId: () => make(),
    });
    return make() as never;
  }

  private async resolveRepo(
    appId: string,
    requestedBranch: string | null,
  ): Promise<{ repoUrl: string; repoToken: string; provider: 'github' | 'local'; branch: string }> {
    const db = this.deps.systemSupabase;
    const { data: connection } = await db
      .from('git_connection')
      .select('provider, repository, installation_id')
      .eq('app_id', appId)
      .maybeSingle();
    if (!connection?.repository) {
      throw new WorkerPreflightError('no_git_connection', 'This app has no connected git repository.');
    }

    const branch =
      requestedBranch ??
      ((
        await db.from('git_branch').select('branch_name').eq('app_id', appId).maybeSingle()
      ).data?.branch_name as string | undefined) ??
      'main';

    // Local dev/e2e bare-repo path — no hosted provider or token.
    if (connection.repository.startsWith('/') || connection.repository.startsWith('file://')) {
      return { repoUrl: connection.repository, repoToken: 'local', provider: 'local', branch };
    }

    const provider = 'github' as const;
    let repoToken: string | null = null;
    if (connection.installation_id) {
      const app = new App({
        appId: this.deps.env.GITHUB_APP_ID,
        privateKey: this.deps.env.GITHUB_APP_PRIVATE_KEY,
      });
      const octokit = await app.getInstallationOctokit(Number(connection.installation_id));
      const auth = (await octokit.auth({ type: 'installation' })) as { token: string };
      repoToken = auth.token;
    }
    if (!repoToken) {
      throw new WorkerPreflightError(
        'git_token_unavailable',
        'Could not obtain a git access token for this app.',
      );
    }
    return { repoUrl: connection.repository, repoToken, provider, branch };
  }

  /**
   * Env-scoped env-var collection — the same resolution
   * GatewayManagedBuildService.collectEnvVars performs (kind-targeting via
   * @repo/env-kind, env-scoped → legacy app-scoped Vault fallback), inlined
   * for the worker payload.
   */
  private async collectEnvVars(
    appId: string,
    environmentId: string,
  ): Promise<Record<string, string>> {
    const db = this.deps.systemSupabase;

    const { data: envRow } = await db
      .from('environment')
      .select('current_version, is_ephemeral')
      .eq('id', environmentId)
      .eq('app_id', appId)
      .maybeSingle();
    const envTarget: EnvTargetKind | null = envRow
      ? envTargetOf(envRow as { current_version: number; is_ephemeral?: boolean | null })
      : null;

    const { data: rows, error } = await db
      .from('env_var')
      .select('key, target_kind, environment_id')
      .eq('app_id', appId)
      .or(`environment_id.eq.${environmentId},target_kind.not.is.null`);
    if (error) {
      throw new WorkerPreflightError(
        'preflight_failed',
        `Failed to fetch env vars for app ${appId}: ${error.message}`,
      );
    }
    if (!rows?.length) return {};

    const winners = resolveEnvVarRows(rows as EnvVarScopedRow[], environmentId, envTarget);
    const out: Record<string, string> = {};
    for (const winner of winners) {
      const name =
        winner.environment_id != null
          ? envVarEnvVaultName(appId, environmentId, winner.key)
          : envVarKindVaultName(appId, winner.target_kind!, winner.key);
      const { data: value } = await db.rpc('read_secret', { secret_name: name });
      if (typeof value === 'string' && value.length > 0) {
        out[winner.key] = value;
      } else if (winner.environment_id != null) {
        // Legacy app-scoped fallback for pre-env rows.
        const { data: legacy } = await db.rpc('read_secret', {
          secret_name: envVarLegacyVaultName(appId, winner.key),
        });
        if (typeof legacy === 'string' && legacy.length > 0) out[winner.key] = legacy;
      }
    }
    return out;
  }
}
