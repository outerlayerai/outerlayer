// ---------------------------------------------------------------------------
// DORA Metrics - Thresholds & Classification Logic
// ---------------------------------------------------------------------------

import type { DoraMetricType, DoraMetricConfig, PerformanceLevel } from './types';

// ---------------------------------------------------------------------------
// Threshold Definitions
// ---------------------------------------------------------------------------

/**
 * Boundary values for each DORA metric performance level.
 *
 * - `elite`, `high`, `medium` hold the threshold value.
 * - For "higher is better" metrics the value is a *minimum* (>=).
 * - For "lower is better" metrics the value is a *maximum* (<).
 * - Anything below medium falls into `low`.
 */
interface MetricThresholds {
  elite: number;
  high: number;
  medium: number;
  /** When true, higher values indicate better performance. */
  higherIsBetter: boolean;
}

/**
 * DORA benchmark thresholds — these are the 2021 State of DevOps bands
 * (https://dora.dev/research/2021/dora-report/), deliberately. They are the
 * most recent OFFICIAL year with monotonic, band-shaped cutoffs:
 *
 * - 2022 dropped the Elite cluster entirely (three clusters).
 * - 2023/2024 published cluster CENTROIDS, not bands — the 2024 CFR column
 *   is non-monotonic (Elite 5%, High 20%, Medium 10%, Low 40%) and cannot
 *   be used as classification boundaries.
 * - 2025 abolished performance tiers altogether (seven team archetypes).
 *
 * DORA also notes the levels "emerge from the survey responses" each year
 * rather than being normative targets — treat these badges as orientation,
 * not certification.
 *
 * deployment_frequency — successful deploys per day (higher is better).
 *   Note: 2021 Elite is "on-demand (multiple deploys per day)"; our >=1/day
 *   boundary admits exactly-daily deployers — a deliberate simplification.
 * lead_time           — hours from commit to production (lower is better)
 * change_failure_rate — percentage of deployments causing failure (lower is better)
 * mttr                — hours to recover from change-caused failures (lower is better)
 */
export const DORA_THRESHOLDS: Record<DoraMetricType, MetricThresholds> = {
  deployment_frequency: {
    elite: 1,        // multiple deploys per day
    high: 1 / 7,     // ~0.143 — at least weekly
    medium: 1 / 30,  // ~0.033 — at least monthly
    higherIsBetter: true,
  },
  lead_time: {
    elite: 1,    // less than 1 hour
    high: 24,    // less than 1 day
    medium: 168, // less than 1 week (7 * 24)
    higherIsBetter: false,
  },
  change_failure_rate: {
    // NOTE: elite === high === 15 by design — the official DORA research puts
    // elite, high, and medium performers all at the same 0–15% CFR band, so
    // there is no separate "high" tier for CFR. Because classification uses
    // strict `<` comparisons against elite then high, a value can never land
    // on 'high': anything `< 15` is already 'elite', and `>= 15` skips past
    // the identical high boundary to be tested against medium. This is
    // intentional; do NOT "fix" it by nudging the numbers apart.
    elite: 15, // < 15% → elite
    high: 15,  // unreachable tier (same boundary as elite); see note above
    medium: 30, // < 30% → medium; otherwise low
    higherIsBetter: false,
  },
  mttr: {
    elite: 1,    // less than 1 hour
    high: 24,    // less than 1 day
    medium: 168, // less than 1 week
    higherIsBetter: false,
  },
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a raw metric value into a DORA performance level.
 *
 * Returns `'low'` for null, undefined, NaN, or values that do not meet the
 * medium threshold.
 */
export function classifyPerformanceLevel(
  metricType: DoraMetricType,
  value: number,
): PerformanceLevel {
  if (value == null || Number.isNaN(value)) {
    return 'low';
  }

  const thresholds = DORA_THRESHOLDS[metricType];

  if (thresholds.higherIsBetter) {
    // Higher value = better performance
    if (value >= thresholds.elite) return 'elite';
    if (value >= thresholds.high) return 'high';
    if (value >= thresholds.medium) return 'medium';
    return 'low';
  }

  // Lower value = better performance
  if (value < thresholds.elite) return 'elite';
  if (value < thresholds.high) return 'high';
  if (value < thresholds.medium) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Display Constants
// ---------------------------------------------------------------------------

/** Semantic colors for each performance level (Tailwind-compatible hex). */
export const PERFORMANCE_LEVEL_COLORS: Record<PerformanceLevel, string> = {
  elite: '#22c55e', // green-500
  high: '#3b82f6',  // blue-500
  medium: '#f59e0b', // amber-500
  low: '#ef4444',   // red-500
};

/** Human-readable labels for each performance level. */
export const PERFORMANCE_LEVEL_LABELS: Record<PerformanceLevel, string> = {
  elite: 'Elite',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in hours to a human-readable string.
 * - < 1 hour  => minutes
 * - >= 24 hours => days
 * - otherwise  => hours (1 decimal)
 */
function formatDuration(hours: number): string {
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes}m`;
  }
  if (hours >= 24) {
    const days = hours / 24;
    return `${days.toFixed(1)}d`;
  }
  return `${hours.toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Metric Display Configs
// ---------------------------------------------------------------------------

/**
 * Canonical DORA reference. dora.dev is Google Cloud's official home for the
 * research program; its "Four Keys" guide defines all four metrics. Linked
 * from every metric's info popover.
 */
const DORA_FOUR_KEYS_GUIDE = 'https://dora.dev/guides/dora-metrics-four-keys/';

/** Display metadata for each of the four DORA metrics. */
export const DORA_METRIC_CONFIGS: DoraMetricConfig[] = [
  {
    key: 'deployment_frequency',
    title: 'Deployment Frequency',
    description: 'How often code is deployed to production.',
    unit: 'deploys/day',
    formatValue: (value: number) => value.toFixed(1),
    higherIsBetter: true,
    explanation:
      'How often you successfully ship code to production. One of DORA’s two throughput signals — frequent, small deployments correlate with faster delivery of value and lower risk per release.',
    sourceUrl: DORA_FOUR_KEYS_GUIDE,
  },
  {
    key: 'lead_time',
    title: 'Lead Time for Changes',
    description: 'Time from code commit to running in production.',
    unit: 'hours',
    formatValue: formatDuration,
    higherIsBetter: false,
    explanation:
      'The time from a commit landing to running in production. DORA’s other throughput signal — short lead times mean fast feedback and a responsive delivery pipeline.',
    sourceUrl: DORA_FOUR_KEYS_GUIDE,
  },
  {
    key: 'change_failure_rate',
    title: 'Change Failure Rate',
    description: 'Percentage of deployments causing a failure in production.',
    unit: '%',
    formatValue: (value: number) => `${value.toFixed(1)}%`,
    higherIsBetter: false,
    explanation:
      'The share of deployments that cause a failure in production needing a hotfix, rollback, or patch. A stability signal — a lower rate reflects a healthier delivery process.',
    sourceUrl: DORA_FOUR_KEYS_GUIDE,
  },
  {
    key: 'mttr',
    title: 'Mean Time to Restore',
    description: 'Time to recover from a change-caused failure in production.',
    unit: 'hours',
    formatValue: formatDuration,
    higherIsBetter: false,
    explanation:
      'How long it takes to restore service after a change-caused failure in production (DORA’s "failed deployment recovery time"). The other stability signal — fast recovery limits the blast radius of incidents.',
    sourceUrl: DORA_FOUR_KEYS_GUIDE,
  },
];
