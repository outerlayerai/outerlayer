/**
 * Emitted-results OpenAPI route — the check-outcome ingest pipe.
 *
 * POST /v1/emitted-results — accepts ONE emitted result: the recorded
 * pass/fail outcome of a check that ran in the customer's own
 * infrastructure (their CI, their compute), carrying the run URL as its
 * proof link. Unlike artifacts, an emitted result has no blob and no
 * deferred reconciliation: it anchors to a repository + PR number at
 * ingest or it is refused outright and nothing is stored.
 *
 * `provenance` is derived server-side and can never be supplied by a
 * caller: `ci` is honored only for a shared machine key (no bound
 * membership); everything else is `local`. A payload cannot claim a
 * stronger provenance than its submission path proves.
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
import { canonicalPrCommentRepo } from '../../lib/pr-comment-repo-key';
import {
  EMITTED_RESULT_MAX_LINK_LENGTH,
  EMITTED_RESULT_PROVENANCES,
  EMITTED_RESULTS,
  EmittedNameSchema,
  type EmittedResultProvenance,
} from '@outerlayer/session-schema';
import { PR_COMMENT_QUEUE_DEBOUNCE_SECONDS } from '../../types/queue-messages';
import type { PrCommentQueueMessage } from '../../types/queue-messages';
import type { QueueMessageSendRequest } from '../../runtime';
import type { Database } from '../../db';

/** The proof link is the row's evidence — a reviewer follows it to the CI
 * run. Only web-resolvable URLs qualify; anything else stores a dead end.
 * Whitespace is refused outright: the link lands inside a markdown `(url)`
 * wrapper on a world-readable comment, and a raw newline would end the
 * wrapper and let the remainder render as fabricated comment content. */
const EmittedLinkSchema = z
  .string()
  .min(1)
  .max(EMITTED_RESULT_MAX_LINK_LENGTH)
  .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'must be an http:// or https:// URL',
  })
  .refine((v) => !/\s/.test(v), {
    message: 'must not contain whitespace — percent-encode it',
  });

const EmitResultBodySchema = z.object({
  schemaVersion: z.literal(1),
  emit: z.object({
    /** Client-minted idempotency key, unique per app. */
    clientEmitId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be 1-64 id characters'),
    name: EmittedNameSchema,
    result: z.enum(EMITTED_RESULTS),
    link: EmittedLinkSchema,
    emittedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), {
      message: 'must be a parseable timestamp',
    }),
    /** Advisory CI marker — honored only when the API key shape agrees. */
    ci: z.boolean().optional(),
    prNumber: z.number().int().positive(),
    /** Bare OWNER/REPO, as CI environments supply it. */
    repository: z.string().optional(),
    /** Host-qualified repo (e.g. github.com/acme/app), as a git remote names it. */
    gitRepo: z.string().optional(),
  }),
});

const EmitResultResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    name: z.string(),
    result: z.enum(EMITTED_RESULTS),
    provenance: z.enum(EMITTED_RESULT_PROVENANCES),
    verification: z.enum(['pending', 'confirmed']),
    prNumber: z.number().int(),
    repository: z.string(),
  }),
});

/** The row slice echoed to the caller (also re-read on an idempotent retry). */
const EMITTED_RESULT_RETURN_COLUMNS = 'id,name,result,provenance,verification,pr_number,repository';

type EmittedResultReturnRow = Pick<
  Database['public']['Tables']['emitted_result']['Row'],
  'id' | 'name' | 'result' | 'provenance' | 'verification' | 'pr_number' | 'repository'
>;

