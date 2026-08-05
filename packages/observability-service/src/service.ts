/**
 * Analytics Service (Facade)
 *
 * Delegates to focused domain sub-services while maintaining the
 * IAnalyticsService interface as the public contract.
 *
 * Sub-services:
 *   - TracesService: trace listing, detail, span I/O, metadata keys
 *   - ScoresService: scores, aggregations, analytics (histogram, trend, etc.)
 *   - MetricsService: dashboard metrics, model stats, ranking, percentiles
 *   - RequestsService: request listing
 */

import type { IClickHouseQuery } from './client';
import { HEALTH_CHECK_QUERY } from './queries';
import type {
  IAnalyticsService,
  DateRange,
  MetricsResponse,
  ModelStatsResponse,
  AgentFleetOverviewResponse,
  AgentFleetQueryOptions,
  AgentAutonomyLadderAttributionResponse,
  AgentFleetDimension,
  AgentFleetDimensionResponse,
  AgentFleetPercentileTrendResponse,
  AgentFleetAutonomyMixTrendResponse,
  AgentFleetActiveActorTrendResponse,
  AgentFleetTrajectorySignalTrendResponse,
  AgentFleetCostAnomalyResponse,
  AgentPrAttributionResponse,
  AgentPrCostAttributionResponse,
  TracesParams,
  TracesResponse,
  TraceDetail,
  SpanIO,
  PercentilesParams,
  PercentilesResponse,
  ExtendedMetricsResponse,
  ScoresParams,
  ScoresResponse,
  Score,
  ScoreAggregationsResponse,
  ScoreNamesResponse,
  RequestsParams,
  RequestsResponse,
  AnalyticsFilter,
  RankingDataResponse,
  AggregateRequestsParams,
  AggregateRequestsResponse,
  ScoreType,
  ScoreHistogramResponse,
  ScoreTrendResponse,
  ScoreTrendInterval,
  ScoreComparisonResponse,
  ScoreScatterResponse,
  SpanKindBreakdownRecord,
} from './types';
import type { TenantContext } from './tenant-context';
import type { EnvironmentQueryScope } from './shared';

import { TracesService } from './services/traces';
import { ScoresService } from './services/scores';
import { MetricsService } from './services/metrics';
import { RequestsService } from './services/requests';
import { AgentFleetService } from './services/agent-fleet';

// Re-exported so callers can import these from the service entrypoint
// alongside AnalyticsService rather than reaching into ./shared.
export { QUERY_TIMEOUT_SETTINGS, buildFilterWhereClause, buildSplitFilterWhereClause, buildScoresFilterWhereClause, buildEnvironmentWhereClause } from './shared';
export type { EnvironmentQueryScope } from './shared';

export class AnalyticsService implements IAnalyticsService {
  private readonly traces: TracesService;
  private readonly scores: ScoresService;
  private readonly metrics: MetricsService;
  private readonly requests: RequestsService;
  private readonly agentFleet: AgentFleetService;

  constructor(private readonly client: IClickHouseQuery) {
    this.scores = new ScoresService(client);
    this.traces = new TracesService(client, this.scores);
    this.metrics = new MetricsService(client);
    this.requests = new RequestsService(client);
    this.agentFleet = new AgentFleetService(client);
  }

  // Health
  async checkConnectivity(): Promise<boolean> {
    await this.client.query({ query: HEALTH_CHECK_QUERY });
    return true;
  }

