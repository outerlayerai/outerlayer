/**
 * Eval Run Worker Endpoints (least-privilege worker)
 *
 * The Fly eval worker's ONLY credential is its per-run gateway key (minted at
 * dispatch: env-bound, named `eval-run:{runId}`, 24h expiry). These routes are
 * everything the worker needs from the control plane, so it never holds a
 * Supabase service-role key:
 *
 *   GET  /v1/evals/runs/:runId/job     — the job spec (request, repo label)
 *   POST /v1/evals/runs/:runId/status  — running | succeeded | failed;
 *                                        terminal statuses AUTO-REVOKE the key
 *   POST /v1/evals/escalations         — the env-escalation sink
 *
 * Authorization: the enum-level permission gate is `score.write` (the key's
 * capability family — no `eval_run.*` enum value exists), but the REAL gate is
 * stricter than any permission: the key row's name must be exactly
 * `eval-run:{runId}` and the run must belong to the key's app + tenant. A key
 * can only ever see and mutate its own run; there is no cross-run surface to
 * authorize. Missing/foreign runs 404 without an existence oracle.
 *
 * Status transitions are enforced (queued→running→terminal; running→running is
 * idempotent for Fly's restart policy) so a zombie machine can never overwrite
 * a completed run.
 */

import { z, BaseRoute, type AppContext, structuredError, errorResponse, parseJsonBody } from './_shared';
import type { GatewayPermission } from '../../lib/permissions';
import { createSystemAdminClient, asServiceClient } from '../../lib/system-client';

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const RunIdParams = z.object({ runId: z.string().uuid() });

const JobResponseSchema = z.object({
  data: z.object({
    id: z.string().uuid(),
    appId: z.string(),
    environmentId: z.string().nullable(),
    repoLabel: z.string(),
    status: z.string(),
    /** The wizard's run request: { configs: [A, B], taskCount, trialsPerTask, budgetUsd }. */
    request: z.record(z.string(), z.unknown()),
  }),
});

const StatusBodySchema = z
  .object({
    status: z.enum(['running', 'succeeded', 'failed']),
    /** Required when status = succeeded. */
    card: z.record(z.string(), z.unknown()).optional(),
    costUsd: z.number().nonnegative().optional(),
    /** Required when status = failed. */
    error: z.string().max(2000).optional(),
  })
  .refine((body) => body.status !== 'succeeded' || body.card !== undefined, {
    message: 'card is required when status is succeeded',
  })
  .refine((body) => body.status !== 'failed' || (body.error ?? '').length > 0, {
    message: 'error is required when status is failed',
  });

/** The OSS `EnvEscalationRow` minus tenant/app (stamped from the key) and
 * minus eval_run_id (derived from the key's run binding — never trusted). */
const EscalationBodySchema = z.object({
  repo: z.string().min(1).max(500),
  base_commit: z.string().max(100),
  task_ids: z.array(z.string().max(200)).max(100),
  last_errors: z.array(z.record(z.string(), z.unknown())).max(20),
  attempts: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  suggested_next_steps: z.string().max(2000),
});

// ---------------------------------------------------------------------------
// The run↔key binding — the actual authorization gate
// ---------------------------------------------------------------------------

/** Fixed key-row name per run — must mirror the dashboard's mint
 * (`evalRunKeyName` in services/evals/eval-gateway-key.ts). */
export function evalRunKeyName(runId: string): string {
  return `eval-run:${runId}`;
}

interface EvalRunRow {
  id: string;
  tenant_id: string;
  app_id: string;
  environment_id: string | null;
  status: string;
  repo_label: string;
  request: Record<string, unknown>;
}

type BoundRun =
  | {
      ok: true;
      run: EvalRunRow;
      /** api_key row PK — used by the terminal-status auto-revoke. */
      keyRowId: string;
    }
  | { ok: false; response: Response };

/**
 * Resolve the caller's run and enforce the binding: the API key row must be
 * named `eval-run:{runId}` and the run must live in the key's tenant + app.
 * Everything else is a no-oracle 404.
 */
async function requireRunBoundKey(c: AppContext, runId: string): Promise<BoundRun> {
  const user = c.get('user');
  const supabase = asServiceClient(createSystemAdminClient(c.env));
  const notFound = () => ({
    ok: false as const,
    response: c.json(structuredError('eval_run_not_found', 'Eval run not found'), 404),
  });

  // Bearer-user sessions have no run binding; these are machine endpoints.
  if (!user.apiKeyId) return notFound();

  const { data: keyRow } = await supabase
    .from('api_key')
    .select('id, name')
    .eq('api_key_id', user.apiKeyId)
    .single();
  if (!keyRow || keyRow.name !== evalRunKeyName(runId)) return notFound();

  const { data: run } = await supabase
    .from('eval_run')
    .select('id, tenant_id, app_id, environment_id, status, repo_label, request')
    .eq('id', runId)
    .eq('app_id', user.appId)
    .eq('tenant_id', user.tenantId)
    .single();
  if (!run) return notFound();

  return { ok: true, run: run as EvalRunRow, keyRowId: keyRow.id };
}

// ---------------------------------------------------------------------------
// GET /v1/evals/runs/:runId/job
// ---------------------------------------------------------------------------

