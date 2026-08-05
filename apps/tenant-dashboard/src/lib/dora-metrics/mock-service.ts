/**
 * Mock DORA Metrics Service
 *
 * Returns realistic fake data when running in Vercel preview mode (no
 * platform_deployment table data) or in GitHub Actions CI. Mirrors
 * DoraMetricsService's public API so routes don't care which implementation
 * they get.
 *
 * Crucially, every metric here is computed via the SAME shared helpers as the
 * real service (`./constants`) — same DF/CFR/MTTR/lead-time formulas and the
 * same offset-based UTC bucketing — so mock and production behave identically.
 */

import type {
  DoraMetricsResponse,
  DoraTrendsResponse,
  DoraRankingsResponse,
  DoraMetricValue,
  DoraAppRanking,
  DoraAppRankingMetric,
  TrendDirection,
  TrendSeries,
} from './types';
import { classifyPerformanceLevel } from './thresholds';
import { resolveTimeRange } from './validation';
import {
  getMockDeployments,
  getMockIncidents,
  type MockDeployment,
  type MockIncident,
} from './mock-data';
import {
  MS_PER_DAY,
  computeMetrics as computeMetricsShared,
  computeChangePercent as computeChangePercentShared,
  trendDirectionFromChange,
  bucketByTime,
  resolveLeadTimeMode,
  resolveMttrMode,
  deploymentRecoveries,
  median,
  roundTo,
} from './constants';

// ============================================================================
// MockDoraMetricsService
// ============================================================================

export class MockDoraMetricsService {
  // =========================================================================
  // Public Methods (same signatures as DoraMetricsService)
  // =========================================================================

