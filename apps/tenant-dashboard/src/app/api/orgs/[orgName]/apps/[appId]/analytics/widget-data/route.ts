/**
 * Widget Data API Route
 *
 * POST /api/orgs/{orgName}/apps/{appId}/analytics/widget-data
 *
 * Fetches data for a single widget by mapping its metric config
 * to existing AnalyticsService methods. Uses POST to support
 * complex filter configurations in the request body.
 *
 * `// live:` — the dashboard polls this route every 60s
 * (`use-widget-data.ts`) because widget metrics advance server-side as new
 * spans land; it is the domain's one sanctioned live route. It sits on the
 * org-scoped path rather than the legacy `/api/analytics/**` tree so
 * `getRequestTenantId()` resolves from the URL org rather than falling back
 * to the JWT claim. The `[appId]` path segment names the canonical URL;
 * `withAnalyticsAuthParams` authorizes the `?appId` query, and the handler
 * pins the two equal so the URL can never name a different app than the one
 * actually authorized (mirrors `onboarding/checklist/route.ts`).
 */

import { NextResponse } from 'next/server';
import { getAnalyticsService, parseDateRange } from '@/lib/analytics';
import {
  getCachedScoreAggregations,
  getCachedScoreHistogram,
  getCachedScoreTrend,
  getCachedScoreComparison,
  getCachedScoreScatter,
} from '@/lib/analytics/cache';
import {
  toErrorResponse,
  getErrorStatusCode,
  mapClickHouseError,
  ValidationError,
} from '@/lib/analytics/errors';
import { analyticsLogger, createTimer } from '@/lib/analytics/logger';
import { withAnalyticsAuthParams } from '@/app/api/analytics/with-auth';
import { widgetDataRequestSchema } from '@/features/dashboards/validation';
import type {
  WidgetDataRequest,
  WidgetDataResponse,
  WidgetTimeSeriesResponse,
  WidgetStatResponse,
  WidgetRankingResponse,
  WidgetScoreSummaryResponse,
  WidgetScoreHistogramResponse,
  WidgetScoreTrendResponse,
  WidgetScoreComparisonResponse,
} from '@/features/dashboards/types';
import { isMetadataField, isDerivedMetric, getDerivedMetric, isScoreMetric, isAgentFleetMetric, isAgentPrMetric, agentFleetDimensionFor, METRIC_LABELS } from '@/features/dashboards/types';
import {
  computeAgentPrCycleTimeBreakdown,
  computeAgentPrCycleTimeTrend,
  computeAgentPrMergeRate,
  computeAgentPrOutcomeByScore,
  computeAgentPrReopenRate,
  computeAgentPrRevertRate,
  computeAgentCleanJobRate,
  computeAgentPrUnreviewedMergeRate,
  computeAgentShareOfMergedPrs,
  computeAgentVsHumanFirstPassCi,
  computeAgentVsHumanPrComparison,
  computeAgentVsHumanPrSize,
  computeDirectCostPerMergedPr,
  computeFullyLoadedCostPerMergedPr,
  computeMergedPrSizeTrend,
  computeShippedAutonomyLadder,
  computeUnshippedSpendShare,
  countAgentMergedPrs,
  priorWindow,
  type AgentPrAttribution,
  type AutonomyLadderItem,
  type PrCostAttributionRow,
  type PrCyclePhase,
  type PrLifecycleRow,
} from '@/lib/dashboards/pr-metrics';
import { getPredictorScoreVerdictsByPr } from '@/lib/system/pr-outcome-correlation/service';
import { isFateDerivedScoreName } from '@/lib/system/outcome-scores/score-rows';
import { namespaceOrgPrData } from '@/lib/dashboards/org-pr-scope';
import {
  fetchDecidedPullRequests,
  fetchDecidedPullRequestsForTenant,
} from '@/lib/system/pr-tracking/pr-lifecycle-read';
import { fetchAiCostConfigForTenant } from '@/lib/system';
import type { AnalyticsFilter, DateRange } from '@/lib/analytics/types';
import type { EnvironmentQueryScope } from '@repo/observability-service';

/**
 * Human-readable bar labels for the decomposed cycle-time phases, keyed by the
 * `PrCyclePhase` ids `PR_CYCLE_PHASES` fixes. Kept next to the response mapping
 * (presentation, not metric math) — the pure lib stays label-free.
 */
const PR_CYCLE_PHASE_LABELS: Record<PrCyclePhase, string> = {
  coding: 'Coding',
  pickup: 'Pickup',
  review: 'Review',
  merge: 'Merge',
};

// ============================================================================
// Env Scope Helper
// ============================================================================

/**
 * Builds the env-scope passed to the analytics metrics methods. The dashboard
 * view has already resolved each widget's env (inherit ⇒ dashboard env,
 * override ⇒ the widget's own list), so the route just maps the wire shape:
 *
 *  - empty / absent       ⇒ `undefined` (no env filter)
 *  - exactly one env      ⇒ single `environment` (honours the legacy
 *                           inclusion rule when it is the default env)
 *  - two or more envs     ⇒ `environments` allow-list (cross-env comparison)
 */
function resolveEnvScope(
  environments: string[] | undefined,
  environmentIsDefault: boolean | undefined,
): EnvironmentQueryScope | undefined {
  const list = (environments ?? []).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
  if (list.length === 0) return undefined;
  if (list.length === 1) {
    return {
      environment: { name: list[0]!, isDefault: environmentIsDefault ?? false },
    };
  }
  return { environments: list };
}

// ============================================================================
// Time Range Helpers
// ============================================================================

function resolveTimeRange(timeRange: WidgetDataRequest['timeRange']): DateRange {
  if (timeRange.preset) {
    return parseDateRange(timeRange.preset);
  }
  if (timeRange.start && timeRange.end) {
    return { start: timeRange.start, end: timeRange.end };
  }
  // Fallback — should not reach here due to Yup validation
  return parseDateRange('7d');
}

/**
 * MetricsService returns hourly buckets (date + hour columns) when
 * dateRange.start === dateRange.end (see services/metrics.ts). Mirror
 * that condition here so the chart receives an ISO datetime per point
 * instead of collapsing 24 hourly buckets onto the same date string.
 */
function buildTimeSeriesX(
  point: Record<string, number | string>,
  hourly: boolean,
): string {
  const date = (point.date as string) || '';
  if (!hourly) return date;
  const hour = String((point.hour as number) ?? 0).padStart(2, '0');
  return `${date}T${hour}:00:00Z`;
}

function mapWidgetFilters(
  filters?: Array<{ field: string; operator: string; value?: string }>
): AnalyticsFilter[] | undefined {
  if (!filters || filters.length === 0) return undefined;
  return filters.map((f) => ({
    field: f.field,
    operator: f.operator,
    value: f.value ?? '',
  }));
}

/**
 * Period-over-period change for a stat tile. A percent change against an
 * empty baseline (prior 0, current > 0) is undefined; substituting "+100%"
 * would make every tile on a fresh install claim +100.0%, which reads as
 * broken data. Instead `change` is omitted and `priorEmpty`
 * tells the stat card to render "no prior data". A true 0→0 stays a flat
 * 0% change (a real, comparable baseline).
 */
