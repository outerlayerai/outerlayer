/**
 * Traces Sub-Service
 *
 * Handles trace listing, detail, span I/O, metadata keys, and export queries.
 */

// Subpath import, NOT the barrel: keeps this browser-reachable service off the
// shared-utils barrel's Node-oriented helpers (the yaml serializer, hmac/crypto)
// so it stays safe to pull into the dashboard's client bundle.
import {
  deriveTraceIO,
  attachTraceIOPreviews as applyTraceIOPreviews,
} from '@repo/shared-utils/trace-io';
import type { IClickHouseQuery } from '../client';
import {
  formatISOForClickHouse,
  getDefaultTracesStartDate,
  getCurrentDateForClickHouse,
  clickHouseToISO,
} from '../date-utils';
import {
  TRACE_DETAIL_QUERY,
  TRACE_DETAIL_LIGHTWEIGHT_QUERY,
  SPAN_IO_QUERY,
  DISTINCT_METADATA_KEYS_QUERY,
  STATUS_ERROR_VALUES_SQL,
  TRACE_ID_TIME_RANGE_QUERY,
  buildTraceIOPreviewQuery,
  TRACE_IO_PREVIEW_MAX_CHARS,
} from '../queries';
import type {
  TracesParams,
  TracesResponse,
  TraceSummary,
  TraceDetail,
  SpanIO,
  Span,
  Score,
} from '../types';
import type { TenantContext } from '../tenant-context';
import {
  buildSplitFilterWhereClause,
  buildEnvironmentWhereClause,
  formatRetentionCutoff,
  QUERY_TIMEOUT_SETTINGS,
  TRACE_SORT_FIELD_MAP,
  toNumber,
  parseMetadata,
} from '../shared';
import type {
  RawTraceSummary,
  RawSpan,
} from '../shared';
import type { ScoresService } from './scores';
import type { EnvironmentQueryScope } from '../shared';

/**
 * The `[min(start), max(end)]` timestamp window of a page of trace rows, in
 * ClickHouse DateTime format — used to bound the I/O-preview lookup so it
 * touches only the granules the page's traces live in. Returns `null` when no
 * row has a parseable timestamp (empty page, or malformed values), signalling
 * the caller to skip the preview query entirely.
 *
 * Exported for direct unit testing: the min/max + parse logic is the part of
 * the preview path most worth pinning (an off-by-one here silently widens or
 * misses the scan window).
 */
export function pageTimeWindow(
  rows: readonly { start: string; end: string }[],
): { start: string; end: string } | null {
  const startsMs = rows
    .map((r) => Date.parse(clickHouseToISO(r.start)))
    .filter((n) => !Number.isNaN(n));
  const endsMs = rows
    .map((r) => Date.parse(clickHouseToISO(r.end)))
    .filter((n) => !Number.isNaN(n));
  if (startsMs.length === 0 || endsMs.length === 0) return null;
  return {
    start: formatISOForClickHouse(new Date(Math.min(...startsMs)).toISOString()),
    end: formatISOForClickHouse(new Date(Math.max(...endsMs)).toISOString()),
  };
}

export class TracesService {
  constructor(
    private readonly client: IClickHouseQuery,
    private readonly scoresService: ScoresService,
  ) {}

  async getTraces(ctx: TenantContext, params: TracesParams): Promise<TracesResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = params.startDate
      ? formatISOForClickHouse(params.startDate)
      : getDefaultTracesStartDate();
    const endDate = params.endDate
      ? formatISOForClickHouse(params.endDate)
      : getCurrentDateForClickHouse();

    const userIdClause = params.userId
      ? `AND UserId = {userId:String}`
      : '';

    const sessionIdClause = params.sessionId
      ? `AND SessionId = {sessionId:String}`
      : '';

    // Exact match on TraceName. Every span in a trace carries the
    // same TraceName (set once per trace), so filtering at span level
    // correctly scopes to matching traces.
    const nameClause = params.name
      ? `AND TraceName = {name:String}`
      : '';