export class GetEvalRunJob extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Evals'],
    summary: 'Fetch an eval run job (worker)',
    operationId: 'get-eval-run-job',
    description:
      'Returns the job spec for one eval run. Machine endpoint for the per-run eval worker: ' +
      'the API key must be the run\'s own dispatch-minted key; anything else is a 404.',
    request: { params: RunIdParams },
    responses: {
      200: {
        description: 'The job spec.',
        content: { 'application/json': { schema: JobResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Run not found (or the key is not bound to it).'),
    },
  };

  async handle(c: AppContext) {
    const params = RunIdParams.safeParse(c.req.param());
    if (!params.success) {
      return c.json(structuredError('invalid_request_body', 'runId must be a UUID'), 400);
    }
    const bound = await requireRunBoundKey(c, params.data.runId);
    if (!bound.ok) return bound.response;
    const { run } = bound;
    return c.json({
      data: {
        id: run.id,
        appId: run.app_id,
        environmentId: run.environment_id,
        repoLabel: run.repo_label,
        status: run.status,
        request: run.request ?? {},
      },
    });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/evals/runs/:runId/status
// ---------------------------------------------------------------------------

/** Legal transitions. running→running is idempotent (Fly restart retries). */
const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(['running', 'failed']),
  running: new Set(['running', 'succeeded', 'failed']),
  succeeded: new Set(),
  failed: new Set(),
};

export class ReportEvalRunStatus extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Evals'],
    summary: 'Report eval run status (worker)',
    operationId: 'report-eval-run-status',
    description:
      'Worker lifecycle reporting: claim (running), complete (succeeded + card), or fail. ' +
      'Terminal statuses also revoke the run\'s API key — the credential dies with the run. ' +
      'Transitions out of a terminal status are rejected (409) so a zombie machine cannot ' +
      'overwrite a completed run.',
    request: {
      params: RunIdParams,
      body: { content: { 'application/json': { schema: StatusBodySchema } } },
    },
    responses: {
      200: { description: 'Status recorded.' },
      400: errorResponse('Invalid body (missing card/error for the terminal status).'),
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Run not found (or the key is not bound to it).'),
      409: errorResponse('Illegal status transition (run already terminal).'),
      500: errorResponse('Persistence failed.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = StatusBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError('invalid_request_body', `Invalid status payload: ${issue?.message ?? 'malformed'}`),
        400,
      );
    }
    const params = RunIdParams.safeParse(c.req.param());
    if (!params.success) {
      return c.json(structuredError('invalid_request_body', 'runId must be a UUID'), 400);
    }
    const runId = params.data.runId;

    const bound = await requireRunBoundKey(c, runId);
    if (!bound.ok) return bound.response;
    const { run, keyRowId } = bound;
    const body = parsed.data;

    if (!ALLOWED_TRANSITIONS[run.status]?.has(body.status)) {
      return c.json(
        structuredError(
          'eval_run_conflict',
          `Run is '${run.status}'; cannot transition to '${body.status}'`,
        ),
        409,
      );
    }

    const supabase = asServiceClient(createSystemAdminClient(c.env));
    const patch: Record<string, unknown> = {
      status: body.status,
      updated_at: new Date().toISOString(),
    };
    if (body.status === 'succeeded') {
      patch.card = body.card;
      patch.cost_usd = body.costUsd ?? 0;
    }
    if (body.status === 'failed') {
      patch.error = body.error;
    }

    const { error } = await supabase.from('eval_run').update(patch).eq('id', run.id);
    if (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      return c.json(structuredError('internal_error', 'Failed to record run status'), 500);
    }

    // Terminal → the credential dies with the run. Best-effort: the mint's
    // 24h expiry backstops a failed revoke.
    if (body.status === 'succeeded' || body.status === 'failed') {
      const { error: revokeError } = await supabase.from('api_key').delete().eq('id', keyRowId);
      if (revokeError) {
        console.warn(`[evals/runs] key revoke failed for run ${run.id}:`, revokeError.message);
      }
    }

    return c.json({ data: { id: run.id, status: body.status } });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/evals/escalations
// ---------------------------------------------------------------------------

export class CreateEvalEscalation extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Evals'],
    summary: 'Record an env-build escalation (worker)',
    operationId: 'create-eval-escalation',
    description:
      'The escalation sink: an env whose repair ladder exhausted its budget becomes a ' +
      'human-readable ticket. tenant/app/eval_run_id are stamped from the key\'s run binding, ' +
      'never from the body.',
    request: {
      body: { content: { 'application/json': { schema: EscalationBodySchema } } },
    },
    responses: {
      201: { description: 'Escalation recorded.' },
      400: errorResponse('Invalid body.'),
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('The key is not an eval-run key.'),
      500: errorResponse('Persistence failed.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = EscalationBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          `Invalid escalation payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`,
        ),
        400,
      );
    }

    // Derive the run binding from the key NAME (`eval-run:{runId}`) — the
    // escalation carries no runId of its own to trust.
    const user = c.get('user');
    const supabase = asServiceClient(createSystemAdminClient(c.env));
    if (!user.apiKeyId) {
      return c.json(structuredError('eval_run_not_found', 'Not an eval-run key'), 404);
    }
    const { data: keyRow } = await supabase
      .from('api_key')
      .select('name')
      .eq('api_key_id', user.apiKeyId)
      .single();
    const runId = keyRow?.name?.startsWith('eval-run:') ? keyRow.name.slice('eval-run:'.length) : null;
    if (!runId) {
      return c.json(structuredError('eval_run_not_found', 'Not an eval-run key'), 404);
    }

    const { error } = await supabase.from('env_escalation').insert({
      ...parsed.data,
      tenant_id: user.tenantId,
      app_id: user.appId,
      eval_run_id: runId,
    });
    if (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      return c.json(structuredError('internal_error', 'Failed to record escalation'), 500);
    }

    return c.json({ data: { recorded: true } }, 201);
  }
}