function statChange(
  currentValue: number,
  priorValue: number
): Pick<WidgetStatResponse, 'change' | 'priorEmpty'> {
  if (priorValue === 0 && currentValue > 0) {
    return { priorEmpty: true };
  }
  const changeValue =
    priorValue > 0 ? ((currentValue - priorValue) / priorValue) * 100 : 0;
  const direction: 'up' | 'down' | 'flat' =
    currentValue > priorValue ? 'up' : currentValue < priorValue ? 'down' : 'flat';
  return { change: { value: Math.round(changeValue * 100) / 100, direction } };
}

// ============================================================================
// Metric → Response Mappers
// ============================================================================

/**
 * Metrics that come from getMetrics() and produce time series or stat data.
 */
const METRICS_SERVICE_METRICS = new Set([
  'request_count',
  'total_cost',
  'avg_cost',
  'total_tokens',
  'avg_tokens',
  'unique_users',
  'error_count',
  'error_rate',
  'avg_latency',
]);

/**
 * Metrics that come from getPercentiles() — require raw trace data.
 */
const PERCENTILE_METRICS = new Set([
  'p50_latency',
  'p95_latency',
  'p99_latency',
]);

/**
 * Field mapping from our widget metric names to MetricsSummary keys.
 */
const METRIC_TO_SUMMARY_KEY: Record<string, string> = {
  request_count: 'totalRequests',
  total_cost: 'totalCost',
  avg_cost: 'avgCostPerRequest',
  total_tokens: 'totalTokens',
  avg_tokens: 'avgTotalTokensPerRequest',
  unique_users: 'uniqueUsers',
  error_count: 'errorCount',
  error_rate: 'errorRate',
  avg_latency: 'avgLatencyMs',
};

/**
 * Field mapping from widget metric names to TimeSeriesPoint keys.
 */
const METRIC_TO_TIMESERIES_KEY: Record<string, string> = {
  request_count: 'requests',
  total_cost: 'cost',
  total_tokens: 'tokens',
  unique_users: 'uniqueUsers',
  error_count: 'errors',
  avg_latency: 'avgLatencyMs',
};

/**
 * Mapping from widget metric names to ModelStats fields for groupBy queries.
 */
const METRIC_TO_MODEL_STATS_FIELD: Record<string, string> = {
  request_count: 'requests',
  total_cost: 'cost',
  total_tokens: 'tokens',
  avg_latency: 'avgLatencyMs',
  error_rate: 'successRate', // inverted — handle in code if needed
};

// ============================================================================
// Route Handler
// ============================================================================

