/**
 * Artifacts OpenAPI route — the evidence ingest pipe.
 *
 * POST /v1/artifacts — accepts ONE artifact (an exhibit: screenshot,
 * recording, report, or log emitted as proof that a change works) plus its
 * content-addressed blob, and anchors it to a pull request: directly via a PR
 * number, or indirectly via the session or git context the reconciler
 * resolves later. Evidence is always evidence OF something, so a request
 * with no anchor at all is refused outright and nothing is stored.
 *
 * Two values are derived server-side and can never be supplied by a caller:
 *
 *   - `kind` comes from `inferArtifactKind(mediaType)` — the wire payload
 *     carries no kind field, so a renderer can trust that "video" really was
 *     video/webm or video/mp4.
 *   - `provenance` comes from HOW the artifact arrived. A session binding is
 *     believed only after the session's summary row is found in ClickHouse
 *     (the trace id derives from the session id exactly as the sync
 *     converter derives it); `ci` is honored only for a shared machine key
 *     (no bound membership); everything else is `local`. A payload cannot
 *     claim a stronger provenance than its submission path proves.
 *
 * The blob dual-write and the PR-comment nomination ride the agents sync
 * pipe's seams (`agent_blobs` + object storage under `agentBlobKey`,
 * PR_COMMENT_QUEUE), so an artifact blob is served and refreshed exactly
 * like a session image blob.
 */

import {
  z,
  BaseRoute,
  type AppContext,
  structuredError,
  errorResponse,
  parseJsonBody,
  getScopedSupabase,
} from './_shared';
import type { GatewayPermission } from '../../lib/permissions';
import { createSystemAdminClient, asServiceClient } from '../../lib/system-client';
import { initCache } from '../../utils';
import { memory } from '../../cache-store';
import { createBlobStorage, type BlobStorage } from '../../lib/blob-storage';
import {
  agentBlobKey,
  base64ToBytes,
  createAgentIngestClient,
  insertAgentRows,
  sha256Hex,
  SYNC_RETRY_AFTER_SECONDS,
} from './agents';
import { traceIdForSession } from '../../services/agent-session-converter';
import { canonicalPrCommentRepo } from '../../lib/pr-comment-repo-key';
import {
  ARTIFACT_KINDS,
  ARTIFACT_PROVENANCES,
  ARTIFACT_MAX_CAPTION_LENGTH,
  ARTIFACT_MAX_FILENAME_LENGTH,
  ArtifactCriterionIdSchema,
  inferArtifactKind,
  type ArtifactProvenance,
} from '@outerlayer/session-schema';
import { PR_COMMENT_QUEUE_DEBOUNCE_SECONDS } from '../../types/queue-messages';
import type { PrCommentQueueMessage } from '../../types/queue-messages';
import type { QueueMessageSendRequest } from '../../runtime';
import type { Database } from '../../db';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Per-artifact decoded-bytes cap (8 MiB) — sized for short screen recordings,
 * the largest evidence kind worth inlining in a request. */
export const ARTIFACT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
/**
 * Whole-request byte ceiling (12 MiB): the blob cap in base64 (~4/3×) plus
 * headroom for the JSON envelope. Rejected up front with a structured 413
 * before the parse + decode allocate, so one oversized emit can't push the
 * isolate toward exhaustion mid-request.
 */
export const ARTIFACT_MAX_REQUEST_BYTES = 12 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars');

/** Filenames are stored and rendered as bare basenames — separators or `..`
 * are rejected so a stored name can never spell a path. */
const ArtifactFilenameSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_MAX_FILENAME_LENGTH)
  .refine((v) => !v.includes('/') && !v.includes('\\') && !v.includes('..'), {
    message: 'must be a bare filename (no path separators or "..")',
  });

