/**
 * Cache Wrappers
 *
 * Server-side caching using Next.js unstable_cache.
 * Provides tag-based invalidation and configurable TTLs.
 *
 * Future (v2): If Redis caching is needed, refactor to ICacheProvider interface:
 * - Extract cache interface with get/set/invalidate methods
 * - Create UnstableCacheProvider (current) and RedisCacheProvider implementations
 * - Inject provider into CachedAnalyticsService wrapper class
 * - Cache layer is isolated here, so refactor is ~2-3 hours when needed
 */

import { unstable_cache } from 'next/cache';
import { getAnalyticsService } from './service';
import type { IAnalyticsService } from './types';
import type {
  DateRange,
  MetricsResponse,
  ModelStatsResponse,
  TracesParams,
  TracesResponse,
  PercentilesParams,
  PercentilesResponse,
  ExtendedMetricsResponse,
  ScoresParams,
  ScoresResponse,
  ScoreAggregationsResponse,
  ScoreHistogramResponse,
  ScoreTrendResponse,
  ScoreTrendInterval,
  ScoreComparisonResponse,
  ScoreScatterResponse,
  RequestsParams,
  RequestsResponse,
  AnalyticsFilter,
  AnalyticsFilterOrGroup,
  AnalyticsFilterNode,
} from './types';
import type { EnvironmentQueryScope } from '@repo/observability-service';

import type { TenantContext } from './tenant-context';

// ============================================================================
// Local interface extension for env-scoped score analytics
// ============================================================================

/**
 * The OSS `IAnalyticsService` interface predates the env-scoping additions to
 * the score analytics methods. The concrete `AnalyticsService`
 * and `MockAnalyticsService` implementations already accept an optional `env?`
 * param. This local augmentation is used as a cast target in the cache
 * wrappers so TypeScript can verify the extended call signatures without
 * modifying the shared OSS interface.
 */
