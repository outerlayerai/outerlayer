/**
 * Metrics Sub-Service
 *
 * Handles dashboard metrics, model stats, ranking data, aggregate requests,
 * percentiles, extended metrics, and span kind breakdown.
 */

import type { IClickHouseQuery } from '../client';
import { formatISOForClickHouse, getDefaultTracesStartDate, getCurrentDateForClickHouse, isoToClickHouseDate } from '../date-utils';
import {
  METRICS_SUMMARY_QUERY,
  METRICS_TIME_SERIES_QUERY,
  MODEL_COUNT_QUERY,
  SPAN_KIND_BREAKDOWN_QUERY,
  buildFilteredMetricsSummaryQuery,
  buildFilteredHourlyTimeSeriesQuery,
  buildFilteredDailyTimeSeriesQuery,
  buildFilteredModelStatsQuery,
  buildFilteredPercentilesQuery,
  buildRankingByDimensionQuery,
  buildPaginatedRankingQuery,
  SORT_FIELD_MAP,
  dimensionToClickHouseColumn,
} from '../queries';
import type {
  DateRange,
  MetricsResponse,
  ModelStatsResponse,
  PercentilesParams,
  PercentilesResponse,
  ExtendedMetricsSummary,
  ExtendedMetricsResponse,
  AnalyticsFilter,
  RankingDataResponse,
  RankingDataItem,
  AggregateRequestsParams,
  AggregateRequestsResponse,
  AggregateRequestsRow,
  SpanKindBreakdownRecord,
} from '../types';
import type { TenantContext } from '../tenant-context';
import {
  buildFilterWhereClause,
  buildEnvironmentWhereClause,
  formatRetentionCutoff,
  formatRetentionCutoffDate,
  QUERY_TIMEOUT_SETTINGS,
  toNumber,
  transformMetricsSummary,
  transformTimeSeriesPoint,
  transformModelStats,
  transformPercentilePoint,
  fillTimeSeriesGaps,
  getTokenColumn,
  resolveDateRange,
} from '../shared';
import type { EnvironmentQueryScope } from '../shared';

/**
 * Merges the env-scoping fragment into an existing
 * filter clause. The env clause is a self-contained `AND <Column> ...`
 * fragment over `otel_traces.Environment` — appending it to `filterClause`
 * (already a chain of `AND ...` fragments) keeps the metrics queries
 * env-aware without a query-builder change. Empty `env` is a no-op.
 */
function mergeEnvClause(
  filterResult: { clause: string; params: Record<string, unknown> },
  env: EnvironmentQueryScope | undefined,
): { clause: string; params: Record<string, unknown> } {
  if (!env || (!env.environment && !(env.environments && env.environments.length > 0))) {
    return filterResult;
  }
  const envResult = buildEnvironmentWhereClause('Environment', env);
  if (!envResult.clause) return filterResult;
  return {
    clause: `${filterResult.clause} ${envResult.clause}`.trim(),
    params: { ...filterResult.params, ...envResult.params },
  };
}
import type { RawMetricsSummary, RawTimeSeriesPoint, RawModelStats, RawRankingRow, RawPercentilePoint } from '../shared';

export class MetricsService {
  constructor(private readonly client: IClickHouseQuery) {}

  async getMetrics(
    ctx: TenantContext,
    dateRange: DateRange,
    filters?: AnalyticsFilter[],
    env?: EnvironmentQueryScope,
  ): Promise<MetricsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const useHourlyGranularity = dateRange.start === dateRange.end;
    const filterResult = mergeEnvClause(
      buildFilterWhereClause(filters, appId, tenantId),
      env,
    );
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    // Queries here bind {startDate:Date} / {endDate:Date} so they can hit
    // the daily-keyed projections (proj_hourly / proj_by_model / proj_by_user).
    // ClickHouse's Date parser rejects full ISO datetimes — Schemathesis
    // caught this by passing `2000-01-01T00:00:00Z` and crashing with
    // "only 10 of 20 bytes was parsed". Normalize through isoToClickHouseDate
    // which parses via `new Date` and extracts the UTC date — handles any
    // ISO-8601 input including timezone offsets.
    const startDate = isoToClickHouseDate(dateRange.start);
    const endDate = isoToClickHouseDate(dateRange.end);
    const queryInput = {
      appId,
      tenantId,
      startDate,
      endDate,
      filterClause: filterResult.clause,
      retentionCutoff,
    };