    // Tag filter — trace has ANY of the listed tags (OR semantics).
    // `hasAny` takes the haystack array (Tags column) and the needle
    // array (the query values).
    const tagsClause = params.tags?.length
      ? `AND hasAny(Tags, {tags:Array(String)})`
      : '';

    // Commit SHA filter — exact match on the dedicated CommitSha
    // column. Set by the SDK/forwarder when git context is available
    // at trace time; useful for attributing regressions to deploys.
    const commitShaClause = params.commitSha
      ? `AND CommitSha = {commitSha:String}`
      : '';

    // Env scoping. `Environment` is span-grain
    // but trace-uniform — every span of a trace carries the same env tag —
    // so it is safe as an outer-query predicate alongside the other
    // trace-level clauses (TraceId/SessionId/UserId/name/tags/commitSha).
    const envClause = buildEnvironmentWhereClause('Environment', {
      environment: params.environment,
      environments: params.environments,
    });

    const filterClause = params.filters?.length
      ? buildSplitFilterWhereClause(params.filters, appId, tenantId)
      : { innerClause: '', outerClause: '', params: {} };

    const sortColumn = (params.sortBy && TRACE_SORT_FIELD_MAP.get(params.sortBy)) || 'start';
    const sortOrder = params.sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Two-step trace query: an inner subquery finds traces that have at
    // least one span matching the span-level filters; the outer rollup then
    // aggregates over ALL spans of those traces. Without this split, span
    // filters drop sibling rows before GROUP BY, contaminating cost/tokens/
    // span_count/latency/name/status/tags with "matching-spans-only" values.
    //
    // Trace-level predicates (TraceId/SessionId/UserId, plus the dedicated
    // userId/sessionId/name/tags/commitSha clauses) are safe in
    // the outer because every span of a trace carries the same value.
    //
    // Base guards (AppId/TenantId/IsDeleted/Timestamp/retention) apply at
    // span grain in BOTH halves — required for retention/soft-delete to
    // work correctly.
    const innerSubquery = `
      SELECT DISTINCT TraceId
      FROM otel_traces FINAL
      WHERE AppId = {appId:String}
        AND TenantId = {tenantId:String}
        AND IsDeleted = 0
        AND Timestamp >= {startDate:DateTime64}
        AND Timestamp <= {endDate:DateTime64}
        AND Timestamp >= {retentionCutoff:DateTime64(3)}
        ${filterClause.innerClause}
    `;

    const innerScopeClause = filterClause.innerClause
      ? `AND TraceId IN (${innerSubquery})`
      : '';

