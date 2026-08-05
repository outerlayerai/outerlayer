// ---------------------------------------------------------------------------
// DORA Metrics - Service Layer
//
// Computes all four DORA metrics from platform_deployment and
// platform_incident tables. When incident data is available, MTTR uses
// median incident resolution time and CFR includes incident-correlated
// deployments. Falls back to deployment-only metrics gracefully.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  DoraMetricsResponse,
  DoraTrendsResponse,
  DoraRankingsResponse,
  DoraMetricValue,
  DoraAppRanking,
  DoraAppRankingMetric,
  TrendSeries,
} from './types';
import { classifyPerformanceLevel } from './thresholds';
import { resolveTimeRange } from './validation';
import { MockDoraMetricsService } from './mock-service';
import {
  MS_PER_DAY,
  ROW_LIMIT,
  COMPLETED_STATUSES,
  computeMetrics as computeMetricsShared,
  computeChangePercent as computeChangePercentShared,
  trendDirectionFromChange,
  bucketByTime,
  resolveLeadTimeMode,
  resolveMttrMode,
  deploymentRecoveries,
  median,
  roundTo as roundToShared,
} from './constants';

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/** Shape of a platform_deployment row returned from the Supabase query. */
interface PlatformDeploymentRow {
  id: string;
  service: string;
  environment: string;
  status: string;
  commit_sha: string | null;
  commit_message: string | null;
  branch: string | null;
  failure_reason: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  pipeline_url: string | null;
  first_commit_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

/** Shape of a platform_incident row returned from the Supabase query. */
interface PlatformIncidentRow {
  id: string;
  service: string | null;
  environment: string | null;
  status: string;
  deployment_id: string | null;
  started_at: string;
  resolved_at: string | null;
  resolution_ms: number | null;
}

// ---------------------------------------------------------------------------
// DoraMetricsService
// ---------------------------------------------------------------------------

/**
 * Service that computes DORA metrics from platform deployment records.
 *
 * Queries the `platform_deployment` table which tracks our platform's own
 * CI/CD deployments — not user applications.
 */
export class DoraMetricsService {
  constructor(private readonly supabase: SupabaseClient) {}

  // =========================================================================
  // Public Methods
  // =========================================================================

  /**
   * Compute all four DORA metrics for the given time range, optionally
   * filtered to a single platform service. Includes trend comparison
   * against the previous period and performance classification.
   */
  async getMetrics(
    timeRange: string,
    serviceFilter?: string | null,
    environmentFilter: string | null = 'production',
  ): Promise<DoraMetricsResponse> {
    const { start, end, previousStart, previousEnd } = resolveTimeRange(timeRange);
    const days = this.daysBetween(start, end);

    // Fetch deployments and incidents for both current and previous periods
    const [currentDeployments, previousDeployments, currentIncidents, previousIncidents] =
      await Promise.all([
        this.fetchDeployments(start, end, serviceFilter, environmentFilter),
        this.fetchDeployments(previousStart, previousEnd, serviceFilter, environmentFilter),
        this.fetchIncidents(start, end, serviceFilter, environmentFilter),
        this.fetchIncidents(previousStart, previousEnd, serviceFilter, environmentFilter),
      ]);

    // Lead-time and MTTR sources are decided once per response, off the
    // current window's full population, then applied to both periods so the
    // summary card and its trend comparison use one consistent source.
    const leadTimeMode = resolveLeadTimeMode(currentDeployments);
    const mttrMode = resolveMttrMode(currentIncidents);

    const current = computeMetricsShared(
      currentDeployments,
      days,
      currentIncidents,
      leadTimeMode,
      mttrMode,
    );
    const previous = computeMetricsShared(
      previousDeployments,
      days,
      previousIncidents,
      leadTimeMode,
      mttrMode,
    );

    return {
      metrics: {
        deploymentFrequency: this.buildMetricValue(
          'deployment_frequency',
          current.deploymentFrequency,
          previous.deploymentFrequency,
          current.sampleSizes.deploymentFrequency,
          'deploys/day',
        ),
        leadTime: {
          ...this.buildMetricValue(
            'lead_time',
            current.leadTime,
            previous.leadTime,
            current.sampleSizes.leadTime,
            'hours',
          ),
          // Computed, not hardcoded: false when commit-based lead time was
          // available for the window, true when we fell back to duration_ms.
          isProxy: current.leadTimeIsProxy,
        },
        changeFailureRate: this.buildMetricValue(
          'change_failure_rate',
          current.changeFailureRate,
          previous.changeFailureRate,
          current.sampleSizes.changeFailureRate,
          '%',
        ),
        mttr: this.buildMetricValue(
          'mttr',
          // Summary card shows a number; a null MTTR (no data under the chosen
          // source) renders as 0.
          current.mttr ?? 0,
          previous.mttr ?? 0,
          current.sampleSizes.mttr,
          'hours',
        ),
      },
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      comparisonPeriod: {
        start: previousStart.toISOString(),
        end: previousEnd.toISOString(),
      },
      environment: environmentFilter,
    };
  }

