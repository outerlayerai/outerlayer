/**
 * Shared Utilities for Analytics Service
 *
 * Contains retention cutoff helpers, filter clause builders, sort field maps,
 * score trend zero-fill, and raw ClickHouse response types shared across
 * multiple sub-services.
 */

import { isAnalyticsFilterOrGroup } from './types';
import type {
  AnalyticsFilter,
  AnalyticsFilterNode,
  DateRange,
  MetricsSummary,
  TimeSeriesPoint,
  ModelStats,
  PercentilePoint,
  PercentileMetric,
  ScoreTrendInterval,
} from './types';

// ============================================================================
// Retention Cutoff Helpers
// ============================================================================

/**
 * Computes the retention cutoff date.
 * -1 means unlimited (returns epoch), positive values mean "last N days".
 */
export function getRetentionCutoff(dataRetentionDays: number): Date {
  if (dataRetentionDays === -1) return new Date('1970-01-01T00:00:00.000Z');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - dataRetentionDays);
  return cutoff;
}

/**
 * Formats retention cutoff for ClickHouse DateTime64(3) parameters.
 * Returns format: 'YYYY-MM-DD HH:mm:ss.SSS'
 */
export function formatRetentionCutoff(dataRetentionDays: number): string {
  return getRetentionCutoff(dataRetentionDays).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Formats retention cutoff for ClickHouse Date parameters.
 * Returns format: 'YYYY-MM-DD'
 */
export function formatRetentionCutoffDate(dataRetentionDays: number): string {
  return getRetentionCutoff(dataRetentionDays).toISOString().split('T')[0]!;
}

// ============================================================================
// Query Settings
// ============================================================================

/**
 * Server-side timeout matching VALIDATION_LIMITS.queryTimeoutSeconds, with
 * no FINAL optimization. This is the correct base for queries against
 * `trace_facets` / `trace_topic_maps`: both partition by
 * `toYYYYMM(CreatedAt)` while `CreatedAt` is NOT in their ORDER BY key, so
 * a re-written row version (a re-extraction, a map tombstone) can land in a
 * different month than the version it replaces —
 * `do_not_merge_across_partitions_select_final` would then dedupe each
 * month independently and return BOTH versions (and an `IsDeleted = 0`
 * filter would resurrect tombstoned rows).
 */
export const QUERY_TIMEOUT_ONLY_SETTINGS = {
  max_execution_time: 30,
} as const;

/**
 * Shared ClickHouse query settings for filtered queries.
 * max_execution_time enforces a server-side timeout matching VALIDATION_LIMITS.queryTimeoutSeconds.
 *
 * do_not_merge_across_partitions_select_final cuts the cost of the heavy
 * `FROM ... FINAL` reads: FINAL then deduplicates each partition
 * independently (and in parallel) instead of merging every selected part
 * across partitions. Safe ONLY for tables where duplicates can never land
 * in different partitions — rows that FINAL would collapse share the full
 * ORDER BY key, and the table partitions by a function of a column in that
 * key (otel_traces: Timestamp; scores: CreatedAt, which update/tombstone
 * writers preserve — see apps/gateway/src/openapi/routes/scores.ts).
 * Harmless no-op on non-FINAL queries. For `trace_facets` /
 * `trace_topic_maps` reads use {@link QUERY_TIMEOUT_ONLY_SETTINGS} — their
 * partition key is not pinned by the dedup key, so this flag is NOT safe
 * there.
 */
export const QUERY_TIMEOUT_SETTINGS = {
  ...QUERY_TIMEOUT_ONLY_SETTINGS,
  do_not_merge_across_partitions_select_final: 1,
} as const;

// ============================================================================
// Filter Utility (exported for testing)
// ============================================================================

/**
 * Parameter values bound into a compiled filter clause. Arrays back the
 * `in` / `notIn` membership operators (`{p:Array(String)}` placeholders).
 */
export type FilterClauseParams = Record<string, string | number | string[] | number[]>;

/**
 * Result of building a filter WHERE clause with parameterized queries.
 */
interface FilterClauseResult {
  /** SQL WHERE clause fragment (starts with ' AND ...') with parameter placeholders */
  clause: string;
  /** Parameter values to pass to ClickHouse query_params */
  params: FilterClauseParams;
}

/**
 * Result of building filter WHERE clauses split for the two-step trace rollup
 * pattern. `innerClause` holds span-level predicates (used in the inner
 * `SELECT DISTINCT TraceId ...` subquery to find traces with at least one
 * matching span). `outerClause` holds trace-level predicates (applied to the
 * outer rollup query, where every span of the matching traces is aggregated).
 */
export interface SplitFilterClauseResult {
  /** Span-grain predicates — placed in the inner trace-finding subquery. */
  innerClause: string;
  /** Trace-grain predicates — placed in the outer rollup query. */
  outerClause: string;
  /** Combined parameter values to pass to ClickHouse query_params. */
  params: FilterClauseParams;
}

/**
 * Classifies fields by grain so the trace list query can split predicates
 * between the inner trace-finding subquery and the outer rollup. Fields that
 * vary per span (model, latency, cost, status, ...) must NOT be applied at
 * the outer rollup — doing so drops sibling spans from the aggregate (e.g.,
 * cost/tokens/span_count would only reflect filter-matching spans, not the
 * whole trace). Trace-level fields carry the same value across every span of
 * a trace (TraceId, SessionId, UserId — set once on the root and propagated).
 */
type FilterGrain = 'span' | 'trace';

/** A single leaf predicate compiled to a SQL fragment plus its grain. */
interface CompiledPredicate {
  grain: FilterGrain;
  sql: string;
}

// `new Map(Object.entries(...))`, not the literal itself: these tables are
// probed with a field name taken from a request. `Object.entries` enumerates
// own properties only, so `.get()` answers exactly the keys declared here and
// nothing inherited.
const FIELD_GRAIN: ReadonlyMap<string, FilterGrain> = new Map(Object.entries({
  // span-grain
  'model': 'span',
  'model_used': 'span',
  'status': 'span',
  'latency_ms': 'span',
  'latency': 'span',
  'input': 'span',
  'output': 'span',
  'props': 'span',
  'prompt_tokens': 'span',
  'completion_tokens': 'span',
  'cost': 'span',
  'semantic_kind': 'span',
  // trace-grain (every span of the trace carries the same value)
  'trace_id': 'trace',
  'session_id': 'trace',
  'user_id': 'trace',
  'user': 'trace',
}));

/** Maps a filter operator string to a SQL comparison operator. */
function toSqlOperator(operator: string): string {
  switch (operator.toLowerCase()) {
    case 'equals':
    case '=':
      return '=';
    case 'notequals':
    case 'not_equals':
    case '!=':
      return '!=';
    case 'lt':
    case '<':
      return '<';
    case 'lte':
    case '<=':
      return '<=';
    case 'gt':
    case '>':
      return '>';
    case 'gte':
    case '>=':
      return '>=';
    default:
      return '=';
  }
}

/** Value kind of a directly comparable ClickHouse column. */
type ColumnKind = 'string' | 'numeric' | 'datetime';

/**
 * Coerces an `in` / `notIn` / `between` value to a non-empty string array.
 * Null for anything else — invalid membership lists are dropped like any
 * other invalid leaf (the public JSON validator rejects them with a 400
 * before they ever reach a compiler).
 */
function toValueList(value: AnalyticsFilter['value']): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((v) => String(v));
}

