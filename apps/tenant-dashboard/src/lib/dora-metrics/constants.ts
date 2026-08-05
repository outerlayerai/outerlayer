// ---------------------------------------------------------------------------
// DORA Metrics - Shared Constants & Pure Computation Helpers
//
// Extracted so the real DoraMetricsService (Supabase-backed) and the
// MockDoraMetricsService (preview/CI fixtures) compute every metric with
// IDENTICAL formulas. Anything here is a pure function — no I/O, no clock
// reads — so it can be unit-tested directly without an HTTP boundary.
//
// DORA metric definitions encoded here:
//
//   Deployment Frequency
//     numerator   = SUCCESSFUL deploys (status 'success'). Per the Four Keys
//                   reference implementation and dora.dev practice, DF counts
//                   deployments that reached production; failed attempts are
//                   pipeline health, not delivery throughput.
//     denominator = days in the window.
//     A 1-day trend bucket's value is therefore that day's completed-deploy
//     count (the per-day rate), using the SAME population as the summary.
//
//   Lead Time (never blends two clocks into one median)
//     If ANY deployment in the window has first_commit_at → commit-to-deploy
//     lead time over the deploys that have it; isProxy = false.
//     Otherwise → duration_ms median as a proxy; isProxy = true.
//
//   Change Failure Rate
//     numerator   = SUCCESSFUL deploys whose id appears in an incident's
//                   deployment_id correlation. Pipeline failures
//                   (status 'failure') never shipped, so they do NOT count as
//                   production change failures.
//     denominator = successful deploys only.
//     Zero successful deploys → rate 0, sample size 0.
//
//   MTTR (one consistent source per response, decided at the window level)
//     If the full window has ≥1 resolved incident → incident-based MTTR for
//     the summary AND every trend bucket (buckets with no resolved incidents
//     are null, NOT a deployment-based fallback).
//     Otherwise → deployment-recovery fallback everywhere, flagged.
// ---------------------------------------------------------------------------

/** Threshold percentage for determining trend direction. */
export const TREND_THRESHOLD_PERCENT = 5;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 60 * 60 * 1000;

/** Milliseconds per day. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Milliseconds per week. */
export const MS_PER_WEEK = 7 * MS_PER_DAY;

/** Maximum rows fetched per query. PostgREST silently caps at 1000 unless an
 *  explicit limit is set; we raise the ceiling and warn when it is hit so a
 *  truncated dataset is never mistaken for a complete one. */
export const ROW_LIMIT = 5000;

/** Deployment statuses that represent completed deployments. */
export const COMPLETED_STATUSES = ['success', 'failure'] as const;

// ---------------------------------------------------------------------------
// Minimal structural shapes the pure helpers operate on.
// Both PlatformDeploymentRow and MockDeployment satisfy these.
// ---------------------------------------------------------------------------

/** Minimal deployment shape the metric helpers read. */
export interface DeploymentLike {
  id: string;
  service: string;
  status: string;
  duration_ms: number | null;
  first_commit_at?: string | null;
  completed_at: string | null;
  started_at: string;
}

/** Minimal incident shape the metric helpers read. */
export interface IncidentLike {
  deployment_id: string | null;
  resolution_ms: number | null;
}

/** Which clock the lead-time median was computed from. */
type LeadTimeMode = 'commit' | 'duration';

/** Which source MTTR is computed from for the whole response. */
type MttrMode = 'incident' | 'deployment';

