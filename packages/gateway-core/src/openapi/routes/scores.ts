/**
 * Scores OpenAPI Routes
 *
 * Endpoints for managing and querying evaluation scores.
 */

import { mapClickHouseError, toErrorResponse, getErrorStatusCode, clickHouseToISO, buildEnvironmentWhereClause } from '@repo/observability-service';
import {
  CreateScoreBodySchema,
  CreateScoresBatchBodySchema,
  CreateScoresBatchResponseSchema,
  MAX_SCORES_BATCH_SIZE,
  ScoresListParamsSchema,
  ScoresListResponseSchema,
  ScoresSearchBodySchema,
  ScoreAggregationsParamsSchema,
  ScoreAggregationsResponseSchema,
  ScoreNamesResponseSchema,
  ScoreDetailResponseSchema,
  type CreateScoresBatchResultItem,
} from '@repo/api-schemas';
import { z, BaseRoute, type AppContext, getService, assertTenantScoped, buildTenantContext, structuredError, errorResponse, parseJsonBody, resolveEnvScope } from './_shared';
import { FilterParseError } from '../../lib/trace-filter-dsl';
import { validateSearchFilters, resolveSearchWindow } from '../../lib/filter-validation';
import { RATE_LIMITS } from '../../rate-limits';
import { createClient } from '@clickhouse/client-web';
import { clickHouseWriteAuth } from '../../stores/clickhouse/write-identity';
import type { GatewayPermission } from '../../lib/permissions';
import { createSystemAdminClient, asServiceClient } from '../../lib/system-client';
import { resolveEnvironmentFromApiKey } from '../../lib/environment-resolver';

// ---------------------------------------------------------------------------
// Score env stamping
// ---------------------------------------------------------------------------

/**
 * The denormalized env triple stamped onto every `scores` row. Mirrors the
 * `(Environment, EnvironmentVersion, CommitSha)` columns on `otel_traces`.
 */
interface ScoreEnvTriple {
  Environment: string;
  EnvironmentVersion: number;
  CommitSha: string;
}

/** The all-defaults triple — legacy / no-binding / unresolvable. */
const EMPTY_ENV_TRIPLE: ScoreEnvTriple = {
  Environment: '',
  EnvironmentVersion: 0,
  CommitSha: '',
};

/**
 * Resolve the env triple for a score row.
 *
 * A score is *about a parent trace*. The parent trace already has a
 * coherent `(Environment, EnvironmentVersion, CommitSha)` triple stamped at
 * trace ingest (see `span-converter.ts`), so the authoritative source for the
 * score's triple is the parent trace, looked up by `ResourceId`. A score's
 * `ResourceId` is either a `TraceId` (CLI / server-side eval scores) or a
 * `SpanId` (annotation scores) — we match against both.
 *
 * When no parent trace is found (e.g. the score arrives before its trace, or
 * references a non-existent resource) we fall back to the env bound to the
 * request's API key via {@link resolveEnvironmentFromApiKey} — the same
 * stamping rule the trace ingest path uses (pinned env → authoritative
 * `pinned_commit_sha`; no-pin / legacy → empty).
 *
 * Resolution is best-effort: any failure yields {@link EMPTY_ENV_TRIPLE} so a
 * lookup error never blocks score creation.
 */
