// ---------------------------------------------------------------------------
// DORA Metrics - Type Definitions
// ---------------------------------------------------------------------------

/** The four key DORA metrics. */
export type DoraMetricType =
  | 'deployment_frequency'
  | 'lead_time'
  | 'change_failure_rate'
  | 'mttr';

/** Performance classification used across all metrics. */
export type PerformanceLevel = 'elite' | 'high' | 'medium' | 'low';

/** Direction of a metric trend relative to the comparison period. */
export type TrendDirection = 'up' | 'down' | 'stable';

/** Supported time-range filters for DORA queries. */
export type DoraTimeRange = '7d' | '30d' | '90d';

/**
 * Deployment environment a DORA query is scoped to. The platform-admin
 * dashboard lets the operator slice metrics by environment rather than
 * inferring it from the host serving the page.
 */
/** A deployment environment. Resolved server-side from DORA_ENVIRONMENT —
 *  never client input (see config-global.server.ts). */
type DoraEnvironment = 'production' | 'staging';

// ---------------------------------------------------------------------------
// Metric Values
// ---------------------------------------------------------------------------

/** A single DORA metric value with performance context. */
export interface DoraMetricValue {
  value: number;
  unit: string;
  performanceLevel: PerformanceLevel;
  trend: {
    direction: TrendDirection;
    changePercent: number;
  };
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// Metrics Response
// ---------------------------------------------------------------------------

/** Response shape returned by the DORA metrics summary endpoint. */
export interface DoraMetricsResponse {
  /** The deployment environment this response was computed for. Resolved
   *  server-side from DORA_ENVIRONMENT — never from client input. */
  environment: DoraEnvironment | string | null;
  metrics: {
    deploymentFrequency: DoraMetricValue;
    leadTime: DoraMetricValue & {
      /** When true, lead time is estimated from proxy data (e.g. commit-to-deploy). */
      isProxy?: boolean;
    };
    changeFailureRate: DoraMetricValue;
    mttr: DoraMetricValue;
  };
  period: {
    start: string;
    end: string;
  };
  comparisonPeriod: {
    start: string;
    end: string;
  };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/** A time-series for a single DORA metric.
 *
 * `y` is `null` for buckets where the metric is undefined for that interval —
 * e.g. an MTTR bucket with no resolved incident while the window is in
 * incident-based mode. Charts render gaps for null rather than a misleading 0.
 */
export interface TrendSeries {
  series: { x: string; y: number | null }[];
  granularity: 'day' | 'week';
}

/** Response shape returned by the DORA trends endpoint. */
export interface DoraTrendsResponse {
  trends: {
    deploymentFrequency: TrendSeries;
    leadTime: TrendSeries;
    changeFailureRate: TrendSeries;
    mttr: TrendSeries;
  };
  period: {
    start: string;
    end: string;
  };
  granularity: 'day' | 'week';
}

// ---------------------------------------------------------------------------
// App Rankings
// ---------------------------------------------------------------------------

/** A single metric value within an app ranking row. */
export interface DoraAppRankingMetric {
  value: number;
  performanceLevel: PerformanceLevel;
}

/** An individual service entry in the rankings table. */
export interface DoraAppRanking {
  serviceId: string;
  serviceName: string;
  metrics: {
    deploymentFrequency: DoraAppRankingMetric;
    leadTime: DoraAppRankingMetric;
    changeFailureRate: DoraAppRankingMetric;
    mttr: DoraAppRankingMetric;
  };
  totalDeployments: number;
}

/** Response shape returned by the DORA rankings endpoint. */
export interface DoraRankingsResponse {
  rankings: DoraAppRanking[];
  period: {
    start: string;
    end: string;
  };
}

// ---------------------------------------------------------------------------
// Display Configuration
// ---------------------------------------------------------------------------

/** Presentation metadata for a DORA metric (titles, formatting, sort direction). */
export interface DoraMetricConfig {
  key: DoraMetricType;
  title: string;
  description: string;
  unit: string;
  formatValue: (value: number) => string;
  higherIsBetter: boolean;
  /** What the metric measures and why it matters — shown in the card info popover. */
  explanation: string;
  /** Authoritative DORA source for "learn more" — shown in the card info popover. */
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Collection Status
// ---------------------------------------------------------------------------

/** Response from the collection status endpoint. */
export interface CollectionStatusResponse {
  sources: Array<{
    source: string;
    last_collected_at: string | null;
    last_run_at: string | null;
    last_run_status: string;
    last_error: string | null;
  }>;
}