    const summaryQueryResult = buildFilteredMetricsSummaryQuery(queryInput);
    const timeSeriesQueryResult = useHourlyGranularity
      ? buildFilteredHourlyTimeSeriesQuery(queryInput)
      : buildFilteredDailyTimeSeriesQuery(queryInput);

    const summaryParams = { ...summaryQueryResult.params, ...filterResult.params };
    const timeSeriesParams = { ...timeSeriesQueryResult.params, ...filterResult.params };

    const [summaryResult, timeSeriesResult] = await Promise.all([
      this.client.query({
        query: summaryQueryResult.query,
        query_params: summaryParams,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
      this.client.query({
        query: timeSeriesQueryResult.query,
        query_params: timeSeriesParams,
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
    ]);

    const summaryData = await summaryResult.json<RawMetricsSummary>();
    const timeSeriesData = await timeSeriesResult.json<RawTimeSeriesPoint>();

    const filledTimeSeries = fillTimeSeriesGaps(timeSeriesData, dateRange, useHourlyGranularity);

    return {
      summary: transformMetricsSummary(summaryData[0]),
      timeSeries: filledTimeSeries.map((row: RawTimeSeriesPoint) => transformTimeSeriesPoint(row)),
    };
  }

  async getModelStats(
    ctx: TenantContext,
    dateRange: DateRange,
    limit: number = 10,
    filters?: AnalyticsFilter[],
    env?: EnvironmentQueryScope,
  ): Promise<ModelStatsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const filterResult = mergeEnvClause(
      buildFilterWhereClause(filters, appId, tenantId),
      env,
    );

    const queryResult = buildFilteredModelStatsQuery({
      appId,
      tenantId,
      // buildFilteredModelStatsQuery binds startDate/endDate as `Date` —
      // normalize via isoToClickHouseDate so offset timezones and full
      // ISO datetimes are handled correctly. See getMetrics for context.
      startDate: isoToClickHouseDate(dateRange.start),
      endDate: isoToClickHouseDate(dateRange.end),
      filterClause: filterResult.clause,
      limit,
      retentionCutoff: formatRetentionCutoff(dataRetentionDays),
    });

    const allParams = { ...queryResult.params, ...filterResult.params };

    const result = await this.client.query({
      query: queryResult.query,
      query_params: allParams,
      clickhouse_settings: {
        use_query_cache: 1,
        query_cache_ttl: 60,
        ...QUERY_TIMEOUT_SETTINGS,
      },
      format: 'JSONEachRow',
    });

    const data = await result.json<RawModelStats>();

    return {
      models: data.map((row: RawModelStats) => transformModelStats(row)),
    };
  }

  async getRankingData(
    ctx: TenantContext,
    dateRange: DateRange,
    dimension: string,
    limit: number = 10,
    filters?: AnalyticsFilter[],
    env?: EnvironmentQueryScope,
  ): Promise<RankingDataResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const groupByColumn = dimensionToClickHouseColumn(dimension);
    if (!groupByColumn) {
      return { items: [] };
    }

    const filterResult = mergeEnvClause(
      buildFilterWhereClause(filters, appId, tenantId),
      env,
    );
    const queryResult = buildRankingByDimensionQuery({
      appId,
      tenantId,
      // Date-bound binding — see getMetrics for rationale.
      startDate: isoToClickHouseDate(dateRange.start),
      endDate: isoToClickHouseDate(dateRange.end),
      filterClause: filterResult.clause,
      limit,
      groupByColumn,
      retentionCutoff: formatRetentionCutoff(dataRetentionDays),
    });

    const allParams = { ...queryResult.params, ...filterResult.params };

    const result = await this.client.query({
      query: queryResult.query,
      query_params: allParams,
      clickhouse_settings: {
        use_query_cache: 1,
        query_cache_ttl: 60,
        ...QUERY_TIMEOUT_SETTINGS,
      },
      format: 'JSONEachRow',
    });

    const data = await result.json<RawRankingRow>();

    return {
      items: data.map((row: RawRankingRow): RankingDataItem => ({
        dimensionValue: row.dimension_value,
        requests: Number(row.total_requests),
        cost: Number(row.cost),
        tokens: Number(row.tokens),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        avgLatencyMs: Number(row.avg_latency_ms),
        successRate: Number(row.success_rate),
      })),
    };
  }

  async getAggregateRequests(
    ctx: TenantContext,
    params: AggregateRequestsParams,
  ): Promise<AggregateRequestsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const groupByColumn = dimensionToClickHouseColumn(params.dimension);
    if (!groupByColumn) {
      return { items: [], total: 0, limit: params.limit, offset: params.offset };
    }

    const startDate = (params.startDate || getDefaultTracesStartDate()).slice(0, 10);
    const endDate = (params.endDate || getCurrentDateForClickHouse()).slice(0, 10);

    // Env scope must reach the SQL itself, not just a cache key — these
    // queries run with `use_query_cache`, so two envs sharing one query
    // text would cross-serve each other's cached aggregates.
    const filterResult = mergeEnvClause(
      buildFilterWhereClause(params.filters, appId, tenantId),
      params.env,
    );
    const sortAlias =
      (params.sortField && SORT_FIELD_MAP.get(params.sortField)) || 'total_requests';

    const { dataQuery, countQuery } = buildPaginatedRankingQuery({
      appId,
      tenantId,
      startDate,
      endDate,
      filterClause: filterResult.clause,
      limit: params.limit,
      offset: params.offset,
      groupByColumn,
      sortAlias,
      sortOrder: params.sortOrder,
      retentionCutoff: formatRetentionCutoff(dataRetentionDays),
    });

    const allDataParams = { ...dataQuery.params, ...filterResult.params };
    const allCountParams = { ...countQuery.params, ...filterResult.params };

    const [dataResult, countResult] = await Promise.all([
      this.client.query({
        query: dataQuery.query,
        query_params: allDataParams,
        clickhouse_settings: {
          use_query_cache: 1,
          query_cache_ttl: 60,
          ...QUERY_TIMEOUT_SETTINGS,
        },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: countQuery.query,
        query_params: allCountParams,
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
        format: 'JSONEachRow',
      }),
    ]);

    const data = await dataResult.json<RawRankingRow>();
    const countData = await countResult.json<{ total: string }>();

    return {
      items: data.map((row: RawRankingRow): AggregateRequestsRow => ({
        dimensionValue: row.dimension_value,
        requests: Number(row.total_requests),
        cost: Number(row.cost),
        tokens: Number(row.tokens),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        avgLatencyMs: Number(row.avg_latency_ms),
        successRate: Number(row.success_rate),
      })),
      total: parseInt(countData[0]?.total || '0', 10),
      limit: params.limit,
      offset: params.offset,
    };
  }