interface IAnalyticsServiceWithScoreEnv extends IAnalyticsService {
  getScoreAggregations(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ScoreAggregationsResponse>;
  getScoreHistogram(ctx: TenantContext, name: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreHistogramResponse>;
  getScoreTrend(ctx: TenantContext, name: string, interval: ScoreTrendInterval, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreTrendResponse>;
  getScoreComparison(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreComparisonResponse>;
  getScoreScatter(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string, env?: EnvironmentQueryScope): Promise<ScoreScatterResponse>;
}

/**
 * Returns the request-scoped analytics service cast to the env-augmented
 * interface. Built per cache miss from the request's TenantContext, so the
 * row-policy read client carries the same tenant scope the cache key encodes.
 */
function requireScoreAnalyticsService(ctx: TenantContext): IAnalyticsServiceWithScoreEnv {
  const svc = getAnalyticsService(ctx);
  if (!svc) {
    throw new Error('Analytics not available — ClickHouse is not configured. Set CLICKHOUSE_HOST to enable.');
  }
  return svc as unknown as IAnalyticsServiceWithScoreEnv;
}

// ============================================================================
// Cache Configuration
// ============================================================================

/**
 * Cache TTLs in seconds.
 */
export const CACHE_TTLS = {
  /** Metrics aggregate data - relatively stable */
  metrics: 60,
  /** Model stats - relatively stable */
  modelStats: 60,
  /** Trace list - changes frequently with new traces */
  traces: 30,
  /** Trace detail - immutable once created */
  traceDetail: 300,
  /** Percentiles - expensive query, cache longer */
  percentiles: 60,
  /** Dataset runs - changes less frequently than traces */
  datasets: 60,
  /** Experiments - similar to datasets */
  experiments: 60,
  /** Scores - changes with new evaluations */
  scores: 30,
} as const;

/**
 * Cache tags for invalidation.
 */
export const CACHE_TAGS = {
  analytics: 'analytics',
  metrics: 'analytics-metrics',
  traces: 'analytics-traces',
  percentiles: 'analytics-percentiles',
  datasets: 'analytics-datasets',
  experiments: 'analytics-experiments',
  scores: 'analytics-scores',
  requests: 'analytics-requests',
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the request-scoped analytics service, throwing if ClickHouse is not
 * configured. Built per cache miss from the request's TenantContext so the
 * row-policy read client carries the same tenant scope the cache key encodes.
 * API routes wrap calls in try/catch and return appropriate error responses.
 */
function requireAnalyticsService(ctx: TenantContext): IAnalyticsService {
  const service = getAnalyticsService(ctx);
  if (!service) {
    throw new Error('Analytics not available — ClickHouse is not configured. Set CLICKHOUSE_HOST to enable.');
  }
  return service;
}

/**
 * Parses a date range preset into start/end dates.
 */
export function parseDateRange(range: string, startDate?: string, endDate?: string): DateRange {
  if (range === 'custom' && startDate && endDate) {
    return { start: startDate, end: endDate };
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0] as string;

  switch (range) {
    case 'today':
      return { start: today, end: today };
    case '24h':
      // Same-day bounds trigger hourly granularity in MetricsService
      // (see services/metrics.ts: useHourlyGranularity = start === end).
      // SQL bounds are Date-typed, so this is "today's hourly buckets",
      // not a true rolling now-24h window.
      return { start: today, end: today };
    case 'yesterday': {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      return { start: yesterday, end: yesterday };
    }
    case '7d':
      return {
        start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: today,
      };
    case '30d':
      return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: today,
      };
    case '90d':
      return {
        start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string,
        end: today,
      };
    default:
      return { start: today, end: today };
  }
}

// ============================================================================
// Cached Service Functions
// ============================================================================

/**
 * Gets cached metrics data.
 *
 * @param ctx - Verified TenantContext (from withAnalyticsAuth)
 * @param range - Date range preset (today, yesterday, 7d, 30d, 90d, custom)
 * @param startDate - Custom start date (required if range is 'custom')
 * @param endDate - Custom end date (required if range is 'custom')
 * @param filters - Optional filters (model, user_id, status)
 */
export const getCachedMetrics = unstable_cache(
  async (
    ctx: TenantContext,
    range: string,
    startDate?: string,
    endDate?: string,
    filters?: AnalyticsFilter[],
    // Env scoping. Passed as discrete primitives so `unstable_cache` keys on
    // them — same pattern as `getCachedTraces`. Without env in the key, two
    // envs hitting the same (appId, range, ...) tuple share the cached entry.
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<MetricsResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const envScope = environmentName
      ? {
          environment: {
            name: environmentName,
            isDefault: environmentIsDefault ?? false,
          },
        }
      : undefined;
    return requireAnalyticsService(ctx).getMetrics(ctx, dateRange, filters, envScope);
  },
  [CACHE_TAGS.metrics],
  {
    revalidate: CACHE_TTLS.metrics,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.metrics],
  }
);

/**
 * Gets cached model statistics.
 *
 * @param ctx - Verified TenantContext (from withAnalyticsAuth)
 * @param range - Date range preset
 * @param limit - Maximum number of models to return
 * @param startDate - Custom start date (required if range is 'custom')
 * @param endDate - Custom end date (required if range is 'custom')
 * @param filters - Optional filters (model, user_id, status, latency_ms)
 */
export const getCachedModelStats = unstable_cache(
  async (
    ctx: TenantContext,
    range: string,
    limit: number = 10,
    startDate?: string,
    endDate?: string,
    filters?: AnalyticsFilter[],
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<ModelStatsResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const envScope = environmentName
      ? {
          environment: {
            name: environmentName,
            isDefault: environmentIsDefault ?? false,
          },
        }
      : undefined;
    return requireAnalyticsService(ctx).getModelStats(ctx, dateRange, limit, filters, envScope);
  },
  ['analytics-model-stats'],
  {
    revalidate: CACHE_TTLS.modelStats,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.metrics],
  }
);

export const getCachedTraces = unstable_cache(
  async (
    ctx: TenantContext,
    limit: number,
    offset: number,
    startDate?: string,
    endDate?: string,
    model?: string,
    userId?: string,
    status?: 'OK' | 'ERROR',
    filters?: AnalyticsFilter[],
    sortBy?: string,
    sortOrder?: string,
    // Env scoping. `environment` is the env name; the
    // `isDefault` half drives legacy-row inclusion for pre-env data.
    // `environments` is the saved-filter multi-env allow-list. Passed as
    // discrete primitives so `unstable_cache` keys on them correctly.
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
    // Full-text search across Input OR Output. Converted to an OR-group
    // filter so the existing buildSplitFilterWhereClause handles it without
    // any service-layer changes.
    searchQuery?: string,
  ): Promise<TracesResponse> => {
    const effectiveFilters: AnalyticsFilterNode[] = [];
    if (searchQuery) {
      const searchGroup: AnalyticsFilterOrGroup = {
        or: [
          { field: 'input', operator: 'contains', value: searchQuery },
          { field: 'output', operator: 'contains', value: searchQuery },
        ],
      };
      effectiveFilters.push(searchGroup);
    }
    if (filters?.length) {
      effectiveFilters.push(...filters);
    }
    const params: TracesParams = {
      limit,
      offset,
      startDate,
      endDate,
      model,
      userId,
      status,
      filters: effectiveFilters.length > 0 ? effectiveFilters : undefined,
      sortBy,
      sortOrder: sortOrder as 'asc' | 'desc' | undefined,
      ...(environmentName
        ? { environment: { name: environmentName, isDefault: environmentIsDefault ?? false } }
        : {}),
      ...(environments && environments.length > 0 ? { environments } : {}),
    };
    return requireAnalyticsService(ctx).getTraces(ctx, params);
  },
  [CACHE_TAGS.traces],
  {
    revalidate: CACHE_TTLS.traces,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.traces],
  }
);

export const getCachedPercentiles = unstable_cache(
  async (
    ctx: TenantContext,
    range: string,
    metric: 'latency' | 'inputTokens' | 'outputTokens' | 'totalTokens',
    startDate?: string,
    endDate?: string,
    filters?: AnalyticsFilter[],
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<PercentilesResponse> => {
    const params: PercentilesParams = {
      range: range as 'today' | '7d' | '30d' | '90d' | 'custom',
      metric,
      startDate,
      endDate,
    };
    const envScope = environmentName
      ? {
          environment: {
            name: environmentName,
            isDefault: environmentIsDefault ?? false,
          },
        }
      : undefined;
    return requireAnalyticsService(ctx).getPercentiles(ctx, params, filters, envScope);
  },
  [CACHE_TAGS.percentiles],
  {
    revalidate: CACHE_TTLS.percentiles,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.percentiles],
  }
);

// ============================================================================
// Extended Cached Service Functions
// ============================================================================

/**
 * Gets cached extended metrics with per-request averages.
 *
 * @param ctx - Verified TenantContext (from withAnalyticsAuth)
 * @param range - Date range preset
 * @param startDate - Custom start date
 * @param endDate - Custom end date
 */
export const getCachedExtendedMetrics = unstable_cache(
  async (
    ctx: TenantContext,
    range: string,
    startDate?: string,
    endDate?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<ExtendedMetricsResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const envScope = environmentName
      ? {
          environment: {
            name: environmentName,
            isDefault: environmentIsDefault ?? false,
          },
        }
      : undefined;
    return requireAnalyticsService(ctx).getExtendedMetrics(ctx, dateRange, envScope);
  },
  ['analytics-extended-metrics'],
  {
    revalidate: CACHE_TTLS.metrics,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.metrics],
  }
);


