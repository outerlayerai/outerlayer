/**
 * Scores Sub-Service
 *
 * Handles score listing, aggregations, score analytics (histogram, trend,
 * comparison, scatter), and score type detection.
 */

import type { IClickHouseQuery } from '../client';
import { formatISOForClickHouse, getDefaultTracesStartDate, getCurrentDateForClickHouse, clickHouseToISO } from '../date-utils';
import {
  SCORES_BY_RESOURCE_QUERY,
  SCORES_BY_RESOURCE_IDS_QUERY,
  SCORES_AGGREGATIONS_QUERY,
  SCORE_LABELS_QUERY,
  buildScoresListQuery,
  buildScoresCountQuery,
  buildScoreAggregationsQuery,
  buildScoreHistogramQuery,
  buildScoreCategoryCountsQuery,
  buildScoreTrendQuery,
  buildScoreComparisonQuery,
  buildScoreMatchedCountQuery,
  buildScoreScatterQuery,
} from '../queries';
import type {
  ScoresParams,
  ScoresResponse,
  Score,
  ScoreAggregation,
  ScoreAggregationsResponse,
  ScoreNamesResponse,
  DateRange,
  ScoreType,
  ScoreHistogramResponse,
  ScoreTrendResponse,
  ScoreTrendInterval,
  ScoreComparisonResponse,
  ScoreScatterResponse,
} from '../types';
import type { TenantContext } from '../tenant-context';
import {
  formatRetentionCutoff,
  formatRetentionCutoffDate,
  buildEnvironmentWhereClause,
  buildScoresFilterWhereClause,
  QUERY_TIMEOUT_SETTINGS,
  zeroFillTrendPoints,
  toNumber,
} from '../shared';
import type { RawScore, RawScoreAggregation } from '../shared';
import type { EnvironmentQueryScope } from '../shared';

export class ScoresService {
  constructor(private readonly client: IClickHouseQuery) {}