  async getPercentiles(
    ctx: TenantContext,
    params: PercentilesParams,
    filters?: AnalyticsFilter[],
    env?: EnvironmentQueryScope,
  ): Promise<PercentilesResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const dateRange = resolveDateRange(params.range, params.startDate, params.endDate);
    const filterResult = mergeEnvClause(
      buildFilterWhereClause(filters, appId, tenantId),
      env,
    );

    const startDateTime = `${dateRange.start} 00:00:00.000`;
    const endDateTime = `${dateRange.end} 23:59:59.999`;

    const metricColumn: 'Duration' | 'TotalTokens' | 'InputTokens' | 'OutputTokens' =
      params.metric === 'latency'
        ? 'Duration'
        : getTokenColumn(params.metric) as 'TotalTokens' | 'InputTokens' | 'OutputTokens';

    const queryResult = buildFilteredPercentilesQuery({
      appId,
      tenantId,
      startDateTime,
      endDateTime,
      metricColumn,
      filterClause: filterResult.clause,
      retentionCutoff: formatRetentionCutoff(dataRetentionDays),
    });

    const allParams = { ...queryResult.params, ...filterResult.params };

    const result = await this.client.query({
      query: queryResult.query,
      query_params: allParams,
      clickhouse_settings: {
        use_query_cache: 1,
        query_cache_ttl: 30,
        ...QUERY_TIMEOUT_SETTINGS,
      },
      format: 'JSONEachRow',
    });

    const data = await result.json<RawPercentilePoint>();