  /**
   * Compute time-series trend data for all four DORA metrics, bucketed
   * by day (7d/30d) or week (90d).
   */
  async getTrends(
    timeRange: string,
    serviceFilter?: string | null,
    environmentFilter: string | null = 'production',
  ): Promise<DoraTrendsResponse> {
    const { start, end } = resolveTimeRange(timeRange);
    const granularity = timeRange === '90d' ? 'week' : 'day';

    const [deployments, incidents] = await Promise.all([
      this.fetchDeployments(start, end, serviceFilter, environmentFilter),
      this.fetchIncidents(start, end, serviceFilter, environmentFilter),
    ]);
    const buckets = bucketByTime(
      deployments,
      (d) => new Date(d.started_at).getTime(),
      start,
      end,
      granularity,
    );
    const incidentBuckets = bucketByTime(
      incidents,
      (inc) => new Date(inc.started_at).getTime(),
      start,
      end,
      granularity,
    );

    // Decide lead-time and MTTR sources once for the whole window so every
    // bucket is consistent with the summary. In incident-based MTTR mode, a
    // bucket with no resolved incident yields null (a chart gap), never a
    // deployment-based fallback.
    const leadTimeMode = resolveLeadTimeMode(deployments);
    const mttrMode = resolveMttrMode(incidents);

    // Deployment-mode MTTR pairs a failed deploy with its recovering success.
    // That success routinely lands in a LATER bucket than the failure, so the
    // pair must be found over the whole window and then attributed to the
    // failure's bucket. Bucketing raw deploy rows and pairing per-bucket (as
    // computeMetrics does for the summary population) misses every cross-bucket
    // recovery, which leaves the entire MTTR trend empty even though the summary
    // and rankings — computed over the whole window — still show a value.
    // Incident-mode MTTR is self-contained per bucket (resolution_ms lives on
    // the incident row), so it keeps computeMetrics' per-bucket value.
    const deploymentRecoveryBuckets =
      mttrMode === 'deployment'
        ? bucketByTime(deploymentRecoveries(deployments), (r) => r.failedAtMs, start, end, granularity)
        : null;

    const deploymentFrequencySeries: TrendSeries['series'] = [];
    const leadTimeSeries: TrendSeries['series'] = [];
    const changeFailureRateSeries: TrendSeries['series'] = [];
    const mttrSeries: TrendSeries['series'] = [];

    for (const [bucketLabel, bucketRows] of buckets) {
      const bucketDays = granularity === 'week' ? 7 : 1;
      const bucketIncidents = incidentBuckets.get(bucketLabel) ?? [];
      const metrics = computeMetricsShared(
        bucketRows,
        bucketDays,
        bucketIncidents,
        leadTimeMode,
        mttrMode,
      );

      // A 1-day deployment-frequency bucket equals that day's completed-deploy
      // count — the per-day rate — using the same population as the summary.
      deploymentFrequencySeries.push({ x: bucketLabel, y: metrics.deploymentFrequency });
      leadTimeSeries.push({ x: bucketLabel, y: metrics.leadTime });
      changeFailureRateSeries.push({ x: bucketLabel, y: metrics.changeFailureRate });

      // In deployment mode, replace the per-bucket MTTR (which can't see a
      // recovery whose success is in a later bucket) with the window-wide
      // recovery attributed to this failure-day bucket. Incident mode keeps
      // computeMetrics' value.
      let mttrY = metrics.mttr;
      if (deploymentRecoveryBuckets) {
        const recoveries = deploymentRecoveryBuckets.get(bucketLabel) ?? [];
        mttrY = recoveries.length > 0 ? median(recoveries.map((r) => r.recoveryHours)) : null;
      }
      mttrSeries.push({ x: bucketLabel, y: mttrY });
    }

    return {
      trends: {
        deploymentFrequency: { series: deploymentFrequencySeries, granularity },
        leadTime: { series: leadTimeSeries, granularity },
        changeFailureRate: { series: changeFailureRateSeries, granularity },
        mttr: { series: mttrSeries, granularity },
      },
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      granularity,
    };
  }