/**
 * Compiles one predicate against a directly comparable column — the single
 * implementation behind both the trace/span compiler's static-field path and
 * the scores-table compiler, so operator semantics can't drift between them.
 *
 * `column` is a SQL expression (usually a bare column name; the metadata
 * path passes a `Map` access). Parameter names come from `allocParam` so
 * each caller keeps its own naming scheme/sequence. Returns the SQL fragment,
 * or null for an invalid leaf (caller drops it).
 *
 * `invalidNumber` preserves a legacy split: trace/span numeric columns
 * historically coerce unparseable values to 0; the scores compiler (new
 * surface) drops the leaf instead.
 */
function compileColumnPredicate(opts: {
  column: string;
  kind: ColumnKind;
  operator: string;
  value: AnalyticsFilter['value'];
  params: FilterClauseParams;
  allocParam: () => string;
  invalidNumber: 'zero' | 'drop';
}): string | null {
  const { column, kind, params, allocParam } = opts;
  const operator = opts.operator.toLowerCase();
  const chType = kind === 'numeric' ? 'Float64' : kind === 'datetime' ? 'DateTime64' : 'String';

  // Membership over the column's native type.
  if (operator === 'in' || operator === 'notin' || operator === 'not_in') {
    if (kind === 'datetime') return null;
    const list = toValueList(opts.value);
    if (!list) return null;
    const sqlOp = operator === 'in' ? 'IN' : 'NOT IN';
    const paramName = allocParam();
    if (kind === 'numeric') {
      const nums = list.map((v) => parseFloat(v));
      if (nums.some((n) => isNaN(n))) return null;
      params[paramName] = nums;
      return `${column} ${sqlOp} {${paramName}:Array(Float64)}`;
    }
    params[paramName] = list;
    return `${column} ${sqlOp} {${paramName}:Array(String)}`;
  }

  // Inclusive range: value is [min, max].
  if (operator === 'between') {
    if (kind === 'string') return null;
    const list = toValueList(opts.value);
    if (!list || list.length !== 2) return null;
    const minParam = allocParam();
    const maxParam = allocParam();
    if (kind === 'numeric') {
      const minValue = parseFloat(list[0]!);
      const maxValue = parseFloat(list[1]!);
      if (isNaN(minValue) || isNaN(maxValue)) return null;
      params[minParam] = minValue;
      params[maxParam] = maxValue;
    } else {
      params[minParam] = list[0]!;
      params[maxParam] = list[1]!;
    }
    return `${column} BETWEEN {${minParam}:${chType}} AND {${maxParam}:${chType}}`;
  }

  const rawValue = typeof opts.value === 'string' ? opts.value : String(opts.value);

  if (kind === 'numeric' || kind === 'datetime') {
    const paramName = allocParam();
    if (kind === 'numeric') {
      const numValue = parseFloat(rawValue);
      if (isNaN(numValue)) {
        if (opts.invalidNumber === 'drop') return null;
        params[paramName] = 0;
      } else {
        params[paramName] = numValue;
      }
    } else {
      params[paramName] = rawValue;
    }
    return `${column} ${toSqlOperator(operator)} {${paramName}:${chType}}`;
  }

  const paramName = allocParam();
  switch (operator) {
    case 'equals':
    case '=':
      params[paramName] = rawValue;
      return `${column} = {${paramName}:String}`;
    case 'notequals':
    case 'not_equals':
    case '!=':
      params[paramName] = rawValue;
      return `${column} != {${paramName}:String}`;
    case 'contains':
    case 'like':
      params[paramName] = `%${rawValue}%`;
      return `${column} ILIKE {${paramName}:String}`;
    case 'startswith':
    case 'starts_with':
      params[paramName] = `${rawValue}%`;
      return `${column} ILIKE {${paramName}:String}`;
    case 'endswith':
    case 'ends_with':
      params[paramName] = `%${rawValue}`;
      return `${column} ILIKE {${paramName}:String}`;
    case 'notcontains':
    case 'not_contains':
      params[paramName] = `%${rawValue}%`;
      return `${column} NOT ILIKE {${paramName}:String}`;
    default:
      params[paramName] = rawValue;
      return `${column} = {${paramName}:String}`;
  }
}