export const getCachedScores = unstable_cache(
  async (
    ctx: TenantContext,
    limit: number,
    offset: number,
    startDate?: string,
    endDate?: string,
    resourceId?: string,
    resourceType?: 'trace' | 'span',
    // Env scoping. Ignored when `resourceId` is set.
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<ScoresResponse> => {
    const params: ScoresParams = {
      limit,
      offset,
      startDate,
      endDate,
      resourceId,
      resourceType,
      ...(environmentName
        ? { environment: { name: environmentName, isDefault: environmentIsDefault ?? false } }
        : {}),
    };
    return requireAnalyticsService(ctx).getScores(ctx, params);
  },
  [CACHE_TAGS.scores],
  {
    revalidate: CACHE_TTLS.scores,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);

/**
 * Builds the env scope for a score-analytics query from the cache wrappers'
 * flattened params. A multi-env override widget passes `environments` (N > 1)
 * which maps to `Environment IN (...)`; a single/inherit widget passes a name
 * + default flag. Empty/absent ⇒ no env filter. Without the `environments`
 * branch, a multi-env override score widget queried EVERY env instead of the
 * selected list (the non-score widget path already honoured the list).
 */
function buildScoreEnvScope(
  environmentName?: string,
  environmentIsDefault?: boolean,
  environments?: string[],
): EnvironmentQueryScope | undefined {
  if (environments && environments.length > 0) return { environments };
  if (environmentName) {
    return { environment: { name: environmentName, isDefault: environmentIsDefault ?? false } };
  }
  return undefined;
}

/**
 * Gets cached score aggregations.
 *
 * @param ctx - Verified TenantContext (from withAnalyticsAuth)
 * @param range - Date range preset
 * @param startDate - Custom start date
 * @param endDate - Custom end date
 * @param environmentName - env name to scope to (optional)
 * @param environmentIsDefault - whether this is the default env (drives legacy inclusion for pre-env data)
 * @param environments - Multi-env override list (cross-env comparison widgets)
 */
export const getCachedScoreAggregations = unstable_cache(
  async (
    ctx: TenantContext,
    range: string,
    startDate?: string,
    endDate?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
  ): Promise<ScoreAggregationsResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const env = buildScoreEnvScope(environmentName, environmentIsDefault, environments);
    return requireScoreAnalyticsService(ctx).getScoreAggregations(ctx, dateRange, env);
  },
  ['analytics-score-aggregations'],
  {
    revalidate: CACHE_TTLS.scores,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);


/**
 * Gets cached requests (GENERATION type traces).
 *
 * @param ctx - Verified TenantContext (from withAnalyticsAuth)
 * @param limit - Maximum number of logs to return
 * @param offset - Number of logs to skip
 * @param startDate - Optional start date filter
 * @param endDate - Optional end date filter
 * @param filtersJson - Serialized filters (JSON string) - must be serialized for cache key stability
 * @param environmentName - env name to scope to (optional)
 * @param environmentIsDefault - whether this is the default env (drives legacy inclusion for pre-env data)
 */
export const getCachedRequests = unstable_cache(
  async (
    ctx: TenantContext,
    limit: number,
    offset: number,
    startDate?: string,
    endDate?: string,
    filtersJson?: string,
    // Env scoping. Passed as discrete primitives so
    // `unstable_cache` keys on them correctly (no object identity issues).
    environmentName?: string,
    environmentIsDefault?: boolean,
  ): Promise<RequestsResponse> => {
    // Parse filters from JSON string for cache key stability
    const filters: AnalyticsFilter[] | undefined = filtersJson ? JSON.parse(filtersJson) : undefined;
    const params: RequestsParams = {
      limit,
      offset,
      startDate,
      endDate,
      filters,
      ...(environmentName
        ? { environment: { name: environmentName, isDefault: environmentIsDefault ?? false } }
        : {}),
    };
    return requireAnalyticsService(ctx).getRequests(ctx, params);
  },
  [CACHE_TAGS.requests],
  {
    revalidate: CACHE_TTLS.traces, // Same TTL as traces
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.requests],
  }
);


/**
 * Gets cached score histogram/distribution data.
 */
export const getCachedScoreHistogram = unstable_cache(
  async (
    ctx: TenantContext,
    name: string,
    range: string,
    startDate?: string,
    endDate?: string,
    source?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
  ): Promise<ScoreHistogramResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const env = buildScoreEnvScope(environmentName, environmentIsDefault, environments);
    return requireScoreAnalyticsService(ctx).getScoreHistogram(ctx, name, dateRange, source, env);
  },
  ['analytics-score-histogram'],
  {
    revalidate: CACHE_TTLS.scores,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);


/**
 * Gets cached score trend data.
 */
export const getCachedScoreTrend = unstable_cache(
  async (
    ctx: TenantContext,
    name: string,
    interval: ScoreTrendInterval,
    range: string,
    startDate?: string,
    endDate?: string,
    source?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
  ): Promise<ScoreTrendResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const env = buildScoreEnvScope(environmentName, environmentIsDefault, environments);
    return requireScoreAnalyticsService(ctx).getScoreTrend(ctx, name, interval, dateRange, source, env);
  },
  ['analytics-score-trend'],
  {
    revalidate: CACHE_TTLS.scores,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);


/**
 * Gets cached score comparison (confusion matrix) data.
 */
export const getCachedScoreComparison = unstable_cache(
  async (
    ctx: TenantContext,
    nameA: string,
    nameB: string,
    range: string,
    startDate?: string,
    endDate?: string,
    source?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
  ): Promise<ScoreComparisonResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const env = buildScoreEnvScope(environmentName, environmentIsDefault, environments);
    return requireScoreAnalyticsService(ctx).getScoreComparison(ctx, nameA, nameB, dateRange, source, env);
  },
  ['analytics-score-comparison'],
  {
    revalidate: 60, // Longer cache for expensive join query
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);


export const getCachedScoreScatter = unstable_cache(
  async (
    ctx: TenantContext,
    nameA: string,
    nameB: string,
    range: string,
    startDate?: string,
    endDate?: string,
    source?: string,
    environmentName?: string,
    environmentIsDefault?: boolean,
    environments?: string[],
  ): Promise<ScoreScatterResponse> => {
    const dateRange = parseDateRange(range, startDate, endDate);
    const env = buildScoreEnvScope(environmentName, environmentIsDefault, environments);
    return requireScoreAnalyticsService(ctx).getScoreScatter(ctx, nameA, nameB, dateRange, source, env);
  },
  ['analytics-score-scatter'],
  {
    revalidate: 60,
    tags: [CACHE_TAGS.analytics, CACHE_TAGS.scores],
  }
);
