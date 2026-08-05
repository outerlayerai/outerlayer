/**
 * SQL Query Strings
 * Feature: 007-analytics-architecture-evaluation
 *
 * Parameterized SQL queries for the analytics service.
 * All queries use ClickHouse's {param:Type} syntax for safe parameter binding.
 *
 * Query naming convention:
 * - QUERY suffix for read queries
 * - Uses MVs where possible for performance
 * - Direct queries only when MVs can't provide the data (e.g., percentiles)
 */

// otel_traces.StatusCode is canonically the OTLP numeric string '0'/'1'/'2'
// (the gateway converter normalizes at write time — see
// normalizeOtlpStatusCode in apps/gateway/src/services/span-converter.ts).
// LEGACY rows written before that normalization may still carry the raw
// OTLP enum-name variants ('STATUS_CODE_ERROR', 'Error', 'STATUS_CODE_OK',
// 'OK', 'UNSET', ...). Old rows keep their old values (ReplacingMergeTree
// rows are immutable in practice), so every read-side status predicate must
// accept BOTH the canonical numeric form and the legacy variants until the
// legacy rows age out via the 90-day TTL.

/**
 * SQL set literal of every stored value that means "error".
 * Use as `StatusCode IN ${STATUS_ERROR_VALUES_SQL}` (errors) or
 * `StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}` (successes).
 * Mirrored by the materialized views / projections in
 * apps/tenant-dashboard/clickhouse/migrations/21_*.sql — keep in sync.
 */
export const STATUS_ERROR_VALUES_SQL = `('2', 'STATUS_CODE_ERROR', 'ERROR', 'Error')`;

// Normalize at the read boundary so every API consumer sees a canonical
// 'OK' / 'ERROR' / 'UNKNOWN' value and per-span and trace-level status agree.
const STATUS_NORMALIZED_SQL = `multiIf(
  StatusCode IN ${STATUS_ERROR_VALUES_SQL}, 'ERROR',
  StatusCode IN ('0', '1', 'STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'OK', 'Ok', 'UNSET', 'Unset'), 'OK',
  'UNKNOWN'
)`;

// ============================================================================
// Metrics Queries (query otel_traces directly; projections optimize automatically)
// ============================================================================

/**
 * Aggregate metrics for dashboard summary.
 * Queries otel_traces directly — ClickHouse projections (proj_hourly)
 * optimize the query automatically.
 */
export const METRICS_SUMMARY_QUERY = `
SELECT
  count() as total_requests,
  countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens,
  sum(InputTokens) as input_tokens,
  sum(OutputTokens) as output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  uniq(UserId) as unique_users
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND toDate(Timestamp) >= {retentionCutoffDate:Date}
`;

/**
 * Time series metrics for dashboard charts.
 * Returns hourly buckets from otel_traces — ClickHouse projections
 * (proj_hourly) optimize the query automatically.
 */
export const METRICS_TIME_SERIES_QUERY = `
SELECT
  toDate(Timestamp) as date,
  toHour(Timestamp) as hour,
  count() as request_count,
  countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens,
  sum(InputTokens) as total_input_tokens,
  sum(OutputTokens) as total_output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  uniq(UserId) as unique_users
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND toDate(Timestamp) >= {retentionCutoffDate:Date}
GROUP BY date, hour
ORDER BY date ASC, hour ASC
`;

// ============================================================================
// Traces Queries (direct queries - need individual trace data)
// ============================================================================

/**
 * Paginated trace listing.
 * Groups by TraceId to get trace-level aggregates.
 *
 * Note: Uses max(Duration) for latency since Duration is the measured span time.
 * Duration is stored in milliseconds.
 */
export const TRACES_LIST_QUERY = `
SELECT
  TraceId as id,
  if(
    length(argMax(TraceName, if(ParentSpanId = '', 1, 0))) > 0,
    argMax(TraceName, if(ParentSpanId = '', 1, 0)),
    if(
      countIf(ParentSpanId = '') > 0,
      argMax(SpanName, if(ParentSpanId = '', 1, 0)),
      argMin(SpanName, Timestamp)
    )
  ) as name,
  min(Timestamp) as start,
  max(Timestamp) + INTERVAL max(Duration) MILLISECOND as end,
  if(countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) > 0, '2', '1') as status,
  sumIf(Cost, Type = 'GENERATION') as cost,
  sumIf(TotalTokens, Type = 'GENERATION') as tokens,
  max(Duration) as latency_ms,
  count(*) as span_count,
  arrayDistinct(groupArrayArray(Tags)) as tags
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
GROUP BY TraceId
ORDER BY start DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

/**
 * Count total traces for pagination.
 */
export const TRACES_COUNT_QUERY = `
SELECT count(DISTINCT TraceId) as total
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
`;

/**
 * Single trace detail with all spans.
 */
export const TRACE_DETAIL_QUERY = `
SELECT
  SpanId as id,
  TraceId as trace_id,
  ParentSpanId as parent_id,
  SpanName as name,
  TraceName as trace_name,
  ${STATUS_NORMALIZED_SQL} as status,
  Duration as duration_ms,
  Timestamp as timestamp,
  Type as type,
  Model as model,
  InputTokens as input_tokens,
  OutputTokens as output_tokens,
  TotalTokens as tokens,
  Cost as cost,
  Input as input,
  Output as output,
  OutputObject as output_object,
  ToolCalls as tool_calls,
  BlobRefs as blob_refs,
  FinishReason as finish_reason,
  Settings as settings,
  ReasoningTokens as reasoning_tokens,
  Metadata as metadata,
  Props as props,
  SpanKind as span_kind,
  ServiceName as service_name,
  StatusMessage as status_message,
  UserId as user_id,
  SessionId as session_id