/**
 * Builds a WHERE clause from analytics filters using parameterized queries.
 * Exported for use in integration tests.
 *
 * Uses ClickHouse's native parameter binding ({paramName:Type}) to prevent
 * SQL injection - values are never interpolated into the query string.
 *
 * Maps frontend field names to ClickHouse column names:
 * - model_used / model -> Model
 * - user_id / user -> UserId
 * - status -> StatusCode (OK/ERROR mapped to != '2' / = '2')
 * - latency_ms -> Duration (both in milliseconds, no conversion needed)
 *
 * @param filters - Filter list: leaf predicates and one-level OR-groups
 *   (`{ or: [...] }`). List elements combine with AND; group members with OR.
 * @returns Object containing SQL clause with placeholders and parameter values
 */
export function buildFilterWhereClause(
  filters?: AnalyticsFilterNode[],
  appId?: string,
  tenantId: string = '',
): FilterClauseResult {
  const split = buildSplitFilterWhereClause(filters, appId, tenantId);
  // Each side already starts with 'AND ' when non-empty; concat with a space.
  const clause = [split.innerClause, split.outerClause].filter(Boolean).join(' ');
  return { clause, params: split.params };
}

/**
 * Builds the env-scoping WHERE fragment for analytics list queries
 * (Environments & Promotion).
 *
 * The `<Column>` token is the env-tag column on the table being queried —
 * `Environment` on both `otel_traces` and `scores`. Two modes:
 *
 *  - Multi-env (`environments` non-empty): emits `AND <Column> IN (...)`,
 *    the saved-filter `environments` JSONB rule. No legacy
 *    inclusion — a saved filter naming explicit envs never silently sweeps
 *    in `Environment = ''` rows.
 *  - Single-env (`environment` set): emits `AND <Column> = {env:String}`,
 *    OR — when scoping to the app's default env — `AND (<Column> = {env} OR
 *    <Column> = '')` so pre-feature legacy rows resolve into the default-env
 *    view exactly once.
 *
 * Returns an empty clause when neither input is provided (no env filter).
 *
 * `environments` wins when both are supplied — the saved filter is the more
 * specific user intent.
 */
/**
 * Combined env-scope input for analytics queries. Canonical
 * definition lives in `@repo/api-types`; re-exported here so callers
 * resolving it through `@repo/observability-service` keep working.
 */
export type { EnvironmentQueryScope } from '@repo/api-types';
import type { EnvironmentQueryScope } from '@repo/api-types';

export function buildEnvironmentWhereClause(
  column: string,
  opts: EnvironmentQueryScope,
): { clause: string; params: Record<string, string | string[]> } {
  const envList = opts.environments;
  if (envList) {
    // An EMPTY allow-list means "this caller may read no environment", which is
    // not the same as "no env filter" — an empty clause here would widen the
    // read to every environment. A kind-scoped API key whose kinds match none of
    // the app's environments resolves to exactly this case.
    //
    // `1 = 0` rather than `IN ()`, which is a ClickHouse syntax error.
    if (envList.length === 0) {
      return { clause: 'AND 1 = 0', params: {} };
    }
    return {
      clause: `AND ${column} IN ({envNames:Array(String)})`,
      params: { envNames: envList },
    };
  }

  const env = opts.environment;
  if (env) {
    if (env.isDefault) {
      // Legacy/no-pre-feature rows (Environment = '') belong to the default
      // env's view — and ONLY the default env's view.
      return {
        clause: `AND (${column} = {envName:String} OR ${column} = '')`,
        params: { envName: env.name },
      };
    }
    return {
      clause: `AND ${column} = {envName:String}`,
      params: { envName: env.name },
    };
  }

  return { clause: '', params: {} };
}

/**
 * Builds the trace-grain split version of {@link buildFilterWhereClause}.
 * Used by the trace list query to apply span-level filters in an inner
 * `SELECT DISTINCT TraceId` subquery (so the outer aggregate covers ALL
 * spans of matching traces, not just spans that matched the filter).
 *
 * For non-trace-rollup callers (sessions, metrics, requests, ...) prefer
 * {@link buildFilterWhereClause}, which combines both halves into a single
 * clause — that is correct for grain-uniform queries.
 */