    const listQuery = `
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
        arrayDistinct(groupArrayArray(Tags)) as tags,
        any(Environment) as environment,
        any(EnvironmentVersion) as environment_version
      FROM otel_traces FINAL
      WHERE AppId = {appId:String}
        AND TenantId = {tenantId:String}
        AND IsDeleted = 0
        AND Timestamp >= {startDate:DateTime64}
        AND Timestamp <= {endDate:DateTime64}
        AND Timestamp >= {retentionCutoff:DateTime64(3)}
        ${userIdClause}
        ${sessionIdClause}
        ${nameClause}
        ${tagsClause}
        ${commitShaClause}
        ${envClause.clause}
        ${innerScopeClause}
        ${filterClause.outerClause}
      GROUP BY TraceId
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    const countQuery = `
      SELECT count(DISTINCT TraceId) as total
      FROM otel_traces FINAL
      WHERE AppId = {appId:String}
        AND TenantId = {tenantId:String}
        AND IsDeleted = 0
        AND Timestamp >= {startDate:DateTime64}
        AND Timestamp <= {endDate:DateTime64}
        AND Timestamp >= {retentionCutoff:DateTime64(3)}
        ${userIdClause}
        ${sessionIdClause}
        ${nameClause}
        ${tagsClause}
        ${commitShaClause}
        ${envClause.clause}
        ${innerScopeClause}
        ${filterClause.outerClause}
    `;

    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);
    const queryParams: Record<string, unknown> = {
      appId,
      tenantId,
      startDate,
      endDate,
      retentionCutoff,
      limit: params.limit,
      offset: params.offset,
      ...filterClause.params,
      ...envClause.params,
    };
    if (params.userId) {
      queryParams.userId = params.userId;
    }
    if (params.sessionId) {
      queryParams.sessionId = params.sessionId;
    }
    if (params.name) {
      queryParams.name = params.name;
    }
    if (params.tags?.length) {
      queryParams.tags = params.tags;
    }
    if (params.commitSha) {
      queryParams.commitSha = params.commitSha;
    }

    const [listResult, countResult] = await Promise.all([
      this.client.query({
        query: listQuery,
        query_params: queryParams,
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: countQuery,
        query_params: queryParams,
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
        format: 'JSONEachRow',
      }),
    ]);

    const rawTraces = await listResult.json<RawTraceSummary>();
    const countData = await countResult.json<{ total: string }>();

    const summaries = rawTraces.map((row: RawTraceSummary) => this.transformTraceSummary(row));

    // I/O preview: a second, bounded query reads truncated
    // input/output for ONLY this page's traces — never widening the hot-path
    // list aggregation with the heavy Input/Output columns. Best-effort: a
    // preview failure must degrade to "no preview", never fail the list.
    await this.attachTraceIOPreviews(ctx, rawTraces, summaries, envClause);

    return {
      traces: summaries,
      total: parseInt(countData[0]?.total || '0', 10),
      limit: params.limit,
      offset: params.offset,
    };
  }

  /**
   * Fetches truncated trace-level I/O for a page of traces and assigns
   * `inputPreview` / `outputPreview` onto the matching summaries in place.
   *
   * Bounds the scan to the page's `[min(start), max(end)]` window (derived from
   * the list rows) plus a `TraceId IN (...)` filter, so ClickHouse reads I/O
   * only for the visible rows' root + GENERATION spans. Previews are derived
   * with the canonical `deriveTraceIO()` so the list and the detail drawer agree
   * on what a trace's input/output is.
   */
  private async attachTraceIOPreviews(
    ctx: TenantContext,
    rawTraces: RawTraceSummary[],
    summaries: TraceSummary[],
    envClause: { clause: string; params: Record<string, unknown> },
  ): Promise<void> {
    // Empty page ⇒ no window ⇒ nothing to fetch (also avoids `TraceId IN ()`).
    const window = pageTimeWindow(rawTraces);
    if (!window) return;

    try {
      const { appId, tenantId } = ctx;
      const dataRetentionDays = ctx.dataRetentionDays ?? -1;

      const result = await this.client.query({
        query: buildTraceIOPreviewQuery(envClause.clause),
        query_params: {
          appId,
          tenantId,
          retentionCutoff: formatRetentionCutoff(dataRetentionDays),
          windowStart: window.start,
          windowEnd: window.end,
          traceIds: summaries.map((s) => s.id),
          ioPreviewChars: TRACE_IO_PREVIEW_MAX_CHARS,
          ...envClause.params,
        },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      });

      const rows = await result.json<{
        trace_id: string;
        parent_id: string;
        type: string;
        timestamp: string;
        input: string;
        output: string;
      }>();

      // Canonical "rows → one preview per trace" step (root span wins,
      // GENERATION fallback) — shared with the local CLI server via
      // shared-utils so cloud and local can never derive previews differently.
      applyTraceIOPreviews(
        summaries,
        rows.map((row) => ({
          traceId: row.trace_id,
          parentId: row.parent_id,
          type: row.type,
          timestamp: row.timestamp,
          input: row.input,
          output: row.output,
        })),
      );
    } catch (error) {
      // Preview is a non-essential enrichment — degrade to no preview rather
      // than failing the whole trace list. Log (don't swallow): a broken
      // preview query should be visible to ops, not silently show blank rows.
      console.error('attachTraceIOPreviews', error, ctx.appId as string);
    }
  }

  async getTraceDetail(
    ctx: TenantContext,
    traceId: string,
    env?: EnvironmentQueryScope,
  ): Promise<TraceDetail | null> {
    return this.fetchTraceDetailWithScores(ctx, traceId, TRACE_DETAIL_QUERY, 'getTraceDetail', env);
  }

  async getTraceDetailLightweight(
    ctx: TenantContext,
    traceId: string,
    env?: EnvironmentQueryScope,
  ): Promise<TraceDetail | null> {
    return this.fetchTraceDetailWithScores(
      ctx,
      traceId,
      TRACE_DETAIL_LIGHTWEIGHT_QUERY,
      'getTraceDetailLightweight',
      env,
    );
  }

  async getSpanIO(
    ctx: TenantContext,
    traceId: string,
    spanId: string,
    env?: EnvironmentQueryScope,
  ): Promise<SpanIO | null> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    // Defense-in-depth: inject env filter when the caller is bound to a
    // specific environment. `SPAN_IO_QUERY` is a constant but
    // the env clause is spliced before `LIMIT 1` so the query still uses
    // ClickHouse's typed parameter binding.
    const envFilter = env
      ? buildEnvironmentWhereClause('Environment', env)
      : { clause: '', params: {} };

    const spanQuery = envFilter.clause
      ? SPAN_IO_QUERY.replace(/\nLIMIT 1/, `\n  ${envFilter.clause}\nLIMIT 1`)
      : SPAN_IO_QUERY;

    const result = await this.client.query({
      query: spanQuery,
      query_params: {
        appId,
        tenantId,
        traceId,
        spanId,
        retentionCutoff: formatRetentionCutoff(dataRetentionDays),
        ...envFilter.params,
      },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const rows = await result.json<{ input: string; output: string; output_object: string; tool_calls: string; blob_refs?: string; metadata: unknown }>();

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0]!;
    return {
      input: row.input,
      output: row.output,
      outputObject: row.output_object || null,
      toolCalls: row.tool_calls || null,
      blobRefs: row.blob_refs || undefined,
      metadata: parseMetadata(row.metadata),
    };
  }

  async getDistinctMetadataKeys(ctx: TenantContext): Promise<string[]> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const result = await this.client.query({
      query: DISTINCT_METADATA_KEYS_QUERY,
      query_params: {
        appId,
        tenantId,
        retentionCutoff: formatRetentionCutoff(dataRetentionDays),
      },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const data = await result.json<{ key: string }>();
    return data.map((row) => row.key);
  }

  private async fetchTraceDetailWithScores(
    ctx: TenantContext,
    traceId: string,
    baseQuery: string,
    logLabel: string,
    env?: EnvironmentQueryScope,
  ): Promise<TraceDetail | null> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    // Defense-in-depth: inject env filter when the caller is bound to a
    // specific environment. The base query is a constant
    // string ending in `ORDER BY Timestamp ASC`; we append the env clause
    // BEFORE the ORDER BY by interpolating into a wrapper subquery is fragile,
    // so instead we append it after the last WHERE clause but before ORDER BY
    // by building the query dynamically.
    const envFilter = env
      ? buildEnvironmentWhereClause('Environment', env)
      : { clause: '', params: {} };

    // Inject env clause: the base queries have `AND IsDeleted = 0\n  AND Timestamp >= ...`
    // as their last WHERE clause before ORDER BY. We append the env clause between
    // the Timestamp line and ORDER BY by string-replacing the `\nORDER BY` boundary.
    let query = envFilter.clause
      ? baseQuery.replace(/\nORDER BY/, `\n  ${envFilter.clause}\nORDER BY`)
      : baseQuery;

    // Perf: narrow the by-TraceId scan with the trace's [min, max] Timestamp
    // from the small `otel_traces_trace_id_ts` lookup (see
    // TRACE_ID_TIME_RANGE_QUERY). Strictly an optimization — when the lookup
    // returns nothing (trace unknown to it) or fails (e.g. table not yet
    // migrated), fall back to the unbounded query so behavior is identical.
    const timeRangeParams: Record<string, unknown> = {};
    const timeRange = await this.lookupTraceTimeRange(ctx, traceId);
    if (timeRange) {
      query = query.replace(
        /\nORDER BY/,
        `\n  AND Timestamp >= {tsRangeStart:DateTime64(9)}\n  AND Timestamp <= {tsRangeEnd:DateTime64(9)}\nORDER BY`,
      );
      timeRangeParams.tsRangeStart = timeRange.start;
      timeRangeParams.tsRangeEnd = timeRange.end;
    }

    const result = await this.client.query({
      query,
      query_params: {
        appId,
        tenantId,
        traceId,
        retentionCutoff: formatRetentionCutoff(dataRetentionDays),
        ...envFilter.params,
        ...timeRangeParams,
      },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const spans = await result.json<RawSpan>();

    if (spans.length === 0) {
      return null;
    }

    const traceDetail = this.transformTraceDetail(traceId, spans);

    // Scores can be keyed by either:
    //   - SpanId (annotations, some eval paths) → shown on the matching span
    //   - TraceId (CLI experiments — postExperimentScores uses evt.traceId) →
    //     shown under the trace-level root node
    // Include both IDs in the batch query so the drawer surfaces scores
    // regardless of which key the writer chose.
    const spanIds = spans.map((s) => s.id);
    const resourceIds = Array.from(new Set([...spanIds, traceId]));
    let spanScoresError = false;
    const spanScores = await this.scoresService.getScoresBySpanIds(ctx, resourceIds).catch((error) => {
      console.error(`${logLabel}:getScoresBySpanIds`, error, appId as string);
      spanScoresError = true;
      return {} as Record<string, Score[]>;
    });

    return { ...traceDetail, spanScores, ...(spanScoresError ? { spanScoresError: true } : {}) };
  }

  /**
   * Resolves the [min, max] span Timestamp for a trace from the
   * `otel_traces_trace_id_ts` lookup table. Returns null when the trace is
   * unknown to the lookup OR the query fails for any reason (e.g. the lookup
   * table doesn't exist yet) — callers must treat null as "query unbounded",
   * never as "trace missing".
   */
  private async lookupTraceTimeRange(
    ctx: TenantContext,
    traceId: string,
  ): Promise<{ start: string; end: string } | null> {
    try {
      const result = await this.client.query({
        query: TRACE_ID_TIME_RANGE_QUERY,
        query_params: {
          appId: ctx.appId,
          tenantId: ctx.tenantId,
          traceId,
        },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      });
      const rows = await result.json<{ start: string; end: string }>();
      const row = rows[0];
      if (!row || !row.start || !row.end) {
        return null;
      }
      return { start: row.start, end: row.end };
    } catch {
      // Lookup is a pure optimization — degrade to the unbounded scan.
      return null;
    }
  }

  private transformTraceSummary(raw: RawTraceSummary): TraceSummary {
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => t.length > 0) : [];
    return {
      id: raw.id,
      name: raw.name || 'Unnamed Trace',
      status: raw.status,
      // ClickHouse serializes DateTime64 as a zoneless 'YYYY-MM-DD HH:mm:ss.SSS'
      // string; the wire schema declares start/end as ISO-8601 UTC. Without this
      // the dashboard does `new Date(zoneless)` → parsed as LOCAL, so the trace
      // list shows times shifted by the viewer's UTC offset (GAP-0013, same fix
      // as the trace-detail span timestamp below).
      start: clickHouseToISO(raw.start),
      end: clickHouseToISO(raw.end),
      latencyMs: toNumber(raw.latency_ms),
      cost: toNumber(raw.cost),
      tokens: toNumber(raw.tokens),
      spanCount: toNumber(raw.span_count),
      ...(tags.length > 0 ? { tags } : {}),
      // Env tag. Always surfaced — `''` is the legacy marker
      // the UI keys its "legacy" chip off, so it must not be elided.
      environment: raw.environment ?? '',
      environmentVersion: toNumber(raw.environment_version),
    };
  }

  transformTraceDetail(traceId: string, rawSpans: RawSpan[]): TraceDetail {
    const spans: Span[] = rawSpans.map((raw) => ({
      id: raw.id,
      traceId: raw.trace_id,
      parentId: raw.parent_id || null,
      name: raw.name,
      status: raw.status,
      statusMessage: raw.status_message || '',
      durationMs: toNumber(raw.duration_ms),
      // ClickHouse serializes the DateTime64 `Timestamp` as a zoneless
      // 'YYYY-MM-DD HH:mm:ss.SSS' string; the wire schema declares span
      // `timestamp` (and the derived trace `start`/`end`, taken from
      // firstSpan/lastSpan.timestamp below) as z.string().datetime() (ISO-8601
      // UTC). Normalize here at the single source so every span-consuming
      // read path this service backs conforms.
      timestamp: clickHouseToISO(raw.timestamp),
      type: raw.type as 'SPAN' | 'GENERATION' | 'EVENT',
      model: raw.model || null,
      inputTokens: toNumber(raw.input_tokens),
      outputTokens: toNumber(raw.output_tokens),
      tokens: toNumber(raw.tokens),
      cost: toNumber(raw.cost),
      input: raw.input,
      output: raw.output,
      outputObject: raw.output_object || null,
      toolCalls: raw.tool_calls || null,
      blobRefs: raw.blob_refs || undefined,
      finishReason: raw.finish_reason || null,
      settings: raw.settings || null,
      reasoningTokens: toNumber(raw.reasoning_tokens),
      metadata: parseMetadata(raw.metadata),
      props: raw.props || null,
      spanKind: raw.span_kind || 'INTERNAL',
      serviceName: raw.service_name || '',
    }));

    const firstSpan = spans[0];
    const lastSpan = spans[spans.length - 1];
    const generationSpans = spans.filter((s) => s.type === 'GENERATION');
    const totalCost = generationSpans.reduce((sum, s) => sum + s.cost, 0);
    const totalTokens = generationSpans.reduce((sum, s) => sum + s.tokens, 0);

    // Trace-level I/O: canonical shared derivation (root span first — the
    // WebhookRunner records agentmark.input/output there — falling back to
    // first/last GENERATION span), from `@repo/shared-utils/trace-io` so
    // every trace-detail consumer of this service agrees on the same rule.
    const traceIO = deriveTraceIO(spans);

    const rootSpan = spans.find((s) => !s.parentId) || firstSpan;
    const rootRawSpan = rawSpans.find((s) => !s.parent_id) || rawSpans[0];

    const traceName = rootRawSpan?.trace_name && rootRawSpan.trace_name.length > 0
      ? rootRawSpan.trace_name
      : (rootSpan?.name || 'Unnamed Trace');

    const hasErrorSpan = spans.some((s) => s.status === 'ERROR');

    const userId = rootRawSpan?.user_id || undefined;
    const sessionId = rootRawSpan?.session_id || undefined;

    return {
      id: traceId,
      name: traceName,
      status: hasErrorSpan ? 'ERROR' : (rootSpan?.status || 'UNKNOWN'),
      start: firstSpan?.timestamp || '',
      end: lastSpan?.timestamp || '',
      latencyMs: spans.reduce((max, s) => Math.max(max, s.durationMs), 0),
      cost: totalCost,
      tokens: totalTokens,
      ...(traceIO.input !== undefined ? { input: traceIO.input as string } : {}),
      ...(traceIO.output !== undefined ? { output: traceIO.output as string } : {}),
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      spans,
    };
  }
}