FROM otel_traces FINAL
WHERE TraceId = {traceId:String}
  AND AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
ORDER BY Timestamp ASC
`;

/**
 * Lightweight trace detail — excludes large payload columns (Input, Output, etc.)
 * so the initial trace load is fast. Payload data is fetched per-span on demand
 * via SPAN_IO_QUERY.
 */
export const TRACE_DETAIL_LIGHTWEIGHT_QUERY = `
SELECT
  SpanId as id,
  TraceId as trace_id,
  ParentSpanId as parent_id,
  SpanName as name,
  TraceName as trace_name,
  ${STATUS_NORMALIZED_SQL} as status,
  Duration as duration_ms,
  Timestamp as timestamp,
  Type as type,
  Model as model,
  InputTokens as input_tokens,
  OutputTokens as output_tokens,
  TotalTokens as tokens,
  Cost as cost,
  '' as input,
  '' as output,
  '' as output_object,
  '' as tool_calls,
  FinishReason as finish_reason,
  Settings as settings,
  ReasoningTokens as reasoning_tokens,
  Metadata as metadata,
  Props as props,
  SpanKind as span_kind,
  ServiceName as service_name,
  StatusMessage as status_message,
  UserId as user_id,
  SessionId as session_id
FROM otel_traces FINAL
WHERE TraceId = {traceId:String}
  AND AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
ORDER BY Timestamp ASC
`;

/**
 * Fetch full I/O payload for a single span.
 * Used for lazy-loading span content on selection.
 */
export const SPAN_IO_QUERY = `
SELECT
  Input as input,
  Output as output,
  OutputObject as output_object,
  ToolCalls as tool_calls,
  BlobRefs as blob_refs,
  Metadata as metadata
FROM otel_traces FINAL
WHERE SpanId = {spanId:String}
  AND TraceId = {traceId:String}
  AND AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
LIMIT 1
`;

/**
 * Max characters of Input/Output read for a trace-list preview. Truncation
 * happens server-side (`substringUTF8`) so the disk→memory copy and the wire
 * payload stay bounded no matter how large the stored payload is. ~160 chars
 * comfortably fills the muted secondary line under a trace name; the UI clamps
 * to a single line with an ellipsis.
 *
 * Re-exported from shared-utils (the canonical definition) so the cloud
 * `substringUTF8` cut and the local CLI server's `substr` cut can never drift.
 */
export { TRACE_IO_PREVIEW_MAX_CHARS } from '@repo/shared-utils/trace-io';

/**
 * Bounded I/O-preview lookup for the trace LIST.
 *
 * The list query deliberately omits the heavy Input/Output columns — reading
 * them across its full `GROUP BY TraceId` scan is exactly the hot-path cost the
 * LIGHTWEIGHT / SPAN_IO split exists to avoid. Instead, once the list returns a
 * page of trace IDs, this query reads TRUNCATED I/O for ONLY those traces,
 * bounded to the page's `[windowStart, windowEnd]` timestamp window so
 * ClickHouse touches only the relevant granules rather than the whole range.
 *
 * Only root spans (`ParentSpanId = ''`) and GENERATION spans are read — the two
 * span classes `deriveTraceIO()` consults — so the row count stays a small
 * multiple of the page size, not every span of every page trace. The service
 * groups the rows by trace and runs the canonical `deriveTraceIO()` to produce
 * one input/output preview per trace (root span wins, GENERATION is fallback).
 *
 * `{envClause}` is spliced by the caller (defense-in-depth: the same OTel
 * TraceId can exist across envs when the CLI replays it). `{ioPreviewChars}`
 * binds `TRACE_IO_PREVIEW_MAX_CHARS`.
 */
export function buildTraceIOPreviewQuery(envClause: string): string {
  return `
SELECT
  TraceId as trace_id,
  ParentSpanId as parent_id,
  Type as type,
  Timestamp as timestamp,
  substringUTF8(Input, 1, {ioPreviewChars:UInt32}) as input,
  substringUTF8(Output, 1, {ioPreviewChars:UInt32}) as output
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  AND Timestamp >= {windowStart:DateTime64}
  AND Timestamp <= {windowEnd:DateTime64}
  AND TraceId IN {traceIds:Array(String)}
  AND (ParentSpanId = '' OR Type = 'GENERATION')
  ${envClause}