export function buildSplitFilterWhereClause(
  filters?: AnalyticsFilterNode[],
  appId?: string,
  tenantId: string = '',
): SplitFilterClauseResult {
  const hasFilters = filters && filters.length > 0;

  if (!hasFilters) {
    return { innerClause: '', outerClause: '', params: {} };
  }

  // Map frontend field names to ClickHouse column names
  // A Map for the same reason as FIELD_GRAIN above.
  const fieldMap: ReadonlyMap<string, string> = new Map(Object.entries({
    'model': 'Model',
    'model_used': 'Model',
    'user_id': 'UserId',
    'user': 'UserId',
    'status': 'StatusCode',
    'latency_ms': 'Duration',
    'latency': 'Duration',
    'input': 'Input',
    'output': 'Output',
    'props': 'Props',
    'trace_id': 'TraceId',
    'prompt_tokens': 'InputTokens',
    'completion_tokens': 'OutputTokens',
    'cost': 'Cost',
    'session_id': 'SessionId',
    'semantic_kind': 'SpanKind',
  }));

  // Numeric fields that use Float64 type
  const numericFields = new Set(['latency_ms', 'latency', 'prompt_tokens', 'completion_tokens', 'cost']);

  const innerClauses: string[] = [];
  const outerClauses: string[] = [];
  const params: FilterClauseParams = {};
  let paramIndex = 0;
  let scoreParamIndex = 0;
  const allocParam = () => `filter_${paramIndex++}`;

  // Push a clause to the side matching its field's grain. Defaults to 'span'
  // for fields without an explicit classification (metadata.*, score__*,
  // tags) — those are span-grain because they live in the per-span row.
  const pushClause = (grain: FilterGrain, sql: string) => {
    if (grain === 'trace') {
      outerClauses.push(sql);
    } else {
      innerClauses.push(sql);
    }
  };

  // Compiles one leaf predicate to a SQL fragment plus its grain. Returns
  // null for unknown/invalid leaves — preserving the historical silently-drop
  // behavior for internal callers (the public DSL parser pre-validates, so
  // its leaves never hit the null paths). Parameter bindings are registered
  // as a side effect; every non-null result's params are referenced by its
  // own SQL fragment, so fragments stay composable (AND or OR) in any order.
  const compilePredicate = (filter: AnalyticsFilter): CompiledPredicate | null => {
    const fieldLower = filter.field.toLowerCase();

    // Handle metadata.* fields -> ClickHouse Metadata Map lookups
    if (fieldLower.startsWith('metadata.')) {
      const metadataKey = filter.field.slice('metadata.'.length);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(metadataKey)) {
        return null;
      }
      const operator = filter.operator.toLowerCase();

      // Membership operators: delegate to the shared column compiler with the
      // Map access as the column expression (key param allocated first).
      if (operator === 'in' || operator === 'notin' || operator === 'not_in') {
        const keyParamName = `filter_key_${paramIndex++}`;
        const sql = compileColumnPredicate({
          column: `Metadata[{${keyParamName}:String}]`,
          kind: 'string',
          operator,
          value: filter.value,
          params,
          allocParam,
          invalidNumber: 'zero',
        });
        if (!sql) return null;
        params[keyParamName] = metadataKey;
        return { grain: 'span', sql };
      }

      const paramName = `filter_${paramIndex++}`;
      const keyParamName = `filter_key_${paramIndex++}`;
      const rawValue = typeof filter.value === 'string' ? filter.value : String(filter.value);

      params[keyParamName] = metadataKey;
      params[paramName] = rawValue;

      // Metadata is per-span — apply at the inner (span) grain.
      switch (operator) {
        case 'equals':
        case '=':
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] = {${paramName}:String}` };
        case 'notequals':
        case 'not_equals':
        case '!=':
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] != {${paramName}:String}` };
        case 'contains':
        case 'like':
          params[paramName] = `%${rawValue}%`;
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] LIKE {${paramName}:String}` };
        case 'notcontains':
        case 'not_contains':
          params[paramName] = `%${rawValue}%`;
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] NOT LIKE {${paramName}:String}` };
        case 'startswith':
        case 'starts_with':
          params[paramName] = `${rawValue}%`;
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] LIKE {${paramName}:String}` };
        case 'endswith':
        case 'ends_with':
          params[paramName] = `%${rawValue}`;
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] LIKE {${paramName}:String}` };
        case 'exists':
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] != ''` };
        case 'doesnotexist':
        case 'does_not_exist':
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] = ''` };
        default:
          return { grain: 'span', sql: `Metadata[{${keyParamName}:String}] = {${paramName}:String}` };
      }
    }

    // Handle score__* fields -> IN subquery against scores table
    if (fieldLower.startsWith('score__')) {
      if (!appId) {
        return null;
      }

      const scoreName = filter.field.slice('score__'.length);
      if (!scoreName || !/^[a-zA-Z_][a-zA-Z0-9_\-]{0,63}$/.test(scoreName)) {
        return null;
      }

      // The Score comparison inside the subquery: a single `op value` for the
      // comparison operators, or an inclusive range for `between`.
      const operator = filter.operator.toLowerCase();
      let scoreCondition: string;
      if (operator === 'between') {
        const list = toValueList(filter.value);
        if (!list || list.length !== 2) return null;
        const minValue = parseFloat(list[0]!);
        const maxValue = parseFloat(list[1]!);
        if (isNaN(minValue) || isNaN(maxValue)) return null;
        const minParam = `score_value_min_${scoreParamIndex}`;
        const maxParam = `score_value_max_${scoreParamIndex}`;
        params[minParam] = minValue;
        params[maxParam] = maxValue;
        scoreCondition = `Score BETWEEN {${minParam}:Float64} AND {${maxParam}:Float64}`;
      } else {
        const rawValue = typeof filter.value === 'string' ? filter.value : String(filter.value);
        const numValue = parseFloat(rawValue);
        if (isNaN(numValue)) {
          return null;
        }
        const scoreValueParam = `score_value_${scoreParamIndex}`;
        params[scoreValueParam] = numValue;
        scoreCondition = `Score ${toSqlOperator(filter.operator)} {${scoreValueParam}:Float64}`;
      }

      if (!params.score_appId) {
        params.score_appId = appId;
      }
      if (tenantId && !params.score_tenantId) {
        params.score_tenantId = tenantId;
      }

      const scoreNameParam = `score_name_${scoreParamIndex}`;
      scoreParamIndex++;
      params[scoreNameParam] = scoreName;

      const tenantClause = tenantId ? ' AND TenantId = {score_tenantId:String}' : '';

      // Scores can be keyed by either SpanId (annotations) or TraceId (CLI evals).
      // Match either so filters surface traces regardless of the writer's choice.
      // Span-grain: each row is a span; OR on TraceId still resolves correctly
      // because every span carries the trace's TraceId.
      const scoreSubquery = `SELECT ResourceId FROM scores FINAL WHERE AppId = {score_appId:String}${tenantClause} AND IsDeleted = 0 AND Name = {${scoreNameParam}:String} AND ${scoreCondition}`;
      return {
        grain: 'span',
        sql: `(SpanId IN (${scoreSubquery}) OR TraceId IN (${scoreSubquery}))`,
      };
    }

    // Handle topic__<facet> -> trace_facets TopicId lookups.
    // TopicIds are only unique WITHIN a facet's map (task v1-c0 and issues
    // v1-c0 are different topics), so the facet is part of the field name —
    // mirroring the score__<name> convention. Value is a TopicId or
    // 'no_match'. Span-grain TraceId IN: every span of a matching trace
    // satisfies it, so the trace-level rollup surfaces the whole trace. A
    // facet may fan out several rows per trace (steering: one per
    // correction); the IN-subquery matches a trace when ANY of its rows
    // carries the topic, which is the drill-down semantics wanted.
    if (fieldLower.startsWith('topic__')) {
      const facet = fieldLower.slice('topic__'.length);
      if (facet !== 'task' && facet !== 'issues' && facet !== 'steering') {
        return null;
      }
      const operator = filter.operator.toLowerCase();
      if (!['equals', '=', 'notequals', 'not_equals', '!='].includes(operator)) {
        return null;
      }
      // The subquery is unconditionally AppId-scoped ({topic_appId:String}),
      // so without an appId that parameter would be unbound and ClickHouse
      // rejects the whole query. Drop the filter instead — matches the
      // score__<name> handler, which also refuses to compose an app-scoped
      // subquery when appId is absent.
      if (!appId) {
        return null;
      }
      const rawValue = typeof filter.value === 'string' ? filter.value : String(filter.value);

      if (!params.topic_appId) {
        params.topic_appId = appId;
      }
      if (tenantId && !params.topic_tenantId) {
        params.topic_tenantId = tenantId;
      }
      const tenantClause = tenantId ? ' AND TenantId = {topic_tenantId:String}' : '';

      const facetParam = `topic_facet_${paramIndex}`;
      const valueParam = `topic_value_${paramIndex}`;
      paramIndex++;
      params[facetParam] = facet;
      params[valueParam] = rawValue;

      const topicSubquery = `SELECT TraceId FROM trace_facets FINAL WHERE AppId = {topic_appId:String}${tenantClause} AND IsDeleted = 0 AND Facet = {${facetParam}:String} AND TopicId = {${valueParam}:String}`;
      const negated = operator === 'notequals' || operator === 'not_equals' || operator === '!=';
      return {
        grain: 'span',
        sql: negated
          ? `TraceId NOT IN (${topicSubquery})`
          : `TraceId IN (${topicSubquery})`,
      };
    }

    // Handle tags field -> ClickHouse Tags Array lookups.
    // Tags live per-span; classify as span-grain so the inner subquery picks
    // any trace with at least one tagged span, while the outer rollup still
    // surfaces the trace-level distinct-tag union.
    if (fieldLower === 'tags') {
      const paramName = `filter_${paramIndex++}`;
      const rawValue = typeof filter.value === 'string' ? filter.value : String(filter.value);
      const operator = filter.operator.toLowerCase();

      switch (operator) {
        case 'equals':
        case '=':
          params[paramName] = rawValue;
          return { grain: 'span', sql: `has(Tags, {${paramName}:String})` };
        case 'notequals':
        case 'not_equals':
        case '!=':
          params[paramName] = rawValue;
          return { grain: 'span', sql: `NOT has(Tags, {${paramName}:String})` };
        case 'contains':
        case 'like':
          params[paramName] = `%${rawValue}%`;
          return { grain: 'span', sql: `arrayExists(x -> x ILIKE {${paramName}:String}, Tags)` };
        // Membership: trace carries ANY of the listed tags (hasAny), or none.
        case 'in': {
          const list = toValueList(filter.value);
          if (!list) return null;
          params[paramName] = list;
          return { grain: 'span', sql: `hasAny(Tags, {${paramName}:Array(String)})` };
        }
        case 'notin':
        case 'not_in': {
          const list = toValueList(filter.value);
          if (!list) return null;
          params[paramName] = list;
          return { grain: 'span', sql: `NOT hasAny(Tags, {${paramName}:Array(String)})` };
        }
        default:
          params[paramName] = rawValue;
          return { grain: 'span', sql: `has(Tags, {${paramName}:String})` };
      }
    }

    const columnName = fieldMap.get(fieldLower);
    if (!columnName) {
      return null;
    }

    const isNumeric = numericFields.has(fieldLower);
    const grain: FilterGrain = FIELD_GRAIN.get(fieldLower) ?? 'span';

    const rawValue = typeof filter.value === 'string'
      ? filter.value
      : String(filter.value);

    // Handle status field specially. Status filter must agree with the
    // displayed any-error status aggregate, so both sides see the trace as
    // a whole, not just whichever spans the filter happened to touch.
    //
    // ERROR  → "trace has at least one error span" (span-grain WHERE).
    // OK     → "trace has zero error spans" (proper inverse of ERROR via a
    //          trace-level `TraceId NOT IN (subquery)`). A naive span-grain
    //          `StatusCode NOT IN (...)` would surface mixed-status traces
    //          because a single OK span satisfies it.
    if (fieldLower === 'status') {
      const statusValue = rawValue.toUpperCase();
      if (statusValue === 'OK' || statusValue === 'SUCCESS') {
        if (appId && !params.status_appId) {
          params.status_appId = appId;
        }
        if (tenantId && !params.status_tenantId) {
          params.status_tenantId = tenantId;
        }
        const tenantClause = tenantId
          ? ' AND TenantId = {status_tenantId:String}'
          : '';
        return {
          grain: 'trace',
          sql: `TraceId NOT IN (SELECT DISTINCT TraceId FROM otel_traces WHERE AppId = {status_appId:String}${tenantClause} AND IsDeleted = 0 AND StatusCode IN ('2', 'STATUS_CODE_ERROR', 'Error'))`,
        };
      }
      if (statusValue === 'ERROR' || statusValue === 'FAIL') {
        return { grain, sql: `${columnName} IN ('2', 'STATUS_CODE_ERROR', 'Error')` };
      }
      return null;
    }

    // Directly comparable column — delegate to the shared compiler (one
    // implementation of equals/contains/range/membership semantics for both
    // this builder and the scores-table builder).
    const sql = compileColumnPredicate({
      column: columnName,
      kind: isNumeric ? 'numeric' : 'string',
      operator: filter.operator,
      value: filter.value,
      params,
      allocParam,
      invalidNumber: 'zero',
    });
    return sql ? { grain, sql } : null;
  };

  for (const node of filters || []) {
    // OR-group: compile each member, then place the disjunction on ONE side
    // of the split. All-trace-grain groups behave like any trace-grain
    // predicate (outer). A group with any span-grain member must go inner —
    // and that is correct even when mixed with trace-grain members, because
    // trace-grain fields are constant across every span of a trace: "some
    // span satisfies (spanPred OR tracePred)" is equivalent to "the trace
    // has a span matching spanPred OR the trace satisfies tracePred".
    if (isAnalyticsFilterOrGroup(node)) {
      const members: CompiledPredicate[] = [];
      for (const leaf of node.or) {
        const compiled = compilePredicate(leaf);
        if (compiled) {
          members.push(compiled);
        }
      }
      // Dropping invalid members narrows an OR (fewer rows match) — the safe
      // direction. An empty group is dropped entirely, matching the
      // historical leaf behavior.
      if (members.length === 0) {
        continue;
      }
      if (members.length === 1) {
        pushClause(members[0]!.grain, members[0]!.sql);
        continue;
      }
      const grain: FilterGrain = members.every((m) => m.grain === 'trace') ? 'trace' : 'span';
      pushClause(grain, `(${members.map((m) => m.sql).join(' OR ')})`);
      continue;
    }

    const compiled = compilePredicate(node);
    if (compiled) {
      pushClause(compiled.grain, compiled.sql);
    }
  }

  if (innerClauses.length === 0 && outerClauses.length === 0) {
    return { innerClause: '', outerClause: '', params: {} };
  }

  return {
    innerClause: innerClauses.length ? 'AND ' + innerClauses.join(' AND ') : '',
    outerClause: outerClauses.length ? 'AND ' + outerClauses.join(' AND ') : '',
    params,
  };
}

