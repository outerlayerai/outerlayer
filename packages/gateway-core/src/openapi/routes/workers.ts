/**
 * /v1/workers — programmatic cloud-worker launch.
 *
 * The integration surface for Slack bots, CI, and other coding agents:
 * launch a one-shot run, read its status/outcome/PR, start a persistent
 * session, continue it turn by turn. Every response carries the run or
 * session's dashboard deep link (`…/workers?run=` / `?session=`) so an
 * integration can always hand a human the live thread.
 *
 * Permissions: worker_run.insert (launch/continue), worker_run.read (reads) —
 * explicit key grants, enforced by the shared route middleware. Entitlements
 * mirror the dashboard launch routes: workers_enabled → concurrency →
 * monthly minutes (runs), persistent_worker_environments + count cap
 * (sessions). Dispatch goes through GatewayWorkerDispatchService (Fly);
 * deployments without worker compute configured return 503 on launches while
 * reads keep working.
 */

import {
  BaseRoute,
  errorResponse,
  entitlementRequiredResponse,
  parseJsonBody,
  structuredError,
  z,
  type AppContext,
} from './_shared';
import { itemResponse } from '@repo/api-schemas';
import type { GatewayPermission } from '../../lib/permissions';
import { createSystemAdminClient } from '../../lib/system-client';
import { getScopedSupabase } from './_shared';
import { resolveNumericLimit } from '../../lib/entitlements';
import {
  FLY_WORKER_AGENT_HOME,
  GatewayWorkerDispatchService,
  WORKER_AGENTS,
  WORKER_DEFAULT_WALL_CLOCK_CAP_S,
  WORKER_MAX_WALL_CLOCK_CAP_S,
  WorkerDispatchUnavailableError,
  WorkerPreflightError,
  acquireEnvironmentTurn,
  countActiveRunsForTenant,
  createWorkerEnvironment,
  createWorkerRun,
  destroyWorkerEnvironmentRow,
  failWorkerRun,
  getWorkerEnvironment,
  getWorkerRun,
  listEnvironmentTurns,
  markEnvironmentMachine,
  markWorkerRunProvisioning,
  releaseEnvironmentTurn,
  sumRunDurationMsSince,
  workerDispatchConfigured,
} from '../../lib/workers';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AGENT_IDS = WORKER_AGENTS.map((a) => a.id);

const LaunchRunBodySchema = z.object({
  agent: z.string().optional().describe(`Agent id (default claude-code). One of: ${AGENT_IDS.join(', ')}`),
  task_prompt: z.string().min(1).describe('What the agent should do.'),
  base_branch: z.string().optional().describe("Base branch (defaults to the app's tracked branch)."),
  wall_clock_cap_s: z
    .number()
    .int()
    .min(60)
    .max(WORKER_MAX_WALL_CLOCK_CAP_S)
    .optional()
    .describe('Wall-clock cap in seconds (default 1800).'),
});

const CreateSessionBodySchema = z.object({
  agent: z.string().optional().describe(`Agent id (default claude-code). One of: ${AGENT_IDS.join(', ')}`),
  task_prompt: z.string().min(1).describe("The session's first task."),
  base_branch: z.string().optional(),
});

const ContinueSessionBodySchema = z.object({
  task_prompt: z.string().min(1).describe('The follow-up task; the agent resumes its prior session.'),
});

const WorkerRunSchema = z.object({
  id: z.string(),
  agent: z.string(),
  task_prompt: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  branch_name: z.string().nullable(),
  pr_url: z.string().nullable(),
  pr_number: z.number().nullable(),
  failure_code: z.string().nullable(),
  error_message: z.string().nullable(),
  duration_ms: z.number().nullable(),
  // Published API field name; sourced from the `worker_workspace` FK column
  // `worker_run.workspace_id` (the DB identifier differs from this contract key).
  environment_ref: z.string().nullable(),
  turn_index: z.number(),
  created_at: z.string(),
});

const LaunchRunResponseSchema = itemResponse(
  z.object({
    run_id: z.string(),
    status: z.string(),
    url: z.string().nullable().describe('Dashboard deep link to the live run thread.'),
  }),
);

const RunResponseSchema = itemResponse(
  z.object({
    run: WorkerRunSchema,
    url: z.string().nullable(),
  }),
);

const SessionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  base_branch: z.string(),
  work_branch: z.string().nullable(),
  substrate: z.string(),
  status: z.string(),
  current_run_id: z.string().nullable(),
  last_active_at: z.string().nullable(),
  created_at: z.string(),
});

const SessionTurnSchema = z.object({
  id: z.string(),
  turn_index: z.number(),
  task_prompt: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  pr_url: z.string().nullable(),
  created_at: z.string(),
});

const CreateSessionResponseSchema = itemResponse(
  z.object({
    environment_id: z.string(),
    run_id: z.string(),
    status: z.string(),
    url: z.string().nullable().describe('Dashboard deep link to the live session thread.'),
  }),
);

const ContinueSessionResponseSchema = itemResponse(
  z.object({
    run_id: z.string(),
    turn_index: z.number(),
    url: z.string().nullable(),
  }),
);

const SessionResponseSchema = itemResponse(
  z.object({
    environment: SessionSchema,
    turns: z.array(SessionTurnSchema),
    url: z.string().nullable(),
  }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUser(c: AppContext): { tenantId: string; appId: string } {
  const user = c.get('user');
  return { tenantId: user.tenantId, appId: user.appId };
}

/**
 * Dashboard deep link for a run/session — the exact URL scheme the Workers UI
 * reads (?run= / ?session=). Name lookups use the system client (tenant has
 * no gateway-role grant); best-effort — a lookup miss yields url: null, never
 * a failed launch.
 */
async function workerDeepLink(
  c: AppContext,
  appId: string,
  agentmarkEnvId: string | null,
  target: { run: string } | { session: string },
): Promise<string | null> {
  try {
    const admin = createSystemAdminClient(c.env) as never as import('@supabase/supabase-js').SupabaseClient<any, any, any>;
    const { data: app } = await admin
      .from('app')
      .select('name, tenant:tenant_id (organization_name)')
      .eq('id', appId)
      .maybeSingle();
    const orgName = (app?.tenant as { organization_name?: string } | null)?.organization_name;
    const appName = app?.name as string | undefined;
    if (!orgName || !appName) return null;

    let envName: string | undefined;
    if (agentmarkEnvId) {
      const { data: env } = await admin
        .from('environment')
        .select('name')
        .eq('id', agentmarkEnvId)
        .maybeSingle();
      envName = env?.name as string | undefined;
    }
    if (!envName) {
      const { data: def } = await admin
        .from('environment')
        .select('name')
        .eq('app_id', appId)
        .eq('is_default', true)
        .maybeSingle();
      envName = (def?.name as string | undefined) ?? 'default';
    }
    const query = 'run' in target ? `run=${target.run}` : `session=${target.session}`;
    return `${c.env.DASHBOARD_BASE_URL}/orgs/${encodeURIComponent(orgName)}/apps/${encodeURIComponent(appName)}/env/${encodeURIComponent(envName)}/workers?${query}`;
  } catch {
    return null;
  }
}

/** The key's pinned environment, else the app default. */
async function resolveAgentmarkEnvironmentId(
  c: AppContext,
  appId: string,
): Promise<string | null> {
  const user = c.get('user');
  if (user.environmentId) return user.environmentId;
  const admin = createSystemAdminClient(c.env) as never as import('@supabase/supabase-js').SupabaseClient<any, any, any>;
  const { data } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function entitlement402(
  c: AppContext,
  entitlement: string,
  message: string,
  quota?: { limit: number; current: number },
) {
  return c.json(
    {
      error: {
        code: 'entitlement_required' as const,
        message,
        entitlement,
        ...(quota ? { limit: quota.limit, current: quota.current } : {}),
      },
    },
    402,
  );
}

/**
 * Concurrency + monthly-minutes quotas, shared by launch and continue —
 * every dispatched run burns minutes regardless of which route started it.
 * (`workers_enabled` itself is enforced by the registration-level guard.)
 */
async function checkRunQuotas(c: AppContext, db: never, tenantId: string) {
  const activeCount = await countActiveRunsForTenant(db, tenantId);
  const concurrencyLimit = await resolveNumericLimit(c.env, tenantId, 'max_concurrent_worker_runs');
  if (concurrencyLimit !== -1 && activeCount >= concurrencyLimit) {
    return entitlement402(c, 'max_concurrent_worker_runs', 'Concurrent worker-run limit reached.', {
      limit: concurrencyLimit,
      current: activeCount,
    });
  }
  const usedMinutes = Math.floor((await sumRunDurationMsSince(db, tenantId, monthStartIso())) / 60_000);
  const minutesLimit = await resolveNumericLimit(c.env, tenantId, 'max_worker_minutes_per_month');
  if (minutesLimit !== -1 && usedMinutes >= minutesLimit) {
    return entitlement402(c, 'max_worker_minutes_per_month', 'Monthly worker-minutes quota exhausted.', {
      limit: minutesLimit,
      current: usedMinutes,
    });
  }
  return null;
}

function buildDispatchService(c: AppContext): GatewayWorkerDispatchService {
  const logger = c.get('gtx').logger.createLogger({ source: 'gateway-workers' });
  return new GatewayWorkerDispatchService({
    systemSupabase: createSystemAdminClient(c.env) as never,
    env: c.env,
    logger: {
      info: (m, ctx) => logger.info(m, ctx),
      error: (m, ctx) => logger.error(new Error(m), ctx),
    },
  });
}

const monthStartIso = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

// ===========================================================================
// POST /v1/workers/runs
// ===========================================================================

export class LaunchWorkerRun extends BaseRoute {
  static requiredPermission: GatewayPermission = 'worker_run.insert';
  schema = {
    tags: ['Workers'],
    summary: 'Launch a worker run',
    operationId: 'launch-worker-run',
    description:
      "Launches a terminal coding agent against the app's connected repo on managed compute: it clones the code, does the task, and delivers a branch + pull request. Poll `GET /v1/workers/runs/{runId}` for the outcome, or hand a human the returned `url` — the dashboard's live chat thread for the run.\n\nRequires the key's environment (or the app default) to carry the agent's credential env var (e.g. `ANTHROPIC_API_KEY`).",
    request: {
      body: { content: { 'application/json': { schema: LaunchRunBodySchema } } },
    },
    responses: {
      200: {
        description: 'Run dispatched.',
        content: { 'application/json': { schema: LaunchRunResponseSchema } },
      },
      400: errorResponse('Invalid request body or unknown agent.'),
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        "Workers not enabled for the tenant's tier, or a concurrency / monthly-minutes quota is exhausted.",
      ),
      403: errorResponse("Caller lacks 'worker_run.insert' permission."),
      502: errorResponse('Dispatch failed; the run is recorded as failed.'),
      503: errorResponse('Worker compute is not configured on this deployment.'),
    },
  };

  async handle(c: AppContext) {
    const body = LaunchRunBodySchema.parse(await parseJsonBody(c));
    const { tenantId, appId } = getUser(c);

    const agentId = body.agent ?? 'claude-code';
    const agent = WORKER_AGENTS.find((a) => a.id === agentId);
    if (!agent) {
      return c.json(structuredError('unknown_worker_agent', `Unknown agent: ${agentId}`), 400);
    }
    if (!workerDispatchConfigured(c.env)) {
      return c.json(structuredError('worker_dispatch_unconfigured', 'Worker compute is not configured on this deployment.'), 503);
    }

    const db = await getScopedSupabase(c);

    const quotaBlock = await checkRunQuotas(c, db as never, tenantId);
    if (quotaBlock) return quotaBlock;

    const environmentId = await resolveAgentmarkEnvironmentId(c, appId);
    if (!environmentId) {
      return c.json(structuredError('invalid_request_body', 'This app has no environment to run against.'), 400);
    }
    const wallClockCapS = Math.min(
      Math.max(body.wall_clock_cap_s ?? WORKER_DEFAULT_WALL_CLOCK_CAP_S, 60),
      WORKER_MAX_WALL_CLOCK_CAP_S,
    );

    const run = await createWorkerRun(db as never, {
      appId,
      tenantId,
      environmentId,
      agent: agentId,
      taskPrompt: body.task_prompt.trim(),
      baseBranch: body.base_branch ?? '',
      dispatch: 'fly',
      wallClockCapS,
    });
    const url = await workerDeepLink(c, appId, environmentId, { run: run.id });

    try {
      const result = await buildDispatchService(c).dispatch({
        workerRunId: run.id,
        appId,
        tenantId,
        environmentId,
        agent: agentId,
        agentCredentialKeys: [...agent.credentialKeys],
        taskPrompt: body.task_prompt.trim(),
        baseBranch: body.base_branch ?? '',
        wallClockCapS,
      });
      await markWorkerRunProvisioning(db as never, appId, run.id, result.machineId);
      return c.json({ data: { run_id: run.id, status: 'provisioning', url } });
    } catch (err) {
      const code = err instanceof WorkerPreflightError ? err.code : 'dispatch_failed';
      const message = err instanceof Error ? err.message : String(err);
      await failWorkerRun(db as never, appId, run.id, code, message);
      if (err instanceof WorkerDispatchUnavailableError) {
        return c.json(structuredError('worker_dispatch_unconfigured', message), 503);
      }
      return c.json(structuredError('worker_dispatch_failed', message), 502);
    }
  }
}

// ===========================================================================
// GET /v1/workers/runs/:runId
// ===========================================================================

export class GetWorkerRun extends BaseRoute {
  static requiredPermission: GatewayPermission = 'worker_run.read';
  schema = {
    tags: ['Workers'],
    summary: 'Get a worker run',
    operationId: 'get-worker-run',
    description:
      "Status, outcome, and delivery (branch / PR) for a run, plus the dashboard deep link to its live thread. Runs are app-scoped to the caller's key.",
    request: {
      params: z.object({ runId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'The run.',
        content: { 'application/json': { schema: RunResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'worker_run.read' permission."),
      404: errorResponse('Run not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as { params: { runId: string } };
    const { appId } = getUser(c);
    const db = await getScopedSupabase(c);
    const run = await getWorkerRun(db as never, appId, data.params.runId);
    if (!run) return c.json(structuredError('worker_run_not_found', 'Run not found'), 404);
    const url = await workerDeepLink(c, appId, run.environment_id, { run: run.id });
    return c.json({
      data: {
      run: {
        id: run.id,
        agent: run.agent,
        task_prompt: run.task_prompt,
        status: run.status,
        outcome: run.outcome,
        branch_name: run.branch_name,
        pr_url: run.pr_url,
        pr_number: run.pr_number,
        failure_code: run.failure_code,
        error_message: run.error_message,
        duration_ms: run.duration_ms,
        environment_ref: run.workspace_id,
        turn_index: run.turn_index,
        created_at: run.created_at,
      },
      url,
      },
    });
  }
}

// ===========================================================================
// POST /v1/workers/environments
// ===========================================================================

export class CreateWorkerSession extends BaseRoute {
  static requiredPermission: GatewayPermission = 'worker_run.insert';
  schema = {
    tags: ['Workers'],
    summary: 'Start a persistent worker session',
    operationId: 'create-worker-session',
    description:
      'Creates a persistent environment (a durable workspace the agent resumes across turns) and dispatches its first turn. Continue it with `POST /v1/workers/environments/{envId}/turns`. The returned `url` opens the session as a live chat thread in the dashboard.',
    request: {
      body: { content: { 'application/json': { schema: CreateSessionBodySchema } } },
    },
    responses: {
      200: {
        description: 'Session created; first turn dispatched.',
        content: { 'application/json': { schema: CreateSessionResponseSchema } },
      },
      400: errorResponse('Invalid request body or unknown agent.'),
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        'Persistent worker environments not in the tier, or the live-environment cap is reached.',
      ),
      403: errorResponse("Caller lacks 'worker_run.insert' permission."),
      502: errorResponse('First turn failed to dispatch; the environment is destroyed, not leaked.'),
      503: errorResponse('Worker compute is not configured on this deployment.'),
    },
  };

  async handle(c: AppContext) {
    const body = CreateSessionBodySchema.parse(await parseJsonBody(c));
    const { tenantId, appId } = getUser(c);

    const agentId = body.agent ?? 'claude-code';
    const agent = WORKER_AGENTS.find((a) => a.id === agentId);
    if (!agent) {
      return c.json(structuredError('unknown_worker_agent', `Unknown agent: ${agentId}`), 400);
    }
    if (!workerDispatchConfigured(c.env)) {
      return c.json(structuredError('worker_dispatch_unconfigured', 'Worker compute is not configured on this deployment.'), 503);
    }

    const environmentId = await resolveAgentmarkEnvironmentId(c, appId);
    if (!environmentId) {
      return c.json(structuredError('invalid_request_body', 'This app has no environment to run against.'), 400);
    }

    const db = await getScopedSupabase(c);
    const env = await createWorkerEnvironment(db as never, {
      appId,
      tenantId,
      environmentId,
      agent: agentId,
      baseBranch: body.base_branch ?? '',
      substrate: 'fly',
    });
    const url = await workerDeepLink(c, appId, environmentId, { session: env.id });

    try {
      const { runId, turnIndex } = await dispatchSessionTurn(c, db as never, env, {
        tenantId,
        environmentId,
        agent,
        taskPrompt: body.task_prompt.trim(),
      });
      void turnIndex;
      return c.json({ data: { environment_id: env.id, run_id: runId, status: 'active', url } });
    } catch (err) {
      // Never leave an orphan consuming the cap.
      await destroyWorkerEnvironmentRow(db as never, env.id, 'First turn failed to dispatch.');
      const message = err instanceof Error ? err.message : String(err);
      return c.json(structuredError('worker_dispatch_failed', message), 502);
    }
  }

}

class SessionBusyError extends Error {
  constructor() {
    super('This environment is already running a turn. Wait for it to finish.');
    this.name = 'SessionBusyError';
  }
}

/** Shared turn orchestration: create run → acquire lock → dispatch. */
async function dispatchSessionTurn(
    c: AppContext,
    db: never,
    env: {
      id: string;
      app_id: string;
      agent: string;
      base_branch: string;
      work_branch: string | null;
      workspace_ref: string | null;
      session_ref: string | null;
      machine_ref: string | null;
    },
    opts: {
      tenantId: string;
      environmentId: string | null;
      agent: { id: string; credentialKeys: readonly string[] };
      taskPrompt: string;
    },
  ): Promise<{ runId: string; turnIndex: number }> {
    const turns = await listEnvironmentTurns(db, env.app_id, env.id);
    const turnIndex = turns.length;
    const run = await createWorkerRun(db, {
      appId: env.app_id,
      tenantId: opts.tenantId,
      environmentId: opts.environmentId,
      agent: opts.agent.id,
      taskPrompt: opts.taskPrompt,
      baseBranch: env.base_branch,
      dispatch: 'fly',
      wallClockCapS: WORKER_DEFAULT_WALL_CLOCK_CAP_S,
      workspaceId: env.id,
      turnIndex,
    });

    const acquired = await acquireEnvironmentTurn(db, env.app_id, env.id, run.id);
    if (!acquired) {
      await failWorkerRun(db, env.app_id, run.id, 'environment_busy', 'Environment was busy with another turn.');
      throw new SessionBusyError();
    }

    try {
      const result = await buildDispatchService(c).dispatch({
        workerRunId: run.id,
        appId: env.app_id,
        tenantId: opts.tenantId,
        environmentId: opts.environmentId ?? '',
        agent: opts.agent.id,
        agentCredentialKeys: [...opts.agent.credentialKeys],
        taskPrompt: opts.taskPrompt,
        baseBranch: env.base_branch,
        wallClockCapS: WORKER_DEFAULT_WALL_CLOCK_CAP_S,
        persistent: {
          workspacePath: env.workspace_ref ?? `/tmp/outerlayer-worker-env/${env.id}`,
          workBranch: env.work_branch ?? `outerlayer/worker/env-${env.id.slice(0, 8)}`,
          sessionRef: env.session_ref ?? undefined,
          firstTurn: turnIndex === 0,
          agentHome: FLY_WORKER_AGENT_HOME,
        },
        persistentMachine: { machineRef: env.machine_ref, envId: env.id },
      });
      await markWorkerRunProvisioning(db, env.app_id, run.id, result.machineId);
      if (result.machineId) await markEnvironmentMachine(db, env.id, result.machineId);
      return { runId: run.id, turnIndex };
    } catch (err) {
      const code = err instanceof WorkerPreflightError ? err.code : 'dispatch_failed';
      const message = err instanceof Error ? err.message : String(err);
      await failWorkerRun(db, env.app_id, run.id, code, message);
      await releaseEnvironmentTurn(db, env.id, run.id);
      throw err;
    }
}

// ===========================================================================
// POST /v1/workers/environments/:envId/turns
// ===========================================================================

export class ContinueWorkerSession extends BaseRoute {
  static requiredPermission: GatewayPermission = 'worker_run.insert';
  schema = {
    tags: ['Workers'],
    summary: 'Continue a worker session',
    operationId: 'continue-worker-session',
    description:
      "Dispatches a follow-up turn in a persistent session: the agent resumes its prior conversation in the same warm workspace and checkpoints to the session's work branch. One turn at a time — a concurrent turn returns 409 `environment_busy`.",
    request: {
      params: z.object({ envId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: ContinueSessionBodySchema } } },
    },
    responses: {
      200: {
        description: 'Turn dispatched.',
        content: { 'application/json': { schema: ContinueSessionResponseSchema } },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        "Workers not enabled for the tenant's tier, or a concurrency / monthly-minutes quota is exhausted.",
      ),
      403: errorResponse("Caller lacks 'worker_run.insert' permission."),
      404: errorResponse('Session not found.'),
      409: errorResponse('A turn is already running in this session.'),
      410: errorResponse('The session has been destroyed.'),
      502: errorResponse('Dispatch failed; the turn is recorded as failed.'),
      503: errorResponse('Worker compute is not configured on this deployment.'),
    },
  };

  async handle(c: AppContext) {
    const paramsResult = z.object({ envId: z.string().uuid() }).safeParse(c.req.param());
    if (!paramsResult.success) {
      return c.json(structuredError('invalid_request_body', 'envId must be a UUID.'), 400);
    }
    const params = paramsResult.data;
    const body = ContinueSessionBodySchema.parse(await parseJsonBody(c));
    const { tenantId, appId } = getUser(c);

    const db = await getScopedSupabase(c);
    const env = await getWorkerEnvironment(db as never, appId, params.envId);
    if (!env) return c.json(structuredError('worker_session_not_found', 'Session not found'), 404);
    if (env.status === 'destroyed') {
      return c.json(structuredError('worker_session_destroyed', 'This session has been destroyed.'), 410);
    }
    if (!workerDispatchConfigured(c.env)) {
      return c.json(structuredError('worker_dispatch_unconfigured', 'Worker compute is not configured on this deployment.'), 503);
    }
    const quotaBlock = await checkRunQuotas(c, db as never, tenantId);
    if (quotaBlock) return quotaBlock;
    const agent = WORKER_AGENTS.find((a) => a.id === env.agent) ?? {
      id: env.agent,
      credentialKeys: [] as const,
    };

    const url = await workerDeepLink(c, appId, env.environment_id, { session: env.id });
    try {
      const { runId, turnIndex } = await dispatchSessionTurn(c, db as never, env, {
        tenantId,
        environmentId: env.environment_id,
        agent,
        taskPrompt: body.task_prompt.trim(),
      });
      return c.json({ data: { run_id: runId, turn_index: turnIndex, url } });
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return c.json(structuredError('worker_environment_busy', err.message), 409);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json(structuredError('worker_dispatch_failed', message), 502);
    }
  }
}

// ===========================================================================
// GET /v1/workers/environments/:envId
// ===========================================================================

export class GetWorkerSession extends BaseRoute {
  static requiredPermission: GatewayPermission = 'worker_run.read';
  schema = {
    tags: ['Workers'],
    summary: 'Get a worker session',
    operationId: 'get-worker-session',
    description:
      'The session and its turn thread (oldest first), plus the dashboard deep link that opens it as a live chat.',
    request: {
      params: z.object({ envId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'The session.',
        content: { 'application/json': { schema: SessionResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'worker_run.read' permission."),
      404: errorResponse('Session not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as { params: { envId: string } };
    const { appId } = getUser(c);
    const db = await getScopedSupabase(c);
    const env = await getWorkerEnvironment(db as never, appId, data.params.envId);
    if (!env) return c.json(structuredError('worker_session_not_found', 'Session not found'), 404);
    const turns = await listEnvironmentTurns(db as never, appId, env.id);
    const url = await workerDeepLink(c, appId, env.environment_id, { session: env.id });
    return c.json({
      data: {
      environment: {
        id: env.id,
        agent: env.agent,
        base_branch: env.base_branch,
        work_branch: env.work_branch,
        substrate: env.substrate,
        status: env.status,
        current_run_id: env.current_run_id,
        last_active_at: env.last_active_at,
        created_at: env.created_at,
      },
      turns: turns.map((t) => ({
        id: t.id,
        turn_index: t.turn_index,
        task_prompt: t.task_prompt,
        status: t.status,
        outcome: t.outcome,
        pr_url: t.pr_url,
        created_at: t.created_at,
      })),
      url,
      },
    });
  }
}