  /**
   * Compute DORA metrics per platform service, ranked by the specified metric.
   */
  async getRankings(
    timeRange: string,
    sortBy: string,
    sortOrder: string,
    environmentFilter: string | null = 'production',
  ): Promise<DoraRankingsResponse> {
    const { start, end } = resolveTimeRange(timeRange);
    const days = this.daysBetween(start, end);

    // Fetch all deployments and incidents for the period (no service filter)
    const [deployments, incidents] = await Promise.all([
      this.fetchDeployments(start, end, null, environmentFilter),
      this.fetchIncidents(start, end, null, environmentFilter),
    ]);

    // Group by service
    const groupedByService = new Map<string, PlatformDeploymentRow[]>();
    for (const d of deployments) {
      const existing = groupedByService.get(d.service);
      if (existing) {
        existing.push(d);
      } else {
        groupedByService.set(d.service, [d]);
      }
    }

    // Group incidents by service
    const incidentsByService = new Map<string, PlatformIncidentRow[]>();
    for (const inc of incidents) {
      if (!inc.service) continue;
      const existing = incidentsByService.get(inc.service);
      if (existing) {
        existing.push(inc);
      } else {
        incidentsByService.set(inc.service, [inc]);
      }
    }

    if (groupedByService.size === 0) {
      return {
        rankings: [],
        period: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
      };
    }

    // Build ranking for each service
    const rankings: DoraAppRanking[] = [];

    for (const [serviceName, serviceDeployments] of groupedByService) {
      const serviceIncidents = incidentsByService.get(serviceName) ?? [];
      const leadTimeMode = resolveLeadTimeMode(serviceDeployments);
      const mttrMode = resolveMttrMode(serviceIncidents);
      const metrics = computeMetricsShared(
        serviceDeployments,
        days,
        serviceIncidents,
        leadTimeMode,
        mttrMode,
      );

      rankings.push({
        serviceId: serviceName,
        serviceName,
        metrics: {
          deploymentFrequency: this.buildRankingMetric('deployment_frequency', metrics.deploymentFrequency),
          leadTime: this.buildRankingMetric('lead_time', metrics.leadTime),
          changeFailureRate: this.buildRankingMetric('change_failure_rate', metrics.changeFailureRate),
          mttr: this.buildRankingMetric('mttr', metrics.mttr ?? 0),
        },
        totalDeployments: serviceDeployments.length,
      });
    }

    // Sort rankings
    this.sortRankings(rankings, sortBy, sortOrder);

    return {
      rankings,
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
    };
  }

  // =========================================================================
  // Data Fetching
  // =========================================================================