function emittedResultResponse(c: AppContext, row: EmittedResultReturnRow) {
  return c.json({
    data: {
      id: row.id,
      name: row.name,
      result: row.result,
      provenance: row.provenance,
      verification: row.verification,
      prNumber: row.pr_number,
      repository: row.repository,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /v1/emitted-results
// ---------------------------------------------------------------------------

export class EmitResult extends BaseRoute {
  static requiredPermission: GatewayPermission = 'trace.write';
  schema = {
    tags: ['Emitted Results'],
    summary: 'Emit a check result (pass/fail evidence for a pull request)',
    operationId: 'emit-result',
    description:
      'Accepts one emitted result — the recorded pass/fail outcome of a check that ran in your own CI or ' +
      'compute, named after the validator that declares it. The link is the proof: the run URL a reviewer ' +
      'follows to see the check. Every emitted result anchors to a repository and PR number at ingest; a ' +
      'request that resolves no repository is refused and nothing is stored. Provenance (ci / local) is ' +
      'derived from the submission path and cannot be supplied by the caller. Retrying with the same ' +
      'clientEmitId returns the already-stored result.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: EmitResultBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The stored result (the existing row on an idempotent retry).',
        content: { 'application/json': { schema: EmitResultResponseSchema } },
      },
      400: errorResponse('Malformed body or nothing to attach to.'),
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = EmitResultBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          `Invalid emitted-result payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`,
        ),
        400,
      );
    }
    const { emit } = parsed.data;

    const user = c.get('user');
    const env = c.env;
    const db = await getScopedSupabase(c);

    // Idempotency: a retry of an already-accepted clientEmitId returns the
    // stored row untouched — checked before the anchor gate so a retry never
    // re-runs it.
    const { data: existing, error: existingError } = await db
      .from('emitted_result')
      .select(EMITTED_RESULT_RETURN_COLUMNS)
      .eq('app_id', user.appId)
      .eq('client_emit_id', emit.clientEmitId)
      .maybeSingle();
    if (existingError) {
      throw new Error(`emitted_result lookup failed: ${existingError.message}`);
    }
    if (existing) {
      return emittedResultResponse(c, existing);
    }

    // Provenance is derived from the submission path, never claimed: `ci` is
    // honored only for a shared machine key (no bound membership) — an
    // actor-bound key claiming ci downgrades to local silently.
    const provenance: EmittedResultProvenance =
      emit.ci === true && !user.actorMembershipId ? 'ci' : 'local';

    // Anchor resolution. `repository` is the canonical LOWERCASE bare
    // owner/repo (the PR-comment identity key) or '' when the input names
    // nothing this feature can address. An emitted result carries its full
    // repo + PR anchor at ingest or is refused — there is no reconciler
    // to resolve it later.
    const repository =
      canonicalPrCommentRepo(emit.repository) ?? canonicalPrCommentRepo(emit.gitRepo) ?? '';
    if (repository === '') {
      return c.json(structuredError('nothing_to_attach', 'nothing to attach this to'), 400);
    }

    const { data: prRow, error: prError } = await db
      .from('pull_request')
      .select('id')
      .eq('app_id', user.appId)
      .eq('pr_number', emit.prNumber)
      .limit(1)
      .maybeSingle();
    if (prError) {
      throw new Error(`pull_request lookup failed: ${prError.message}`);
    }
    const verification: 'pending' | 'confirmed' = prRow ? 'confirmed' : 'pending';

    // Row insert. `ignoreDuplicates` + the (app_id, client_emit_id) unique
    // key turns a concurrent duplicate into a read, not an error.
    const insertRow: Database['public']['Tables']['emitted_result']['Insert'] = {
      tenant_id: user.tenantId,
      app_id: user.appId,
      client_emit_id: emit.clientEmitId,
      name: emit.name,
      result: emit.result,
      link: emit.link,
      provenance,
      repository,
      pr_number: emit.prNumber,
      verification,
      emitted_at: new Date(emit.emittedAt).toISOString(),
    };
    const { data: upserted, error: upsertError } = await db
      .from('emitted_result')
      .upsert(insertRow, { onConflict: 'app_id,client_emit_id', ignoreDuplicates: true })
      .select(EMITTED_RESULT_RETURN_COLUMNS)
      .maybeSingle();
    if (upsertError) {
      throw new Error(`emitted_result insert failed: ${upsertError.message}`);
    }
    let row = upserted;
    if (!row) {
      // The upsert was ignored: a concurrent request won the unique key.
      // Return the winner's row — same idempotent contract as the pre-check.
      const { data: raced, error: racedError } = await db
        .from('emitted_result')
        .select(EMITTED_RESULT_RETURN_COLUMNS)
        .eq('app_id', user.appId)
        .eq('client_emit_id', emit.clientEmitId)
        .maybeSingle();
      if (racedError || !raced) {
        throw new Error(`emitted_result upsert returned no row: ${racedError?.message ?? 'row not found'}`);
      }
      row = raced;
    }

    // Nominate the PR for a comment refresh — same message schema, debounce
    // constant, and never-fail-the-request posture as the artifacts emit.
    // Every stored row carries a non-empty repository and a PR number (the
    // refusal gate guarantees it), so nomination is unconditional. The queue
    // binding is optional (self-host / local dev); the webhook + hourly cron
    // sweep remain the backstop, so a swallowed failure here only costs
    // latency, never correctness.
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
      console.warn('[emitted-results] PR_COMMENT_QUEUE enqueue failed (cron sweep will repair):', e);
    }

    return emittedResultResponse(c, row);
  }
}