`;
}

/**
 * TraceId → time-range lookup against the small `otel_traces_trace_id_ts`
 * materialized-view target table (canonical OTel ClickHouse exporter
 * pattern). The main `otel_traces` table is ordered by
 * (TenantId, AppId, toUnixTimestamp(Timestamp), TraceId, SpanId), so a
 * by-TraceId detail query without a Timestamp bound must scan the tenant's
 * full retention window (bloom-filter assisted, but still every granule the
 * filter can't exclude). This lookup resolves the trace's [min, max]
 * Timestamp in one cheap read of a table keyed by (TenantId, AppId, TraceId);
 * the caller then narrows the detail query with `Timestamp BETWEEN` so it
 * touches only the relevant granules/partitions.
 *
 * `min(Start)` / `max(End)` collapse any unmerged AggregatingMergeTree parts.
 * Empty result (trace unknown to the lookup, e.g. rows that predate the MV
 * backfill) → callers MUST fall back to the unbounded query, never narrow
 * to a guessed range.
 */
export const TRACE_ID_TIME_RANGE_QUERY = `
SELECT
  min(Start) as start,
  max(End) as end
FROM otel_traces_trace_id_ts
WHERE TraceId = {traceId:String}
  AND AppId = {appId:String}
  AND TenantId = {tenantId:String}
GROUP BY TraceId
`;

// ============================================================================
// Percentiles Queries (direct queries - can't pre-aggregate accurately)
// ============================================================================

/**
 * Latency percentiles by hour.
 * Must query raw data - percentiles can't be pre-aggregated.
 */
export const PERCENTILES_LATENCY_QUERY = `
SELECT
  toStartOfHour(Timestamp) as timestamp,
  quantile(0.75)(Duration) as p75,
  quantile(0.90)(Duration) as p90,
  quantile(0.95)(Duration) as p95,
  quantile(0.99)(Duration) as p99
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
GROUP BY timestamp
ORDER BY timestamp ASC
`;

/**
 * Token percentiles by hour.
 * Supports inputTokens, outputTokens, or totalTokens.
 */
export const PERCENTILES_TOKENS_QUERY = `
SELECT
  toStartOfHour(Timestamp) as timestamp,
  quantile(0.75)({tokenColumn:Identifier}) as p75,
  quantile(0.90)({tokenColumn:Identifier}) as p90,
  quantile(0.95)({tokenColumn:Identifier}) as p95,
  quantile(0.99)({tokenColumn:Identifier}) as p99
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
GROUP BY timestamp
ORDER BY timestamp ASC
`;

// ============================================================================
// Extended Metrics Query
// ============================================================================

/**
 * Count unique models for extended metrics.
 */
export const MODEL_COUNT_QUERY = `
SELECT count(DISTINCT Model) as model_count
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
`;


// ============================================================================
// Dataset Analytics Queries
// ============================================================================

export const SCORES_LIST_QUERY = `
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
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
ORDER BY CreatedAt DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

/**
 * Count total scores for pagination.
 */
export const SCORES_COUNT_QUERY = `
SELECT count(*) as total
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
`;

/**
 * Subclause that restricts scores.ResourceId to spans/traces belonging to a
 * specific SessionId. Scores are linked to either a TraceId or a SpanId via
 * the ResourceId column, so we look up both via otel_traces and union them.
 */
const SCORES_SESSION_FILTER_CLAUSE = `
  AND ResourceId IN (
    SELECT TraceId FROM otel_traces
    WHERE AppId = {appId:String} AND TenantId = {tenantId:String}
      AND SessionId = {sessionId:String}
    UNION DISTINCT
    SELECT SpanId FROM otel_traces
    WHERE AppId = {appId:String} AND TenantId = {tenantId:String}
      AND SessionId = {sessionId:String}
  )
`;

/**
 * Builds a SCORES_LIST_QUERY variant with an optional SessionId filter and
 * optional env-scoping clause.
 *
 * - `sessionId` restricts results to scores whose ResourceId matches a
 *   TraceId or SpanId in otel_traces with the given SessionId.
 * - `envClause` is a pre-built `AND Environment ...` fragment
 *   from {@link buildEnvironmentWhereClause}; its named params are merged
 *   into `query_params` by the caller. Empty string = no env filter.
 */
export function buildScoresListQuery(opts: {
  sessionId?: string;
  envClause?: string;
  /** Compiled structured-filter clause (starts with ' AND ') — see buildScoresFilterWhereClause. */
  filterClause?: string;
}): string {
  const envClause = opts.envClause ?? '';
  const filterClause = opts.filterClause ?? '';
  if (!opts.sessionId && !envClause && !filterClause) return SCORES_LIST_QUERY;
  return `
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
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  ${opts.sessionId ? SCORES_SESSION_FILTER_CLAUSE : ''}
  ${envClause}
  ${filterClause}
ORDER BY CreatedAt DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;
}

/**
 * Builds a SCORES_COUNT_QUERY variant with an optional SessionId filter and
 * optional env-scoping clause. See {@link buildScoresListQuery}.
 */
export function buildScoresCountQuery(opts: {
  sessionId?: string;
  envClause?: string;
  /** Compiled structured-filter clause (starts with ' AND ') — see buildScoresFilterWhereClause. */
  filterClause?: string;
}): string {
  const envClause = opts.envClause ?? '';
  const filterClause = opts.filterClause ?? '';
  if (!opts.sessionId && !envClause && !filterClause) return SCORES_COUNT_QUERY;
  return `
SELECT count(*) as total
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  ${opts.sessionId ? SCORES_SESSION_FILTER_CLAUSE : ''}
  ${envClause}
  ${filterClause}
`;
}

/**
 * Scores for a specific resource (trace or span).
 */
export const SCORES_BY_RESOURCE_QUERY = `
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
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND ResourceId = {resourceId:String}
ORDER BY CreatedAt DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

/**
 * Scores for multiple resources (batch fetch by span IDs).
 * Used to attach eval scores to all spans in a trace in a single query.
 * Avoids ClickHouse JOIN — runs in parallel with trace spans query.
 */
export const SCORES_BY_RESOURCE_IDS_QUERY = `
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
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND ResourceId IN ({resourceIds:Array(String)})
ORDER BY CreatedAt DESC
`;

/**
 * Score aggregations by name.
 * Returns avg, min, max, and count for each score name.
 *
 * @deprecated Prefer `buildScoreAggregationsQuery` for env-scoped queries.
 * This constant is kept for the numeric-bounds sub-query
 * inside `getScoreHistogram`, which does not require env filtering.
 */
export const SCORES_AGGREGATIONS_QUERY = `
SELECT
  Name as name,
  avg(Score) as avg_score,
  count(*) as count,
  min(Score) as min_score,
  max(Score) as max_score
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
GROUP BY Name
ORDER BY count DESC
`;

/**
 * Input for the env-aware aggregations query builder.
 */
export interface ScoreAggregationsInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  retentionCutoff: string;
  envClause?: string;
}