const EmitArtifactBodySchema = z.object({
  schemaVersion: z.literal(1),
  artifact: z.object({
    /** Client-minted idempotency key, unique per app. */
    clientArtifactId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be 1-64 id characters'),
    filename: ArtifactFilenameSchema,
    mediaType: z.string().min(1).max(100),
    bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    caption: z.string().max(ARTIFACT_MAX_CAPTION_LENGTH),
    criterionId: ArtifactCriterionIdSchema.optional(),
    emittedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), {
      message: 'must be a parseable timestamp',
    }),
    /** Advisory CI marker — honored only when the API key shape agrees. */
    ci: z.boolean().optional(),
    prNumber: z.number().int().positive().optional(),
    /** Bare OWNER/REPO, as CI environments supply it. */
    repository: z.string().optional(),
    /** Host-qualified repo (e.g. github.com/acme/app), as a git remote names it. */
    gitRepo: z.string().optional(),
    gitBranch: z.string().optional(),
    commitSha: z.string().optional(),
    session: z
      .object({
        sessionId: z.string().min(1),
        turnIndex: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
  blob: z.object({
    /** Base64-encoded content. */
    data: z.string().min(1),
  }),
});

const EmitArtifactResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    kind: z.enum(ARTIFACT_KINDS),
    provenance: z.enum(ARTIFACT_PROVENANCES),
    verification: z.enum(['pending', 'confirmed', 'unmatched']),
    prNumber: z.number().int().nullable(),
    repository: z.string(),
  }),
});

/** The row slice echoed to the caller (also re-read on an idempotent retry). */
const ARTIFACT_RETURN_COLUMNS = 'id,kind,provenance,verification,pr_number,repository';

type ArtifactReturnRow = Pick<
  Database['public']['Tables']['artifact']['Row'],
  'id' | 'kind' | 'provenance' | 'verification' | 'pr_number' | 'repository'
>;

function artifactResponse(c: AppContext, row: ArtifactReturnRow) {
  return c.json({
    data: {
      id: row.id,
      kind: row.kind,
      provenance: row.provenance,
      verification: row.verification,
      prNumber: row.pr_number,
      repository: row.repository,
    },
  });
}

/**
 * True when the claimed session's summary row exists for this tenant + app.
 *
 * The trace id derives from the session id by the SAME function the sync
 * converter uses, so an artifact can only bind to a session that actually
 * synced — this check is what makes claimed `session` provenance impossible
 * to fake. The read is tenant+app scoped so the primary-key prefix prunes to
 * the caller's parts. A query failure propagates (500) rather than deciding
 * either way: failing open would let a made-up session claim `session`
 * provenance during an outage; failing closed would 400 a real one.
 */