  async getScores(ctx: TenantContext, params: ScoresParams): Promise<ScoresResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const startDate = params.startDate
      ? formatISOForClickHouse(params.startDate)
      : getDefaultTracesStartDate();
    const endDate = params.endDate
      ? formatISOForClickHouse(params.endDate)
      : getCurrentDateForClickHouse();

    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);
    const isResourceQuery = !!params.resourceId;

    const sessionId = params.sessionId;
    const sessionParams = sessionId ? { sessionId } : {};

    // Env scoping. The `scores` table
    // has its own denormalized `Environment` column — same empty-string
    // legacy convention as `otel_traces`. Resource-keyed lookups (scores
    // for one trace/span) are not env-filtered: the resource id already
    // pins the row set.
    const env = buildEnvironmentWhereClause('Environment', {
      environment: params.environment,
      environments: params.environments,
    });
    const envClause = isResourceQuery ? '' : env.clause;
    const envParams = isResourceQuery ? {} : env.params;

    // Structured filters (POST /v1/scores/search). Resource-keyed lookups
    // ignore them — the resource id already pins the row set.
    const filter = isResourceQuery
      ? { clause: '', params: {} }
      : buildScoresFilterWhereClause(params.filters);

    const [listResult, countResult] = await Promise.all([
      this.client.query({
        query: isResourceQuery
          ? SCORES_BY_RESOURCE_QUERY
          : buildScoresListQuery({ sessionId, envClause, filterClause: filter.clause }),
        query_params: isResourceQuery
          ? {
              appId,
              tenantId,
              resourceId: params.resourceId,
              limit,
              offset,
            }
          : {
              appId,
              tenantId,
              startDate,
              endDate,
              retentionCutoff,
              limit,
              offset,
              ...sessionParams,
              ...envParams,
              ...filter.params,
            },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
      this.client.query({
        query: buildScoresCountQuery({ sessionId, envClause, filterClause: filter.clause }),
        query_params: {
          appId,
          tenantId,
          startDate,
          endDate,
          retentionCutoff,
          ...sessionParams,
          ...envParams,
          ...filter.params,
        },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
    ]);

    const scores = await listResult.json<RawScore>();
    const countData = await countResult.json<{ total: string }>();

    return {
      scores: scores.map((row) => this.transformScore(row)),
      total: parseInt(countData[0]?.total || '0', 10),
      limit,
      offset,
    };
  }

  async getScoresBySpanIds(ctx: TenantContext, spanIds: string[]): Promise<Record<string, Score[]>> {
    if (spanIds.length === 0) return {};
    const { appId, tenantId } = ctx;

    const result = await this.client.query({
      query: SCORES_BY_RESOURCE_IDS_QUERY,
      query_params: { appId, tenantId, resourceIds: spanIds },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const scores = await result.json<RawScore>();

    const map: Record<string, Score[]> = {};
    for (const raw of scores) {
      const score = this.transformScore(raw);
      if (!map[score.resourceId]) map[score.resourceId] = [];
      map[score.resourceId]!.push(score);
    }
    return map;
  }

  async getScoreAggregations(
    ctx: TenantContext,
    dateRange: DateRange,
    env?: EnvironmentQueryScope,
  ): Promise<ScoreAggregationsResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = formatISOForClickHouse(dateRange.start);
    const endDate = formatISOForClickHouse(dateRange.end);
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    // Env-scope the aggregations query.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };

    const { query, params } = buildScoreAggregationsQuery({
      appId, tenantId, startDate, endDate, retentionCutoff,
      envClause: envFilter.clause,
    });

    const result = await this.client.query({
      query,
      query_params: { ...params, ...envFilter.params },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const data = await result.json<RawScoreAggregation>();

    return {
      aggregations: data.map((row) => this.transformScoreAggregation(row)),
    };
  }

  async getDistinctScoreNames(ctx: TenantContext, env?: EnvironmentQueryScope): Promise<ScoreNamesResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    // Env-scope the score names query. Build a dynamic
    // variant of DISTINCT_SCORE_NAMES_QUERY that injects the env clause
    // before ORDER BY so it is valid SQL.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };
    const query = `
SELECT DISTINCT Name as name
FROM scores FINAL
WHERE AppId = {appId:String}
  AND TenantId = {tenantId:String}
  AND IsDeleted = 0
  AND CreatedAt >= {retentionCutoff:DateTime64(3)}
  ${envFilter.clause}
ORDER BY name ASC
LIMIT 200
`;

    const result = await this.client.query({
      query,
      query_params: {
        appId,
        tenantId,
        retentionCutoff: formatRetentionCutoff(dataRetentionDays),
        ...envFilter.params,
      },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const data = await result.json<{ name: string }>();
    return { names: data.map((row) => row.name) };
  }

  async detectScoreType(ctx: TenantContext, name: string): Promise<ScoreType> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const result = await this.client.query({
      query: SCORE_LABELS_QUERY,
      query_params: {
        appId,
        tenantId,
        name,
        retentionCutoff: formatRetentionCutoff(dataRetentionDays),
      },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const labels = (await result.json<{ label: string }>()).map((r) => r.label);

    if (labels.length === 0) return 'numeric';

    const booleanLabels = new Set(['true', 'false']);
    const allBoolean = labels.every((l) => booleanLabels.has(l.toLowerCase()));
    return allBoolean ? 'boolean' : 'categorical';
  }

  async getScoreHistogram(
    ctx: TenantContext,
    name: string,
    dateRange: DateRange,
    source?: string,
    env?: EnvironmentQueryScope,
  ): Promise<ScoreHistogramResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = formatISOForClickHouse(dateRange.start);
    const endDate = formatISOForClickHouse(dateRange.end);
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    const scoreType = await this.detectScoreType(ctx, name);

    // Env-scope the histogram query.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };
    const baseInput = { appId, tenantId, name, startDate, endDate, retentionCutoff, source, envClause: envFilter.clause };

    if (scoreType === 'categorical' || scoreType === 'boolean') {
      const { query, params } = buildScoreCategoryCountsQuery(baseInput);

      const result = await this.client.query({
        query,
        query_params: { ...params, ...envFilter.params },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      });

      const data = await result.json<{ label: string; count: string }>();
      return {
        name,
        type: scoreType,
        buckets: [],
        categories: data.map((row) => ({ label: row.label, count: Number(row.count) })),
      };
    }

    // For numeric histogram, the bounds sub-query intentionally omits env
    // filtering: using the full-range min/max produces consistent bucket
    // widths across env switches, preventing disorienting axis rescaling.
    const aggResult = await this.client.query({
      query: SCORES_AGGREGATIONS_QUERY,
      query_params: { appId, tenantId, startDate, endDate, retentionCutoff },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const aggs = await aggResult.json<{ name: string; min_score: string; max_score: string }>();
    const scoreAgg = aggs.find((a) => a.name === name);

    if (!scoreAgg) {
      return { name, type: 'numeric', buckets: [], categories: [] };
    }

    const minScore = Number(scoreAgg.min_score);
    const maxScore = Number(scoreAgg.max_score);
    const range = maxScore - minScore;
    const bucketWidth = range === 0 ? 1 : range / 10;

    const { query, params } = buildScoreHistogramQuery({ ...baseInput, minScore, maxScore, bucketWidth });

    const result = await this.client.query({
      query,
      query_params: { ...params, ...envFilter.params },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const data = await result.json<{ bucket: string; count: string }>();
    return {
      name,
      type: 'numeric',
      buckets: data.map((row) => ({ bucket: Number(row.bucket), count: Number(row.count) })),
      categories: [],
    };
  }

  async getScoreTrend(
    ctx: TenantContext,
    name: string,
    interval: ScoreTrendInterval,
    dateRange: DateRange,
    source?: string,
    env?: EnvironmentQueryScope,
  ): Promise<ScoreTrendResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = formatISOForClickHouse(dateRange.start);
    const endDate = formatISOForClickHouse(dateRange.end);
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    const groupExprMap: Record<ScoreTrendInterval, string> = {
      hour: 'toStartOfHour(CreatedAt)',
      day: 'toStartOfDay(CreatedAt)',
      week: 'toStartOfWeek(CreatedAt, 1)',
      month: 'toStartOfMonth(CreatedAt)',
    };

    // Env-scope the trend query.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };

    const { query, params } = buildScoreTrendQuery(
      { appId, tenantId, name, startDate, endDate, retentionCutoff, source, envClause: envFilter.clause },
      groupExprMap[interval],
    );

    const result = await this.client.query({
      query,
      query_params: { ...params, ...envFilter.params },
      format: 'JSONEachRow',
      clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
    });

    const data = await result.json<{ timestamp: string; avgScore: string; count: string }>();
    const rawPoints = data.map((row) => ({
      // Normalize the zoneless ClickHouse bucket to ISO-8601 UTC so the trend
      // chart parses every point as UTC (zeroFillTrendPoints emits ISO fillers;
      // a raw zoneless data point would be `new Date()`-parsed as local and sit
      // at the wrong x-offset relative to the fillers).
      timestamp: clickHouseToISO(row.timestamp),
      avgScore: Number(row.avgScore),
      count: Number(row.count),
    }));

    const filledPoints = zeroFillTrendPoints(rawPoints, dateRange, interval);

    return {
      name,
      interval,
      points: filledPoints,
    };
  }

  async getScoreComparison(
    ctx: TenantContext,
    nameA: string,
    nameB: string,
    dateRange: DateRange,
    source?: string,
    env?: EnvironmentQueryScope,
  ): Promise<ScoreComparisonResponse> {
    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = formatISOForClickHouse(dateRange.start);
    const endDate = formatISOForClickHouse(dateRange.end);
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    const [typeA, typeB] = await Promise.all([
      this.detectScoreType(ctx, nameA),
      this.detectScoreType(ctx, nameB),
    ]);

    if (typeA === 'numeric' || typeB === 'numeric') {
      const err = new Error('Score type mismatch: cannot compare numeric scores in confusion matrix');
      (err as Error & { code: string }).code = 'SCORE_TYPE_MISMATCH';
      throw err;
    }

    if (typeA !== typeB) {
      const mismatchErr = new Error(`Score type mismatch: cannot compare ${typeA} and ${typeB} scores`);
      (mismatchErr as Error & { code: string }).code = 'SCORE_TYPE_MISMATCH';
      throw mismatchErr;
    }

    // Env-scope the comparison query.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };

    const compInput = {
      appId, tenantId, nameA, nameB, startDate, endDate, retentionCutoff,
      retentionCutoffDate: formatRetentionCutoffDate(dataRetentionDays),
      source,
      envClause: envFilter.clause,
    };
    const comparison = buildScoreComparisonQuery(compInput);
    const matchedCount = buildScoreMatchedCountQuery(compInput);

    const [matrixResult, countResult] = await Promise.all([
      this.client.query({
        query: comparison.query,
        query_params: { ...comparison.params, ...envFilter.params },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
      this.client.query({
        query: matchedCount.query,
        query_params: { ...matchedCount.params, ...envFilter.params },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
    ]);

    const matrixData = await matrixResult.json<{ labelA: string; labelB: string; count: string }>();
    const countData = await countResult.json<{ totalMatched: string; totalA: string; totalB: string }>();
    const counts = countData[0] ?? { totalMatched: '0', totalA: '0', totalB: '0' };

    return {
      nameA,
      nameB,
      type: typeA,
      matrix: matrixData.map((row) => ({
        labelA: row.labelA,
        labelB: row.labelB,
        count: Number(row.count),
      })),
      totalMatched: Number(counts.totalMatched),
      totalA: Number(counts.totalA),
      totalB: Number(counts.totalB),
    };
  }

  async getScoreScatter(
    ctx: TenantContext,
    nameA: string,
    nameB: string,
    dateRange: DateRange,
    source?: string,
    env?: EnvironmentQueryScope,
  ): Promise<ScoreScatterResponse> {
    const [typeA, typeB] = await Promise.all([
      this.detectScoreType(ctx, nameA),
      this.detectScoreType(ctx, nameB),
    ]);
    if (typeA !== 'numeric') {
      throw new Error(`Score "${nameA}" is ${typeA}, not numeric. Scatter plot requires two numeric scores.`);
    }
    if (typeB !== 'numeric') {
      throw new Error(`Score "${nameB}" is ${typeB}, not numeric. Scatter plot requires two numeric scores.`);
    }

    const { appId, tenantId } = ctx;
    const dataRetentionDays = ctx.dataRetentionDays ?? -1;
    const startDate = formatISOForClickHouse(dateRange.start);
    const endDate = formatISOForClickHouse(dateRange.end);
    const retentionCutoff = formatRetentionCutoff(dataRetentionDays);

    // Env-scope the scatter query.
    const envFilter = env ? buildEnvironmentWhereClause('Environment', env) : { clause: '', params: {} };

    const compInput = {
      appId, tenantId, nameA, nameB, startDate, endDate, retentionCutoff,
      retentionCutoffDate: formatRetentionCutoffDate(dataRetentionDays),
      source,
      envClause: envFilter.clause,
    };
    const scatter = buildScoreScatterQuery(compInput);
    const matchedCount = buildScoreMatchedCountQuery(compInput);

    const [scatterResult, countResult] = await Promise.all([
      this.client.query({
        query: scatter.query,
        query_params: { ...scatter.params, ...envFilter.params },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
      this.client.query({
        query: matchedCount.query,
        query_params: { ...matchedCount.params, ...envFilter.params },
        format: 'JSONEachRow',
        clickhouse_settings: QUERY_TIMEOUT_SETTINGS,
      }),
    ]);

    const scatterData = await scatterResult.json<{ scoreA: string; scoreB: string }>();
    const countData = await countResult.json<{ totalMatched: string; totalA: string; totalB: string }>();
    const counts = countData[0] ?? { totalMatched: '0', totalA: '0', totalB: '0' };

    return {
      nameA,
      nameB,
      points: scatterData.map((row) => ({
        scoreA: Number(row.scoreA),
        scoreB: Number(row.scoreB),
      })),
      totalMatched: Number(counts.totalMatched),
      totalA: Number(counts.totalA),
      totalB: Number(counts.totalB),
    };
  }

  private transformScore(raw: RawScore): Score {
    return {
      id: raw.id,
      resourceId: raw.resource_id,
      name: raw.name,
      score: toNumber(raw.score),
      label: raw.label || '',
      reason: raw.reason || '',
      source: raw.source as Score['source'],
      userId: raw.user_id || undefined,
      // ClickHouse returns 'YYYY-MM-DD HH:mm:ss.SSS' (space separator,
      // no zone). Convert to ISO 8601 so the response matches the spec's
      // `format: date-time` declaration; the raw ClickHouse format fails
      // schema conformance against the published spec.
      createdAt: clickHouseToISO(raw.created_at),
    };
  }

  private transformScoreAggregation(raw: RawScoreAggregation): ScoreAggregation {
    return {
      name: raw.name,
      avgScore: toNumber(raw.avg_score),
      count: toNumber(raw.count),
      minScore: toNumber(raw.min_score),
      maxScore: toNumber(raw.max_score),
      dataType: raw.data_type ?? '',
    };
  }
}
