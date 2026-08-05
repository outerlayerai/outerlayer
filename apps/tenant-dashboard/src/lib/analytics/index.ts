/**
 * Analytics Module
 *
 * Public API for the analytics service layer.
 * Re-exports from both the shared @repo/observability-service package
 * and remaining dashboard-specific modules.
 * Exports are intentionally public for module consumers.
 */

/* eslint-disable import/no-unused-modules */

export type {
  DateRange,
  DateRangePreset,
  PaginationParams,
  MetricsSummary,
  TimeSeriesPoint,
  MetricsResponse,
  ModelStats,
  ModelStatsResponse,
  TracesParams,
  TraceSummary,
  TracesResponse,
  Span,
  TraceDetail,
  PercentileMetric,
  PercentilesParams,
  PercentilePoint,
  PercentilesResponse,
  HealthResponse,
  HealthStatus,
  DependencyStatus,
  IAnalyticsService,
} from './types';

// Client
export {
  createClickHouseClient,
  getDefaultClient,
  resetDefaultClient,
  DEFAULT_QUERY_SETTINGS,
  type ClickHouseConfig,
  type ClickHouseClient,
} from './client';

// Service
export {
  AnalyticsService,
  getAnalyticsService,
  createAnalyticsService,
  isClickHouseConfigured,
} from './service';

// Mock Service (preview branches)
export { MockAnalyticsService } from './mock-service';

// Cache
export {
  getCachedMetrics,
  getCachedModelStats,
  getCachedTraces,
  getCachedPercentiles,
  getCachedExtendedMetrics,
  getCachedScores,
  getCachedScoreAggregations,
  parseDateRange,
  CACHE_TTLS,
  CACHE_TAGS,
} from './cache';

// Errors
export {
  AnalyticsError,
  QueryTimeoutError,
  ServiceUnavailableError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
} from './errors';

// Validation
export {
  metricsParamsSchema,
  tracesParamsSchema,
  percentilesParamsSchema,
  traceIdSchema,
  validateInput,
  VALIDATION_LIMITS,
  type MetricsParams,
  type TracesParamsValidated,
  type PercentilesParamsValidated,
} from './validation';

// Logger
export {
  analyticsLogger,
  createTimer,
  withLogging,
} from './logger';

// Queries (for testing/debugging)
export * from './queries';