async function resolveScoreEnvTriples(
  c: AppContext,
  resourceIds: string[],
): Promise<Map<string, ScoreEnvTriple>> {
  const result = new Map<string, ScoreEnvTriple>();
  const uniqueIds = Array.from(new Set(resourceIds.filter(Boolean)));
  if (uniqueIds.length === 0) return result;

  const user = c.get('user');
  const tenantId = String(user.tenantId);
  const appId = String(user.appId);

  // 1. Parent-trace lookup — authoritative when the trace exists.
  const client = createClient({
    url: c.env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(c.env),
  });
  try {
    const queryParams = { tenantId, appId, resourceIds: uniqueIds };
    // Defense-in-depth — every otel_traces read is tenant-scoped.
    assertTenantScoped({ tenantId, appId });
    const rows = await client.query({
      query: `
        SELECT
          TraceId AS trace_id,
          SpanId AS span_id,
          Environment AS environment,
          EnvironmentVersion AS environment_version,
          CommitSha AS commit_sha
        FROM otel_traces FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND IsDeleted = 0
          AND (TraceId IN {resourceIds:Array(String)}
               OR SpanId IN {resourceIds:Array(String)})
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    const traceRows = await rows.json<{
      trace_id: string;
      span_id: string;
      environment: string;
      environment_version: number | string;
      commit_sha: string;
    }>();
    for (const row of traceRows) {
      const triple: ScoreEnvTriple = {
        Environment: row.environment || '',
        EnvironmentVersion: Number(row.environment_version) || 0,
        CommitSha: row.commit_sha || '',
      };
      // A score's ResourceId can be either the trace id or a span id —
      // index the triple under both so the lookup hits regardless.
      if (row.trace_id) result.set(row.trace_id, triple);
      if (row.span_id) result.set(row.span_id, triple);
    }
  } catch (err) {
    console.warn('[scores] parent-trace env lookup failed, falling back:', err);
  } finally {
    await client.close();
  }

  // 2. API-key fallback for ResourceIds with no matching parent trace.
  const unresolved = uniqueIds.filter((id) => !result.has(id));
  if (unresolved.length > 0) {
    let fallback: ScoreEnvTriple = EMPTY_ENV_TRIPLE;
    try {
      const env = await resolveEnvironmentFromApiKey({
        supabase: asServiceClient(createSystemAdminClient(c.env)),
        apiKeyId: user.apiKeyId,
        tenantId,
        environmentIdFromToken: user.environmentId,
      });
      if (env) {
        const isPinned = env.pinned_version != null;
        fallback = {
          Environment: env.name,
          EnvironmentVersion: env.pinned_version ?? 0,
          // Same pinned/no-pin CommitSha rule as the trace ingest path.
          CommitSha: isPinned ? env.pinned_commit_sha ?? '' : '',
        };
      }
    } catch (err) {
      console.warn('[scores] api-key env fallback failed, stamping defaults:', err);
    }
    for (const id of unresolved) {
      result.set(id, fallback);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// POST /v1/scores
// ---------------------------------------------------------------------------

/**
 * Legacy SDKs send camelCase body fields (`resourceId`), while the public
 * OpenAPI contract uses snake_case (`resource_id`). This internal schema
 * makes `resource_id` optional and adds legacy fields so the handler can
 * normalise before inserting.
 */
const CreateScoreInputSchema = CreateScoreBodySchema
  .extend({
    // Override resource_id to optional so legacy clients that send `resourceId` pass validation
    resource_id: z.string().optional(),
    // Legacy camelCase fields (SDKs still in the wild)
    resourceId: z.string().optional(),
    type: z.string().optional(),
    dataType: z.string().optional(),
  });

const VALID_DATA_TYPES = ['boolean', 'numeric', 'categorical', ''];

export class CreateScore extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Scoring'],
    summary: 'Create score',
    operationId: 'create-score',
    description: 'Create a score record for a span or trace. Scores are used to track quality metrics,\nevaluation results, and human feedback.\n\n<Note>`/v1/score` (singular) is an accepted alias for this endpoint.</Note>',
    request: {
      body: {
        content: {
          'application/json': {
            schema: CreateScoreBodySchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Score created.',
        content: {
          'application/json': {
            schema: z.object({
              message: z.string(),
              id: z.string().uuid(),
            }),
          },
        },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      500: errorResponse('Internal server error.'),
    },
  };

  async handle(c: AppContext) {
    // Parse the raw body so we can accept both legacy camelCase and snake_case fields
    const raw: unknown = await parseJsonBody(c);
    const parsed = CreateScoreInputSchema.safeParse(raw);

    if (!parsed.success) {
      return c.json(structuredError('invalid_request_body', 'Invalid request body'), 400);
    }

    const body = parsed.data;

    // Normalise: prefer snake_case `resource_id`, fall back to legacy `resourceId`
    const resourceId = body.resource_id || body.resourceId;
    if (!resourceId) {
      return c.json(structuredError('missing_required_field', 'resource_id is required', { field: 'resource_id' }), 400);
    }

    // Validate dataType when provided (legacy field)
    if (body.dataType != null && !VALID_DATA_TYPES.includes(body.dataType)) {
      return c.json(
        structuredError(
          'invalid_field_value',
          'Invalid dataType. Must be boolean, numeric, or categorical.',
          { field: 'dataType' },
        ),
        400,
      );
    }

    // Shape-only: score/label/dataType are validated by Zod (api-schemas) and
    // the dataType allowlist above. No server-side config enforcement — the
    // score is stored exactly as submitted.
    const scoreValue = body.score;
    const scoreLabel = body.label ?? '';
    const scoreDataType = body.dataType ?? '';

    const id = crypto.randomUUID();
    const user = c.get('user');
    const tenantId = user.tenantId;
    const appId = user.appId;

    // Resolve the env triple from the parent trace,
    // falling back to the API key's bound env.
    const envTriples = await resolveScoreEnvTriples(c, [resourceId]);
    const envTriple = envTriples.get(resourceId) ?? EMPTY_ENV_TRIPLE;

    const client = createClient({
      url: c.env.CLICKHOUSE_HOST,
      ...clickHouseWriteAuth(c.env),
    });

    try {
      // Millisecond precision — DateTime64(3) columns interpret integer JSON
      // values as units of their precision. Do not divide by 1000: JSONEachRow
      // cannot parse a float token for a DateTime/DateTime64 column.
      const now = Date.now();
      await client.insert({
        table: 'scores',
        values: [
          {
            Id: id,
            TenantId: tenantId,
            AppId: appId,
            ResourceId: resourceId,
            Score: scoreValue,
            Label: scoreLabel,
            Reason: body.reason || '',
            Name: body.name,
            Type: body.type || '',
            DataType: scoreDataType,
            Source: body.source || 'api',
            // Denormalized env triple.
            Environment: envTriple.Environment,
            EnvironmentVersion: envTriple.EnvironmentVersion,
            CommitSha: envTriple.CommitSha,
            CreatedAt: now,
            UpdatedAt: now,
            IsDeleted: 0,
          },
        ],
        format: 'JSONEachRow',
      });

      return c.json({ message: 'Score created successfully', id }, 201);
    } finally {
      await client.close();
    }
  }
}

// ---------------------------------------------------------------------------
// POST /v1/scores/batch
// ---------------------------------------------------------------------------

const CreateScoresBatchItemInputSchema = CreateScoreBodySchema
  .extend({
    resource_id: z.string().optional(),
    resourceId: z.string().optional(),
    type: z.string().optional(),
    dataType: z.string().optional(),
    client_id: z.string().max(128).optional(),
  });

export class CreateScoresBatch extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.write';
  schema = {
    tags: ['Scoring'],
    summary: 'Create scores (batch)',
    operationId: 'create-scores-batch',
    description:
      'Create up to 1000 scores in a single request. Each item is validated independently and the response always contains a per-item results array.\n\nStatus codes:\n  - `201 Created` — every item succeeded.\n  - `207 Multi-Status` — at least one item failed validation (e.g. missing `resource_id` or invalid `dataType`).\n  - `400 Bad Request` — every item failed validation (or the envelope itself is malformed).\n  - `413 Payload Too Large` — the request contains more than 1000 items.\n  - `500 Internal Server Error` — the batch insert against analytics storage failed; no items were persisted.\n\nPass an optional `client_id` on each item (max 128 chars) to correlate the server-generated `id` back to your own identifier in the results array. The server never inspects or stores `client_id`.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: CreateScoresBatchBodySchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: 'All scores created successfully.',
        content: {
          'application/json': {
            schema: CreateScoresBatchResponseSchema,
          },
        },
      },
      207: {
        description: 'Partial success — some items succeeded and some failed validation.',
        content: {
          'application/json': {
            schema: CreateScoresBatchResponseSchema,
          },
        },
      },
      400: errorResponse('Malformed request body, or every item failed validation.'),
      401: errorResponse('Missing or invalid API key.'),
      413: errorResponse('Batch exceeds max size of 1000.'),
      500: errorResponse('Analytics-layer insert failed; no items were persisted.'),
    },
  };

  async handle(c: AppContext) {
    const raw: unknown = await parseJsonBody(c);
    const envelope = z
      .object({ scores: z.array(CreateScoresBatchItemInputSchema) })
      .safeParse(raw);

    if (!envelope.success) {
      return c.json(
        structuredError('invalid_request_body', 'Invalid request body: expected { scores: [...] }'),
        400,
      );
    }

    const items = envelope.data.scores;
    if (items.length === 0) {
      return c.json(
        structuredError('invalid_request_body', 'scores must contain at least one item'),
        400,
      );
    }
    if (items.length > MAX_SCORES_BATCH_SIZE) {
      return c.json(
        structuredError(
          'payload_too_large',
          `Batch size ${items.length} exceeds max of ${MAX_SCORES_BATCH_SIZE}`,
          { max: MAX_SCORES_BATCH_SIZE },
        ),
        413,
      );
    }

    const user = c.get('user');
    const tenantId = user.tenantId;
    const appId = user.appId;
    const now = Date.now();

    // Resolve env triples for every referenced ResourceId up
    // front (one parent-trace query for the whole batch), then stamp each
    // row below.
    const batchResourceIds = items
      .map((it) => it.resource_id || it.resourceId)
      .filter((rid): rid is string => Boolean(rid));
    const envTriples = await resolveScoreEnvTriples(c, batchResourceIds);

    const results: CreateScoresBatchResultItem[] = new Array(items.length);
    const toInsert: Array<{ index: number; row: Record<string, unknown> }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const resourceId = item.resource_id || item.resourceId;

      if (!resourceId) {
        results[i] = {
          status: 'error',
          ...(item.client_id ? { client_id: item.client_id } : {}),
          error: {
            code: 'missing_required_field',
            message: 'resource_id is required',
          },
        };
        continue;
      }

      if (item.dataType != null && !VALID_DATA_TYPES.includes(item.dataType)) {
        results[i] = {
          status: 'error',
          ...(item.client_id ? { client_id: item.client_id } : {}),
          error: {
            code: 'invalid_field_value',
            message: 'Invalid dataType. Must be boolean, numeric, or categorical.',
          },
        };
        continue;
      }

      // Shape-only: stored exactly as submitted (Zod + dataType allowlist).
      const id = crypto.randomUUID();
      results[i] = {
        status: 'success',
        ...(item.client_id ? { client_id: item.client_id } : {}),
        id,
      };

      const envTriple = envTriples.get(resourceId) ?? EMPTY_ENV_TRIPLE;
      toInsert.push({
        index: i,
        row: {
          Id: id,
          TenantId: tenantId,
          AppId: appId,
          ResourceId: resourceId,
          Score: item.score,
          Label: item.label ?? '',
          Reason: item.reason || '',
          Name: item.name,
          Type: item.type || '',
          DataType: item.dataType ?? '',
          Source: item.source || 'api',
          // Denormalized env triple.
          Environment: envTriple.Environment,
          EnvironmentVersion: envTriple.EnvironmentVersion,
          CommitSha: envTriple.CommitSha,
          CreatedAt: now,
          UpdatedAt: now,
          IsDeleted: 0,
        },
      });
    }

    if (toInsert.length > 0) {
      const client = createClient({
        url: c.env.CLICKHOUSE_HOST,
        ...clickHouseWriteAuth(c.env),
      });

      try {
        await client.insert({
          table: 'scores',
          values: toInsert.map((t) => t.row),
          format: 'JSONEachRow',
        });
      } catch (error) {
        console.error(`[${c.req.method} ${c.req.path}]`, error);
        const mapped = mapClickHouseError(error);
        return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
      } finally {
        await client.close();
      }
    }

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.length - succeeded;
    const body = {
      data: {
        results,
        summary: { total: results.length, succeeded, failed },
      },
    };

    if (succeeded === 0) return c.json(body, 400);
    if (failed === 0) return c.json(body, 201);
    return c.json(body, 207);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/scores
// ---------------------------------------------------------------------------

export class ListScores extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Scoring'],
    summary: 'List scores',
    operationId: 'list-scores',
    description: 'Returns a paginated list of scores for the authenticated application. Supports filtering by resource, name, source, and date range.',
    request: {
      query: ScoresListParamsSchema,
    },
    responses: {
      200: {
        description: 'A paginated list of scores.',
        content: {
          'application/json': {
            schema: ScoresListResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const ctx = buildTenantContext(c);
    const query = data.query;

    try {
      const service = getService(c);
      // Resolve the API-key-bound environment to scope the scores list.
      const envScope = await resolveEnvScope(c);

      const result = await service.getScores(ctx, {
        limit: query.limit,
        offset: query.offset,
        startDate: query.start_date,
        endDate: query.end_date,
        resourceId: query.resource_id,
        resourceType: query.resource_type,
        name: query.name,
        source: query.source,
        sessionId: query.session_id,
        environment: envScope?.environment,
        environments: envScope?.environments,
      });

      return c.json(toScoresListPayload(result));
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

/**
 * Wire shape of a scores list/search response. Shared by GET /v1/scores and
 * POST /v1/scores/search so the two surfaces cannot diverge.
 */
function toScoresListPayload(result: Awaited<ReturnType<ReturnType<typeof getService>['getScores']>>) {
  return {
    data: result.scores.map((s) => ({
      id: s.id,
      resource_id: s.resourceId,
      name: s.name,
      score: s.score,
      label: s.label,
      reason: s.reason,
      source: s.source,
      user_id: s.userId,
      created_at: s.createdAt,
    })),
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /v1/scores/search
//
// Structured JSON filters over the scores table. Unlike traces/spans there
// is no string-DSL twin — GET /v1/scores only has fixed params — so this is
// the first expressive query surface for scores.
// Filterable fields: name, score, source, user_id, resource_id, label,
// created_at (see GET /v1/filter-schema). New-surface guardrails:
// rate-limited, 7-day default window, 90-day max window.
// ---------------------------------------------------------------------------

export class SearchScores extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Scoring'],
    summary: 'Search scores',
    operationId: 'search-scores',
    description:
      'Search scores with structured JSON filters. `filters` is an AND-list ' +
      'of predicates (`{field, operator, value}`) and one-level OR-groups ' +
      '(`{or: [...]}`) over the score fields: name, score, source, user_id, ' +
      'resource_id, label, created_at. Membership (`in`, `notIn`) and range ' +
      '(`between`) operators are supported; valid fields and operators are ' +
      'machine-readable at `GET /v1/filter-schema`. Defaults to the last ' +
      '7 days when `start_date` is unset; the maximum search window is 90 days.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: ScoresSearchBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'A paginated list of matching scores.',
        content: {
          'application/json': {
            schema: ScoresListResponseSchema,
          },
        },
      },
      400: errorResponse('Invalid filters or time window.'),
      401: errorResponse('Missing or invalid API key.'),
      429: errorResponse('Rate limited.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const ctx = buildTenantContext(c);
    const body = data.body;

    // Semantic validation + normalization against the scores field allowlist
    // (shape is already Zod-validated). 400 on any problem.
    const parsed = (() => {
      try {
        return {
          filters: validateSearchFilters(body.filters, 'scores'),
          window: resolveSearchWindow(body.start_date, body.end_date),
        };
      } catch (e) {
        if (e instanceof FilterParseError) return e;
        throw e;
      }
    })();
    if (parsed instanceof FilterParseError) {
      return c.json(structuredError('invalid_filter', parsed.message), 400);
    }
    const { filters, window } = parsed;

    try {
      const service = getService(c);
      const envScope = await resolveEnvScope(c);

      const result = await service.getScores(ctx, {
        limit: body.limit,
        offset: body.offset,
        startDate: window.startDate,
        endDate: window.endDate,
        filters,
        environment: envScope?.environment,
        environments: envScope?.environments,
      });

      return c.json(toScoresListPayload(result));
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/scores/:scoreId
// ---------------------------------------------------------------------------

export class GetScore extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Scoring'],
    summary: 'Get score',
    operationId: 'get-score',
    description: 'Retrieve a single score record by ID. Returns the full score object including its value, label, reason, and source.',
    request: {
      params: z.object({
        scoreId: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: 'The score record.',
        content: {
          'application/json': {
            schema: ScoreDetailResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Score not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const appId = String(user.appId);
    const tenantId = String(user.tenantId);

    const client = createClient({
      url: c.env.CLICKHOUSE_HOST,
      ...clickHouseWriteAuth(c.env),
    });

    try {
      // Resolve the API-key-bound env so a key bound to env=dev cannot read
      // a prod-stamped score by id. The list/aggregate/histogram score
      // routes already apply this filter; the by-id read was the gap.
      const envScope = await resolveEnvScope(c);
      const envFilter = envScope
        ? buildEnvironmentWhereClause('Environment', envScope)
        : { clause: '', params: {} };

      const queryParams: Record<string, unknown> = {
        scoreId: data.params.scoreId,
        appId,
        tenantId,
        ...envFilter.params,
      };
      // Defense-in-depth: every query against tenant tables MUST include TenantId.
      assertTenantScoped(queryParams);

      const result = await client.query({
        query: `
          SELECT
            Id as id,
            ResourceId as resource_id,
            Name as name,
            Score as score,
            Label as label,
            Reason as reason,
            Source as source,
            UserId as user_id,
            CreatedAt as created_at
          FROM scores
          WHERE TenantId = {tenantId:String} AND Id = {scoreId:String} AND AppId = {appId:String}
          ${envFilter.clause}
          LIMIT 1
        `,
        query_params: queryParams,
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        id: string;
        resource_id: string;
        name: string;
        score: number;
        label: string;
        reason: string;
        source: string;
        user_id: string;
        created_at: string;
      }>();

      if (rows.length === 0) {
        return c.json(structuredError('score_not_found', 'Score not found'), 404);
      }

      const row = rows[0]!;
      return c.json({
        data: {
          id: row.id,
          resource_id: row.resource_id,
          name: row.name,
          score: Number(row.score),
          label: row.label || '',
          reason: row.reason || '',
          source: row.source || 'eval',
          user_id: row.user_id || undefined,
          created_at: clickHouseToISO(row.created_at),
        },
      });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    } finally {
      await client.close();
    }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/scores/aggregations
// ---------------------------------------------------------------------------

export class GetScoreAggregations extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Scoring'],
    summary: 'Get score aggregations',
    operationId: 'get-score-aggregations',
    description: 'Returns aggregated statistics for scores grouped by name. Useful for understanding score distributions across your application.\n\n<Note>This endpoint is only available on cloud. The local dev server returns 501.</Note>',
    request: {
      query: ScoreAggregationsParamsSchema,
    },
    responses: {
      200: {
        description: 'Score aggregations grouped by name.',
        content: {
          'application/json': {
            schema: ScoreAggregationsResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const ctx = buildTenantContext(c);
    const query = data.query;

    try {
      const service = getService(c);
      // Resolve the API-key-bound environment to scope the aggregations.
      const envScope = await resolveEnvScope(c);
      const today = new Date().toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await service.getScoreAggregations(ctx, {
        start: query.start_date ?? sevenDaysAgo,
        end: query.end_date ?? today,
      }, envScope);

      return c.json({
        data: result.aggregations.map((a) => ({
          name: a.name,
          avg_score: a.avgScore,
          count: a.count,
          min_score: a.minScore,
          max_score: a.maxScore,
        })),
      });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/scores/names
// ---------------------------------------------------------------------------

export class GetScoreNames extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Scoring'],
    summary: 'Get score names',
    operationId: 'get-score-names',
    description: 'Returns a list of distinct score names used in your application. Useful for building filter dropdowns and discovering available score types.',
    responses: {
      200: {
        description: 'List of distinct score names.',
        content: {
          'application/json': {
            schema: ScoreNamesResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const ctx = buildTenantContext(c);

    try {
      const service = getService(c);
      // Resolve the API-key-bound environment to scope score names.
      const envScope = await resolveEnvScope(c);
      const result = await service.getDistinctScoreNames(ctx, envScope);
      return c.json({ data: result.names });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/scores/:scoreId
// ---------------------------------------------------------------------------

export class DeleteScore extends BaseRoute {
  static requiredPermission: GatewayPermission = 'score.delete';
  schema = {
    tags: ['Scoring'],
    summary: 'Delete score',
    operationId: 'delete-score',
    description: 'Delete a score record by ID.',
    request: {
      params: z.object({
        scoreId: z.string().uuid(),
      }),
    },
    responses: {
      204: { description: 'Score deleted.' },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Score not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const appId = String(user.appId);
    const tenantId = user.tenantId;

    const client = createClient({
      url: c.env.CLICKHOUSE_HOST,
      ...clickHouseWriteAuth(c.env),
    });

    try {
      assertTenantScoped({ tenantId, appId });

      // Fetch the existing score so we can insert a matching tombstone.
      // The tombstone must share the same ORDER BY key for ReplacingMergeTree
      // to collapse it during merges.
      const rows = await client.query({
        query: `SELECT Name, CreatedAt FROM scores FINAL WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND IsDeleted = 0 AND Id = {scoreId:String} LIMIT 1`,
        query_params: { tenantId, appId, scoreId: data.params.scoreId },
        format: 'JSONEachRow',
      });
      const existing = await rows.json<{ Name: string; CreatedAt: string }>();
      const score = existing[0];

      if (!score) {
        return c.json(structuredError('score_not_found', 'Score not found'), 404);
      }

      // Insert tombstone: same ORDER BY key, IsDeleted=1, newer UpdatedAt
      await client.insert({
        table: 'scores',
        values: [
          {
            Id: data.params.scoreId,
            TenantId: tenantId,
            AppId: appId,
            Name: score.Name,
            CreatedAt: score.CreatedAt,
            UpdatedAt: Date.now() / 1000,
            IsDeleted: 1,
            // Remaining fields don't matter — will be collapsed
            Score: 0,
            Label: '',
            Reason: '',
            ResourceId: '',
          },
        ],
        format: 'JSONEachRow',
      });

      return new Response(null, { status: 204 });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    } finally {
      await client.close();
    }
  }
}
