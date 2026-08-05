/**
 * Eval Trials Ingest — persist trial results.
 *
 * POST /v1/evals/trials — the Fly eval worker POSTs each run's full
 * `TrialResult`s here (chunked). Per accepted trial the handler writes:
 *
 *   1. Three thin `scores` rows — the queryable index the SLO/analytics
 *      surfaces read (`eval.trial.resolved` with the status taxonomy as Label,
 *      `eval.trial.cost_usd` with measured|estimated as Label,
 *      `eval.trial.duration_ms`). `ResourceId` is the deterministic trace id
 *      of the trial's AgentSession (`traceIdForSession(sessionId)`), so scores
 *      join to the trial's session trace the same way annotation scores join
 *      to their parent traces.
 *   2. One full-fidelity blob (R2/S3 via the blob-storage seam) holding the
 *      verbatim TrialResult under `evals/{tenant}/{app}/{runId}/{traceId}.json`
 *      — key derivable from any score row's ResourceId.
 *
 * Idempotency: the blob key is deterministic (last-writer-wins put) and score
 * row Ids derive from (sessionId, name), so a retried chunk collapses under
 * the scores table's ReplacingMergeTree instead of duplicating.
 *
 * The env triple is stamped from the API-key-bound environment (the per-run
 * worker key is minted bound to the run's env) — same fallback rule as the
 * scores ingest; a resolution failure stamps defaults, never blocks.
 */

import { z, BaseRoute, type AppContext, structuredError, errorResponse, parseJsonBody } from './_shared';
import type { GatewayPermission } from '../../lib/permissions';
import { createClient } from '@clickhouse/client-web';
import { clickHouseWriteAuth } from '../../stores/clickhouse/write-identity';
import { createHash } from 'node:crypto';
import { createSystemAdminClient, asServiceClient } from '../../lib/system-client';
import { createBlobStorage, type BlobStorage } from '../../lib/blob-storage';
import { resolveEnvironmentFromApiKey } from '../../lib/environment-resolver';
import { traceIdForSession } from '../../services/agent-session-converter';
import { mapClickHouseError, toErrorResponse, getErrorStatusCode } from '@repo/observability-service';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_TRIALS_PER_REQUEST = 20;
/** Per-trial serialized cap — the frozen patch rides in `result.patch`. */
export const MAX_TRIAL_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire schema — validate only what this handler READS; the rest of the
// TrialResult is an OSS contract (@outerlayer/trial-harness) stored verbatim
// in the blob, so unknown fields must pass through, not reject.
// ---------------------------------------------------------------------------

const TrialResultWireSchema = z
  .object({
    taskId: z.string().min(1),
    configId: z.string().min(1),
    trialIndex: z.number().int().nonnegative(),
    status: z.string().min(1).max(40),
    resolved: z.boolean(),
    cost: z.object({ usd: z.number().nonnegative(), source: z.string().min(1).max(20) }).passthrough(),
    timings: z.object({ totalMs: z.number().nonnegative() }).passthrough(),
    error: z.string().optional(),
  })
  .passthrough();

const TrialItemSchema = z.object({
  /** Canonical trial session id (the eval-runner owns the recipe). The same id
   * is used for the trial's AgentSession sync, so ResourceId joins by hash. */
  sessionId: z.string().min(1).max(512),
  result: TrialResultWireSchema,
});

const IngestBodySchema = z.object({
  schemaVersion: z.literal(1),
  evalRunId: z.string().uuid(),
  /** Items validated INDIVIDUALLY below so one bad trial rejects alone. */
  trials: z.array(z.unknown()).min(1).max(MAX_TRIALS_PER_REQUEST),
});

const RejectedSchema = z.object({
  index: z.number().int(),
  sessionId: z.string().optional(),
  reason: z.string(),
});

