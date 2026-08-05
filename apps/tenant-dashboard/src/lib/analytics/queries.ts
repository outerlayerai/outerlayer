/**
 * SQL Query Strings
 *
 * Re-exports all query constants and builder functions from the shared
 * @repo/observability-service package.
 */

// Re-export all queries from shared package
export {
  METRICS_SUMMARY_QUERY,
  METRICS_TIME_SERIES_QUERY,
  MODEL_COUNT_QUERY,
  TRACES_LIST_QUERY,
  TRACES_COUNT_QUERY,
  TRACE_DETAIL_QUERY,
  TRACE_DETAIL_LIGHTWEIGHT_QUERY,
  SPAN_IO_QUERY,
  PERCENTILES_LATENCY_QUERY,
  PERCENTILES_TOKENS_QUERY,
  SCORES_LIST_QUERY,
  SCORES_COUNT_QUERY,
  SCORES_BY_RESOURCE_QUERY,
  SCORES_BY_RESOURCE_IDS_QUERY,
  SCORES_AGGREGATIONS_QUERY,
  DISTINCT_SCORE_NAMES_QUERY,
  SCORE_LABELS_QUERY,
  DISTINCT_METADATA_KEYS_QUERY,
  HEALTH_CHECK_QUERY,
  REQUESTS_LIST_QUERY,
  REQUESTS_COUNT_QUERY,
  USERS_ANALYTICS_LIST_QUERY,
  USERS_ANALYTICS_COUNT_QUERY,
  SORT_FIELD_MAP,
  SPAN_KIND_BREAKDOWN_QUERY,
  buildScoreHistogramQuery,
  buildScoreCategoryCountsQuery,
  buildScoreTrendQuery,
  buildScoreComparisonQuery,
  buildScoreMatchedCountQuery,
  buildScoreScatterQuery,
  buildFilteredMetricsSummaryQuery,
  buildFilteredHourlyTimeSeriesQuery,
  buildFilteredDailyTimeSeriesQuery,
  buildFilteredModelStatsQuery,
  buildFilteredPercentilesQuery,
  buildRankingByDimensionQuery,
  buildPaginatedRankingQuery,
  dimensionToClickHouseColumn,
} from '@repo/observability-service';

// Re-export types used by query builder functions
export type {
  ScoreAnalyticsInput,
  ScoreComparisonInput,
  FilteredQueryResult,
  FilteredMetricsInput,
  FilteredModelStatsInput,
  FilteredRankingInput,
  PaginatedRankingInput,
  FilteredPercentilesInput,
} from '@repo/observability-service';