    return {
      metric: params.metric,
      data: data.map((row: RawPercentilePoint) => transformPercentilePoint(row)),
    };
  }

  async getExtendedMetrics(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ExtendedMetricsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);
    const retentionCutoffDate = formatRetentionCutoffDate(dataRetentionDays);
    // See getMetrics above for rationale. Normalizes any ISO-8601 input
    // (including offset timezones) to a UTC `YYYY-MM-DD` string.
    const startDateOnly = isoToClickHouseDate(dateRange.start);
    const endDateOnly = isoToClickHouseDate(dateRange.end);

    // Env-scope the extended metrics queries by appending
    // the env WHERE fragment to the static query strings.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };

    const baseParams = {
      appId,
      tenantId,
      startDate: startDateOnly,
      endDate: endDateOnly,
      retentionCutoffDate,
      ...envFilter.params,
    };

    // Inject env clause into the WHERE clause (before GROUP BY for time-series).
    const summaryQuery = envFilter.clause
      ? METRICS_SUMMARY_QUERY.trimEnd() + `\n  ${envFilter.clause}`
      : METRICS_SUMMARY_QUERY;
    const timeSeriesQuery = envFilter.clause
      ? METRICS_TIME_SERIES_QUERY.replace('GROUP BY date, hour', `  ${envFilter.clause}\nGROUP BY date, hour`)
      : METRICS_TIME_SERIES_QUERY;

    const [summaryResult, timeSeriesResult, modelCountResult] = await Promise.all([
      this.client.query({
        query: summaryQuery,
        query_params: baseParams,
        clickhouse_settings: {
          use_query_cache: 1,
          query_cache_ttl: 60,
          ...QUERY_TIMEOUT_SETTINGS,
        },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: timeSeriesQuery,
        query_params: baseParams,
        clickhouse_settings: {
          use_query_cache: 1,
          query_cache_ttl: 60,
          ...QUERY_TIMEOUT_SETTINGS,
        },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: MODEL_COUNT_QUERY,
        query_params: {
          appId,
          tenantId,
          startDate: formatISOForClickHouse(dateRange.start),
          endDate: formatISOForClickHouse(dateRange.end),
          retentionCutoff,
        },
        format: 'JSONEachRow',
      }),
    ]);

    const summaryData = await summaryResult.json<RawMetricsSummary>();
    const timeSeriesData = await timeSeriesResult.json<RawTimeSeriesPoint>();
    const modelCountData = await modelCountResult.json<{ model_count: string }>();

    const baseSummary = transformMetricsSummary(summaryData[0]);
    const modelCount = toNumber(modelCountData[0]?.model_count);

    const totalRequests = baseSummary.totalRequests || 1;
    const extendedSummary: ExtendedMetricsSummary = {
      ...baseSummary,
      avgCostPerRequest: baseSummary.totalCost / totalRequests,
      avgInputTokensPerRequest: baseSummary.inputTokens / totalRequests,
      avgOutputTokensPerRequest: baseSummary.outputTokens / totalRequests,
      avgTotalTokensPerRequest: baseSummary.totalTokens / totalRequests,
      modelCount,
    };

    return {
      summary: extendedSummary,
      timeSeries: timeSeriesData.map((row: RawTimeSeriesPoint) => transformTimeSeriesPoint(row)),
    };
  }

  async getSpanKindBreakdown(
    ctx: TenantContext,
    dateRange: { startDate: string; endDate: string },
  ): Promise<SpanKindBreakdownRecord[]> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const result = await this.client.query({
      query: SPAN_KIND_BREAKDOWN_QUERY,
      query_params: {
        appId,
        tenantId,
        // SPAN_KIND_BREAKDOWN_QUERY binds Date — normalize ISO input.
        startDate: isoToClickHouseDate(dateRange.startDate),
        endDate: isoToClickHouseDate(dateRange.endDate),
        retentionCutoffDate: formatRetentionCutoffDate(dataRetentionDays),
      },
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      format: 'JSONEachRow',
    });

    const raw = await result.json<{ kind: string; count: string; avg_latency_ms: string; total_cost: string; total_tokens: string }>();
    return raw.map((row) => ({
      kind: row.kind,
      count: parseInt(row.count, 10),
      avgLatencyMs: parseFloat(row.avg_latency_ms),
      totalCost: parseFloat(row.total_cost),
      totalTokens: parseInt(row.total_tokens, 10),
    }));
  }
}