async function agentSessionSummaryExists(
  env: { CLICKHOUSE_HOST: string; CLICKHOUSE_PASSWORD: string },
  tenantId: string,
  appId: string,
  traceId: string,
): Promise<boolean> {
  const client = createAgentIngestClient(env);
  try {
    const rs = await client.query({
      query:
        'SELECT count() AS n FROM agent_session_summary ' +
        'WHERE TenantId = {t:String} AND AppId = {a:String} AND TraceId = {id:String}',
      query_params: { t: tenantId, a: appId, id: traceId },
      format: 'JSONEachRow',
    });
    const rows = (await rs.json()) as Array<{ n: string | number }>;
    return Number(rows[0]?.n ?? 0) > 0;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// POST /v1/artifacts
// ---------------------------------------------------------------------------

export class EmitArtifact extends BaseRoute {
  static requiredPermission: GatewayPermission = 'trace.write';
  schema = {
    tags: ['Artifacts'],
    summary: 'Emit an artifact (evidence for a pull request)',
    operationId: 'emit-artifact',
    description:
      'Accepts one artifact — a screenshot, recording, report, or log emitted as proof that a change works — ' +
      'plus its content-addressed blob. The artifact anchors to a pull request directly (prNumber), through the ' +
      'recorded session that produced it, or through git context resolved to a PR later; a request with no ' +
      'anchor at all is refused and nothing is stored. `kind` is inferred from the media type and provenance ' +
      '(session / ci / local) is derived from the submission path — neither can be supplied by the caller. ' +
      'Retrying with the same clientArtifactId returns the already-stored artifact.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: EmitArtifactBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The stored artifact (the existing row on an idempotent retry).',
        content: { 'application/json': { schema: EmitArtifactResponseSchema } },
      },
      400: errorResponse('Malformed body, sha256 mismatch, unknown session binding, or nothing to attach to.'),
      401: errorResponse('Missing or invalid API key.'),
      413: errorResponse('Blob or request exceeds the byte ceiling.'),
      429: errorResponse('Monthly storage cap exceeded.'),
      503: {
        ...errorResponse('Ingest temporarily unavailable; retry after the interval.'),
        headers: z.object({
          'Retry-After': z.number().int().nonnegative().optional(),
        }),
      },
    },
  };

  async handle(c: AppContext) {
    // Shed an oversized request before the parse allocates (the agents-sync
    // pre-check): the base64 blob is the dominant allocation.
    const declaredLength = Number(c.req.header?.('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > ARTIFACT_MAX_REQUEST_BYTES) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Artifact request exceeds the ${ARTIFACT_MAX_REQUEST_BYTES}-byte ceiling.`,
          { limit: ARTIFACT_MAX_REQUEST_BYTES },
        ),
        413,
      );
    }

    const raw = await parseJsonBody(c);
    const parsed = EmitArtifactBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          `Invalid artifact payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`,
        ),
        400,
      );
    }
    const { artifact } = parsed.data;
    const blobData = parsed.data.blob.data;

    // Secondary guard for clients that omit Content-Length (chunked uploads):
    // the base64 blob is the request's weight, so cap it here too.
    if (blobData.length > ARTIFACT_MAX_REQUEST_BYTES) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Artifact request exceeds the ${ARTIFACT_MAX_REQUEST_BYTES}-byte ceiling.`,
          { limit: ARTIFACT_MAX_REQUEST_BYTES },
        ),
        413,
      );
    }

    const user = c.get('user');
    const env = c.env;
    const db = await getScopedSupabase(c);

    // Idempotency: a retry of an already-accepted clientArtifactId returns the
    // stored row untouched. Checked BEFORE the blob write so a retry never
    // stores the blob (or re-runs the anchor checks) a second time.
    const { data: existing, error: existingError } = await db
      .from('artifact')
      .select(ARTIFACT_RETURN_COLUMNS)
      .eq('app_id', user.appId)
      .eq('client_artifact_id', artifact.clientArtifactId)
      .maybeSingle();
    if (existingError) {
      throw new Error(`artifact lookup failed: ${existingError.message}`);
    }
    if (existing) {
      return artifactResponse(c, existing);
    }

    // Verify the content addressing (recompute sha256 server-side — the blob
    // key IS the hash) before anything downstream trusts it.
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(blobData);
    } catch {
      return c.json(structuredError('invalid_field_value', 'blob.data is not valid base64'), 400);
    }
    if (bytes.byteLength > ARTIFACT_MAX_BLOB_BYTES) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Artifact blob exceeds the ${ARTIFACT_MAX_BLOB_BYTES}-byte decoded ceiling.`,
          { limit: ARTIFACT_MAX_BLOB_BYTES },
        ),
        413,
      );
    }
    const digest = await sha256Hex(bytes);
    if (digest !== artifact.sha256) {
      return c.json(structuredError('invalid_field_value', 'sha256 does not match content'), 400);
    }

    const kind = inferArtifactKind(artifact.mediaType);

    // Provenance is derived from the submission path, never claimed. A
    // session binding must name a session that actually synced; `ci` is
    // honored only for a shared machine key (no bound membership) — an
    // actor-bound key claiming ci downgrades to local silently.
    let provenance: ArtifactProvenance;
    let sessionId = '';
    let traceId = '';
    let turnIndex: number | null = null;
    if (artifact.session) {
      traceId = traceIdForSession(artifact.session.sessionId);
      const found = await agentSessionSummaryExists(env, user.tenantId, user.appId, traceId);
      if (!found) {
        return c.json(
          structuredError(
            'session_not_found',
            'No synced session matches this binding for the app — sync the session before emitting artifacts bound to it.',
          ),
          400,
        );
      }
      provenance = 'session';
      sessionId = artifact.session.sessionId;
      turnIndex = artifact.session.turnIndex ?? null;
    } else if (artifact.ci === true && !user.actorMembershipId) {
      provenance = 'ci';
    } else {
      provenance = 'local';
    }

    // Anchor resolution. `repository` is the canonical LOWERCASE bare
    // owner/repo (the PR-comment identity key) or '' when the input names
    // nothing this feature can address — never a best-effort guess.
    const repository =
      canonicalPrCommentRepo(artifact.repository) ?? canonicalPrCommentRepo(artifact.gitRepo) ?? '';

    let verification: 'pending' | 'confirmed';
    let prNumber: number | null = null;
    if (artifact.prNumber !== undefined) {
      prNumber = artifact.prNumber;
      const { data: prRow, error: prError } = await db
        .from('pull_request')
        .select('id')
        .eq('app_id', user.appId)
        .eq('pr_number', artifact.prNumber)
        .limit(1)
        .maybeSingle();
      if (prError) {
        throw new Error(`pull_request lookup failed: ${prError.message}`);
      }
      verification = prRow ? 'confirmed' : 'pending';
    } else if (provenance === 'session') {
      // The reconciler resolves the PR through the session's own PR links.
      verification = 'pending';
    } else if ((artifact.gitRepo ?? '') !== '' || (artifact.gitBranch ?? '') !== '') {
      // Git context: the reconciler matches branch/commit against a PR's
      // activity window.
      verification = 'pending';
    } else {
      // No anchor of any sort. Refuse BEFORE the blob write and the row
      // insert — an unanchorable artifact must leave no trace.
      return c.json(structuredError('nothing_to_attach', 'nothing to attach this to'), 400);
    }

    // Storage-cap gate: hobby-tier monthly storage ceiling (Stripe usage
    // meter), mirroring the agents sync gate. Placed AFTER the refusal gate —
    // a refused emit stores nothing, so it must never be counted or gated as
    // storage — and BEFORE the blob write, so a capped tenant stores nothing.
    // Fails OPEN: a Stripe/cache hiccup must never drop evidence.
    try {
      const gtx = c.get('gtx');
      const gatewayCache = initCache(gtx.cacheL2Store, gtx.execCtx, memory);
      const capResult = await gtx.billing.checkStorageCap(
        asServiceClient(createSystemAdminClient(env)),
        user.tenantId,
        user.stripeCustomerId,
        gatewayCache,
      );
      if (!capResult.allowed) {
        return c.json(
          structuredError('storage_cap_exceeded', 'Monthly storage cap exceeded. Upgrade your plan for more storage.', {
            currentBytes: capResult.currentBytes,
            limitBytes: capResult.limitBytes,
          }),
          429,
        );
      }
    } catch (e) {
      console.warn('[artifacts] storage-cap check failed, continuing:', e);
    }

    // Blob dual-write, only now that the refusal gate has passed — the same
    // seams as the agents sync pipe, so the blob serves via
    // GET /v1/agents/blob/:sha256 and the dashboard's transcript path alike.
    let storage: BlobStorage | null = null;
    try {
      storage = createBlobStorage(env);
    } catch (e) {
      // No object storage configured (self-host without R2/S3) — the
      // ClickHouse row below still makes the blob servable.
      console.warn('[artifacts] blob storage unavailable, ClickHouse only:', e);
    }
    if (storage) {
      try {
        await storage.put(agentBlobKey(user.tenantId, user.appId, artifact.sha256), bytes, artifact.mediaType);
      } catch (e) {
        // ClickHouse row still serves it; object storage catches up on a
        // retry (same deterministic key).
        console.warn(`[artifacts] object-storage put failed for ${artifact.sha256}:`, e);
      }
    }
    const inserted = await insertAgentRows(env, [
      {
        table: 'agent_blobs',
        values: [
          {
            TenantId: user.tenantId,
            AppId: user.appId,
            Sha256: artifact.sha256,
            MediaType: artifact.mediaType,
            Bytes: bytes.byteLength,
            Data: blobData,
          },
        ],
      },
    ]);
    if (!inserted) {
      return c.json(
        structuredError('service_unavailable', 'Ingest temporarily unavailable. Retry after the interval.'),
        {
          status: 503,
          headers: { 'Retry-After': String(SYNC_RETRY_AFTER_SECONDS) },
        } as any, // Hono's c.json() typing doesn't accept status+headers together
      );
    }

    // Row insert. `ignoreDuplicates` + the (app_id, client_artifact_id)
    // unique key turns a concurrent duplicate into a read, not an error.
    const insertRow: Database['public']['Tables']['artifact']['Insert'] = {
      tenant_id: user.tenantId,
      app_id: user.appId,
      client_artifact_id: artifact.clientArtifactId,
      sha256: artifact.sha256,
      filename: artifact.filename,
      media_type: artifact.mediaType,
      kind,
      caption: artifact.caption,
      criterion_id: artifact.criterionId ?? '',
      provenance,
      session_id: sessionId,
      trace_id: traceId,
      turn_index: turnIndex,
      repository,
      pr_number: prNumber,
      git_repo: artifact.gitRepo ?? '',
      git_branch: artifact.gitBranch ?? '',
      commit_sha: artifact.commitSha ?? '',
      verification,
      emitted_at: new Date(artifact.emittedAt).toISOString(),
    };
    const { data: upserted, error: upsertError } = await db
      .from('artifact')
      .upsert(insertRow, { onConflict: 'app_id,client_artifact_id', ignoreDuplicates: true })
      .select(ARTIFACT_RETURN_COLUMNS)
      .maybeSingle();
    if (upsertError) {
      throw new Error(`artifact insert failed: ${upsertError.message}`);
    }
    let row = upserted;
    if (!row) {
      // The upsert was ignored: a concurrent request won the unique key.
      // Return the winner's row — same idempotent contract as the pre-check.
      const { data: raced, error: racedError } = await db
        .from('artifact')
        .select(ARTIFACT_RETURN_COLUMNS)
        .eq('app_id', user.appId)
        .eq('client_artifact_id', artifact.clientArtifactId)
        .maybeSingle();
      if (racedError || !raced) {
        throw new Error(`artifact upsert returned no row: ${racedError?.message ?? 'row not found'}`);
      }
      row = raced;
    }

    // Nominate the PR for a comment refresh — same message schema, debounce
    // constant, and never-fail-the-request posture as the agents sync
    // producer. The queue binding is optional (self-host / local dev), and
    // the webhook + hourly cron sweep remain the backstop, so a swallowed
    // failure here only costs latency, never correctness.
    if (row.pr_number !== null && row.repository !== '') {
      try {
        const requests: QueueMessageSendRequest<PrCommentQueueMessage>[] = [
          {
            body: {
              tenantId: user.tenantId,
              repository: row.repository,
              prNumber: row.pr_number,
              enqueuedAt: Date.now(),
            },
            delaySeconds: PR_COMMENT_QUEUE_DEBOUNCE_SECONDS,
          },
        ];
        await env.PR_COMMENT_QUEUE?.sendBatch(requests);
      } catch (e) {
        console.warn('[artifacts] PR_COMMENT_QUEUE enqueue failed (cron sweep will repair):', e);
      }
    }

    return artifactResponse(c, row);
  }
}