const IngestResponseSchema = z.object({
  data: z.object({
    accepted: z.array(z.string()),
    rejected: z.array(RejectedSchema),
    scoreRows: z.number().int(),
    blobsStored: z.number().int(),
  }),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Object-storage key for a trial's full-fidelity artifact. `traceId` is
 * `traceIdForSession(sessionId)` — the same value stamped on the trial's
 * score rows as ResourceId, so the blob is addressable from any score row. */
export function evalTrialBlobKey(
  tenantId: string,
  appId: string,
  evalRunId: string,
  traceId: string,
): string {
  return `evals/${tenantId}/${appId}/${evalRunId}/${traceId}.json`;
}

/**
 * Deterministic UUID-shaped score Id from (sessionId, score name). Retried
 * chunks re-produce the same Id, so ReplacingMergeTree collapses duplicates
 * (same ORDER BY key, newer UpdatedAt wins) instead of double-counting.
 */
export function deterministicScoreId(sessionId: string, name: string): string {
  const hex = createHash('sha256').update(`${sessionId}\n${name}`).digest('hex');
  // Format as a v4-shaped UUID (version/variant nibbles pinned) so consumers
  // that Zod-validate `.uuid()` on score ids keep working.
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

interface EnvTriple {
  Environment: string;
  EnvironmentVersion: number;
  CommitSha: string;
}

const EMPTY_ENV_TRIPLE: EnvTriple = { Environment: '', EnvironmentVersion: 0, CommitSha: '' };

/** Env triple from the API-key-bound environment (same rule as the scores
 * ingest fallback). Best-effort: failure stamps defaults, never blocks. */
async function resolveKeyEnvTriple(c: AppContext): Promise<EnvTriple> {
  const user = c.get('user');
  try {
    const env = await resolveEnvironmentFromApiKey({
      supabase: asServiceClient(createSystemAdminClient(c.env)),
      apiKeyId: user.apiKeyId,
      tenantId: String(user.tenantId),
      environmentIdFromToken: user.environmentId,
    });
    if (env) {
      const isPinned = env.pinned_version != null;
      return {
        Environment: env.name,
        EnvironmentVersion: env.pinned_version ?? 0,
        CommitSha: isPinned ? env.pinned_commit_sha ?? '' : '',
      };
    }
  } catch (err) {
    console.warn('[evals/trials] api-key env resolution failed, stamping defaults:', err);
  }
  return EMPTY_ENV_TRIPLE;
}

// ---------------------------------------------------------------------------
// POST /v1/evals/trials
// ---------------------------------------------------------------------------

export class IngestEvalTrials extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Evals'],
    summary: 'Ingest eval trial results',
    operationId: 'ingest-eval-trials',
    description:
      'Persists full eval TrialResults: per trial, thin score rows for the queryable index ' +
      '(`eval.trial.resolved`, `eval.trial.cost_usd`, `eval.trial.duration_ms`) plus a ' +
      'full-fidelity artifact blob. Trials are validated individually — a malformed trial ' +
      'is rejected without failing the batch. Deterministic ids make retries idempotent.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: IngestBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Batch result: accepted/rejected per trial.',
        content: { 'application/json': { schema: IngestResponseSchema } },
      },
      400: errorResponse('Malformed request body.'),
      401: errorResponse('Missing or invalid API key.'),
      500: errorResponse('Analytics-layer insert failed; no score rows were persisted.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = IngestBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          `Invalid trials payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`,
        ),
        400,
      );
    }
    const { evalRunId, trials } = parsed.data;

    const user = c.get('user');
    const tenantId = String(user.tenantId);
    const appId = String(user.appId);
    const envTriple = await resolveKeyEnvTriple(c);

    let storage: BlobStorage | null = null;
    try {
      storage = createBlobStorage(c.env);
    } catch (err) {
      // No object storage configured (self-host without R2/S3) — score rows
      // still land; the blob catches up when storage exists.
      console.warn('[evals/trials] blob storage unavailable, scores only:', err);
    }

    const accepted: string[] = [];
    const rejected: Array<z.infer<typeof RejectedSchema>> = [];
    const scoreRows: Array<Record<string, unknown>> = [];
    let blobsStored = 0;
    const now = Date.now();

    for (const [index, rawTrial] of trials.entries()) {
      const item = TrialItemSchema.safeParse(rawTrial);
      if (!item.success) {
        const issue = item.error.issues[0];
        const sessionId =
          typeof rawTrial === 'object' && rawTrial !== null && 'sessionId' in rawTrial
            ? String((rawTrial as { sessionId: unknown }).sessionId)
            : undefined;
        rejected.push({
          index,
          ...(sessionId ? { sessionId } : {}),
          reason: `schema: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`.slice(0, 200),
        });
        continue;
      }
      const { sessionId, result } = item.data;

      const serialized = JSON.stringify({ schemaVersion: 1, evalRunId, sessionId, result });
      if (serialized.length > MAX_TRIAL_BYTES) {
        rejected.push({
          index,
          sessionId,
          reason: `trial: serialized size exceeds ${MAX_TRIAL_BYTES} bytes`,
        });
        continue;
      }

      const traceId = traceIdForSession(sessionId);

      const shared = {
        TenantId: tenantId,
        AppId: appId,
        ResourceId: traceId,
        Type: 'eval_trial',
        Source: 'eval-runner',
        DataType: '',
        UserId: '',
        Environment: envTriple.Environment,
        EnvironmentVersion: envTriple.EnvironmentVersion,
        CommitSha: envTriple.CommitSha,
        CreatedAt: now,
        UpdatedAt: now,
        IsDeleted: 0,
      };
      scoreRows.push(
        {
          ...shared,
          Id: deterministicScoreId(sessionId, 'eval.trial.resolved'),
          Name: 'eval.trial.resolved',
          Score: result.resolved ? 1 : 0,
          DataType: 'boolean',
          Label: result.status,
          Reason: (result.error ?? '').slice(0, 500),
        },
        {
          ...shared,
          Id: deterministicScoreId(sessionId, 'eval.trial.cost_usd'),
          Name: 'eval.trial.cost_usd',
          Score: result.cost.usd,
          DataType: 'numeric',
          Label: result.cost.source,
          Reason: '',
        },
        {
          ...shared,
          Id: deterministicScoreId(sessionId, 'eval.trial.duration_ms'),
          Name: 'eval.trial.duration_ms',
          Score: result.timings.totalMs,
          DataType: 'numeric',
          Label: result.status,
          Reason: '',
        },
      );

      if (storage) {
        try {
          await storage.put(
            evalTrialBlobKey(tenantId, appId, evalRunId, traceId),
            new TextEncoder().encode(serialized),
            'application/json',
          );
          blobsStored += 1;
        } catch (err) {
          // Score rows still land; the deterministic key means the next retry
          // or re-sync fills the gap.
          console.warn(`[evals/trials] blob put failed for ${sessionId}:`, err);
        }
      }

      accepted.push(sessionId);
    }

    if (scoreRows.length > 0) {
      const client = createClient({
        url: c.env.CLICKHOUSE_HOST,
        ...clickHouseWriteAuth(c.env),
      });
      try {
        await client.insert({ table: 'scores', values: scoreRows, format: 'JSONEachRow' });
      } catch (error) {
        console.error(`[${c.req.method} ${c.req.path}]`, error);
        const mapped = mapClickHouseError(error);
        return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
      } finally {
        await client.close();
      }
    }

    return c.json({
      data: {
        accepted,
        rejected,
        scoreRows: scoreRows.length,
        blobsStored,
      },
    });
  }
}