  /**
   * Fetch platform deployment rows from Supabase for a date range,
   * optionally filtered by service name. Only includes completed deployments.
   */
  private async fetchDeployments(
    start: Date,
    end: Date,
    serviceFilter?: string | null,
    environmentFilter?: string | null,
  ): Promise<PlatformDeploymentRow[]> {
    let query = this.supabase
      .from('platform_deployment')
      .select(
        'id, service, environment, status, commit_sha, commit_message, branch, failure_reason, duration_ms, triggered_by, pipeline_url, first_commit_at, started_at, completed_at, created_at',
      )
      .gte('started_at', start.toISOString())
      .lt('started_at', end.toISOString())
      .in('status', [...COMPLETED_STATUSES])
      .order('started_at', { ascending: true })
      // PostgREST silently caps at 1000 rows without an explicit limit. Raise
      // the ceiling so DORA windows aren't quietly truncated, and warn below
      // when we actually hit it.
      .limit(ROW_LIMIT);

    if (serviceFilter) {
      query = query.eq('service', serviceFilter);
    }

    if (environmentFilter) {
      query = query.eq('environment', environmentFilter);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch platform deployments: ${error.message}`);
    }

    const rows = (data as PlatformDeploymentRow[]) ?? [];
    if (rows.length === ROW_LIMIT) {
      console.warn('[dora-metrics] row limit hit — metrics may be truncated', {
        table: 'platform_deployment',
        limit: ROW_LIMIT,
        start: start.toISOString(),
        end: end.toISOString(),
        serviceFilter: serviceFilter ?? null,
        environmentFilter: environmentFilter ?? null,
      });
    }
    return rows;
  }

  /**
   * Fetch platform incident rows from Supabase for a date range,
   * optionally filtered by service name. Only includes resolved incidents
   * (which have resolution_ms) for MTTR computation.
   */
  private async fetchIncidents(
    start: Date,
    end: Date,
    serviceFilter?: string | null,
    environmentFilter?: string | null,
  ): Promise<PlatformIncidentRow[]> {
    let query = (this.supabase as any)
      .from('platform_incident')
      .select('id, service, environment, status, deployment_id, started_at, resolved_at, resolution_ms')
      .gte('started_at', start.toISOString())
      .lt('started_at', end.toISOString())
      .order('started_at', { ascending: true })
      // PostgREST silently caps at 1000 rows without an explicit limit.
      .limit(ROW_LIMIT);

    if (serviceFilter) {
      query = query.eq('service', serviceFilter);
    }

    // BetterStack monitors cover BOTH staging and production. Filtering on
    // the mapped environment keeps staging incidents out of production
    // MTTR/CFR (and vice versa). NULL-environment rows (collector could not
    // infer) are excluded by eq() — better uncounted than miscounted.
    if (environmentFilter) {
      query = query.eq('environment', environmentFilter);
    }

    const { data, error } = await query;

    if (error) {
      // Non-fatal: fall back to deployment-based metrics
      console.error(`[dora-metrics] Failed to fetch incidents: ${error.message}`);
      return [];
    }

    const rows = (data as PlatformIncidentRow[]) ?? [];
    if (rows.length === ROW_LIMIT) {
      console.warn('[dora-metrics] row limit hit — metrics may be truncated', {
        table: 'platform_incident',
        limit: ROW_LIMIT,
        start: start.toISOString(),
        end: end.toISOString(),
        serviceFilter: serviceFilter ?? null,
      });
    }
    return rows;
  }

  // =========================================================================
  // Metric Building Helpers
  // =========================================================================

  private buildMetricValue(
    metricType: 'deployment_frequency' | 'lead_time' | 'change_failure_rate' | 'mttr',
    currentValue: number,
    previousValue: number,
    sampleSize: number,
    unit: string,
  ): DoraMetricValue {
    const changePercent = computeChangePercentShared(currentValue, previousValue);
    return {
      value: roundToShared(currentValue, 2),
      unit,
      performanceLevel: classifyPerformanceLevel(metricType, currentValue),
      trend: {
        direction: trendDirectionFromChange(changePercent),
        changePercent,
      },
      sampleSize,
    };
  }

  private buildRankingMetric(
    metricType: 'deployment_frequency' | 'lead_time' | 'change_failure_rate' | 'mttr',
    value: number,
  ): DoraAppRankingMetric {
    return {
      value: roundToShared(value, 2),
      performanceLevel: classifyPerformanceLevel(metricType, value),
    };
  }

  // =========================================================================
  // Sorting
  // =========================================================================

  private sortRankings(
    rankings: DoraAppRanking[],
    sortBy: string,
    sortOrder: string,
  ): void {
    const metricKeyMap: Record<string, keyof DoraAppRanking['metrics']> = {
      deploymentFrequency: 'deploymentFrequency',
      leadTime: 'leadTime',
      changeFailureRate: 'changeFailureRate',
      mttr: 'mttr',
    };

    const metricKey = metricKeyMap[sortBy] ?? 'deploymentFrequency';
    const ascending = sortOrder === 'asc';

    rankings.sort((a, b) => {
      const aVal = a.metrics[metricKey].value;
      const bVal = b.metrics[metricKey].value;
      return ascending ? aVal - bVal : bVal - aVal;
    });
  }

  // =========================================================================
  // Utility Helpers
  // =========================================================================

  private daysBetween(start: Date, end: Date): number {
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

export function createDoraMetricsService(
  supabase: SupabaseClient,
): DoraMetricsService {
  return new DoraMetricsService(supabase);
}

// ---------------------------------------------------------------------------
// Preview Mode — mock data for Vercel preview deployments
// ---------------------------------------------------------------------------

/**
 * Returns true when running on a Vercel preview branch where the
 * platform_deployment table has no real data. Mirrors the ClickHouse
 * pattern in analytics/service.ts.
 */
export function isPreviewMode(): boolean {
  return process.env.VERCEL_ENV === 'preview';
}

/**
 * Returns true in GitHub Actions CI.
 *
 * Keys specifically on `GITHUB_ACTIONS`, NOT the ambient `CI` variable. Many
 * real (non-preview) environments — and some local tooling — export `CI=true`,
 * and keying on that would leak mock DORA data into a production-like
 * deployment. `GITHUB_ACTIONS=true` is set only by the GitHub Actions runner.
 */
export function isCiMode(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Returns the appropriate DORA metrics service for the current environment.
 *
 * - Production / local dev: real DoraMetricsService backed by Supabase
 * - Vercel preview or CI: MockDoraMetricsService with realistic generated data
 *
 * When in preview/CI mode, the supabase parameter is ignored.
 */
export function getDoraMetricsService(
  supabase: SupabaseClient,
): DoraMetricsService | MockDoraMetricsService {
  if (isPreviewMode()) {
    console.log('[dora-metrics] Preview mode — using mock deployment data');
    return new MockDoraMetricsService();
  }
  if (isCiMode()) {
    console.log('[dora-metrics] CI mode — using mock deployment data');
    return new MockDoraMetricsService();
  }
  return new DoraMetricsService(supabase);
}
