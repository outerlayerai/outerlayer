/**
 * Spans OpenAPI Routes
 *
 * Endpoints for listing and retrieving span data within traces.
 */

import {
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
  buildFilterWhereClause,
  buildEnvironmentWhereClause,
  formatISOForClickHouse,
  getDefaultTracesStartDate,
  getCurrentDateForClickHouse,
  clickHouseToISO,
} from '@repo/observability-service';
import type { AnalyticsFilterNode } from '@repo/observability-service';
import {
  SpansListParamsSchema,
  SpansListResponseSchema,
  SpansSearchBodySchema,
  TraceSpanResponseSchema,
  SpanIOSchema,
} from '@repo/api-schemas';
import { z, BaseRoute, type AppContext, mapStatusToName, mapStatusToCode, statusCodeEquivalents, structuredError, errorResponse, resolveEnvScope } from './_shared';
import { createClient } from '@clickhouse/client-web';
import { clickHouseWriteAuth } from '../../stores/clickhouse/write-identity';
import type { GatewayPermission } from '../../lib/permissions';
import { parseFilterExpression, FilterParseError } from '../../lib/trace-filter-dsl';
import { validateSearchFilters, resolveSearchWindow } from '../../lib/filter-validation';
import { stripReservedMetadata } from '../../lib/metadata';
import { RATE_LIMITS } from '../../rate-limits';
import { createBlobStorage } from '../../lib/blob-storage';
import { OFFLOAD_FIELDS } from '../../utils/blob-offload';

/**
 * Executes the span list/search SELECT + count pair against ClickHouse and
 * maps rows to the wire shape. Shared by GET /v1/spans and
 * POST /v1/spans/search so the two surfaces cannot diverge. `whereClause`
 * must be fully parameterized; `params` carries every binding it references.
 * Throws on query failure — callers translate via mapClickHouseError.
 */