  async getMetrics(
    timeRange: string,
    serviceFilter?: string | null,
    environmentFilter: string | null = 'production',
  ): Promise<DoraMetricsResponse> {
    const { start, end, previousStart, previousEnd } = resolveTimeRange(timeRange);
    const days = this.daysBetween(start, end);

    const currentDeployments = this.filterDeployments(start, end, serviceFilter);
    const previousDeployments = this.filterDeployments(previousStart, previousEnd, serviceFilter);
    const currentIncidents = this.filterIncidents(start, end, serviceFilter);
    const previousIncidents = this.filterIncidents(previousStart, previousEnd, serviceFilter);

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
          'deployment_frequency', current.deploymentFrequency, previous.deploymentFrequency,
          current.sampleSizes.deploymentFrequency, 'deploys/day',
        ),
        leadTime: {
          ...this.buildMetricValue(
            'lead_time', current.leadTime, previous.leadTime,
            current.sampleSizes.leadTime, 'hours',
          ),
          isProxy: current.leadTimeIsProxy,
        },
        changeFailureRate: this.buildMetricValue(
          'change_failure_rate', current.changeFailureRate, previous.changeFailureRate,
          current.sampleSizes.changeFailureRate, '%',
        ),
        mttr: this.buildMetricValue(
          'mttr', current.mttr ?? 0, previous.mttr ?? 0,
          current.sampleSizes.mttr, 'hours',
        ),
      },
      period: { start: start.toISOString(), end: end.toISOString() },
      comparisonPeriod: { start: previousStart.toISOString(), end: previousEnd.toISOString() },
      environment: environmentFilter ?? null,
    };
  }

  async getTrends(
    timeRange: string,
    serviceFilter?: string | null,
  ): Promise<DoraTrendsResponse> {
    const { start, end } = resolveTimeRange(timeRange);
    const granularity = timeRange === '90d' ? 'week' : 'day';

    const deployments = this.filterDeployments(start, end, serviceFilter);
    const incidents = this.filterIncidents(start, end, serviceFilter);

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

    const leadTimeMode = resolveLeadTimeMode(deployments);
    const mttrMode = resolveMttrMode(incidents);

    // Deployment-mode MTTR pairs a failure with its recovering success over the
    // whole window and attributes each recovery to the failure's bucket — a
    // per-bucket pairing misses cross-bucket recoveries and empties the trend.
    // Mirrors the real service so mock and prod trend shapes match.
    const deploymentRecoveryBuckets =
      mttrMode === 'deployment'
        ? bucketByTime(deploymentRecoveries(deployments), (r) => r.failedAtMs, start, end, granularity)
        : null;

    const deploymentFrequencySeries: TrendSeries['series'] = [];
    const leadTimeSeries: TrendSeries['series'] = [];
    const changeFailureRateSeries: TrendSeries['series'] = [];
    const mttrSeries: TrendSeries['series'] = [];

    for (const [bucketLabel, bucketRows] of Array.from(buckets.entries())) {
      const bucketDays = granularity === 'week' ? 7 : 1;
      const bucketIncidents = incidentBuckets.get(bucketLabel) ?? [];
      const metrics = computeMetricsShared(
        bucketRows,
        bucketDays,
        bucketIncidents,
        leadTimeMode,
        mttrMode,
      );

      deploymentFrequencySeries.push({ x: bucketLabel, y: metrics.deploymentFrequency });
      leadTimeSeries.push({ x: bucketLabel, y: metrics.leadTime });
      changeFailureRateSeries.push({ x: bucketLabel, y: metrics.changeFailureRate });

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
      period: { start: start.toISOString(), end: end.toISOString() },
      granularity,
    };
  }

  async getRankings(
    timeRange: string,
    sortBy: string,
    sortOrder: string,
  ): Promise<DoraRankingsResponse> {
    const { start, end } = resolveTimeRange(timeRange);
    const days = this.daysBetween(start, end);

    const deployments = this.filterDeployments(start, end, null);
    const incidents = this.filterIncidents(start, end, null);

    const groupedByService = new Map<string, MockDeployment[]>();
    for (const d of deployments) {
      const existing = groupedByService.get(d.service);
      if (existing) existing.push(d);
      else groupedByService.set(d.service, [d]);
    }

    const incidentsByService = new Map<string, MockIncident[]>();
    for (const inc of incidents) {
      if (!inc.service) continue;
      const existing = incidentsByService.get(inc.service);
      if (existing) existing.push(inc);
      else incidentsByService.set(inc.service, [inc]);
    }

    if (groupedByService.size === 0) {
      return { rankings: [], period: { start: start.toISOString(), end: end.toISOString() } };
    }

    const rankings: DoraAppRanking[] = [];
    for (const [serviceName, serviceDeployments] of Array.from(groupedByService.entries())) {
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

    this.sortRankings(rankings, sortBy, sortOrder);

    return { rankings, period: { start: start.toISOString(), end: end.toISOString() } };
  }

  /** Returns distinct service names from mock data (used by /apps route). */
  getServices(): string[] {
    const pool = getMockDeployments();
    return Array.from(new Set(pool.map((d) => d.service))).sort();
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private filterDeployments(
    start: Date,
    end: Date,
    serviceFilter?: string | null,
  ): MockDeployment[] {
    const pool = getMockDeployments();
    return pool.filter((d) => {
      const t = new Date(d.started_at);
      if (t < start || t >= end) return false;
      if (serviceFilter && d.service !== serviceFilter) return false;
      return true;
    });
  }

  private filterIncidents(
    start: Date,
    end: Date,
    serviceFilter?: string | null,
  ): MockIncident[] {
    const pool = getMockIncidents();
    return pool.filter((inc) => {
      const t = new Date(inc.started_at);
      if (t < start || t >= end) return false;
      if (serviceFilter && inc.service !== serviceFilter) return false;
      return true;
    });
  }

  private buildMetricValue(
    metricType: 'deployment_frequency' | 'lead_time' | 'change_failure_rate' | 'mttr',
    currentValue: number,
    previousValue: number,
    sampleSize: number,
    unit: string,
  ): DoraMetricValue {
    const changePercent = computeChangePercentShared(currentValue, previousValue);
    const direction = this.computeTrendDirection(changePercent);

    return {
      value: roundTo(currentValue, 2),
      unit,
      performanceLevel: classifyPerformanceLevel(metricType, currentValue),
      trend: { direction, changePercent },
      sampleSize,
    };
  }

  private buildRankingMetric(
    metricType: 'deployment_frequency' | 'lead_time' | 'change_failure_rate' | 'mttr',
    value: number,
  ): DoraAppRankingMetric {
    return {
      value: roundTo(value, 2),
      performanceLevel: classifyPerformanceLevel(metricType, value),
    };
  }

  private computeTrendDirection(changePercent: number): TrendDirection {
    return trendDirectionFromChange(changePercent);
  }

  private sortRankings(rankings: DoraAppRanking[], sortBy: string, sortOrder: string): void {
    const key = sortBy as keyof DoraAppRanking['metrics'];
    rankings.sort((a, b) => {
      const aVal = a.metrics[key]?.value ?? 0;
      const bVal = b.metrics[key]?.value ?? 0;
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }

  private daysBetween(start: Date, end: Date): number {
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
  }
}