export const POST = withAnalyticsAuthParams<{ orgName: string; appId: string }>(
  async (request, context, params) => {
  const timer = createTimer();
  const { appId } = context;

  try {
    // The `[appId]` path segment names the canonical URL; `?appId` is what
    // `withAnalyticsAuthParams` authorized. Pin them equal so the URL can
    // never name a different app than the one actually authorized.
    if (params.appId !== appId) {
      throw new ValidationError('appId path segment and query must match');
    }

    const body = await request.json();
    // A saved dashboard can name a metric this build no longer serves. That is
    // a bad request, not a server fault, so reject it as a 400 rather than
    // letting the raw schema failure fall through to the generic 500 mapping.
    const parsed = widgetDataRequestSchema.safeParse(body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(
        firstIssue?.message ?? 'Invalid widget data request',
        firstIssue?.path.join('.') || undefined
      );
    }
    const validated = parsed.data;

    const metric = validated.metric as string;
    const dateRange = resolveTimeRange(validated.timeRange as WidgetDataRequest['timeRange']);
    const hourly = dateRange.start === dateRange.end;
    const filters = mapWidgetFilters(validated.filters);
    const visualization = (body.visualization as string) || 'line';

    const groupBy = (validated.groupBy as string) || (body.groupBy as string) || null;
    const scoreName = (validated.scoreName as string) || (body.scoreName as string) || undefined;
    const scoreNameB = (validated.scoreNameB as string) || (body.scoreNameB as string) || undefined;

    // Env scoping. The dashboard view resolves
    // each widget's env (inherit ⇒ dashboard env, override ⇒ widget list)
    // before posting here, so the route receives a concrete env-name list.
    const env = resolveEnvScope(
      validated.environments as string[] | undefined,
      validated.environmentIsDefault as boolean | undefined,
    );
    // Fleet/PR query scope: 'app' (default — the dominant-repo convention) or
    // 'org' (tenant-wide rollup for the Executive Overview's org toggle).
    // tenantId comes from the verified TenantContext either way; org scope
    // widens WHICH of the tenant's rows are swept, never WHOSE.
    const scope = (validated.scope as string | undefined) === 'org' ? ('org' as const) : ('app' as const);
    const fleetOptions = scope === 'org' ? { scope } : undefined;
    let response: WidgetDataResponse;

    // Score metric handling — route to score analytics cache functions.
    // Env scoping now flows through to all score analytics queries
    // via the `environmentName` / `environmentIsDefault` params on the cache
    // functions. The `env` variable resolved above carries the widget's
    // effective env scope (inherit ⇒ header env, override ⇒ widget's own list).
    if (isScoreMetric(metric)) {
      const timeRange = validated.timeRange as WidgetDataRequest['timeRange'];
      const range = timeRange.preset ?? '7d';
      const startDate = timeRange.start;
      const endDate = timeRange.end;

      // Flatten the resolved env scope to the params the cache functions take.
      // Single/inherit widgets pass a name + default flag; a multi-env override
      // widget (N > 1 envs) passes the `environments` list so the score query
      // is `Environment IN (...)`, matching the non-score path, instead of
      // aggregating every env.
      const singleEnv = (env?.environment != null) ? env.environment : null;
      const envName = singleEnv?.name;
      const envIsDefault = singleEnv?.isDefault;
      const envList = env?.environments;

      if (metric === 'score_summary') {
        const result = await getCachedScoreAggregations(context, range, startDate, endDate, envName, envIsDefault, envList);
        response = { type: 'scoreSummary', aggregations: result.aggregations } satisfies WidgetScoreSummaryResponse;

      } else if (metric === 'score_histogram') {
        const name = scoreName ?? 'accuracy';
        const result = await getCachedScoreHistogram(context, name, range, startDate, endDate, undefined, envName, envIsDefault, envList);
        response = { type: 'scoreHistogram', data: result } satisfies WidgetScoreHistogramResponse;

      } else if (metric === 'score_trend') {
        const name = scoreName ?? 'accuracy';
        const result = await getCachedScoreTrend(context, name, 'day', range, startDate, endDate, undefined, envName, envIsDefault, envList);
        response = { type: 'scoreTrend', data: result } satisfies WidgetScoreTrendResponse;

      } else {
        // score_comparison
        if (!scoreName || !scoreNameB) {
          response = { type: 'scoreComparison' } satisfies WidgetScoreComparisonResponse;
        } else {
          try {
            const comparison = await getCachedScoreComparison(context, scoreName, scoreNameB, range, startDate, endDate, undefined, envName, envIsDefault, envList);
            response = { type: 'scoreComparison', comparison } satisfies WidgetScoreComparisonResponse;
          } catch (comparisonError) {
            // Only fall through to scatter on type-mismatch errors (both scores are numeric).
            // Re-throw other errors (ClickHouse timeouts, auth failures, etc.)
            const isTypeMismatch = comparisonError instanceof Error &&
              ((comparisonError as Error & { code?: string }).code === 'SCORE_TYPE_MISMATCH' ||
               comparisonError.message.includes('Score type mismatch'));
            if (!isTypeMismatch) throw comparisonError;

            const scatter = await getCachedScoreScatter(context, scoreName, scoreNameB, range, startDate, endDate, undefined, envName, envIsDefault, envList);
            response = { type: 'scoreComparison', scatter } satisfies WidgetScoreComparisonResponse;
          }
        }
      }

      analyticsLogger.query('widgetData', appId, timer.elapsed(), true, { metric, scoreName });
      return NextResponse.json(response);
    }

    const service = getAnalyticsService(context);
    if (!service) {
      return NextResponse.json({ error: 'Analytics not available — ClickHouse is not configured.' }, { status: 503 });
    }

    // GroupBy handling — return per-group ranking data via getRankingData
    if (groupBy === 'model' || groupBy === 'user_id' || (groupBy && isMetadataField(groupBy))) {
      const rankingData = await service.getRankingData(context, dateRange, groupBy, 10, filters, env);
      const metricToField = METRIC_TO_MODEL_STATS_FIELD[metric] ?? 'requests';

      response = {
        type: 'ranking',
        items: rankingData.items.map((item) => ({
          name: item.dimensionValue,
          value: (item as unknown as Record<string, number>)[metricToField] ?? 0,
        })),
      } satisfies WidgetRankingResponse;

    // Agent PR-lifecycle metrics — Postgres `pull_request`
    // is the source of truth (webhook-tracked + backfilled lifecycle rows);
    // ClickHouse contributes ONLY the session→PR attribution set. Metric
    // definitions live in `lib/dashboards/pr-metrics.ts` (pure, tested);
    // this branch just feeds it both inputs. Env scoping doesn't apply
    // (PRs aren't env-scoped; preview-env linkage is a different concern).
    } else if (isAgentPrMetric(metric)) {
      if (!service.getAgentPrAttribution) {
        throw new ValidationError('Agent PR metrics are not available in this environment.');
      }
      // Cost-consuming metrics need the per-(branch, PR) spend set too — and
      // it must be fetched HERE, not inside the metric branch: under org
      // scope every input is rewritten into org-unique identifiers in ONE
      // namespacing pass (indices must cover the cost rows' repos as well).
      const needsCostAttribution =
        metric === 'agent_unshipped_spend_share' || metric === 'agent_direct_cost_per_merged_pr';
      if (needsCostAttribution && !service.getAgentPrCostAttribution) {
        throw new ValidationError('Agent PR metrics are not available in this environment.');
      }
      // Ladder widgets need the per-(repo, branch, PR) minimum-session-level
      // set — prefetched here for the same org-namespacing reason as cost.
      const needsLadderAttribution =
        metric === 'agent_shipped_autonomy_trend' || metric === 'agent_delegated_share';
      if (needsLadderAttribution && !service.getAutonomyLadderAttribution) {
        throw new ValidationError('Agent PR metrics are not available in this environment.');
      }
      // Score-outcome-correlation metrics need a scoreName (which
      // predictor to segment by — no sane default) and are app-scoped only
      // (the predictor-score join doesn't go through org-pr-scope's
      // repo-namespacing pass yet). Checked here, before the rows/attribution
      // fetch below, same as the other capability gates.
      const isScoreOutcomeMetric =
        metric === 'agent_pr_outcome_by_score_merge_rate' ||
        metric === 'agent_pr_outcome_by_score_cycle_time' ||
        metric === 'agent_pr_outcome_by_score_revert_rate';
      if (isScoreOutcomeMetric && !scoreName) {
        throw new ValidationError(
          'agent_pr_outcome_by_score metrics require scoreName (which predictor score to segment by).',
        );
      }
      if (isScoreOutcomeMetric && scope === 'org') {
        throw new ValidationError('agent_pr_outcome_by_score metrics are not available under org scope yet.');
      }
      // Anti-circularity, surfaced as a real message rather than an empty
      // tile: `worker.merged` correlated against merge rate would just prove
      // that merged PRs merge. The service enforces this too — this check
      // exists so the user is told WHY instead of seeing "no data".
      if (isScoreOutcomeMetric && scoreName && isFateDerivedScoreName(scoreName)) {
        throw new ValidationError(
          `"${scoreName}" records what happened to the PR, so it can't also be used to predict it. Pick a signal produced before the PR was decided (e.g. worker.ci_green).`,
        );
      }

      // Both metrics read decided PRs only (open = undecided, never counted),
      // and the merge-rate tile also needs the immediately preceding window
      // for its change indicator — so one fetch covers closed_at from the
      // prior window's start onward. The read lives in the service layer
      // (it needs the RLS-bypassing admin client — data-access-boundary);
      // the verified tenant/app scope from withAnalyticsAuth is its contract.
      const window = { start: dateRange.start.slice(0, 10), end: dateRange.end.slice(0, 10) };
      const [attributionResponse, costAttribution, ladderAttribution] = await Promise.all([
        service.getAgentPrAttribution(context, fleetOptions),
        needsCostAttribution ? service.getAgentPrCostAttribution!(context, fleetOptions) : Promise.resolve(null),
        needsLadderAttribution
          ? service.getAutonomyLadderAttribution!(context, fleetOptions)
          : Promise.resolve(null),
      ]);

      let rows: PrLifecycleRow[];
      let attribution: AgentPrAttribution;
      let costRows: readonly PrCostAttributionRow[];
      let ladderItems: readonly AutonomyLadderItem[];
      if (scope === 'org') {
        // Org scope: tenant-wide PR rows, matched to sessions WITHIN each
        // repo — bare branch names and PR numbers collide across repos, so
        // both sides are rewritten into org-unique identifiers first (see
        // org-pr-scope.ts). The pure metric functions run unchanged.
        const tenantRows = await fetchDecidedPullRequestsForTenant({
          tenantId: context.tenantId,
          sinceDay: priorWindow(window).start,
        });
        const namespaced = namespaceOrgPrData({
          rows: tenantRows,
          attributionItems: attributionResponse.items,
          costItems: costAttribution?.items ?? [],
          ladderItems: ladderAttribution?.items ?? [],
        });
        rows = namespaced.rows;
        attribution = namespaced.attribution;
        costRows = namespaced.costRows;
        ladderItems = namespaced.ladderItems;
      } else {
        rows = await fetchDecidedPullRequests({
          tenantId: context.tenantId,
          appId: context.appId,
          sinceDay: priorWindow(window).start,
        });
        attribution = attributionResponse;
        costRows = costAttribution?.items ?? [];
        ladderItems = ladderAttribution?.items ?? [];
      }

      if (metric === 'agent_pr_merge_rate') {
        const result = computeAgentPrMergeRate(rows, attribution, window);
        // 0..1 fraction -> percentage points, same convention as the fleet
        // tiles' rate metrics; change math mirrors the tile branch below.
        const currentValue = result.current.rate * 100;
        const priorValue = result.prior.rate * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (metric === 'agent_pr_unreviewed_merge_rate') {
        // Share of merged agent PRs with no human review/approval.
        // Same 0..1 → percentage-points convention as merge rate; the stat
        // card treats an increase as BAD (METRIC_BETTER_DIRECTION = 'down').
        const result = computeAgentPrUnreviewedMergeRate(rows, attribution, window);
        const currentValue = result.current.rate * 100;
        const priorValue = result.prior.rate * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (metric === 'agent_pr_reopen_rate') {
        // Share of decided agent PRs reopened at least once (rework/churn).
        // Same 0..1 → percentage-points convention; the stat card treats an
        // increase as BAD (METRIC_BETTER_DIRECTION = 'down').
        const result = computeAgentPrReopenRate(rows, attribution, window);
        const currentValue = result.current.rate * 100;
        const priorValue = result.prior.rate * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (metric === 'agent_pr_revert_rate') {
        // Share of decided agent PRs later reverted (durability — "did the work
        // stick?"). Same 0..1 → percentage-points convention; the stat card
        // treats an increase as BAD (INVERTED_CHANGE_METRICS).
        const result = computeAgentPrRevertRate(rows, attribution, window);
        const currentValue = result.current.rate * 100;
        const priorValue = result.prior.rate * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (metric === 'agent_clean_job_rate') {
        // Autonomy composite: decided agent PRs that merged, held (no revert),
        // AND needed no mid-session steering. Same 0..1 → percentage-points
        // convention; up = GOOD here (more clean jobs), so NOT inverted.
        const result = computeAgentCleanJobRate(rows, attribution, window);
        const currentValue = result.current.rate * 100;
        const priorValue = result.prior.rate * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (metric === 'agent_share_of_merged_prs') {
        // Share of ALL merged PRs that were agent-attributed — adoption curve
        // AND (disclosed in the metric description) the data-coverage floor.
        // Same 0..1 → percentage-points convention as the other rates.
        const result = computeAgentShareOfMergedPrs(rows, attribution, window);
        const currentValue = result.current.share * 100;
        const priorValue = result.prior.share * 100;

        response = {
          type: 'stat',
          value: Math.round(currentValue * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
          ...statChange(currentValue, priorValue),
        } satisfies WidgetStatResponse;
      } else if (
        metric === 'agent_vs_human_cycle_time' ||
        metric === 'agent_vs_human_merge_rate' ||
        metric === 'agent_vs_human_revert_rate'
      ) {
        // The within-org control group — a fixed two-item ranking
        // ("Agent-shipped" / "Human-only"), one bar per population, rendered
        // by WidgetRankingList which preserves item order. Cohorts mirror the
        // standalone metrics (cycle time = merged-in-window, rates = decided),
        // so this never disagrees with a tile under the same label. An empty
        // window (no PRs in the relevant cohort for EITHER population) returns
        // an empty ranking so the widget shows its empty state, not two bars
        // of measured-looking zeros.
        const cmp = computeAgentVsHumanPrComparison(rows, attribution, window);
        const pick = (p: typeof cmp.agent): number =>
          metric === 'agent_vs_human_cycle_time'
            ? p.cycleTimeP50Hours
            : metric === 'agent_vs_human_merge_rate'
              ? Math.round(p.mergeRate * 10000) / 100
              : Math.round(p.revertRate * 10000) / 100;
        const hasCohort =
          metric === 'agent_vs_human_cycle_time'
            ? cmp.agent.merged + cmp.human.merged > 0
            : cmp.agent.decided + cmp.human.decided > 0;
        response = {
          type: 'ranking',
          items: hasCohort
            ? [
                { name: 'Agent-shipped', value: pick(cmp.agent) },
                { name: 'Human-only', value: pick(cmp.human) },
              ]
            : [],
        } satisfies WidgetRankingResponse;
      } else if (metric === 'agent_unshipped_spend_share') {
        // Share of the window's agent spend not attributed to a merged PR —
        // needs total spend (ClickHouse overview) AND the per-(branch, PR)
        // cost-attribution set, like the direct-cost metric. Math + the
        // no-spend "unavailable" decision live in pr-metrics.ts.
        if (!service.getAgentFleetOverview) {
          throw new ValidationError('Agent PR metrics are not available in this environment.');
        }
        const overview = await service.getAgentFleetOverview(context, dateRange, fleetOptions);
        const unshipped = computeUnshippedSpendShare(
          rows,
          attribution,
          costRows,
          { current: overview.totalCost.current, prior: overview.totalCost.prior },
          window,
        );
        response = unshipped.currentUnavailable
          ? {
              type: 'stat',
              value: 0,
              label: METRIC_LABELS[metric] ?? metric,
              // No spend at all — a "0% unshipped" tile would read as a perfect
              // score when there's nothing to measure.
              unavailable: { reason: 'no agent spend in this window' },
            }
          : {
              type: 'stat',
              value: Math.round(unshipped.current * 10000) / 100,
              label: METRIC_LABELS[metric] ?? metric,
              ...statChange(unshipped.current * 100, unshipped.prior * 100),
            };
      } else if (metric === 'agent_pr_cycle_time_breakdown') {
        // Decomposed cycle time — a fixed ranking (one bar per phase, in the
        // chronological order `PR_CYCLE_PHASES` fixes: coding → pickup →
        // review → merge). Ranking shape (not time-series) because it's a
        // single-window "where the time goes" cut, rendered by WidgetRankingList
        // which preserves item order. Per-phase medians are independent samples
        // (see pr-metrics.ts header) — a phase with no measurable PR is 0h.
        const breakdown = computeAgentPrCycleTimeBreakdown(rows, attribution, window);
        // No merged agent PR reached ANY phase → return an empty ranking so the
        // widget shows its "nothing to break down" empty state, not four 0h
        // bars that read as "measured, all instant".
        const items = breakdown.phases.some((p) => p.sampleSize > 0)
          ? breakdown.phases.map((p) => ({ name: PR_CYCLE_PHASE_LABELS[p.phase], value: p.p50Hours }))
          : [];
        response = { type: 'ranking', items } satisfies WidgetRankingResponse;
      } else if (metric === 'agent_cost_per_merged_pr') {
        // Fully-loaded cost-per-merged-PR: ALL agent spend
        // this window ÷ agent PRs merged in it. Uniquely needs BOTH sources —
        // the PR merge count (Postgres, already fetched) and total agent spend
        // (ClickHouse, getAgentFleetOverview). The math + the zero-merge
        // "unavailable" decision live in pr-metrics.ts (pure, tested).
        if (!service.getAgentFleetOverview) {
          throw new ValidationError('Agent PR metrics are not available in this environment.');
        }
        const overview = await service.getAgentFleetOverview(context, dateRange, fleetOptions);
        const mergedCounts = countAgentMergedPrs(rows, attribution, window);
        const costPerPr = computeFullyLoadedCostPerMergedPr(mergedCounts, {
          current: overview.totalCost.current,
          prior: overview.totalCost.prior,
        });

        response = costPerPr.currentUnavailable
          ? {
              type: 'stat',
              value: 0,
              label: METRIC_LABELS[metric] ?? metric,
              // Distinguish "spend, nothing merged" (worst case) from "no
              // agent activity at all" — same tile, very different story.
              unavailable: {
                reason: overview.totalCost.current > 0 ? 'agent spend, no PRs merged yet' : 'no agent PRs merged in this window',
              },
            }
          : {
              type: 'stat',
              value: Math.round(costPerPr.current * 1_000_000) / 1_000_000,
              label: METRIC_LABELS[metric] ?? metric,
              // A zero prior denominator makes costPerPr.prior 0, so statChange
              // already yields priorEmpty — same fresh-install suppression as
              // every other tile; no special-casing needed here.
              ...statChange(costPerPr.current, costPerPr.prior),
            };
      } else if (metric === 'agent_direct_cost_per_merged_pr') {
        // Direct cost-per-merged-PR: only the spend of sessions
        // ATTRIBUTED to a merged PR ÷ merged count. Needs the per-(branch,PR)
        // cost-attribution set from ClickHouse; the gap vs. fully-loaded is the
        // unattributed overhead. Math + attribution live in pr-metrics.ts.
        const direct = computeDirectCostPerMergedPr(rows, attribution, costRows, window);
        response = direct.currentUnavailable
          ? {
              type: 'stat',
              value: 0,
              label: METRIC_LABELS[metric] ?? metric,
              unavailable: { reason: 'no agent PRs merged in this window' },
            }
          : {
              type: 'stat',
              value: Math.round(direct.current * 1_000_000) / 1_000_000,
              label: METRIC_LABELS[metric] ?? metric,
              ...statChange(direct.current, direct.prior),
            };
      } else if (metric === 'agent_shipped_autonomy_trend') {
        // The category headline: daily merged-PR counts stacked by autonomy
        // level. Counts, not percentages — the stacked bands show composition
        // while keeping thin days visibly thin. Unclassifiable work is
        // excluded here and surfaced by the share tile's description.
        const ladder = computeShippedAutonomyLadder(rows, ladderItems, window);
        const SERIES = [
          ['Assisted', 'assisted'],
          ['Supervised', 'supervised'],
          ['Delegated', 'delegated'],
          ['Autonomous', 'autonomous'],
        ] as const;
        response = {
          type: 'timeSeries',
          series: SERIES.map(([name, key]) => ({
            name,
            data: ladder.points.map((p) => ({ x: p.date, y: p[key] })),
          })),
        } satisfies WidgetTimeSeriesResponse;
      } else if (metric === 'agent_delegated_share') {
        // Single number of the ladder: share of CLASSIFIED merged PRs at
        // Delegated or Autonomous. Zero classified → unavailable (an empty
        // cohort must not render as 0% delegation).
        const ladder = computeShippedAutonomyLadder(rows, ladderItems, window);
        const currentValue = ladder.current.delegatedShare * 100;
        const priorValue = ladder.prior.delegatedShare * 100;
        response =
          ladder.current.classified === 0
            ? {
                type: 'stat',
                value: 0,
                label: METRIC_LABELS[metric] ?? metric,
                unavailable: { reason: 'no classifiable merged PRs in this window' },
              }
            : {
                type: 'stat',
                value: Math.round(currentValue * 10000) / 10000,
                label: METRIC_LABELS[metric] ?? metric,
                ...statChange(currentValue, priorValue),
              };
      } else if (metric === 'pr_size_trend') {
        // Batch-size guardrail: daily median lines changed over ALL merged
        // PRs (agent and human — batch-size inflation is a property of the
        // delivery stream). Days with no sized merge emit no point; a size
        // of NULL is unknown, never zero (see computeMergedPrSizeTrend).
        const sizeTrend = computeMergedPrSizeTrend(rows, window);
        response = {
          type: 'timeSeries',
          series: [
            {
              name: 'Median lines changed',
              data: sizeTrend.points.map((p) => ({ x: p.date, y: p.medianLinesChanged })),
            },
          ],
        } satisfies WidgetTimeSeriesResponse;
      } else if (metric === 'agent_vs_human_pr_size') {
        // Median merged-PR size per population — the DORA batch-size
        // mechanism as a within-org comparison. Empty when NO merged PR in
        // the window carried size data (rows predating capture, GitLab line
        // counts unavailable): an empty state, not two confident 0s.
        const size = computeAgentVsHumanPrSize(rows, attribution, window);
        response = {
          type: 'ranking',
          items:
            size.agent.sized + size.human.sized > 0
              ? [
                  { name: 'Agent-shipped', value: size.agent.medianLinesChanged },
                  { name: 'Human-only', value: size.human.medianLinesChanged },
                ]
              : [],
        } satisfies WidgetRankingResponse;
      } else if (metric === 'agent_vs_human_first_pass_ci') {
        // First-pass CI failure rate per population — the customer-side
        // change-failure proxy. Measured rows only; empty when no decided PR
        // in the window has an observed CI verdict.
        const ci = computeAgentVsHumanFirstPassCi(rows, attribution, window);
        response = {
          type: 'ranking',
          items:
            ci.agent.measured + ci.human.measured > 0
              ? [
                  { name: 'Agent-shipped', value: Math.round(ci.agent.failureRate * 10000) / 100 },
                  { name: 'Human-only', value: Math.round(ci.human.failureRate * 10000) / 100 },
                ]
              : [],
        } satisfies WidgetRankingResponse;
      } else if (
        metric === 'agent_pr_outcome_by_score_merge_rate' ||
        metric === 'agent_pr_outcome_by_score_cycle_time' ||
        metric === 'agent_pr_outcome_by_score_revert_rate'
      ) {
        // The eval-score validation loop for online evals.
        // `scoreName` selects WHICH score; the service excludes
        // `Source: 'outcome'` scores unconditionally (see
        // pr-outcome-correlation/predictor-scores.ts) so a fate-derived
        // score can never be chosen as its own predictor. `scoreName`
        // presence and org-scope rejection are guarded above, before the
        // rows/attribution fetch.
        //
        // A SINGLE lift stat (pass cohort minus fail cohort), not a
        // two-item ranking: "Pass 100% / Fail 50%" read as if the two
        // numbers should sum to 100 (they don't — each is a merge/revert
        // rate WITHIN its own cohort, not a frequency of pass/fail), and a
        // bar chart for two numbers you have to subtract in your head is
        // decorative on top of being confusing. `formatMetricValue`
        // (widget-stat-card.tsx) signs the value and units it in "pp"
        // (percentage points), never "%", to keep it from being misread as
        // a rate itself.
        const verdictByPr = await getPredictorScoreVerdictsByPr({
          tenantId: context.tenantId,
          appId: context.appId,
          scoreName: scoreName!,
        });
        if (!verdictByPr) {
          throw new ValidationError('Agent PR metrics are not available in this environment.');
        }
        const cmp = computeAgentPrOutcomeByScore(rows, attribution, verdictByPr, window);
        const pick = (p: typeof cmp.pass): number =>
          metric === 'agent_pr_outcome_by_score_cycle_time'
            ? p.cycleTimeP50Hours
            : metric === 'agent_pr_outcome_by_score_merge_rate'
              ? Math.round(p.mergeRate * 10000) / 100
              : Math.round(p.revertRate * 10000) / 100;
        // BOTH cohorts must be populated — a lift against an empty cohort
        // (which pr-metrics.ts defaults to rate 0) isn't "the fail cohort
        // has a 0% rate", it's "there's nothing to compare against", and
        // the tile must say so, not print a misleadingly confident number.
        const cohortSize = (p: typeof cmp.pass): number =>
          metric === 'agent_pr_outcome_by_score_cycle_time' ? p.merged : p.decided;
        const passN = cohortSize(cmp.pass);
        const failN = cohortSize(cmp.fail);
        const lift = Math.round((pick(cmp.pass) - pick(cmp.fail)) * 100) / 100;
        const label = METRIC_LABELS[metric] ? `${scoreName}: ${METRIC_LABELS[metric]}` : String(metric);
        // A signed lift ("+50pp") means very different things at n=4 vs
        // n=400, and the number alone can't say which — so the tile carries
        // the two cohort sizes as its caption whenever it shows a value. The
        // unit ("PRs" for merge/revert-rate cohorts, "merged PRs" for cycle
        // time, whose cohort is the merged subset) matches what pr-metrics.ts
        // actually counted for this metric.
        const cohortUnit = metric === 'agent_pr_outcome_by_score_cycle_time' ? 'merged PRs' : 'PRs';
        const caption = `${passN} passing vs ${failN} failing ${cohortUnit}`;
        response =
          passN > 0 && failN > 0
            ? { type: 'stat', value: lift, label, caption }
            : {
                type: 'stat',
                value: 0,
                label,
                // Report the two cohort counts, not an instruction to go get
                // more data: this is the DEFAULT-template state for any tenant
                // whose PRs all landed on one side (a healthy repo often has
                // zero first-try CI failures), so it must read as "here's what
                // I have" rather than as a broken tile. The counts double as
                // the sample-size disclosure a two-bar chart hid.
                unavailable: { reason: `${passN} passing, ${failN} failing — need both to compare` },
              };
      } else {
        // agent_pr_cycle_time_trend — fixed time-series shape (daily p50/p95
        // hours by merge date), like the other agent-fleet trend metrics.
        const trend = computeAgentPrCycleTimeTrend(rows, attribution, window);
        response = {
          type: 'timeSeries',
          series: [
            { name: 'P50', data: trend.points.map((p) => ({ x: p.date, y: p.p50Hours })) },
            { name: 'P95', data: trend.points.map((p) => ({ x: p.date, y: p.p95Hours })) },
          ],
        } satisfies WidgetTimeSeriesResponse;
      }

    // Total Cost of AI — fixed seat spend (ai_cost_config, prorated to the
    // window) + metered token spend. ALWAYS org-scoped regardless of the
    // request's scope: the seat figure is tenant-wide, and blending it with
    // one app's metered slice would produce a number that is neither.
    } else if (metric === 'total_cost_of_ai') {
      if (!service.getAgentFleetOverview) {
        throw new ValidationError('Agent fleet metrics are not available in this environment.');
      }
      const [overview, costConfig] = await Promise.all([
        service.getAgentFleetOverview(context, dateRange, { scope: 'org' }),
        fetchAiCostConfigForTenant(context.tenantId),
      ]);
      // Prorate the monthly seat figure to the window's length (mean Gregorian
      // month). Current and prior windows are equal-length by construction, so
      // the seat portion is identical on both sides — the change indicator
      // moves on metered spend only, which is the honest reading (seat spend
      // is a step function that only moves when the config is edited).
      const windowDays =
        Math.round(
          (Date.parse(`${dateRange.end.slice(0, 10)}T00:00:00Z`) -
            Date.parse(`${dateRange.start.slice(0, 10)}T00:00:00Z`)) /
            (24 * 60 * 60 * 1000),
        ) + 1;
      const seatPortion = costConfig.seatCount * costConfig.costPerSeatUsd * (windowDays / 30.4375);
      const currentValue = overview.totalCost.current + seatPortion;
      const priorValue = overview.totalCost.prior + seatPortion;
      response = {
        type: 'stat',
        value: Math.round(currentValue * 100) / 100,
        label: METRIC_LABELS[metric] ?? metric,
        ...statChange(currentValue, priorValue),
      } satisfies WidgetStatResponse;


    // Agent Fleet metrics — a DIFFERENT row population (agent_session_summary,
    // one row = one coding-agent session) than every other branch below
    // (Type = 'GENERATION'). Five sub-shapes, each backed by its own query;
    // env scoping doesn't apply here (agent sessions aren't env-tagged).
    } else if (isAgentFleetMetric(metric)) {
      const dimension = agentFleetDimensionFor(metric);
      const isTileMetric =
        metric === 'agent_model_mix' ||
        metric === 'session_count' ||
        metric === 'tool_error_rate' ||
        metric === 'clean_session_rate' ||
        metric === 'agent_hands_on_rate' ||
        metric === 'active_actor_count' ||
        metric === 'total_agent_cost' ||
        metric === 'agent_spend_per_active_dev' ||
        metric === 'agent_tool_denial_rate' ||
        metric === 'agent_auto_approved_rate';
      const isTrendMetric =
        metric === 'cost_per_session_trend' ||
        metric === 'agent_session_duration_trend' ||
        metric === 'agent_turn_count_trend' ||
        metric === 'agent_interventions_trend';

      if (isTileMetric) {
        if (!service.getAgentFleetOverview) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const overview = await service.getAgentFleetOverview(context, dateRange, fleetOptions);

        if (metric === 'agent_model_mix') {
          response = {
            type: 'ranking',
            items: overview.modelMix.map((m) => ({ name: m.model, value: m.sessions })),
          } satisfies WidgetRankingResponse;
        } else {
          // Every tile metric is stat-only (STAT_ONLY_METRICS) — the widget's
          // persisted visualization is always 'stat' by the time it reaches
          // here, so no time-series branch is needed (trending these lives
          // in AGENT_FLEET_TREND_METRICS, a separate query, below).
          // Spend-per-active-dev is a ratio of two overview tiles — an
          // aggregate over an aggregate (the actor count stays a bare
          // uniqExact), computed per period so the change indicator compares
          // like with like. Zero actors ⇒ 0 (no spend is possible without a
          // session, so 0/0 is the only zero-actor case).
          const perDev = (cost: number, actors: number) => (actors > 0 ? cost / actors : 0);
          const tile = metric === 'session_count'
            ? overview.sessions
            : metric === 'tool_error_rate'
              ? overview.toolErrorRate
              : metric === 'clean_session_rate'
                ? overview.cleanSessionRate
                : metric === 'agent_hands_on_rate'
                  ? overview.handsOnRate
                  : metric === 'active_actor_count'
                    ? overview.activeActors
                    : metric === 'agent_spend_per_active_dev'
                      ? {
                          current: perDev(overview.totalCost.current, overview.activeActors.current),
                          prior: perDev(overview.totalCost.prior, overview.activeActors.prior),
                        }
                      : metric === 'agent_tool_denial_rate'
                        ? overview.toolDenialRate
                        : metric === 'agent_auto_approved_rate'
                          ? overview.autoApprovedRate
                          : overview.totalCost;
          // Rates are 0..1 fractions from the service; scale to the 0..100
          // percentage-point convention every other rate metric uses (see
          // error_rate below). Counts and cost (total_agent_cost) pass through
          // at scale 1.
          const scale =
            metric === 'tool_error_rate' ||
            metric === 'clean_session_rate' ||
            metric === 'agent_hands_on_rate' ||
            metric === 'agent_tool_denial_rate' ||
            metric === 'agent_auto_approved_rate'
              ? 100
              : 1;
          const currentValue = tile.current * scale;
          const priorValue = tile.prior * scale;

          response = {
            type: 'stat',
            value: Math.round(currentValue * 10000) / 10000,
            label: METRIC_LABELS[metric] ?? metric,
            ...statChange(currentValue, priorValue),
          } satisfies WidgetStatResponse;
        }

      // Repo Activity: cost/sessions/tool-error-rate by branch or agent
      // type — one query, the metric name picks which field of each row to
      // surface. The error-rate field rides alongside cost/sessions
      // deliberately (see AgentFleetDimensionItem) so a spend ranking is
      // never shown without a quality signal for the same row.
      } else if (dimension) {
        if (!service.getAgentFleetDimensionBreakdown) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const breakdown = await service.getAgentFleetDimensionBreakdown(context, dateRange, dimension, fleetOptions);
        const isCostMetric =
          metric === 'agent_cost_by_branch' ||
          metric === 'agent_cost_by_agent_type' ||
          metric === 'agent_cost_by_worker_kind';
        const isErrorRateMetric = metric === 'agent_tool_error_rate_by_branch';

        response = {
          type: 'ranking',
          items: breakdown.items.map((item) => ({
            name: item.dimensionValue,
            value: isCostMetric
              ? item.costUsd
              : isErrorRateMetric
                ? Math.round(item.toolErrorRate * 10000) / 100 // 0..1 fraction -> percentage points
                : item.sessions,
          })),
        } satisfies WidgetRankingResponse;

      // Repo Activity: branches whose latest-day spend is a statistical
      // outlier vs. their own trailing baseline (SQL-only heuristic, no ML
      // — see buildAgentFleetCostAnomalyQuery). Ranked by dollar delta.
      } else if (metric === 'agent_cost_anomalies_by_branch') {
        if (!service.getAgentFleetCostAnomalies) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const anomalies = await service.getAgentFleetCostAnomalies(context, dateRange, fleetOptions);

        response = {
          type: 'ranking',
          items: anomalies.items.map((item) => ({
            name: item.dimensionValue,
            value: Math.round(item.deltaUsd * 100) / 100,
          })),
        } satisfies WidgetRankingResponse;

      // Agent Execution Health: session-grain percentiles as a daily TREND —
      // never a single blended number for the whole date range (see the
      // header comment in queries-agent-fleet.ts for why). One query backs
      // the three percentile-trend metrics; each picks which series to
      // surface from the same daily rows.
      } else if (isTrendMetric) {
        if (!service.getAgentFleetPercentileTrend) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const trend = await service.getAgentFleetPercentileTrend(context, dateRange, fleetOptions);

        const series =
          metric === 'cost_per_session_trend'
            ? [
                { name: 'P50', data: trend.points.map((p) => ({ x: p.date, y: p.costP50 })) },
                { name: 'P95', data: trend.points.map((p) => ({ x: p.date, y: p.costP95 })) },
              ]
            : metric === 'agent_session_duration_trend'
              ? [
                  { name: 'P50', data: trend.points.map((p) => ({ x: p.date, y: p.durationP50Ms })) },
                  { name: 'P95', data: trend.points.map((p) => ({ x: p.date, y: p.durationP95Ms })) },
                  { name: 'P99', data: trend.points.map((p) => ({ x: p.date, y: p.durationP99Ms })) },
                ]
              : metric === 'agent_interventions_trend'
                ? [
                    {
                      name: 'Mean interventions',
                      data: trend.points.map((p) => ({ x: p.date, y: Math.round(p.interventionsMean * 100) / 100 })),
                    },
                  ]
                : [{ name: 'P95', data: trend.points.map((p) => ({ x: p.date, y: p.turnCountP95 })) }];

        response = { type: 'timeSeries', series } satisfies WidgetTimeSeriesResponse;

      // Trajectory signals: daily tool-error / denial / steered rates as one
      // chart, scaled to the 0..100 percentage-point convention every other
      // rate metric uses. A day with no sessions is absent — the
      // service never zero-fills, so a gap reads as "nothing ran", not
      // "everything was clean".
      } else if (metric === 'agent_trajectory_signals_trend') {
        if (!service.getAgentFleetTrajectorySignalTrend) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const signals = await service.getAgentFleetTrajectorySignalTrend(context, dateRange, fleetOptions);

        const pct = (v: number) => Math.round(v * 10000) / 100;
        response = {
          type: 'timeSeries',
          series: [
            { name: 'Tool error rate', data: signals.points.map((p) => ({ x: p.date, y: pct(p.toolErrorRate) })) },
            { name: 'Denial rate', data: signals.points.map((p) => ({ x: p.date, y: pct(p.denialRate) })) },
            { name: 'Hands-on sessions', data: signals.points.map((p) => ({ x: p.date, y: pct(p.handsOnShare) })) },
          ],
        } satisfies WidgetTimeSeriesResponse;

      // Autonomy mix: daily session counts split by worker kind (run-origin:
      // seat | cloud | ci | shared) — one bounded series per kind present.
      // Dates are zero-filled across the union of days so the stacked chart's
      // bands stay aligned (a sparse series would mis-stack against a dense
      // one). Series order is fixed human-first so "seat" always reads as the
      // base band the delegated kinds grow against.
      } else if (metric === 'agent_autonomy_mix_trend') {
        if (!service.getAgentFleetAutonomyMixTrend) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const mix = await service.getAgentFleetAutonomyMixTrend(context, dateRange, fleetOptions);

        const KIND_ORDER = ['seat', 'shared', 'ci', 'cloud'];
        const dates = [...new Set(mix.points.map((p) => p.date))].sort();
        const kinds = [...new Set(mix.points.map((p) => p.workerKind))].sort(
          (a, b) => {
            const ia = KIND_ORDER.indexOf(a);
            const ib = KIND_ORDER.indexOf(b);
            return (ia === -1 ? KIND_ORDER.length : ia) - (ib === -1 ? KIND_ORDER.length : ib) || a.localeCompare(b);
          },
        );
        const counts = new Map(mix.points.map((p) => [`${p.workerKind}|${p.date}`, p.sessions]));

        response = {
          type: 'timeSeries',
          series: kinds.map((kind) => ({
            name: kind,
            data: dates.map((date) => ({ x: date, y: counts.get(`${kind}|${date}`) ?? 0 })),
          })),
        } satisfies WidgetTimeSeriesResponse;

      // Agent Fleet Overview: daily active-actor count as a trend — a count
      // over time, never a %-of-org-seats adoption RATE (that denominator
      // lives in Postgres org membership, not ClickHouse).
      } else {
        if (!service.getAgentFleetActiveActorTrend) {
          throw new ValidationError('Agent fleet metrics are not available in this environment.');
        }
        const trend = await service.getAgentFleetActiveActorTrend(context, dateRange, fleetOptions);

        response = {
          type: 'timeSeries',
          series: [{ name: 'Active Actors', data: trend.points.map((p) => ({ x: p.date, y: p.activeActors })) }],
        } satisfies WidgetTimeSeriesResponse;
      }

    // Handle derived metrics — compute from two built-in metrics
    } else if (isDerivedMetric(metric)) {
      const derived = getDerivedMetric(metric)!;
      // getExtendedMetrics has no env-filter hook; route through getMetrics
      // (which does) whenever an env scope is active.
      const metricsData = (filters || env)
        ? await service.getMetrics(context, dateRange, filters, env)
        : await service.getExtendedMetrics(context, dateRange);

      const numKey = METRIC_TO_SUMMARY_KEY[derived.numerator];
      const denKey = METRIC_TO_SUMMARY_KEY[derived.denominator];

      if (visualization === 'stat') {
        const num = (metricsData.summary as unknown as Record<string, number>)[numKey ?? ''] ?? 0;
        const den = (metricsData.summary as unknown as Record<string, number>)[denKey ?? ''] ?? 0;

        let value: number;
        if (metric === 'success_rate') {
          // Special: (requests - errors) / requests * 100
          const requests = metricsData.summary.totalRequests;
          const errors = metricsData.summary.errorCount;
          value = requests > 0 ? ((requests - errors) / requests) * 100 : 0;
        } else {
          value = den > 0 ? num / den : 0;
        }

        response = {
          type: 'stat',
          value: Math.round(value * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
        } satisfies WidgetStatResponse;
      } else {
        // Time series — compute ratio per time bucket
        const numTsKey = METRIC_TO_TIMESERIES_KEY[derived.numerator];
        const denTsKey = METRIC_TO_TIMESERIES_KEY[derived.denominator];

        const seriesData = metricsData.timeSeries.map((point) => {
          const p = point as unknown as Record<string, number | string>;
          let y: number;
          if (metric === 'success_rate') {
            const req = (p.requests as number) || 0;
            const err = (p.errors as number) || 0;
            y = req > 0 ? ((req - err) / req) * 100 : 0;
          } else {
            const num = numTsKey ? ((p[numTsKey] as number) || 0) : 0;
            const den = denTsKey ? ((p[denTsKey] as number) || 0) : 0;
            y = den > 0 ? num / den : 0;
          }
          return { x: buildTimeSeriesX(p, hourly), y: Math.round(y * 10000) / 10000 };
        });

        response = {
          type: 'timeSeries',
          series: [{ name: metric, data: seriesData }],
        } satisfies WidgetTimeSeriesResponse;
      }

    // Route to the appropriate service method based on metric type
    } else if (metric === 'top_models') {
      const modelStats = await service.getModelStats(context, dateRange, 10, filters, env);
      response = {
        type: 'ranking',
        items: modelStats.models.map((m) => ({
          name: m.model,
          value: m.requests,
        })),
      } satisfies WidgetRankingResponse;

    } else if (PERCENTILE_METRICS.has(metric)) {
      // Enforce 90-day max for percentile queries
      const startMs = new Date(dateRange.start).getTime();
      const endMs = new Date(dateRange.end).getTime();
      const daysDiff = (endMs - startMs) / (1000 * 60 * 60 * 24);
      if (daysDiff > 90) {
        throw new ValidationError('Time range too large for percentile metrics (max 90 days)');
      }

      const percentileMap: Record<string, string> = {
        p50_latency: '50',
        p95_latency: '95',
        p99_latency: '99',
      };
      const percentile = percentileMap[metric] ?? '95';

      const percData = await service.getPercentiles(
        context,
        { range: 'custom', startDate: dateRange.start, endDate: dateRange.end, metric: 'latency' },
        filters,
        env,
      );

      const pKey = `p${percentile}` as 'p75' | 'p90' | 'p95' | 'p99';

      if (visualization === 'stat') {
        const values = percData.data.map((d) => d[pKey]);
        const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        response = {
          type: 'stat',
          value: Math.round(avg * 100) / 100,
          label: `${pKey.toUpperCase()} Latency (ms)`,
        } satisfies WidgetStatResponse;
      } else {
        response = {
          type: 'timeSeries',
          series: [
            {
              name: `${pKey.toUpperCase()} Latency`,
              data: percData.data.map((d) => ({
                x: d.timestamp,
                y: d[pKey],
              })),
            },
          ],
        } satisfies WidgetTimeSeriesResponse;
      }

    } else if (METRICS_SERVICE_METRICS.has(metric)) {
      // Use getMetrics (supports filters + env scoping) when filters or an
      // env scope are present, otherwise getExtendedMetrics for richer
      // summary data. Env-scoped widgets always take the getMetrics
      // path because getExtendedMetrics has no env-filter hook.
      const metricsData = (filters || env)
        ? await service.getMetrics(context, dateRange, filters, env)
        : await service.getExtendedMetrics(context, dateRange);
      const summaryKey = METRIC_TO_SUMMARY_KEY[metric];
      const timeseriesKey = METRIC_TO_TIMESERIES_KEY[metric];

      if (visualization === 'stat') {
        const summaryValue = (metricsData.summary as unknown as Record<string, number>)[summaryKey ?? ''] ?? 0;

        // Compute error_rate manually if needed
        let value = summaryValue;
        if (metric === 'error_rate') {
          const { totalRequests, errorCount } = metricsData.summary;
          value = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;
        }
        if (metric === 'avg_cost') {
          const { totalCost, totalRequests } = metricsData.summary;
          value = totalRequests > 0 ? totalCost / totalRequests : 0;
        }
        if (metric === 'avg_tokens') {
          const { totalTokens, totalRequests } = metricsData.summary;
          value = totalRequests > 0 ? totalTokens / totalRequests : 0;
        }

        response = {
          type: 'stat',
          value: Math.round(value * 10000) / 10000,
          label: METRIC_LABELS[metric] ?? metric,
        } satisfies WidgetStatResponse;
      } else {
        // Time series response
        const seriesData = metricsData.timeSeries.map((point) => {
          const p = point as unknown as Record<string, number | string>;
          let y = 0;
          if (timeseriesKey && timeseriesKey in p) {
            y = p[timeseriesKey] as number;
          } else if (metric === 'error_rate') {
            const req = (p.requests as number) || 0;
            const err = (p.errors as number) || 0;
            y = req > 0 ? (err / req) * 100 : 0;
          } else if (metric === 'avg_cost') {
            const cost = (p.cost as number) || 0;
            const req = (p.requests as number) || 0;
            y = req > 0 ? cost / req : 0;
          } else if (metric === 'avg_tokens') {
            const tokens = (p.tokens as number) || 0;
            const req = (p.requests as number) || 0;
            y = req > 0 ? tokens / req : 0;
          }

          return {
            x: buildTimeSeriesX(p, hourly),
            y: Math.round(y * 1000000) / 1000000,
          };
        });

        response = {
          type: 'timeSeries',
          series: [{ name: metric, data: seriesData }],
          summary: {
            total: (metricsData.summary as unknown as Record<string, number>)[summaryKey ?? ''] ?? 0,
            average:
              seriesData.length > 0
                ? seriesData.reduce((sum: number, d: { y: number }) => sum + d.y, 0) / seriesData.length
                : 0,
          },
        } satisfies WidgetTimeSeriesResponse;
      }
    } else {
      throw new ValidationError(`Unsupported metric: ${metric}`);
    }

    analyticsLogger.query('widgetData', appId, timer.elapsed(), true, { metric });

    return NextResponse.json(response);
  } catch (error) {
    const analyticsError = mapClickHouseError(error);
    analyticsLogger.error('widgetData', error, appId);

    return NextResponse.json(
      toErrorResponse(analyticsError),
      { status: getErrorStatusCode(analyticsError) }
    );
  }
  },
);