// ============================================================================
// Scores-Table Filter Compiler (POST /v1/scores/search)
// ============================================================================

/**
 * Filterable fields on the `scores` table. Unlike the trace/span compiler
 * there is no grain split — every score row is flat — so the output is a
 * single ` AND ...` clause. Datetime values must already be in ClickHouse
 * format ('YYYY-MM-DD HH:mm:ss.SSS'); the gateway validator normalizes
 * ISO-8601 input before compiling.
 */
// A Map for the same reason as FIELD_GRAIN — the `if (!field)` drop below is
// only a real allowlist check when the lookup cannot answer inherited keys.
const SCORES_FILTER_FIELDS: ReadonlyMap<string, { column: string; kind: ColumnKind }> =
  new Map(Object.entries({
  'name': { column: 'Name', kind: 'string' },
  'source': { column: 'Source', kind: 'string' },
  'user_id': { column: 'UserId', kind: 'string' },
  'resource_id': { column: 'ResourceId', kind: 'string' },
  'label': { column: 'Label', kind: 'string' },
  'score': { column: 'Score', kind: 'numeric' },
  'created_at': { column: 'CreatedAt', kind: 'datetime' },
}));

/**
 * Compiles `AnalyticsFilterNode[]` against the `scores` table. Same contract
 * as {@link buildFilterWhereClause}: AND of leaves and one-level OR-groups,
 * parameterized fragments only, invalid leaves silently dropped (the public
 * JSON validator 400s them first). Params are prefixed `sfilter_` so the
 * result merges safely with the list query's own params (appId, startDate…).
 */