/**
 * Builds the score aggregations query with an optional env WHERE clause.
 *
 * When `envClause` is empty/absent the result is identical to
 * `SCORES_AGGREGATIONS_QUERY` so the function is safe to call for both
 * scoped and unscoped callers without behavioural change.
 */
export function buildScoreAggregationsQuery(
  input: ScoreAggregationsInput,
): FilteredQueryResult {
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  Name as name,
  avg(Score) as avg_score,
  count(*) as count,
  min(Score) as min_score,
  max(Score) as max_score,
  any(DataType) as data_type
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  ${envClause}
GROUP BY Name
ORDER BY count DESC`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Distinct score names for a given app.
 * Used to populate the score filter dropdown in the dashboard UI.
 */
export const DISTINCT_SCORE_NAMES_QUERY = `
SELECT DISTINCT Name as name
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
ORDER BY name ASC
LIMIT 200
`;

// ============================================================================
// Score Analytics Queries
// ============================================================================

/**
 * Input for score analytics queries with optional source and env filters.
 */
export interface ScoreAnalyticsInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  retentionCutoff: string;
  name: string;
  source?: string;
  /** SQL WHERE fragment from `buildEnvironmentWhereClause`. */
  envClause?: string;
}

/**
 * Builds histogram query for numeric scores.
 * Returns count per equal-width bucket (10 bins between min and max).
 */
export function buildScoreHistogramQuery(
  input: ScoreAnalyticsInput & { minScore: number; maxScore: number; bucketWidth: number },
): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  floor((Score - {minScore:Float64}) / {bucketWidth:Float64}) AS bucketIndex,
  {minScore:Float64} + floor((Score - {minScore:Float64}) / {bucketWidth:Float64}) * {bucketWidth:Float64} AS bucket,
  count(*) AS count
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Name = {name:String}
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  AND Score >= {minScore:Float64}
  AND Score <= {maxScore:Float64}
  ${sourceClause}
  ${envClause}
GROUP BY bucketIndex, bucket
ORDER BY bucket ASC
LIMIT 100000`,
    params: {
      appId: input.appId, tenantId: input.tenantId, name: input.name, startDate: input.startDate, endDate: input.endDate,
      retentionCutoff: input.retentionCutoff, minScore: input.minScore, maxScore: input.maxScore,
      bucketWidth: input.bucketWidth, ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Builds category counts query for categorical/boolean scores.
 */
export function buildScoreCategoryCountsQuery(input: ScoreAnalyticsInput): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  Label AS label,
  count(*) AS count
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Name = {name:String}
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  AND Label != ''
  ${sourceClause}
  ${envClause}
GROUP BY Label
ORDER BY count DESC
LIMIT 1000`,
    params: {
      appId: input.appId, tenantId: input.tenantId, name: input.name, startDate: input.startDate, endDate: input.endDate,
      retentionCutoff: input.retentionCutoff, ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Builds score trend query with the specified time grouping function.
 *
 * SAFETY: groupExpr is interpolated directly into the SQL string (not parameterized).
 * This is safe because the value comes from a hardcoded map in service.ts (groupExprMap).
 * ClickHouse does not support parameterized function names. Do NOT pass user input.
 */
export function buildScoreTrendQuery(
  input: ScoreAnalyticsInput,
  groupExpr: string,
): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  ${groupExpr} AS timestamp,
  avg(Score) AS avgScore,
  count(*) AS count
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Name = {name:String}
  AND CreatedAt >= {startDate:DateTime64}
  AND CreatedAt <= {endDate:DateTime64}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  ${sourceClause}
  ${envClause}
GROUP BY timestamp
ORDER BY timestamp ASC
LIMIT 100000`,
    params: {
      appId: input.appId, tenantId: input.tenantId, name: input.name, startDate: input.startDate, endDate: input.endDate,
      retentionCutoff: input.retentionCutoff, ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Input for score comparison queries.
 */
export interface ScoreComparisonInput {
  appId: string;
  tenantId: string;
  nameA: string;
  nameB: string;
  startDate: string;
  endDate: string;
  /** 'YYYY-MM-DD HH:mm:ss.SSS' for filtering scores.CreatedAt (DateTime64) */
  retentionCutoff: string;
  /** 'YYYY-MM-DD' for filtering otel_traces.Timestamp via toDate() (Date) */
  retentionCutoffDate: string;
  source?: string;
  /** SQL WHERE fragment from `buildEnvironmentWhereClause`. */
  envClause?: string;
}

/**
 * Score ResourceIds split by keying convention:
 *   - annotations typically write ResourceId = SpanId
 *   - CLI evals (postExperimentScores) write ResourceId = TraceId
 * Comparing two scores across these conventions requires normalizing both to
 * the same key before joining. We pick TraceId as the canonical key because
 * every span belongs to exactly one trace (many-to-one). A LEFT JOIN resolves
 * SpanId -> TraceId via otel_traces; rows whose ResourceId is already a TraceId
 * fall through via if(t.TraceId = '', s.ResourceId, t.TraceId).
 */
const SPAN_TO_TRACE_LOOKUP = `LEFT JOIN (
    SELECT DISTINCT SpanId, TraceId FROM otel_traces
    WHERE AppId = {appId:String} AND TenantId = {tenantId:String}
      AND toDate(Timestamp) >= {retentionCutoffDate:Date}
  ) AS t ON t.SpanId = s.ResourceId`;

/**
 * Builds cross-score comparison query for confusion matrix.
 * Uses subqueries with argMax to deduplicate: picks one score per trace per name,
 * preventing cross-product inflation when multiple scores exist for the same trace.
 * ResourceId normalization happens via SPAN_TO_TRACE_LOOKUP — see its docstring.
 */
export function buildScoreComparisonQuery(input: ScoreComparisonInput): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  a.resolved_label AS labelA,
  b.resolved_label AS labelB,
  count(*) AS count
FROM (
  SELECT if(t.TraceId = '', s.ResourceId, t.TraceId) AS trace_key, argMax(s.Label, s.CreatedAt) AS resolved_label
  FROM scores FINAL AS s
  ${SPAN_TO_TRACE_LOOKUP}
  WHERE s.AppId = {appId:String} AND s.TenantId = {tenantId:String} AND s.IsDeleted = 0 AND s.Name = {nameA:String}
    AND s.CreatedAt >= {startDate:DateTime64} AND s.CreatedAt <= {endDate:DateTime64}
    AND s.CreatedAt >= {retentionCutoff:DateTime64(3)} AND s.Label != ''
    ${sourceClause}
    ${envClause}
  GROUP BY trace_key
) AS a
INNER JOIN (
  SELECT if(t.TraceId = '', s.ResourceId, t.TraceId) AS trace_key, argMax(s.Label, s.CreatedAt) AS resolved_label
  FROM scores FINAL AS s
  ${SPAN_TO_TRACE_LOOKUP}
  WHERE s.AppId = {appId:String} AND s.TenantId = {tenantId:String} AND s.IsDeleted = 0 AND s.Name = {nameB:String}
    AND s.CreatedAt >= {startDate:DateTime64} AND s.CreatedAt <= {endDate:DateTime64}
    AND s.CreatedAt >= {retentionCutoff:DateTime64(3)} AND s.Label != ''
    ${sourceClause}
    ${envClause}
  GROUP BY trace_key
) AS b ON a.trace_key = b.trace_key
GROUP BY labelA, labelB
ORDER BY labelA, labelB
LIMIT 10000`,
    params: {
      appId: input.appId, tenantId: input.tenantId, nameA: input.nameA, nameB: input.nameB,
      startDate: input.startDate, endDate: input.endDate, retentionCutoff: input.retentionCutoff,
      retentionCutoffDate: input.retentionCutoffDate,
      ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Builds matched count query for score comparison.
 * Returns total traces with both scores, and total for each score individually.
 * totalA/totalB count distinct normalized keys so totalMatched never exceeds them.
 */
export function buildScoreMatchedCountQuery(input: ScoreComparisonInput): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  const singleNameCte = (nameParam: 'nameA' | 'nameB') => `
  SELECT if(t.TraceId = '', s.ResourceId, t.TraceId) AS trace_key
  FROM scores FINAL AS s
  ${SPAN_TO_TRACE_LOOKUP}
  WHERE s.AppId = {appId:String} AND s.TenantId = {tenantId:String} AND s.IsDeleted = 0 AND s.Name = {${nameParam}:String}
    AND s.CreatedAt >= {startDate:DateTime64} AND s.CreatedAt <= {endDate:DateTime64}
    AND s.CreatedAt >= {retentionCutoff:DateTime64(3)}
    ${sourceClause}
    ${envClause}
  GROUP BY trace_key`;

  return {
    query: `SELECT
  countDistinct(a.trace_key) AS totalMatched,
  (SELECT countDistinct(trace_key) FROM (${singleNameCte('nameA')})) AS totalA,
  (SELECT countDistinct(trace_key) FROM (${singleNameCte('nameB')})) AS totalB
FROM (${singleNameCte('nameA')}) AS a
INNER JOIN (${singleNameCte('nameB')}) AS b ON a.trace_key = b.trace_key`,
    params: {
      appId: input.appId, tenantId: input.tenantId, nameA: input.nameA, nameB: input.nameB,
      startDate: input.startDate, endDate: input.endDate, retentionCutoff: input.retentionCutoff,
      retentionCutoffDate: input.retentionCutoffDate,
      ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Builds numeric scatter plot query for two scores.
 * Returns paired score values for traces that have both scores.
 * Capped at 10,000 pairs to prevent browser overload.
 */
export function buildScoreScatterQuery(input: ScoreComparisonInput): FilteredQueryResult {
  const sourceClause = input.source ? 'AND Source = {source:String}' : '';
  const envClause = input.envClause ?? '';
  return {
    query: `SELECT
  a.Score AS scoreA,
  b.Score AS scoreB
FROM (
  SELECT if(t.TraceId = '', s.ResourceId, t.TraceId) AS trace_key, argMax(s.Score, s.CreatedAt) AS Score
  FROM scores FINAL AS s
  ${SPAN_TO_TRACE_LOOKUP}
  WHERE s.AppId = {appId:String} AND s.TenantId = {tenantId:String} AND s.IsDeleted = 0 AND s.Name = {nameA:String}
    AND s.CreatedAt >= {startDate:DateTime64} AND s.CreatedAt <= {endDate:DateTime64}
    AND s.CreatedAt >= {retentionCutoff:DateTime64(3)}
    ${sourceClause}
    ${envClause}
  GROUP BY trace_key
) AS a
INNER JOIN (
  SELECT if(t.TraceId = '', s.ResourceId, t.TraceId) AS trace_key, argMax(s.Score, s.CreatedAt) AS Score
  FROM scores FINAL AS s
  ${SPAN_TO_TRACE_LOOKUP}
  WHERE s.AppId = {appId:String} AND s.TenantId = {tenantId:String} AND s.IsDeleted = 0 AND s.Name = {nameB:String}
    AND s.CreatedAt >= {startDate:DateTime64} AND s.CreatedAt <= {endDate:DateTime64}
    AND s.CreatedAt >= {retentionCutoff:DateTime64(3)}
    ${sourceClause}
    ${envClause}
  GROUP BY trace_key
) AS b ON a.trace_key = b.trace_key
LIMIT 10000`,
    params: {
      appId: input.appId, tenantId: input.tenantId, nameA: input.nameA, nameB: input.nameB,
      startDate: input.startDate, endDate: input.endDate, retentionCutoff: input.retentionCutoff,
      retentionCutoffDate: input.retentionCutoffDate,
      ...(input.source ? { source: input.source } : {}),
    },
  };
}

/**
 * Detect score type by examining labels.
 * Returns distinct non-empty labels for a score name.
 */
export const SCORE_LABELS_QUERY = `
SELECT DISTINCT Label AS label
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Name = {name:String}
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  AND Label != ''
LIMIT 100
`;

/**
 * Distinct metadata keys across all traces for a given app.
 * Used to populate the metadata key dropdown in the filter UI.
 */
export const DISTINCT_METADATA_KEYS_QUERY = `
SELECT DISTINCT arrayJoin(mapKeys(Metadata)) AS key
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
ORDER BY key ASC
LIMIT 200
`;

export const HEALTH_CHECK_QUERY = 'SELECT 1';

// ============================================================================
// Requests Queries
// ============================================================================

/**
 * Paginated requests listing.
 * Returns GENERATION type traces with input/output.
 */
export const REQUESTS_LIST_QUERY = `
SELECT
  SpanId as id,
  TenantId as tenant_id,
  AppId as app_id,
  Cost as cost,
  InputTokens as prompt_tokens,
  OutputTokens as completion_tokens,
  Duration as latency_ms,
  Model as model_used,
  ${STATUS_NORMALIZED_SQL} as status,
  Input as input,
  if(Output != '', Output, OutputObject) as output,
  Timestamp as ts,
  UserId as user_id,
  TraceId as trace_id,
  StatusMessage as status_message,
  Props as props
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

/**
 * Count total requests for pagination.
 */
export const REQUESTS_COUNT_QUERY = `
SELECT count(*) as total
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
`;

// ============================================================================
// User Analytics Queries
// ============================================================================

/**
 * Paginated user analytics listing.
 * Groups by UserId to get per-user aggregates.
 */
export const USERS_ANALYTICS_LIST_QUERY = `
SELECT
  UserId as user_id,
  count(*) as request_count,
  sum(Cost) as total_cost,
  if(count(*) > 0, sum(TotalTokens) / count(*), 0) as avg_total_tokens_per_request,
  sum(OutputTokens) as total_completion_tokens,
  sum(InputTokens) as total_prompt_tokens,
  count(*) / greatest(dateDiff('day', min(toDate(Timestamp)), max(toDate(Timestamp))) + 1, 1) as avg_requests_per_day
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND UserId != ''
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
GROUP BY UserId
ORDER BY request_count DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

/**
 * Count total unique users for pagination.
 */
export const USERS_ANALYTICS_COUNT_QUERY = `
SELECT count(DISTINCT UserId) as total
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND UserId != ''
  AND Timestamp >= {startDate:DateTime64}
  AND Timestamp <= {endDate:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
`;

// ============================================================================
// Filtered Query Builders (Parameterized)
// ============================================================================
// These functions build queries with parameterized placeholders to prevent
// SQL injection. They return both the query template and base parameter values.
// Filter parameters from buildFilterWhereClause should be merged with these.

/**
 * Result of building a filtered query.
 */
export interface FilteredQueryResult {
  /** SQL query with ClickHouse parameter placeholders */
  query: string;
  /** Base parameter values (appId, dates, limit) - merge with filter params */
  params: Record<string, string | number>;
}

/**
 * Input for filtered metrics queries.
 */
export interface FilteredMetricsInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  /** Filter clause with parameter placeholders (e.g., "AND Model = {filter_0:String}") */
  filterClause: string;
  /** Retention cutoff formatted for DateTime64(3) queries */
  retentionCutoff: string;
}

/**
 * Builds metrics summary query with parameterized values.
 * Uses ClickHouse native parameter binding for security.
 */
export function buildFilteredMetricsSummaryQuery(input: FilteredMetricsInput): FilteredQueryResult {
  return {
    query: `SELECT
  count() as total_requests,
  countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens,
  sum(InputTokens) as input_tokens,
  sum(OutputTokens) as output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  uniq(UserId) as unique_users
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Builds hourly time series query with parameterized values.
 */
export function buildFilteredHourlyTimeSeriesQuery(input: FilteredMetricsInput): FilteredQueryResult {
  return {
    query: `SELECT
  toDate(Timestamp) as date,
  toHour(Timestamp) as hour,
  count() as request_count,
  countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens,
  sum(InputTokens) as total_input_tokens,
  sum(OutputTokens) as total_output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  uniq(UserId) as unique_users
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}
GROUP BY date, hour
ORDER BY date ASC, hour ASC`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Builds daily time series query with parameterized values.
 */
export function buildFilteredDailyTimeSeriesQuery(input: FilteredMetricsInput): FilteredQueryResult {
  return {
    query: `SELECT
  toDate(Timestamp) as date,
  0 as hour,
  count() as request_count,
  countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) as success_count,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) as error_count,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens,
  sum(InputTokens) as total_input_tokens,
  sum(OutputTokens) as total_output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  uniq(UserId) as unique_users
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}
GROUP BY date
ORDER BY date ASC`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Input for filtered model stats query.
 */
export interface FilteredModelStatsInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  filterClause: string;
  limit: number;
  /** Retention cutoff formatted for DateTime64(3) queries */
  retentionCutoff: string;
}

/**
 * Valid ClickHouse column names for ranking GROUP BY.
 * Only these are allowed to prevent SQL injection — the column name
 * is interpolated into the query (ClickHouse doesn't support parameterized column names).
 */
const RANKING_DIMENSION_TO_COLUMN: ReadonlyMap<string, string> = new Map([
  ['model', 'Model'],
  ['user_id', 'UserId'],
]);

/**
 * Maps a dimension string to a safe ClickHouse column expression.
 * Returns null if the dimension is not valid.
 *
 * A Map because the truthiness check below IS the validity check: `.get()`
 * answers only for keys the map owns, so nothing inherited can be returned as
 * a column name and reach `GROUP BY`.
 */
export function dimensionToClickHouseColumn(dimension: string): string | null {
  // Direct dimension lookup
  const column = RANKING_DIMENSION_TO_COLUMN.get(dimension);
  if (column) {
    return column;
  }
  // metadata.xxx → Metadata['xxx'] (validate key contains only safe chars)
  if (dimension.startsWith('metadata.')) {
    const key = dimension.slice('metadata.'.length);
    if (key && /^[a-zA-Z0-9_.-]+$/.test(key)) {
      return `Metadata['${key}']`;
    }
  }
  return null;
}

/**
 * Input for dimension-grouped ranking query.
 */
export interface FilteredRankingInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  filterClause: string;
  limit: number;
  /** Safe ClickHouse column expression (from dimensionToClickHouseColumn) */
  groupByColumn: string;
  /** Retention cutoff formatted for DateTime64(3) queries */
  retentionCutoff: string;
}

/**
 * Builds a ranking query that groups by an arbitrary dimension.
 * The groupByColumn MUST come from dimensionToClickHouseColumn (validated).
 */
export function buildRankingByDimensionQuery(input: FilteredRankingInput): FilteredQueryResult {
  return {
    query: `SELECT
  ${input.groupByColumn} as dimension_value,
  count() as total_requests,
  sum(Cost) as cost,
  sum(TotalTokens) as tokens,
  sum(InputTokens) as input_tokens,
  sum(OutputTokens) as output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  if(count() > 0, countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) / count() * 100, 0) as success_rate
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND ${input.groupByColumn} != ''
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}
GROUP BY ${input.groupByColumn}
ORDER BY total_requests DESC
LIMIT {limit:UInt32}`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Valid sort field names for paginated ranking queries.
 * Maps frontend field names to the ClickHouse SELECT aliases.
 * Only these are allowed to prevent SQL injection (column names are interpolated).
 *
 * A `Map`, not an object literal: a plain-object lookup also resolves inherited
 * members, so a caller-supplied `sortField=constructor` would hand back a
 * truthy prototype value for interpolation into `ORDER BY`. A `Map` has no
 * prototype chain to walk, so unknown keys are always `undefined`.
 */
export const SORT_FIELD_MAP = new Map<string, string>([
  ['requests', 'total_requests'],
  ['cost', 'cost'],
  ['tokens', 'tokens'],
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['avgLatencyMs', 'avg_latency_ms'],
  ['successRate', 'success_rate'],
]);

/**
 * Input for paginated ranking query (extends FilteredRankingInput with pagination + sort).
 */
export interface PaginatedRankingInput extends FilteredRankingInput {
  offset: number;
  /** Safe ClickHouse alias (from SORT_FIELD_MAP). Defaults to 'total_requests'. */
  sortAlias?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Builds a paginated ranking query with configurable sort.
 * Returns both the data query and a count subquery for total rows.
 */
export function buildPaginatedRankingQuery(input: PaginatedRankingInput): {
  dataQuery: FilteredQueryResult;
  countQuery: FilteredQueryResult;
} {
  const sortAlias = input.sortAlias || 'total_requests';
  const sortOrder = input.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const baseSelect = `
  ${input.groupByColumn} as dimension_value,
  count() as total_requests,
  sum(Cost) as cost,
  sum(TotalTokens) as tokens,
  sum(InputTokens) as input_tokens,
  sum(OutputTokens) as output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  if(count() > 0, countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) / count() * 100, 0) as success_rate`;

  const baseWhere = `AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND ${input.groupByColumn} != ''
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}`;

  const baseParams = {
    appId: input.appId,
    tenantId: input.tenantId,
    startDate: input.startDate,
    endDate: input.endDate,
    retentionCutoff: input.retentionCutoff,
    limit: input.limit,
    offset: input.offset,
  };

  const dataQuery: FilteredQueryResult = {
    query: `SELECT ${baseSelect}
FROM otel_traces FINAL
WHERE ${baseWhere}
GROUP BY ${input.groupByColumn}
ORDER BY ${sortAlias} ${sortOrder}
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}`,
    params: baseParams,
  };

  const countQuery: FilteredQueryResult = {
    query: `SELECT count() as total FROM (
  SELECT ${input.groupByColumn}
  FROM otel_traces FINAL
  WHERE ${baseWhere}
  GROUP BY ${input.groupByColumn}
)`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      retentionCutoff: input.retentionCutoff,
    },
  };

  return { dataQuery, countQuery };
}

/**
 * Builds model stats query with parameterized values.
 */
export function buildFilteredModelStatsQuery(input: FilteredModelStatsInput): FilteredQueryResult {
  return {
    query: `SELECT
  Model as model,
  count() as total_requests,
  sum(Cost) as cost,
  sum(TotalTokens) as tokens,
  sum(InputTokens) as input_tokens,
  sum(OutputTokens) as output_tokens,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  if(count() > 0, countIf(StatusCode NOT IN ${STATUS_ERROR_VALUES_SQL}) / count() * 100, 0) as success_rate
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Model != ''
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}
GROUP BY Model
ORDER BY total_requests DESC
LIMIT {limit:UInt32}`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

/**
 * Input for filtered percentiles query.
 * Note: metricColumn is a column name (not user input) and is safe to interpolate.
 */
export interface FilteredPercentilesInput {
  appId: string;
  tenantId: string;
  startDateTime: string;
  endDateTime: string;
  /** Column name for percentile calculation - must be a known safe value */
  metricColumn: 'Duration' | 'TotalTokens' | 'InputTokens' | 'OutputTokens';
  filterClause: string;
  /** Retention cutoff formatted for DateTime64(3) queries */
  retentionCutoff: string;
}

/**
 * Builds percentiles query with parameterized values.
 * metricColumn is intentionally interpolated as it's a validated column name,
 * not user input (ClickHouse doesn't support parameterized column names).
 */
export function buildFilteredPercentilesQuery(input: FilteredPercentilesInput): FilteredQueryResult {
  return {
    query: `SELECT
  toStartOfHour(Timestamp) as timestamp,
  quantile(0.75)(${input.metricColumn}) as p75,
  quantile(0.90)(${input.metricColumn}) as p90,
  quantile(0.95)(${input.metricColumn}) as p95,
  quantile(0.99)(${input.metricColumn}) as p99
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND Type = 'GENERATION'
  AND Timestamp >= {startDateTime:DateTime64}
  AND Timestamp <= {endDateTime:DateTime64}
  AND Timestamp >= {retentionCutoff:DateTime64(3)}
  ${input.filterClause}
GROUP BY timestamp
ORDER BY timestamp ASC`,
    params: {
      appId: input.appId,
      tenantId: input.tenantId,
      startDateTime: input.startDateTime,
      endDateTime: input.endDateTime,
      retentionCutoff: input.retentionCutoff,
    },
  };
}

// ============================================================================
// Span Kind Breakdown Query
// Feature: 044-semantic-span-kinds
// ============================================================================

/**
 * Breakdown of span metrics grouped by semantic kind.
 * Answers: "What % of latency is retrieval vs LLM?" and "Cost breakdown by span type"
 */
export const SPAN_KIND_BREAKDOWN_QUERY = `
SELECT
  SpanKind as kind,
  count() as count,
  if(count() > 0, sum(Duration) / count(), 0) as avg_latency_ms,
  sum(Cost) as total_cost,
  sum(TotalTokens) as total_tokens
FROM otel_traces FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
  AND toDate(Timestamp) >= {retentionCutoffDate:Date}
  AND SpanKind != ''
GROUP BY SpanKind
ORDER BY count DESC
`;