  // Metrics
  getMetrics(ctx: TenantContext, dateRange: DateRange, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<MetricsResponse> {
    return this.metrics.getMetrics(ctx, dateRange, filters, env);
  }
  getExtendedMetrics(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ExtendedMetricsResponse> {
    return this.metrics.getExtendedMetrics(ctx, dateRange, env);
  }
  getModelStats(ctx: TenantContext, dateRange: DateRange, limit?: number, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<ModelStatsResponse> {
    return this.metrics.getModelStats(ctx, dateRange, limit, filters, env);
  }
  getPercentiles(ctx: TenantContext, params: PercentilesParams, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<PercentilesResponse> {
    return this.metrics.getPercentiles(ctx, params, filters, env);
  }
  getRankingData(ctx: TenantContext, dateRange: DateRange, dimension: string, limit?: number, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<RankingDataResponse> {
    return this.metrics.getRankingData(ctx, dateRange, dimension, limit, filters, env);
  }
  getAggregateRequests(ctx: TenantContext, params: AggregateRequestsParams): Promise<AggregateRequestsResponse> {
    return this.metrics.getAggregateRequests(ctx, params);
  }
  getSpanKindBreakdown(ctx: TenantContext, dateRange: { startDate: string; endDate: string }): Promise<SpanKindBreakdownRecord[]> {
    return this.metrics.getSpanKindBreakdown(ctx, dateRange);
  }

  // Traces
  getTraces(ctx: TenantContext, params: TracesParams): Promise<TracesResponse> {
    return this.traces.getTraces(ctx, params);
  }
  getTraceDetail(ctx: TenantContext, traceId: string, env?: EnvironmentQueryScope): Promise<TraceDetail | null> {
    return this.traces.getTraceDetail(ctx, traceId, env);
  }
  getTraceDetailLightweight(ctx: TenantContext, traceId: string, env?: EnvironmentQueryScope): Promise<TraceDetail | null> {
    return this.traces.getTraceDetailLightweight(ctx, traceId, env);
  }
  getSpanIO(ctx: TenantContext, traceId: string, spanId: string, env?: EnvironmentQueryScope): Promise<SpanIO | null> {
    return this.traces.getSpanIO(ctx, traceId, spanId, env);
  }
  getDistinctMetadataKeys(ctx: TenantContext): Promise<string[]> {
    return this.traces.getDistinctMetadataKeys(ctx);
  }

  // Scores
  getScores(ctx: TenantContext, params: ScoresParams): Promise<ScoresResponse> {
    return this.scores.getScores(ctx, params);
  }
  getScoresBySpanIds(ctx: TenantContext, spanIds: string[]): Promise<Record<string, Score[]>> {
    return this.scores.getScoresBySpanIds(ctx, spanIds);
  }
  getScoreAggregations(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ScoreAggregationsResponse> {
    return this.scores.getScoreAggregations(ctx, dateRange, env);
  }
  getDistinctScoreNames(ctx: TenantContext, env?: EnvironmentQueryScope): Promise<ScoreNamesResponse> {
    return this.scores.getDistinctScoreNames(ctx, env);
  }
  detectScoreType(ctx: TenantContext, name: string): Promise<ScoreType> {
    return this.scores.detectScoreType(ctx, name);
  }
  getScoreHistogram(ctx: TenantContext, name: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreHistogramResponse> {
    return this.scores.getScoreHistogram(ctx, name, dateRange, source, env);
  }
  getScoreTrend(ctx: TenantContext, name: string, interval: ScoreTrendInterval, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreTrendResponse> {
    return this.scores.getScoreTrend(ctx, name, interval, dateRange, source, env);
  }
  getScoreComparison(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreComparisonResponse> {
    return this.scores.getScoreComparison(ctx, nameA, nameB, dateRange, source, env);
  }
  getScoreScatter(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreScatterResponse> {
    return this.scores.getScoreScatter(ctx, nameA, nameB, dateRange, source, env);
  }

  // Requests
  getRequests(ctx: TenantContext, params: RequestsParams): Promise<RequestsResponse> {
    return this.requests.getRequests(ctx, params);
  }

  // Agent fleet
  getAgentFleetOverview(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetOverviewResponse> {
    return this.agentFleet.getAgentFleetOverview(ctx, dateRange, options);
  }
  getAgentFleetDimensionBreakdown(
    ctx: TenantContext,
    dateRange: DateRange,
    dimension: AgentFleetDimension,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetDimensionResponse> {
    return this.agentFleet.getAgentFleetDimensionBreakdown(ctx, dateRange, dimension, options);
  }
  getAgentFleetPercentileTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetPercentileTrendResponse> {
    return this.agentFleet.getAgentFleetPercentileTrend(ctx, dateRange, options);
  }
  getAgentFleetAutonomyMixTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetAutonomyMixTrendResponse> {
    return this.agentFleet.getAgentFleetAutonomyMixTrend(ctx, dateRange, options);
  }
  getAgentFleetActiveActorTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetActiveActorTrendResponse> {
    return this.agentFleet.getAgentFleetActiveActorTrend(ctx, dateRange, options);
  }
  getAgentFleetTrajectorySignalTrend(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetTrajectorySignalTrendResponse> {
    return this.agentFleet.getAgentFleetTrajectorySignalTrend(ctx, dateRange, options);
  }
  getAgentFleetCostAnomalies(
    ctx: TenantContext,
    dateRange: DateRange,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetCostAnomalyResponse> {
    return this.agentFleet.getAgentFleetCostAnomalies(ctx, dateRange, options);
  }
  getAgentPrAttribution(ctx: TenantContext, options?: AgentFleetQueryOptions): Promise<AgentPrAttributionResponse> {
    return this.agentFleet.getAgentPrAttribution(ctx, options);
  }
  getAgentPrCostAttribution(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentPrCostAttributionResponse> {
    return this.agentFleet.getAgentPrCostAttribution(ctx, options);
  }
  getAutonomyLadderAttribution(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentAutonomyLadderAttributionResponse> {
    return this.agentFleet.getAutonomyLadderAttribution(ctx, options);
  }
}

/**
 * Creates a new AnalyticsService with a custom client.
 */
export function createAnalyticsService(client: IClickHouseQuery): AnalyticsService {
  return new AnalyticsService(client);
}