export function buildScoresFilterWhereClause(
  filters?: AnalyticsFilterNode[],
): { clause: string; params: FilterClauseParams } {
  if (!filters || filters.length === 0) {
    return { clause: '', params: {} };
  }

  const params: FilterClauseParams = {};
  let paramIndex = 0;
  const allocParam = () => `sfilter_${paramIndex++}`;

  const compileLeaf = (filter: AnalyticsFilter): string | null => {
    const field = SCORES_FILTER_FIELDS.get(filter.field.toLowerCase());
    if (!field) return null;
    return compileColumnPredicate({
      column: field.column,
      kind: field.kind,
      operator: filter.operator,
      value: filter.value,
      params,
      allocParam,
      // New surface — no legacy NaN→0 coercion to honor; drop invalid leaves.
      invalidNumber: 'drop',
    });
  };

  const clauses: string[] = [];
  for (const node of filters) {
    if (isAnalyticsFilterOrGroup(node)) {
      const members = node.or
        .map((leaf) => compileLeaf(leaf))
        .filter((sql): sql is string => sql !== null);
      if (members.length === 0) continue;
      clauses.push(members.length === 1 ? members[0]! : `(${members.join(' OR ')})`);
      continue;
    }
    const sql = compileLeaf(node);
    if (sql) clauses.push(sql);
  }

  return {
    clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params,
  };
}