/** Result of computing all four DORA metrics over one population. */
interface ComputedMetrics {
  deploymentFrequency: number;
  /** Lead time in hours. `null` when no deploy contributed a value. */
  leadTime: number;
  /** Whether lead time is a proxy (duration-based) rather than commit-based. */
  leadTimeIsProxy: boolean;
  /** CFR as a percentage. */
  changeFailureRate: number;
  /** MTTR in hours, or `null` when the chosen source has no data here. */
  mttr: number | null;
  sampleSizes: {
    deploymentFrequency: number;
    leadTime: number;
    changeFailureRate: number;
    mttr: number;
  };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/** Median of a numeric array. Returns 0 for an empty array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1] ?? 0;
    const upper = sorted[mid] ?? 0;
    return (lower + upper) / 2;
  }
  return sorted[mid] ?? 0;
}

/** Round to a fixed number of decimals. */
export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Percentage change from `previous` to `current`.
 * - both zero → 0
 * - previous zero, current non-zero → 100
 * - otherwise → ((current - previous) / previous) * 100, rounded to 1 decimal
 */
export function computeChangePercent(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return roundTo(((current - previous) / previous) * 100, 1);
}

// ---------------------------------------------------------------------------
// Lead time
// ---------------------------------------------------------------------------

/**
 * Decide whether the window uses commit-based lead time (any deploy has
 * first_commit_at) or the duration_ms proxy. Decided once at the window level
 * so trend buckets stay consistent with the summary.
 */
export function resolveLeadTimeMode(deployments: DeploymentLike[]): LeadTimeMode {
  return deployments.some((d) => d.first_commit_at) ? 'commit' : 'duration';
}

/**
 * Lead times (ms) for a population under a fixed mode. Never blends clocks:
 * - 'commit'   → only deploys with a positive first_commit_at→completed_at gap.
 * - 'duration' → only deploys with a positive duration_ms.
 */
export function leadTimesMs(deployments: DeploymentLike[], mode: LeadTimeMode): number[] {
  const out: number[] = [];
  for (const d of deployments) {
    if (mode === 'commit') {
      if (d.first_commit_at && d.completed_at) {
        const diff = new Date(d.completed_at).getTime() - new Date(d.first_commit_at).getTime();
        if (diff > 0) out.push(diff);
      }
    } else {
      if (d.duration_ms && d.duration_ms > 0) out.push(d.duration_ms);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change failure rate
// ---------------------------------------------------------------------------

/** Set of deployment ids correlated with an incident. */
export function incidentDeploymentIds(incidents: IncidentLike[]): Set<string> {
  return new Set(
    incidents
      .filter((inc) => inc.deployment_id !== null)
      .map((inc) => inc.deployment_id as string),
  );
}

// ---------------------------------------------------------------------------
// MTTR
// ---------------------------------------------------------------------------

/**
 * Change-caused incidents only: the 2023+ DORA definition is "failed
 * deployment recovery time" — restoring service after production failures
 * CAUSED BY SOFTWARE CHANGES (dora.dev/insights/dora-metrics-history). An
 * incident is change-caused here iff correlation attributed it to a
 * deployment. This also makes MTTR and CFR share one incident population.
 */
function changeCausedIncidents(incidents: IncidentLike[]): IncidentLike[] {
  return incidents.filter((i) => i.deployment_id !== null);
}

/**
 * Decide the MTTR source for the whole response. Incident-based wins whenever
 * the full window has at least one resolved CHANGE-CAUSED incident (positive
 * resolution_ms on a deployment-correlated incident); otherwise the
 * deployment-recovery fallback is used everywhere.
 */
export function resolveMttrMode(incidents: IncidentLike[]): MttrMode {
  const hasResolved = changeCausedIncidents(incidents).some(
    (i) => i.resolution_ms !== null && i.resolution_ms > 0,
  );
  return hasResolved ? 'incident' : 'deployment';
}

/** Resolution times (ms, positive only) of resolved CHANGE-CAUSED incidents. */
export function resolutionTimesMs(incidents: IncidentLike[]): number[] {
  return changeCausedIncidents(incidents)
    .filter((i) => i.resolution_ms !== null && i.resolution_ms > 0)
    .map((i) => i.resolution_ms as number);
}

/**
 * Deployment-recovery pairs. For each failed deploy, the gap to the next
 * successful deploy for the same service, tagged with the FAILURE timestamp
 * (`failedAtMs`). The timestamp lets trend bucketing attribute each recovery to
 * the day the failure occurred — necessary because the recovering success
 * routinely lands in a later bucket than the failure, so pairing must happen
 * over the whole window, not per-bucket. Input need not be pre-sorted; this
 * sorts per-service by started_at ascending.
 */
export function deploymentRecoveries(
  deployments: DeploymentLike[],
): { failedAtMs: number; recoveryHours: number }[] {
  const byService = new Map<string, DeploymentLike[]>();
  for (const d of deployments) {
    const existing = byService.get(d.service);
    if (existing) existing.push(d);
    else byService.set(d.service, [d]);
  }

  const recoveries: { failedAtMs: number; recoveryHours: number }[] = [];
  for (const serviceDeployments of byService.values()) {
    const sorted = [...serviceDeployments].sort((a, b) =>
      a.started_at.localeCompare(b.started_at),
    );
    for (let i = 0; i < sorted.length; i++) {
      const failed = sorted[i];
      if (!failed || failed.status !== 'failure') continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const candidate = sorted[j];
        if (candidate && candidate.status === 'success') {
          const failedAtMs = new Date(failed.started_at).getTime();
          const recoveredAtMs = new Date(candidate.started_at).getTime();
          recoveries.push({
            failedAtMs,
            recoveryHours: (recoveredAtMs - failedAtMs) / MS_PER_HOUR,
          });
          break;
        }
      }
    }
  }
  return recoveries;
}

/**
 * Deployment-recovery times (hours) over a population — the recovery values
 * only, for whole-window medians (summary card, rankings). Trend bucketing uses
 * {@link deploymentRecoveries} instead so it can bucket by failure time.
 */
export function deploymentRecoveryHours(deployments: DeploymentLike[]): number[] {
  return deploymentRecoveries(deployments).map((r) => r.recoveryHours);
}

// ---------------------------------------------------------------------------
// Combined metric computation
// ---------------------------------------------------------------------------

/**
 * Compute all four DORA metrics for one population (a window or a single trend
 * bucket). `leadTimeMode` and `mttrMode` are decided once at the window level
 * and passed in so every bucket is consistent with the summary.
 *
 * MTTR semantics:
 * - mode 'incident'   → median of this population's resolved incidents, or
 *                       `null` when this population has none (e.g. an empty
 *                       trend bucket). NEVER falls back to deployments.
 * - mode 'deployment' → average deployment-recovery hours, or `null` when
 *                       there is no failure→success pair here.
 */
export function computeMetrics(
  deployments: DeploymentLike[],
  days: number,
  incidents: IncidentLike[],
  leadTimeMode: LeadTimeMode,
  mttrMode: MttrMode,
): ComputedMetrics {
  const successful = deployments.filter((d) => d.status === 'success');

  // Deployment Frequency: SUCCESSFUL deploys / days — per the Four Keys
  // reference implementation and dora.dev practice, deployment frequency
  // counts deployments that reached production; failed attempts belong to
  // pipeline health, not delivery throughput.
  const deploymentFrequency = days > 0 ? successful.length / days : 0;

  // Lead Time: single-clock median under the resolved mode.
  const lt = leadTimesMs(deployments, leadTimeMode);
  const leadTime = lt.length > 0 ? median(lt) / MS_PER_HOUR : 0;

  // Change Failure Rate: successful deploys correlated with incidents,
  // over successful deploys only.
  const incidentIds = incidentDeploymentIds(incidents);
  const failedSuccessful = successful.filter((d) => incidentIds.has(d.id)).length;
  const changeFailureRate =
    successful.length > 0 ? (failedSuccessful / successful.length) * 100 : 0;

  // MTTR: one source for the whole response.
  let mttr: number | null;
  let mttrSampleSize: number;
  if (mttrMode === 'incident') {
    const times = resolutionTimesMs(incidents);
    mttr = times.length > 0 ? median(times) / MS_PER_HOUR : null;
    mttrSampleSize = times.length;
  } else {
    const recoveries = deploymentRecoveryHours(deployments);
    // Median (not mean) — consistent with incident-mode MTTR above and DORA's
    // skew-resistant "time to restore" convention (one slow recovery shouldn't
    // drag the whole window). `recoveries` is already in hours.
    mttr = recoveries.length > 0 ? median(recoveries) : null;
    mttrSampleSize = recoveries.length;
  }

  return {
    deploymentFrequency,
    leadTime,
    leadTimeIsProxy: leadTimeMode === 'duration',
    changeFailureRate,
    mttr,
    sampleSizes: {
      deploymentFrequency: successful.length,
      leadTime: lt.length,
      changeFailureRate: successful.length,
      mttr: mttrSampleSize,
    },
  };
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

/** UTC date label (YYYY-MM-DD) for a Date. */
export function formatDateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Offset-based UTC bucketing. Creates one empty bucket per interval across
 * [start, end), then assigns each item by integer offset from `start`. O(n).
 * Items outside the range are dropped. Returns insertion-ordered buckets.
 *
 * Used identically by the real and mock services so trend shapes match.
 */
export function bucketByTime<T>(
  items: T[],
  getTime: (item: T) => number,
  start: Date,
  end: Date,
  granularity: 'day' | 'week',
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  const intervalMs = granularity === 'week' ? MS_PER_WEEK : MS_PER_DAY;
  const startMs = start.getTime();

  let cursor = startMs;
  while (cursor < end.getTime()) {
    buckets.set(formatDateLabel(new Date(cursor)), []);
    cursor += intervalMs;
  }

  for (const item of items) {
    const offsetMs = getTime(item) - startMs;
    if (offsetMs < 0) continue;
    const bucketIndex = Math.floor(offsetMs / intervalMs);
    const bucketStart = new Date(startMs + bucketIndex * intervalMs);
    const label = formatDateLabel(bucketStart);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(item);
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Trend direction
// ---------------------------------------------------------------------------

type TrendDirectionValue = 'up' | 'down' | 'stable';

/** Trend direction from a change percentage, using TREND_THRESHOLD_PERCENT. */
export function trendDirectionFromChange(changePercent: number): TrendDirectionValue {
  if (changePercent > TREND_THRESHOLD_PERCENT) return 'up';
  if (changePercent < -TREND_THRESHOLD_PERCENT) return 'down';
  return 'stable';
}