async function runSpansListQuery(
  c: AppContext,
  opts: {
    whereClause: string;
    params: Record<string, unknown>;
    limit: number;
    offset: number;
  },
) {
  const client = createClient({
    url: c.env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(c.env),
  });

  try {
    const clickhouseSettings = { max_execution_time: 30 };

    const [listResult, countResult] = await Promise.all([
      client.query({
        query: `
          SELECT
            SpanId AS id,
            TraceId AS trace_id,
            ParentSpanId AS parent_id,
            SpanName AS name,
            StatusCode AS status_code,
            StatusMessage AS status_message,
            Duration AS duration,
            Timestamp AS timestamp,
            Type AS type,
            Model AS model,
            InputTokens AS input_tokens,
            OutputTokens AS output_tokens,
            TotalTokens AS tokens,
            Cost AS cost,
            SpanKind AS span_kind,
            ServiceName AS service_name,
            Metadata AS metadata
          FROM otel_traces FINAL
          ${opts.whereClause}
            AND IsDeleted = 0
          ORDER BY Timestamp DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        `,
        query_params: opts.params,
        format: 'JSONEachRow',
        clickhouse_settings: clickhouseSettings,
      }),
      client.query({
        query: `SELECT count(*) AS total FROM otel_traces FINAL ${opts.whereClause} AND IsDeleted = 0`,
        query_params: opts.params,
        format: 'JSONEachRow',
        clickhouse_settings: clickhouseSettings,
      }),
    ]);

    const rows = await listResult.json<Record<string, unknown>>();
    const countData = await countResult.json<{ total: string }>();
    const total = parseInt(countData[0]?.total || '0', 10);

    return {
      data: rows.map((row) => ({
        id: row.id as string,
        trace_id: row.trace_id as string,
        parent_id: (row.parent_id as string) || null,
        name: row.name as string,
        status: mapStatusToName(String(row.status_code ?? '0')),
        status_message: (row.status_message as string) || '',
        duration_ms: Number(row.duration) || 0,
        // ClickHouse serializes the DateTime64 `Timestamp` column as a
        // zoneless 'YYYY-MM-DD HH:mm:ss.SSS' string; the response schema
        // declares `timestamp` as z.string().datetime() (ISO-8601 UTC).
        // Normalize so the live body conforms to the spec — same drift
        // class as the /v1/traces start/end fix.
        timestamp: clickHouseToISO(String(row.timestamp)),
        type: (row.type as string) || '',
        model: (row.model as string) || null,
        input_tokens: Number(row.input_tokens) || 0,
        output_tokens: Number(row.output_tokens) || 0,
        tokens: Number(row.tokens) || 0,
        cost: Number(row.cost) || 0,
        span_kind: (row.span_kind as string) || '',
        service_name: (row.service_name as string) || '',
        metadata: stripReservedMetadata(row.metadata as Record<string, string>),
      })),
      pagination: { total, limit: opts.limit, offset: opts.offset },
    };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// GET /v1/spans
// ---------------------------------------------------------------------------

export class ListSpans extends BaseRoute {
  static requiredPermission: GatewayPermission = 'span.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Spans'],
    summary: 'List spans',
    operationId: 'list-spans',
    description: 'Query spans across all traces. Supports filtering by type, status, model, name, and duration range.',
    request: {
      query: SpansListParamsSchema,
    },
    responses: {
      200: {
        description: 'A list of spans.',
        content: {
          'application/json': {
            schema: SpansListResponseSchema,
          },
        },
      },
      400: errorResponse('Invalid query parameters.'),
      401: errorResponse('Missing or invalid API key.'),
      429: errorResponse('Rate limited.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const appId = String(user.appId);
    const tenantId = user.tenantId;
    const query = data.query;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    // Resolve the API-key-bound environment to scope the spans query.
    const envScope = await resolveEnvScope(c);
    const envFilter = envScope ? buildEnvironmentWhereClause('Environment', envScope) : { clause: '', params: {} };

    const conditions: string[] = ['TenantId = {tenantId:String}', 'AppId = {appId:String}'];
    const params: Record<string, unknown> = { tenantId, appId, limit, offset, ...envFilter.params };
    if (envFilter.clause) {
      conditions.push(envFilter.clause.replace(/^AND /, ''));
    }

    if (query.trace_id) {
      conditions.push('TraceId = {traceId:String}');
      params.traceId = query.trace_id;
    }
    if (query.type) {
      conditions.push('Type = {type:String}');
      params.type = query.type;
    }
    if (query.status) {
      const code = mapStatusToCode(query.status);
      if (code) {
        // Match canonical numeric codes AND legacy stored enum-name variants.
        conditions.push('StatusCode IN {statusCodes:Array(String)}');
        params.statusCodes = statusCodeEquivalents(code);
      }
    }
    if (query.name) {
      conditions.push('SpanName LIKE {name:String}');
      params.name = `%${query.name}%`;
    }
    if (query.model) {
      conditions.push('Model LIKE {model:String}');
      params.model = `%${query.model}%`;
    }
    if (query.min_duration != null) {
      conditions.push('Duration >= {minDuration:Float64}');
      params.minDuration = query.min_duration;
    }
    if (query.max_duration != null) {
      conditions.push('Duration <= {maxDuration:Float64}');
      params.maxDuration = query.max_duration;
    }

    // Time range. Two modes here:
    //
    //   (a) `trace_id` is set: the trace itself is the scope. We do NOT
    //       apply a default time window even if start/end are unspecified
    //       — the established contract is "all spans for this trace_id,
    //       regardless of age", and the wire contract on existing endpoints
    //       must not change. Explicit start/end
    //       are still honored when passed.
    //
    //   (b) No `trace_id` — apply the shared "recent traces" default window
    //       when start/end are unspecified, so an unbounded query doesn't
    //       scan the whole table.
    const hasExplicitStart = !!query.start_date;
    const hasExplicitEnd = !!query.end_date;
    const applyDefaultWindow = !query.trace_id;

    if (hasExplicitStart || applyDefaultWindow) {
      const startDate = hasExplicitStart
        ? formatISOForClickHouse(query.start_date)
        : getDefaultTracesStartDate();
      conditions.push('Timestamp >= {startDate:DateTime64}');
      params.startDate = startDate;
    }
    if (hasExplicitEnd || applyDefaultWindow) {
      const endDate = hasExplicitEnd
        ? formatISOForClickHouse(query.end_date)
        : getCurrentDateForClickHouse();
      conditions.push('Timestamp <= {endDate:DateTime64}');
      params.endDate = endDate;
    }

    // Trace-grain attribution filters. Every span in a trace carries the
    // same UserId / SessionId, so a span-grain WHERE matches the trace-side
    // semantics without needing the inner-subquery split.
    if (query.user_id) {
      conditions.push('UserId = {userId:String}');
      params.userId = query.user_id;
    }
    if (query.session_id) {
      conditions.push('SessionId = {sessionId:String}');
      params.sessionId = query.session_id;
    }

    // Advanced `filter` string DSL (see lib/trace-filter-dsl), mirroring the
    // trace-side `filter` param. Compiled to the internal AnalyticsFilterNode[]
    // AST (leaf predicates + one-level OR-groups), then to SQL by the shared
    // `buildFilterWhereClause` parser — which handles span-grain (model,
    // status, latency_ms, cost, ...), trace-grain (user_id, session_id,
    // trace_id), and dynamic predicates (metadata.<key>, score__<name>, tags).
    // Spans are span-grain (no trace rollup), so we use the combined `clause`
    // form rather than the trace-side inner/outer split.
    // A malformed filter is a 400 (never silently dropped).
    let advancedFilters: AnalyticsFilterNode[] | undefined;
    if (query.filter) {
      try {
        advancedFilters = parseFilterExpression(query.filter);
      } catch (e) {
        if (e instanceof FilterParseError) {
          return c.json(structuredError('invalid_filter', e.message), 400);
        }
        throw e;
      }
    }
    const filterClause = advancedFilters?.length
      ? buildFilterWhereClause(advancedFilters, appId, tenantId)
      : { clause: '', params: {} };
    Object.assign(params, filterClause.params);

    const whereClause = `WHERE ${conditions.join(' AND ')}${filterClause.clause ? ` ${filterClause.clause}` : ''}`;

    try {
      return c.json(await runSpansListQuery(c, { whereClause, params, limit, offset }));
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// POST /v1/spans/search
//
// Structured-JSON twin of GET /v1/spans' `filter` string DSL. Same
// allowlist, same compiler, same response shape via runSpansListQuery.
// New-surface guardrails: rate-limited, 7-day default window, 90-day max.
//
// Design debt (deliberate, matching ListSpans): spans have no service-layer
// method — both routes build ClickHouse SQL directly. If a spans service
// ever lands (e.g. for local-CLI parity or cross-cutting service hooks),
// migrate BOTH handlers through it in the same change; this search route
// must not be left behind on the raw-SQL path.
// ---------------------------------------------------------------------------

export class SearchSpans extends BaseRoute {
  static requiredPermission: GatewayPermission = 'span.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Spans'],
    summary: 'Search spans',
    operationId: 'search-spans',
    description:
      'Search spans with structured JSON filters — the programmatic form of ' +
      'the `filter` string DSL on `GET /v1/spans`. `filters` is an AND-list ' +
      'of predicates (`{field, operator, value}`) and one-level OR-groups ' +
      '(`{or: [...]}`). Adds membership operators `in`, `notIn`, and `between`. ' +
      'Valid fields and operators are machine-readable at ' +
      '`GET /v1/filter-schema`. Defaults to the last 7 days when `start_date` ' +
      'is unset; the maximum search window is 90 days.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: SpansSearchBodySchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'A paginated list of matching spans.',
        content: {
          'application/json': {
            schema: SpansListResponseSchema,
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
    const user = c.get('user');
    const appId = String(user.appId);
    const tenantId = user.tenantId;
    const body = data.body;

    // Semantic validation + normalization (shape is already Zod-validated).
    // Any field/operator/value/window problem is a 400 with the message.
    const parsed = (() => {
      try {
        return {
          filters: validateSearchFilters(body.filters, 'spans'),
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

    const envScope = await resolveEnvScope(c);
    const envFilter = envScope ? buildEnvironmentWhereClause('Environment', envScope) : { clause: '', params: {} };

    const conditions: string[] = ['TenantId = {tenantId:String}', 'AppId = {appId:String}'];
    const params: Record<string, unknown> = {
      tenantId,
      appId,
      limit: body.limit,
      offset: body.offset,
      ...envFilter.params,
    };
    if (envFilter.clause) {
      conditions.push(envFilter.clause.replace(/^AND /, ''));
    }

    conditions.push('Timestamp >= {startDate:DateTime64}');
    params.startDate = formatISOForClickHouse(window.startDate);
    conditions.push('Timestamp <= {endDate:DateTime64}');
    params.endDate = formatISOForClickHouse(window.endDate);

    // Spans are span-grain (no trace rollup) — combined clause, same as GET.
    const filterClause = filters?.length
      ? buildFilterWhereClause(filters, appId, tenantId)
      : { clause: '', params: {} };
    Object.assign(params, filterClause.params);

    const whereClause = `WHERE ${conditions.join(' AND ')}${filterClause.clause ? ` ${filterClause.clause}` : ''}`;

    try {
      return c.json(await runSpansListQuery(c, { whereClause, params, limit: body.limit, offset: body.offset }));
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/spans/:spanId
//
// Fetch a single span by its globally-unique span_id WITHOUT needing the
// trace_id. A span is a concrete entity (one otel_traces row), so a by-id
// resource is correct here — the thing you reach for when you hold only a
// span_id (a score reference, an alert, a copied link). Unlike sessions (a
// filter dimension), this is not the "sub-resource modeling mistake": the
// span isn't nested under a parent it doesn't belong to — it's addressed
// directly by its own id.
//
// Returns the FULL entity in one call: span metadata + its I/O payload
// (input/output/output_object/tool_calls). The I/O columns live on the same
// otel_traces row, so this is a single query — no second round trip.
// ---------------------------------------------------------------------------

const SpanByIdResponseSchema = z.object({
  // Full span = list-item metadata + the I/O payload. Reuses the canonical
  // SpanIOSchema so this stays in lockstep with the I/O-detail shape.
  data: TraceSpanResponseSchema.merge(SpanIOSchema),
});

export class GetSpan extends BaseRoute {
  static requiredPermission: GatewayPermission = 'span.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Spans'],
    summary: 'Get span',
    operationId: 'get-span',
    description:
      'Fetch a single span by its globally-unique span_id, without needing its trace_id. Returns the full span: metadata plus its input/output payload.',
    request: {
      params: z.object({
        spanId: z.string(),
      }),
    },
    responses: {
      200: {
        description: 'The full span (metadata + I/O payload).',
        content: {
          'application/json': {
            schema: SpanByIdResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Span not found.'),
      429: errorResponse('Rate limited.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const appId = String(user.appId);
    const tenantId = user.tenantId;
    const spanId = data.params.spanId;

    // Scope to the API-key-bound environment (defense-in-depth + correctness),
    // same as the list endpoints.
    const envScope = await resolveEnvScope(c);
    const envFilter = envScope
      ? buildEnvironmentWhereClause('Environment', envScope)
      : { clause: '', params: {} };

    const conditions = [
      'TenantId = {tenantId:String}',
      'AppId = {appId:String}',
      'SpanId = {spanId:String}',
    ];
    const params: Record<string, unknown> = { tenantId, appId, spanId, ...envFilter.params };
    if (envFilter.clause) {
      conditions.push(envFilter.clause.replace(/^AND /, ''));
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const client = createClient({
      url: c.env.CLICKHOUSE_HOST,
      ...clickHouseWriteAuth(c.env),
    });

    try {
      const result = await client.query({
        query: `
          SELECT
            SpanId AS id,
            TraceId AS trace_id,
            ParentSpanId AS parent_id,
            SpanName AS name,
            StatusCode AS status_code,
            StatusMessage AS status_message,
            Duration AS duration,
            Timestamp AS timestamp,
            Type AS type,
            Model AS model,
            InputTokens AS input_tokens,
            OutputTokens AS output_tokens,
            TotalTokens AS tokens,
            Cost AS cost,
            SpanKind AS span_kind,
            ServiceName AS service_name,
            Metadata AS metadata,
            Input AS input,
            Output AS output,
            OutputObject AS output_object,
            ToolCalls AS tool_calls
          FROM otel_traces FINAL
          ${whereClause}
            AND IsDeleted = 0
          ORDER BY Timestamp DESC
          LIMIT 1
        `,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 30 },
      });

      const rows = await result.json<Record<string, unknown>>();
      const row = rows[0];
      if (!row) {
        return c.json(structuredError('span_not_found', 'Span not found'), 404);
      }

      return c.json({
        data: {
          id: row.id as string,
          trace_id: row.trace_id as string,
          parent_id: (row.parent_id as string) || null,
          name: row.name as string,
          status: mapStatusToName(String(row.status_code ?? '0')),
          status_message: (row.status_message as string) || '',
          duration_ms: Number(row.duration) || 0,
          // Same DateTime64 → ISO normalization as the list endpoints.
          timestamp: clickHouseToISO(String(row.timestamp)),
          type: (row.type as string) || '',
          model: (row.model as string) || null,
          input_tokens: Number(row.input_tokens) || 0,
          output_tokens: Number(row.output_tokens) || 0,
          tokens: Number(row.tokens) || 0,
          cost: Number(row.cost) || 0,
          span_kind: (row.span_kind as string) || '',
          service_name: (row.service_name as string) || '',
          metadata: stripReservedMetadata(row.metadata as Record<string, string>),
          // I/O payload from the same row — empty string → null for the
          // optional object/tool-call columns, matching service.getSpanIO.
          input: (row.input as string) || '',
          output: (row.output as string) || '',
          output_object: (row.output_object as string) || null,
          tool_calls: (row.tool_calls as string) || null,
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

/**
 * GET /v1/blobs — fetch the full content of a span field payload that was
 * offloaded to object storage at ingest (referenced by BlobRefs[].blob_id).
 *
 * Tenant-scoped: the key is `{tenantId}/{appId}/{traceId}/{spanId}/{field}`, so
 * we require the path to start with the caller's tenantId before touching R2 —
 * a caller can never read another tenant's blobs. Streams from R2 (zero egress
 * on Workers) so the full payload never sits in ClickHouse or the queue.
 */
export class GetBlob extends BaseRoute {
  static requiredPermission: GatewayPermission = 'span.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Spans'],
    summary: 'Fetch an offloaded span field blob',
    operationId: 'get-blob',
    description:
      'Returns the full content of a span field payload (input/output/...) that was offloaded to object storage at ingest. Reference the object via a BlobRefs[].blob_id from a span. Tenant-scoped.',
    request: {
      query: z.object({ path: z.string().min(1) }),
    },
    responses: {
      200: {
        description: 'Full blob content.',
        content: {
          'application/json': {
            schema: z.object({ data: z.object({ content: z.string() }) }),
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Blob not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const user = c.get('user');
    const path = (data.query as { path: string }).path;

    // Structural parse, not a prefix test: a prefix test admits relative
    // segments after the tenant id, and the layers below resolve them rather
    // than reject them (see `assertSafeBlobKey`). The key shape is fixed by
    // `blobKey()`:
    //   {TenantId}/{AppId}/{TraceId}/{SpanId}/{field}
    // so require exactly that — five segments, segment 0 equal to the verified
    // tenant, and the field from the same allowlist the writer uses.
    // `assertSafeBlobKey` in the storage layer is the backstop for every other
    // caller.
    const segments = path.split('/');
    const fieldOk = (OFFLOAD_FIELDS as readonly string[]).includes(segments[4] ?? '');
    if (segments.length !== 5 || segments[0] !== String(user.tenantId) || !fieldOk) {
      return c.json(structuredError('blob_not_found', 'Blob not found'), 404);
    }

    const bytes = await createBlobStorage(c.env).get(path);
    if (!bytes) {
      return c.json(structuredError('blob_not_found', 'Blob not found'), 404);
    }
    return c.json({ data: { content: new TextDecoder().decode(bytes) } });
  }
}