// ============================================================================
// Sort Field Mappings (Traces & Sessions)
// ============================================================================

/**
 * Maps validated trace sort field names to ClickHouse column/alias names.
 *
 * A `Map`, not an object literal: a plain-object lookup also resolves inherited
 * members, so a caller-supplied `sortBy=constructor` would hand back a truthy
 * prototype value for interpolation into `ORDER BY`. A `Map` has no prototype
 * chain to walk, so unknown keys are always `undefined`.
 */
export const TRACE_SORT_FIELD_MAP = new Map<string, string>([
  ['name', 'name'],
  ['status', 'status'],
  ['latency', 'latency_ms'],
  ['cost', 'cost'],
  ['tokens', 'tokens'],
  ['start_time', 'start'],
]);

// ============================================================================
// Score Trend Zero-Fill Helper
// ============================================================================

/**
 * Fills missing time periods in trend data with zero-count entries.
 * Ensures consistent chart visualization without gaps.
 */
export function zeroFillTrendPoints(
  points: Array<{ timestamp: string; avgScore: number; count: number }>,
  dateRange: DateRange,
  interval: ScoreTrendInterval,
): Array<{ timestamp: string; avgScore: number; count: number }> {
  if (points.length === 0) return points;

  const existing = new Map(points.map((p) => [p.timestamp, p]));
  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);
  const filled: Array<{ timestamp: string; avgScore: number; count: number }> = [];

  // Align start to interval boundary
  const cursor = new Date(start);
  if (interval === 'hour') {
    cursor.setMinutes(0, 0, 0);
  } else if (interval === 'day') {
    cursor.setHours(0, 0, 0, 0);
  } else if (interval === 'week') {
    // Align to Monday (matches ClickHouse toStartOfWeek(CreatedAt, 1) mode)
    const day = cursor.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    cursor.setDate(cursor.getDate() + diff);
    cursor.setHours(0, 0, 0, 0);
  } else {
    // Month: align to 1st of month (matches ClickHouse toStartOfMonth)
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
  }

  while (cursor <= end) {
    const iso = cursor.toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const dateOnly = cursor.toISOString().split('T')[0]!;
    const timeOnly = cursor.toISOString().split('T')[1]!.replace('.000Z', '');
    const chFormat = `${dateOnly} ${timeOnly}`;
    const match = existing.get(iso) ??
      existing.get(chFormat) ??
      existing.get(dateOnly) ??
      existing.get(cursor.toISOString().replace(/\.000Z$/, 'Z'));

    filled.push(match ?? { timestamp: iso, avgScore: 0, count: 0 });

    // Advance cursor by interval
    if (interval === 'month') {
      cursor.setMonth(cursor.getMonth() + 1);
    } else {
      const incrementMs: Record<string, number> = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
      };
      cursor.setTime(cursor.getTime() + incrementMs[interval]!);
    }
  }

  // Include any existing points that didn't match our generated timestamps
  for (const point of points) {
    if (!filled.some((f) => f.timestamp === point.timestamp)) {
      filled.push(point);
    }
  }

  return filled.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ============================================================================
// Shared Number/Metadata Transformers
// ============================================================================

export function toNumber(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return isNaN(num) ? 0 : num;
}

export function parseMetadata(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null) {
    return raw as Record<string, string>;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error('parseMetadata: invalid JSON in metadata field', error);
      return {};
    }
  }
  return {};
}

// ============================================================================
// Metrics Transform Helpers
// ============================================================================

export function transformMetricsSummary(raw: RawMetricsSummary | undefined): MetricsSummary {
  if (!raw) {
    return {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgLatencyMs: 0,
      uniqueUsers: 0,
    };
  }

  return {
    totalRequests: toNumber(raw.total_requests),
    successCount: toNumber(raw.success_count),
    errorCount: toNumber(raw.error_count),
    totalCost: toNumber(raw.total_cost),
    totalTokens: toNumber(raw.total_tokens),
    inputTokens: toNumber(raw.input_tokens),
    outputTokens: toNumber(raw.output_tokens),
    avgLatencyMs: toNumber(raw.avg_latency_ms),
    uniqueUsers: toNumber(raw.unique_users),
  };
}

export function transformTimeSeriesPoint(raw: RawTimeSeriesPoint): TimeSeriesPoint {
  return {
    date: raw.date,
    hour: toNumber(raw.hour),
    requests: toNumber(raw.request_count),
    successes: toNumber(raw.success_count),
    errors: toNumber(raw.error_count),
    cost: toNumber(raw.total_cost),
    tokens: toNumber(raw.total_tokens),
    inputTokens: toNumber(raw.total_input_tokens),
    outputTokens: toNumber(raw.total_output_tokens),
    avgLatencyMs: toNumber(raw.avg_latency_ms),
    uniqueUsers: toNumber(raw.unique_users),
  };
}

export function transformModelStats(raw: RawModelStats): ModelStats {
  return {
    model: raw.model,
    requests: toNumber(raw.total_requests),
    cost: toNumber(raw.cost),
    tokens: toNumber(raw.tokens),
    inputTokens: toNumber(raw.input_tokens),
    outputTokens: toNumber(raw.output_tokens),
    avgLatencyMs: toNumber(raw.avg_latency_ms),
    successRate: toNumber(raw.success_rate),
  };
}

export function transformPercentilePoint(raw: RawPercentilePoint): PercentilePoint {
  return {
    timestamp: raw.timestamp,
    p75: toNumber(raw.p75),
    p90: toNumber(raw.p90),
    p95: toNumber(raw.p95),
    p99: toNumber(raw.p99),
  };
}

export function createEmptyTimeSeriesPoint(date: string, hour: number): RawTimeSeriesPoint {
  return {
    date,
    hour: String(hour),
    request_count: '0',
    success_count: '0',
    error_count: '0',
    total_cost: '0',
    total_tokens: '0',
    total_input_tokens: '0',
    total_output_tokens: '0',
    avg_latency_ms: '0',
    unique_users: '0',
  };
}

export function fillTimeSeriesGaps(
  data: RawTimeSeriesPoint[],
  dateRange: DateRange,
  hourly: boolean
): RawTimeSeriesPoint[] {
  const dataMap = new Map<string, RawTimeSeriesPoint>();
  for (const point of data) {
    const key = hourly ? `${point.date}-${point.hour}` : point.date;
    dataMap.set(key, point);
  }

  const result: RawTimeSeriesPoint[] = [];
  const startDate = new Date(dateRange.start);
  const endDate = new Date(dateRange.end);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0] as string;

    if (hourly) {
      for (let hour = 0; hour < 24; hour++) {
        const key = `${dateStr}-${hour}`;
        const existing = dataMap.get(key);
        if (existing) {
          result.push(existing);
        } else {
          result.push(createEmptyTimeSeriesPoint(dateStr, hour));
        }
      }
    } else {
      const existing = dataMap.get(dateStr);
      if (existing) {
        result.push(existing);
      } else {
        result.push(createEmptyTimeSeriesPoint(dateStr, 0));
      }
    }
  }

  return result;
}

export function getTokenColumn(metric: PercentileMetric): string {
  switch (metric) {
    case 'inputTokens':
      return 'InputTokens';
    case 'outputTokens':
      return 'OutputTokens';
    case 'totalTokens':
      return 'TotalTokens';
    default:
      return 'TotalTokens';
  }
}

export function resolveDateRange(
  range: string,
  startDate?: string,
  endDate?: string
): DateRange {
  if (range === 'custom' && startDate && endDate) {
    return { start: startDate, end: endDate };
  }

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0] as string;

  switch (range) {
    case 'today':
      return { start: todayStr, end: todayStr };
    case 'yesterday': {
      const yesterdayStr = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      return { start: yesterdayStr, end: yesterdayStr };
    }
    case '7d':
      return {
        start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: todayStr,
      };
    case '30d':
      return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: todayStr,
      };
    case '90d':
      return {
        start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: todayStr,
      };
    default:
      return { start: todayStr, end: todayStr };
  }
}

// ============================================================================
// Raw Data Types (ClickHouse response shapes)
// ============================================================================

export interface RawMetricsSummary {
  total_requests: string;
  success_count: string;
  error_count: string;
  total_cost: string;
  total_tokens: string;
  input_tokens: string;
  output_tokens: string;
  avg_latency_ms: string;
  unique_users: string;
}

export interface RawTimeSeriesPoint {
  date: string;
  hour: string;
  request_count: string;
  success_count: string;
  error_count: string;
  total_cost: string;
  total_tokens: string;
  total_input_tokens: string;
  total_output_tokens: string;
  avg_latency_ms: string;
  unique_users: string;
}

export interface RawModelStats {
  model: string;
  total_requests: string;
  cost: string;
  tokens: string;
  input_tokens: string;
  output_tokens: string;
  avg_latency_ms: string;
  success_rate: string;
}

export interface RawRankingRow {
  dimension_value: string;
  total_requests: string;
  cost: string;
  tokens: string;
  input_tokens: string;
  output_tokens: string;
  avg_latency_ms: string;
  success_rate: string;
}

export interface RawTraceSummary {
  id: string;
  name: string;
  start: string;
  end: string;
  status: string;
  cost: string;
  tokens: string;
  latency_ms: string;
  span_count: string;
  tags?: string[];
  /** Env tag. `''` for legacy/no-pin rows. */
  environment?: string;
  /** Env version at ingest. `0` for legacy/no-pin rows. */
  environment_version?: string | number;
}

export interface RawSpan {
  id: string;
  trace_id: string;
  parent_id: string;
  name: string;
  trace_name: string;
  status: string;
  status_message: string;
  duration_ms: string;
  timestamp: string;
  type: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  tokens: string;
  cost: string;
  input: string;
  output: string;
  output_object: string;
  tool_calls: string;
  blob_refs?: string;
  finish_reason: string;
  settings: string;
  reasoning_tokens: string;
  metadata: unknown;
  props: string;
  span_kind: string;
  service_name: string;
  user_id?: string;
  session_id?: string;
}

export interface RawPercentilePoint {
  timestamp: string;
  p75: string;
  p90: string;
  p95: string;
  p99: string;
}

export interface RawScore {
  id: string;
  resource_id: string;
  name: string;
  score: string;
  label: string;
  reason: string;
  source: string;
  user_id: string;
  created_at: string;
}

export interface RawScoreAggregation {
  name: string;
  avg_score: string;
  count: string;
  min_score: string;
  max_score: string;
  data_type?: string;
}

export interface RawRequest {
  id: string;
  tenant_id: string;
  app_id: string;
  cost: string;
  prompt_tokens: string;
  completion_tokens: string;
  latency_ms: string;
  model_used: string;
  status: string;
  input: string;
  output: string;
  output_object: string;
  ts: string;
  user_id: string;
  trace_id: string;
  status_message: string;
  props: string;
}
