/**
 * Dashboard Types
 *
 * Types define the contract for the dashboard system,
 * including API request/response shapes and internal data structures.
 */

// ============================================================================
// Widget Metric Types
// ============================================================================

/**
 * Built-in metrics available for dashboard widgets.
 * Each maps to an existing ClickHouse data source.
 */
type BuiltInMetric =
  | 'request_count'
  | 'total_cost'
  | 'avg_cost'
  | 'total_tokens'
  | 'avg_tokens'
  | 'unique_users'
  | 'error_count'
  | 'error_rate'
  | 'avg_latency'
  | 'p50_latency'
  | 'p95_latency'
  | 'p99_latency'
  | 'top_models'
  | 'score_summary'
  | 'score_histogram'
  | 'score_trend'
  | 'score_comparison'
  // Agent Fleet Overview tile metrics — read the `agent_session_summary` row
  // population (one row = one coding-agent session), not the
  // `Type = 'GENERATION'` population the metrics above read. See
  // `AGENT_FLEET_METRICS` and the privacy constraint on `active_actor_count`.
  | 'session_count'
  | 'tool_error_rate'
  // A floor ("didn't obviously fail"), not a success claim — there is no
  // reliable task-success signal in this data (see AgentFleetOverviewResponse).
  | 'clean_session_rate'
  // Share of agent sessions that needed mid-session human steering
  // (UserTurnCount > 1). The most direct independence signal; higher = less
  // autonomous. Read next to durability (agent_pr_revert_rate) — see
  // AGENT_AUTONOMY_METRICS.
  | 'agent_hands_on_rate'
  | 'active_actor_count'
  // Fleet-wide agent spend for the period (sum of `agent_session_summary`
  // cost) with a prior-period change — a headline stat tile, NOT the per-call
  // `total_cost` (GENERATION population). See `AGENT_FLEET_TILE_METRICS`.
  | 'total_agent_cost'
  | 'agent_model_mix'
  // Repo Activity dimension metrics — cost/sessions/tool-error-rate
  // by branch or agent type. See `AGENT_FLEET_DIMENSION_METRICS`.
  | 'agent_cost_by_branch'
  | 'agent_sessions_by_branch'
  | 'agent_tool_error_rate_by_branch'
  | 'agent_cost_by_agent_type'
  | 'agent_sessions_by_agent_type'
  // Repo Activity cost-anomaly metric — branches whose latest-day spend is a
  // statistical outlier vs. their own trailing baseline. SQL-only heuristic,
  // no ML. See `buildAgentFleetCostAnomalyQuery`.
  | 'agent_cost_anomalies_by_branch'
  // Agent Execution Health trend metrics — session-grain
  // percentiles and daily active-actor count as TRENDS, never a single
  // blended snapshot for the date range. See `AGENT_FLEET_TREND_METRICS`.
  | 'cost_per_session_trend'
  | 'agent_session_duration_trend'
  | 'agent_turn_count_trend'
  | 'active_actor_trend'
  // Agent PR-lifecycle metrics — read the Postgres
  // `pull_request` table (webhook-tracked + backfilled lifecycle rows), NOT
  // ClickHouse; only the session→PR attribution set comes from
  // `agent_session_summary`. See `AGENT_PR_METRICS` and
  // `src/lib/dashboards/pr-metrics.ts` for the pinned definitions.
  | 'agent_pr_merge_rate'
  | 'agent_pr_cycle_time_trend'
  | 'agent_pr_cycle_time_breakdown'
  | 'agent_cost_per_merged_pr'
  | 'agent_direct_cost_per_merged_pr'
  | 'agent_pr_unreviewed_merge_rate'
  | 'agent_pr_reopen_rate'
  // Share of decided agent PRs later reverted — the durability leg of autonomy
  // ("did the work stick?"). Up = worse. See AGENT_PR_METRICS.
  | 'agent_pr_revert_rate'
  // Autonomy composite: share of decided agent PRs that merged, held (no
  // revert), AND needed no mid-session steering. The headline "can we trust it
  // on its own?" number. Up = better (NOT inverted). See AGENT_PR_METRICS.
  | 'agent_clean_job_rate'
  // Executive Overview additions — the metrics that let a leader answer the
  // three questions the default dashboard is framed around: shipping
  // efficiency, cost-worth-it, and agenticness.
  //
  // Fleet-spend ratio: total agent spend ÷ distinct active actors — an
  // AGGREGATE ratio (both inputs are the existing overview tiles), never a
  // per-person breakdown. The number every budget conversation asks for.
  | 'agent_spend_per_active_dev'
  // Repo Activity-style dimension rankings by WorkerKind (run-origin:
  // seat | cloud | ci | shared) — work-shaped like branch/agent-type.
  | 'agent_sessions_by_worker_kind'
  | 'agent_cost_by_worker_kind'
  // Daily session counts split by WorkerKind — the "are we becoming more
  // agentic" trend (share of work run by cloud/CI workers vs. human seats).
  | 'agent_autonomy_mix_trend'
  // Daily mean interventions per session (UserTurnCount − 1) — the
  // finer-grained companion to the binary hands-on-rate tile.
  | 'agent_interventions_trend'
  // Daily trajectory-signal rates in one chart: tool-error rate (every
  // origin), denial rate and steered-session share (interactive origins) —
  // HOW sessions ran, trended so drift is visible.
  | 'agent_trajectory_signals_trend'
  // Share of ALL merged PRs that were agent-attributed — the adoption curve,
  // and (deliberately, disclosed in its description) the data-coverage floor:
  // attribution's only signal is synced sessions.
  | 'agent_share_of_merged_prs'
  // The within-org control group: the same delivery stat over the
  // agent-attributed vs. non-attributed PR populations, as a fixed
  // two-item ranking. "More efficient" is a comparative claim.
  | 'agent_vs_human_cycle_time'
  | 'agent_vs_human_merge_rate'
  | 'agent_vs_human_revert_rate'
  // Share of the window's spend not attributed to a merged PR — the waste
  // lever the fully-loaded-vs-direct cost gap exposes, as a headline stat.
  | 'agent_unshipped_spend_share'
  // Steering-signal tiles (agent_session_summary counters): human-denied tool
  // calls as a share of all tool calls, and sessions that ran without a single
  // permission prompt. The revealed-preference trust signals behind "are we
  // becoming more agentic" — paired with quality guardrails on the default
  // dashboard so a rise in autonomy is never read alone.
  | 'agent_tool_denial_rate'
  | 'agent_auto_approved_rate'
  // Daily median merged-PR size (lines changed), ALL merges — the batch-size
  // guardrail next to throughput (rising delivery + swelling PRs is the
  // instability mechanism, not acceleration).
  | 'pr_size_trend'
  // Agent-vs-human comparisons over the new pull_request columns: median
  // merged-PR size, and first-pass CI failure rate (the change-failure proxy).
  | 'agent_vs_human_pr_size'
  | 'agent_vs_human_first_pass_ci'
  // Fixed seat spend (ai_cost_config, prorated to the window) + metered token
  // spend — the whole AI program cost, always org-scoped. Stat tile.
  | 'total_cost_of_ai'
  // Autonomy Ladder over SHIPPED work: every merged PR classified at the
  // MINIMUM autonomy level of its session chain (L1 assisted → L4
  // autonomous, cut points published in the methodology doc). The trend is
  // the category headline; the share tile is its single number. Read next to
  // Clean Job Rate — autonomy growth is only good news if quality holds.
  | 'agent_shipped_autonomy_trend'
  | 'agent_delegated_share'
  // Eval-score ↔ PR-outcome correlation: a single
  // pass-minus-fail LIFT stat tile (positive/negative = which cohort
  // performed better), not a two-item ranking — a bar chart for two raw
  // rates you have to subtract in your head is decorative and hides cohort
  // size at low volume. Requires `scoreName` (which predictor to segment
  // by); fate-derived (`Source: 'outcome'`) scores are excluded — see
  // pr-outcome-correlation service. See AGENT_PR_METRICS.
  | 'agent_pr_outcome_by_score_merge_rate'
  | 'agent_pr_outcome_by_score_cycle_time'
  | 'agent_pr_outcome_by_score_revert_rate'
  // Not a data metric: renders its widget title as a full-width heading band,
  // giving a dashboard question-framed sections. Never fetches data.
  | 'section_header';

/** WidgetMetric includes both built-in and derived metric IDs */
type WidgetMetric = BuiltInMetric | string;

export const BUILT_IN_METRICS: readonly BuiltInMetric[] = [
  'request_count',
  'total_cost',
  'avg_cost',
  'total_tokens',
  'avg_tokens',
  'unique_users',
  'error_count',
  'error_rate',
  'avg_latency',
  'p50_latency',
  'p95_latency',
  'p99_latency',
  'top_models',
  'score_summary',
  'score_histogram',
  'score_trend',
  'score_comparison',
  'session_count',
  'tool_error_rate',
  'clean_session_rate',
  'agent_hands_on_rate',
  'active_actor_count',
  'total_agent_cost',
  'agent_model_mix',
  'agent_cost_by_branch',
  'agent_sessions_by_branch',
  'agent_tool_error_rate_by_branch',
  'agent_cost_by_agent_type',
  'agent_sessions_by_agent_type',
  'agent_cost_anomalies_by_branch',
  'cost_per_session_trend',
  'agent_session_duration_trend',
  'agent_turn_count_trend',
  'active_actor_trend',
  'agent_pr_merge_rate',
  'agent_pr_cycle_time_trend',
  'agent_pr_cycle_time_breakdown',
  'agent_cost_per_merged_pr',
  'agent_direct_cost_per_merged_pr',
  'agent_pr_unreviewed_merge_rate',
  'agent_pr_reopen_rate',
  'agent_pr_revert_rate',
  'agent_clean_job_rate',
  'agent_spend_per_active_dev',
  'agent_sessions_by_worker_kind',
  'agent_cost_by_worker_kind',
  'agent_autonomy_mix_trend',
  'agent_interventions_trend',
  'agent_trajectory_signals_trend',
  'agent_share_of_merged_prs',
  'agent_vs_human_cycle_time',
  'agent_vs_human_merge_rate',
  'agent_vs_human_revert_rate',
  'agent_unshipped_spend_share',
  'agent_tool_denial_rate',
  'agent_auto_approved_rate',
  'pr_size_trend',
  'agent_vs_human_pr_size',
  'agent_vs_human_first_pass_ci',
  'total_cost_of_ai',
  'agent_shipped_autonomy_trend',
  'agent_delegated_share',
  'agent_pr_outcome_by_score_merge_rate',
  'agent_pr_outcome_by_score_cycle_time',
  'agent_pr_outcome_by_score_revert_rate',
  'section_header',
] as const;

/** Score-specific metric IDs. */
export const SCORE_METRICS: readonly BuiltInMetric[] = [
  'score_summary',
  'score_histogram',
  'score_trend',
  'score_comparison',
] as const;

/** Check whether a metric is a score widget metric. */
export function isScoreMetric(metric: string): boolean {
  return (SCORE_METRICS as readonly string[]).includes(metric);
}

/**
 * Agent Fleet Overview tile metric IDs — the `getAgentFleetOverview` tiles
 * (`session_count`, `tool_error_rate`, `clean_session_rate`,
 * `active_actor_count`, `total_agent_cost`) plus the `agent_model_mix`
 * ranking. All are backed by one query per request (the widget-data route
 * calls `getAgentFleetOverview` once and reads the field the requested metric
 * maps to).
 */
export const AGENT_FLEET_TILE_METRICS: readonly BuiltInMetric[] = [
  'session_count',
  'tool_error_rate',
  'clean_session_rate',
  'agent_hands_on_rate',
  'active_actor_count',
  'total_agent_cost',
  // Total spend ÷ active actors, both read off the same overview response —
  // an aggregate ratio; the actor count stays a bare uniqExact, never a list.
  'agent_spend_per_active_dev',
  // Steering signals off the same overview response: human-denied tool calls
  // ÷ all tool calls, and prompt-free sessions ÷ all sessions.
  'agent_tool_denial_rate',
  'agent_auto_approved_rate',
] as const;

/**
 * Repo Activity dimension metric IDs — cost/session-count/tool-error-rate
 * grouped by an impersonal dimension (branch or agent type; see
 * `AgentFleetDimension`). All three ride the same row per dimension value
 * (one `getAgentFleetDimensionBreakdown` call); the route reads `costUsd`,
 * `sessions`, or `toolErrorRate` off the same rows depending on which
 * metric was requested. `agent_tool_error_rate_by_branch` exists so a cost
 * ranking is never shown without a quality signal for the same row.
 */
export const AGENT_FLEET_DIMENSION_METRICS: readonly BuiltInMetric[] = [
  'agent_cost_by_branch',
  'agent_sessions_by_branch',
  'agent_tool_error_rate_by_branch',
  'agent_cost_by_agent_type',
  'agent_sessions_by_agent_type',
  // WorkerKind (run-origin) rides the same dimension query — a work-shaped
  // dimension exactly like branch/agent type, never an identity.
  'agent_sessions_by_worker_kind',
  'agent_cost_by_worker_kind',
] as const;

/** Repo Activity's cost-anomaly metric — its own query, ranking-shaped response. */
export const AGENT_FLEET_ANOMALY_METRICS: readonly BuiltInMetric[] = [
  'agent_cost_anomalies_by_branch',
] as const;

/**
 * Agent Execution Health trend metric IDs — session-grain percentiles and
 * daily active-actor count as TRENDS. Each is its own query
 * (`getAgentFleetPercentileTrend` backs the first three,
 * `getAgentFleetActiveActorTrend` backs the fourth) and always renders as a
 * time series regardless of the widget's stored visualization — like
 * `agent_model_mix` always renders as a ranking. There is deliberately no
 * snapshot/stat version of any of these: a single blended percentile for a
 * date range hides exactly what percentiles exist to catch (see the file
 * header in `queries-agent-fleet.ts`).
 */
export const AGENT_FLEET_TREND_METRICS: readonly BuiltInMetric[] = [
  'cost_per_session_trend',
  'agent_session_duration_trend',
  'agent_turn_count_trend',
  'active_actor_trend',
  // Daily sessions by WorkerKind — one bounded series per run-origin.
  'agent_autonomy_mix_trend',
  // Daily mean interventions per session — rides the percentile-trend query.
  'agent_interventions_trend',
  // Daily tool-error / denial / steered rates — its own query.
  'agent_trajectory_signals_trend',
] as const;

export const AGENT_FLEET_METRICS: readonly BuiltInMetric[] = [
  ...AGENT_FLEET_TILE_METRICS,
  'agent_model_mix',
  ...AGENT_FLEET_DIMENSION_METRICS,
  ...AGENT_FLEET_ANOMALY_METRICS,
  ...AGENT_FLEET_TREND_METRICS,
] as const;

/** Check whether a metric is an agent-fleet metric (any of the three templates). */
export function isAgentFleetMetric(metric: string): boolean {
  return (AGENT_FLEET_METRICS as readonly string[]).includes(metric);
}

/**
 * Agent PR-lifecycle metric IDs — deliberately NOT part of
 * `AGENT_FLEET_METRICS`: those route to ClickHouse queries over
 * `agent_session_summary`, while these read the Postgres `pull_request`
 * table (the lifecycle source of truth — mirroring it into ClickHouse was
 * considered and rejected: best-effort dual-writes drift, and drift is fatal
 * to a metric whose whole claim is "matches what GitHub shows"). ClickHouse
 * contributes only the session→PR attribution set. `agent_pr_merge_rate` is
 * a stat tile (decided-cohort: merged ÷ merged+closed-unmerged);
 * `agent_pr_cycle_time_trend` is a fixed time-series (daily p50/p95 of
 * merged_at − opened_at, in hours); `agent_pr_cycle_time_breakdown` is a
 * fixed ranking (per-phase median hours: coding → pickup → review → merge);
 * `agent_cost_per_merged_pr` is a stat tile (fully-loaded: all agent spend ÷
 * agent PRs merged in the window) — in this group because it reads the same
 * `pull_request` rows for the merge count, but note it ALSO needs total agent
 * spend from ClickHouse (`getAgentFleetOverview`), so the route branch feeds
 * it both. `agent_pr_unreviewed_merge_rate` is a stat tile (share of merged
 * agent PRs with no human review/approval — a review-quality signal);
 * `agent_pr_reopen_rate` is a stat tile (share of decided agent PRs reopened
 * at least once — a rework/churn signal). Definitions live in `pr-metrics.ts`.
 */
export const AGENT_PR_METRICS: readonly BuiltInMetric[] = [
  'agent_pr_merge_rate',
  'agent_pr_cycle_time_trend',
  'agent_pr_cycle_time_breakdown',
  'agent_cost_per_merged_pr',
  'agent_direct_cost_per_merged_pr',
  'agent_pr_unreviewed_merge_rate',
  'agent_pr_reopen_rate',
  'agent_pr_revert_rate',
  'agent_clean_job_rate',
  // Adoption/coverage share over ALL merged PRs (stat tile).
  'agent_share_of_merged_prs',
  // Agent-vs-human population comparisons — fixed two-item rankings
  // ("Agent-shipped" / "Human-only"), one per delivery measure.
  'agent_vs_human_cycle_time',
  'agent_vs_human_merge_rate',
  'agent_vs_human_revert_rate',
  // Spend not attributed to a merged PR (stat tile) — needs total spend from
  // ClickHouse AND the cost-attribution set, like the direct-cost metric.
  'agent_unshipped_spend_share',
  // Batch-size guardrail — daily median merged-PR size, fixed time-series.
  'pr_size_trend',
  // Two more agent-vs-human two-item rankings: median merged-PR size, and
  // first-pass CI failure rate (measured rows only — see pr-metrics.ts).
  'agent_vs_human_pr_size',
  'agent_vs_human_first_pass_ci',
  // Autonomy Ladder: merged-PR cohort classified by session autonomy level
  // (needs the ladder attribution set from ClickHouse, like the cost metrics
  // need theirs). Trend = fixed stacked time-series; share = stat tile.
  'agent_shipped_autonomy_trend',
  'agent_delegated_share',
  // Score-outcome correlation: a pass-minus-fail lift stat, NOT
  // an agent-vs-human-shaped ranking (see STAT_ONLY_METRICS). Needs the
  // predictor-score verdict set from `pr-outcome-correlation`, like the
  // cost/ladder metrics need their own ClickHouse-sourced attribution.
  'agent_pr_outcome_by_score_merge_rate',
  'agent_pr_outcome_by_score_cycle_time',
  'agent_pr_outcome_by_score_revert_rate',
] as const;

/** Check whether a metric is a PR-lifecycle metric (Postgres-backed). */
export function isAgentPrMetric(metric: string): boolean {
  return (AGENT_PR_METRICS as readonly string[]).includes(metric);
}

/** Which dimension (`AgentFleetDimension`) a Repo Activity metric groups by. */
export function agentFleetDimensionFor(metric: string): 'branch' | 'agent_type' | 'worker_kind' | null {
  if (
    metric === 'agent_cost_by_branch' ||
    metric === 'agent_sessions_by_branch' ||
    metric === 'agent_tool_error_rate_by_branch'
  ) {
    return 'branch';
  }
  if (metric === 'agent_cost_by_agent_type' || metric === 'agent_sessions_by_agent_type') return 'agent_type';
  if (metric === 'agent_sessions_by_worker_kind' || metric === 'agent_cost_by_worker_kind') return 'worker_kind';
  return null;
}

/**
 * Metrics restricted to the `stat` visualization — every Agent Fleet
 * Overview tile. `active_actor_count` is a bare COUNT of distinct actors —
 * rendering it as a ranking/bar/line would invite a per-actor breakdown
 * (the exact pattern the no-per-developer-data decision rules out).
 * `session_count`/`tool_error_rate`/`clean_session_rate` are restricted for
 * a different, non-privacy reason: `getAgentFleetOverview` returns one
 * current/prior snapshot, not a time-bucketed series — trending THOSE
 * specific tiles is `AGENT_FLEET_TREND_METRICS`'s job (a separate query),
 * not a `line` visualization on the same metric ID. Enforced at the
 * validation layer (`validation.ts`, `zod-schemas.ts`), not just here — see
 * the privacy constraint test. Every other agent-fleet metric (dimension
 * rankings, the cost-anomaly ranking, the trend metrics) is NOT stat-only —
 * each always renders as its one fixed shape (ranking or time series)
 * regardless of the widget's stored visualization, like `agent_model_mix`.
 */
export const STAT_ONLY_METRICS: readonly BuiltInMetric[] = [
  ...AGENT_FLEET_TILE_METRICS,
  // Merge rate is a decided-cohort snapshot with a prior-period change, like
  // the fleet tiles; its trend belongs to a future dedicated metric, not a
  // 'line' visualization of this ID.
  'agent_pr_merge_rate',
  // Fully-loaded cost-per-merged-PR is a single ratio with a prior-period
  // change — a stat, like the spend tile it derives from. The direct variant
  // (attributed spend only) is the same shape.
  'agent_cost_per_merged_pr',
  'agent_direct_cost_per_merged_pr',
  // Unreviewed-merge rate is a single share with a prior-period change.
  'agent_pr_unreviewed_merge_rate',
  // Reopen rate — same shape (a decided-cohort share with prior-period change).
  'agent_pr_reopen_rate',
  // Revert rate — same decided-cohort share with prior-period change.
  'agent_pr_revert_rate',
  // Clean-job rate — the autonomy composite, same decided-cohort snapshot shape.
  'agent_clean_job_rate',
  // Merged-cohort share with prior-period change — a single snapshot number.
  'agent_share_of_merged_prs',
  // Spend share with prior-period change — same single-snapshot shape.
  'agent_unshipped_spend_share',
  // Seat + metered spend is a single figure with a prior-period change.
  'total_cost_of_ai',
  // Delegated+ share is a single classified-cohort share with a prior change.
  'agent_delegated_share',
  // Score-outcome correlation lift — a single pass-minus-fail
  // number, not a two-item ranking (see pr-outcome-correlation): a bar
  // chart for two numbers you have to subtract in your head is decorative,
  // and worse, it hides cohort size at low volume.
  'agent_pr_outcome_by_score_merge_rate',
  'agent_pr_outcome_by_score_cycle_time',
  'agent_pr_outcome_by_score_revert_rate',
  // Renders its title as a heading band — there is nothing to chart.
  'section_header',
] as const;

export function isStatOnlyMetric(metric: string): boolean {
  return (STAT_ONLY_METRICS as readonly string[]).includes(metric);
}

export const METRIC_LABELS: Record<string, string> = {
  request_count: 'Request Count',
  total_cost: 'Total Cost',
  avg_cost: 'Avg Cost per Request',
  total_tokens: 'Total Tokens',
  avg_tokens: 'Avg Tokens per Request',
  unique_users: 'Unique Users',
  error_count: 'Error Count',
  error_rate: 'Error Rate (%)',
  avg_latency: 'Avg Latency (ms)',
  p50_latency: 'P50 Latency (ms)',
  p95_latency: 'P95 Latency (ms)',
  p99_latency: 'P99 Latency (ms)',
  top_models: 'Top Models',
  score_summary: 'Score Summary',
  score_histogram: 'Score Distribution',
  score_trend: 'Score Trend',
  score_comparison: 'Score Comparison',
  session_count: 'Sessions',
  tool_error_rate: 'Tool Error Rate (%)',
  clean_session_rate: 'Error-Free Sessions (%)',
  agent_hands_on_rate: 'Hands-On Rate (%)',
  active_actor_count: 'Active Actors',
  total_agent_cost: 'Total Spend',
  agent_model_mix: 'Model Mix',
  agent_cost_by_branch: 'Cost by Branch',
  agent_sessions_by_branch: 'Sessions by Branch',
  agent_tool_error_rate_by_branch: 'Tool Error Rate by Branch',
  agent_cost_by_agent_type: 'Cost by Agent Type',
  agent_sessions_by_agent_type: 'Sessions by Agent Type',
  agent_cost_anomalies_by_branch: 'Cost Anomalies by Branch',
  cost_per_session_trend: 'Cost per Session (Trend)',
  agent_session_duration_trend: 'Session Duration (Trend)',
  agent_turn_count_trend: 'Turn Count (Trend)',
  active_actor_trend: 'Active Actors (Trend)',
  agent_pr_merge_rate: 'Agent PR Merge Rate',
  agent_pr_cycle_time_trend: 'PR Cycle Time (Trend)',
  agent_pr_cycle_time_breakdown: 'PR Cycle Time by Phase',
  agent_cost_per_merged_pr: 'Cost per Merged PR',
  agent_direct_cost_per_merged_pr: 'Attributed Cost per Merged PR',
  agent_pr_unreviewed_merge_rate: 'Merged Without Review (%)',
  agent_pr_reopen_rate: 'PR Reopen Rate (%)',
  agent_pr_revert_rate: 'Revert Rate (%)',
  agent_clean_job_rate: 'Clean Job Rate (%)',
  agent_spend_per_active_dev: 'Spend per Active Dev',
  agent_sessions_by_worker_kind: 'Sessions by Worker Kind',
  agent_cost_by_worker_kind: 'Cost by Worker Kind',
  agent_autonomy_mix_trend: 'Autonomy Mix (Trend)',
  // Display says "follow-ups" — the metric counts ANY human turn beyond the
  // initial ask (correction, answer, or new task alike); the stored metric id
  // keeps its wire name.
  agent_interventions_trend: 'Follow-ups per Session (Trend)',
  agent_trajectory_signals_trend: 'Trajectory Signals (Trend)',
  agent_share_of_merged_prs: 'Agent Share of Merged PRs (%)',
  agent_vs_human_cycle_time: 'Cycle Time: Agent vs Human',
  agent_vs_human_merge_rate: 'Merge Rate: Agent vs Human',
  agent_vs_human_revert_rate: 'Revert Rate: Agent vs Human',
  agent_unshipped_spend_share: 'Unshipped Spend (%)',
  agent_tool_denial_rate: 'Tool Denial Rate (%)',
  agent_auto_approved_rate: 'Auto-Approved Sessions (%)',
  pr_size_trend: 'Median PR Size (Trend)',
  agent_vs_human_pr_size: 'PR Size: Agent vs Human',
  agent_vs_human_first_pass_ci: 'First-Pass CI Failure: Agent vs Human',
  total_cost_of_ai: 'Total Cost of AI',
  agent_shipped_autonomy_trend: 'Shipped Work by Autonomy Level',
  agent_delegated_share: 'Delegated+ Share of Merged PRs (%)',
  // Parenthesised, not colon-separated: the widget route prefixes the
  // scoreName ("worker.ci_green: …"), and a second colon in the label made
  // the tile read as two competing headings.
  agent_pr_outcome_by_score_merge_rate: 'Merge-Rate Lift (Pass − Fail)',
  agent_pr_outcome_by_score_cycle_time: 'Cycle-Time Lift (Pass − Fail)',
  agent_pr_outcome_by_score_revert_rate: 'Revert-Rate Lift (Pass − Fail)',
  section_header: 'Section Header',
};

/**
 * One-line, plain-language explanation of what each stat metric measures,
 * surfaced under the tile value (WidgetStatCard) and in the widget config
 * picker. Written for someone who has never seen the metric before — the
 * label alone ("Merged Without Review", "Cost per Merged PR") says WHAT,
 * the description says exactly HOW it's counted and what a change means.
 * Only stat/tile metrics need one; ranking and trend metrics are
 * self-describing from their axis labels.
 */
export const METRIC_DESCRIPTIONS: Record<string, string> = {
  total_agent_cost: 'Total agent-session cost for the selected period.',
  session_count: 'Number of agent sessions — one per coding-agent run.',
  active_actor_count: 'Distinct developers and agents active in the period.',
  agent_pr_merge_rate: 'Of the agent PRs decided this period, the share that actually got merged.',
  agent_cost_per_merged_pr:
    'All agent spend this period ÷ agent PRs merged — the fully-loaded cost of one landed change. Lower is better.',
  agent_direct_cost_per_merged_pr:
    'Directly-attributed agent spend only ÷ agent PRs merged. The gap vs. Cost per Merged PR is unattributed overhead. Lower is better.',
  tool_error_rate: 'Share of the fleet’s tool calls that returned an error. Lower is better.',
  clean_session_rate: 'Share of agent sessions that finished with zero failed tool calls. Higher is better.',
  agent_clean_job_rate:
    'Share of agent jobs that landed cleanly and stayed landed — the autonomy composite. Higher is better.',
  agent_hands_on_rate:
    'Share of interactive sessions where a human typed again after the initial hand-off — any follow-up counts, whether a correction, an answer, or a new ask. Headless agent and worker runs are excluded — their extra turns are programmatic. Lower means more work completes on one hand-off.',
  agent_pr_unreviewed_merge_rate:
    'Share of merged agent PRs that no human reviewed or approved before merging. Lower is better.',
  agent_pr_reopen_rate:
    'Share of agent PRs that had to be reopened after being closed — work that didn’t hold the first time. Lower is better.',
  agent_pr_revert_rate:
    'Share of merged agent PRs later reverted by a follow-up PR. Exact-match detection only, so it undercounts. Lower is better.',
  error_rate: 'Share of requests that returned an error. Lower is better.',
  agent_spend_per_active_dev:
    'Total agent spend ÷ distinct active developers this period — an aggregate ratio, never a per-person breakdown. Typical published range: $150–250/dev/month.',
  agent_share_of_merged_prs:
    'Of everything merged this period, the share shipped with agent involvement (a synced agent session). When this is low, the other agent metrics describe only part of your shipped work.',
  agent_unshipped_spend_share:
    'Share of agent spend not attributed to any PR that merged this period. Includes legitimate non-PR work — aim for a falling trend, not zero. Lower is better.',
  agent_vs_human_cycle_time:
    'Median open→merge hours for agent-shipped vs. human-only PRs, same repo, same period. A comparison, not a controlled experiment — teams route different work to agents.',
  agent_vs_human_merge_rate:
    'Share of decided PRs that merged, agent-shipped vs. human-only. A comparison, not a controlled experiment.',
  agent_vs_human_revert_rate:
    'Share of decided PRs later reverted, agent-shipped vs. human-only — the stability check on any speed gap. Lower is better.',
  agent_tool_denial_rate:
    'Share of interactive sessions\u2019 tool calls a human denied at the permission prompt \u2014 headless and worker runs never see a prompt, so they don\u2019t count. Falling denial with steady quality is growing trust; with slipping quality it\u2019s rubber-stamping. Lower is better.',
  agent_auto_approved_rate:
    'Share of interactive sessions that ran without a single permission prompt. Rises as teams pre-approve more of the agent\u2019s toolkit. Headless agent and worker runs are excluded \u2014 they auto-approve by construction. Pre-signal sessions count as prompt-free.',
  agent_vs_human_pr_size:
    'Median lines changed per merged PR, agent-shipped vs. human-only. If agent PRs run much larger, a throughput edge is partly batch-size inflation — the instability mechanism, not speed.',
  agent_vs_human_first_pass_ci:
    'Share of PRs whose FIRST CI verdict was a failure, agent-shipped vs. human-only. Counts only PRs with an observed CI result. Lower is better.',
  total_cost_of_ai:
    'Seat spend (Settings \u2192 AI costs, prorated) plus metered token spend, org-wide. Token spend is API-equivalent value, not necessarily cash outlay.',
  agent_delegated_share:
    'Share of classifiable merged PRs that ran Delegated or Autonomous \u2014 one hand-off, zero steering, zero denials. Read beside Clean Job Rate; unclassifiable work is excluded, never guessed.',
  agent_pr_outcome_by_score_merge_rate:
    'Merge rate among agent PRs whose score PASSED, minus merge rate among PRs whose score FAILED \u2014 in percentage points. Positive = passing the score predicts a HIGHER merge rate (a good predictor); negative = the opposite. Cohorts split on the score recorded for the PR\u2019s session, never on the PR\u2019s own fate. For worker.ci_green that is \u201cdid CI pass on the FIRST run\u201d, so the fail cohort is PRs that failed first CI, got fixed, and usually merged anyway \u2014 not PRs that shipped red. PRs with no verdict count on neither side. Fate-derived scores can\u2019t be selected here (they\u2019d be circular).',
  agent_pr_outcome_by_score_cycle_time:
    'Median open\u2192merge hours for the PASS cohort minus the FAIL cohort. Negative = passing the score predicts a FASTER merge (a good predictor); positive = slower. Same cohort rules as the merge-rate variant \u2014 for worker.ci_green, \u201cright on the first try\u201d vs \u201cneeded a fix round\u201d.',
  agent_pr_outcome_by_score_revert_rate:
    'Revert rate among the PASS cohort minus the FAIL cohort, in percentage points. Negative = passing the score predicts FEWER reverts (a good predictor); positive = more. Same cohort rules as the merge-rate variant \u2014 for worker.ci_green, \u201cright on the first try\u201d vs \u201cneeded a fix round\u201d.',
  section_header: 'Displays its title as a section heading — use it to group widgets under a question.',
};

export function getMetricDescription(metric: string | undefined): string | undefined {
  if (!metric) return undefined;
  return METRIC_DESCRIPTIONS[metric];
}

/**
 * Evidence tier per metric — how much a reader should trust the number, shown
 * in the tile's info affordance ahead of the description. Three tiers:
 *
 *  - `provider-record`: computed from the webhook-fed PR/CI lifecycle record,
 *    checkable against the git provider — the strongest evidence this
 *    product has.
 *  - `metered`: computed from metered spend and hard merge/resolve events —
 *    dollars and counts, not inference.
 *  - `session-derived`: computed from synced session telemetry (turns, tool
 *    calls, classifications). Faithful to what sessions report, but only as
 *    complete as what syncs.
 *
 * A metric with no entry shows no evidence line — absence of a claim, never
 * an implied one. Pre-built templates prefer the first two tiers.
 */
type MetricEvidenceTier = 'provider-record' | 'metered' | 'session-derived';

const METRIC_EVIDENCE: Record<string, MetricEvidenceTier> = {
  agent_pr_merge_rate: 'provider-record',
  agent_pr_revert_rate: 'provider-record',
  agent_pr_reopen_rate: 'provider-record',
  agent_pr_unreviewed_merge_rate: 'provider-record',
  agent_vs_human_cycle_time: 'provider-record',
  agent_vs_human_merge_rate: 'provider-record',
  agent_vs_human_revert_rate: 'provider-record',
  agent_vs_human_first_pass_ci: 'provider-record',
  agent_vs_human_pr_size: 'provider-record',
  agent_share_of_merged_prs: 'provider-record',
  total_agent_cost: 'metered',
  total_cost_of_ai: 'metered',
  agent_cost_per_merged_pr: 'metered',
  agent_direct_cost_per_merged_pr: 'metered',
  agent_spend_per_active_dev: 'metered',
  agent_unshipped_spend_share: 'metered',
  agent_clean_job_rate: 'session-derived',
  agent_hands_on_rate: 'session-derived',
  agent_delegated_share: 'session-derived',
  // The PR side is a provider record, but the split itself is a synced
  // eval-score verdict — the weaker link sets the tier, same reasoning as
  // every other session-derived metric here.
  agent_pr_outcome_by_score_merge_rate: 'session-derived',
  agent_pr_outcome_by_score_cycle_time: 'session-derived',
  agent_pr_outcome_by_score_revert_rate: 'session-derived',
  agent_tool_denial_rate: 'session-derived',
  agent_auto_approved_rate: 'session-derived',
  tool_error_rate: 'session-derived',
  clean_session_rate: 'session-derived',
  session_count: 'session-derived',
  active_actor_count: 'session-derived',
};

const EVIDENCE_LINES: Record<MetricEvidenceTier, string> = {
  'provider-record': 'Evidence: ground truth — the webhook-fed PR/CI record, checkable against your git provider.',
  metered: 'Evidence: ground truth — metered spend and hard merge/resolve events.',
  'session-derived': 'Evidence: derived from synced session telemetry — as complete as what syncs.',
};

export function getMetricEvidenceLine(metric: string | undefined): string | undefined {
  if (!metric) return undefined;
  const tier = METRIC_EVIDENCE[metric];
  return tier ? EVIDENCE_LINES[tier] : undefined;
}

/**
 * Which direction of a period-over-period change reads as GOOD for a metric —
 * the single source of truth behind the green / red / grey sentiment on a
 * stat tile (see `resolveChangeSentiment`).
 *
 *   'up'      higher is better  → up-arrow green, down-arrow red
 *   'down'    lower is better   → down-arrow green, up-arrow red
 *   'neutral' no inherent good/bad → arrow shown, but grey (no verdict)
 *
 * A metric MISSING here falls back to 'up' at the call site. That fallback is
 * exactly the bug this map fixes: cost-per-merged-PR and revert rate used to
 * fall through to 'up', so a FALLING cost or a RISING revert rate rendered as
 * the wrong colour. Keep every stat/tile metric listed. Raw spend is
 * deliberately 'neutral': a rise can mean more usage, not waste, so we don't
 * colour it as good or bad.
 */
type BetterDirection = 'up' | 'down' | 'neutral';

const METRIC_BETTER_DIRECTION: Record<string, BetterDirection> = {
  // Higher is better.
  session_count: 'up',
  active_actor_count: 'up',
  clean_session_rate: 'up',
  agent_clean_job_rate: 'up',
  agent_pr_merge_rate: 'up',
  request_count: 'up',
  unique_users: 'up',
  // Adoption share — the "becoming more agentic" curve; paired with the
  // clean-job guardrail on the default dashboard so a rise is never read alone.
  agent_share_of_merged_prs: 'up',

  // Lower is better.
  error_rate: 'down',
  error_count: 'down',
  tool_error_rate: 'down',
  agent_hands_on_rate: 'down',
  agent_pr_unreviewed_merge_rate: 'down',
  agent_pr_reopen_rate: 'down',
  agent_pr_revert_rate: 'down',
  agent_cost_per_merged_pr: 'down',
  agent_direct_cost_per_merged_pr: 'down',
  agent_unshipped_spend_share: 'down',
  avg_latency: 'down',
  p50_latency: 'down',
  p95_latency: 'down',
  p99_latency: 'down',

  // No inherent good/bad — a rise isn't a win or a loss on its own.
  total_agent_cost: 'neutral',
  total_cost: 'neutral',
  total_tokens: 'neutral',
  // Spend-per-dev rising can mean deeper adoption (good) or waste (bad) —
  // the cost-per-merged-PR trend is the tile that carries the verdict.
  agent_spend_per_active_dev: 'neutral',
  // Fewer human denials = more warranted autonomy — IF the quality guardrails
  // hold; the default dashboard pairs it with Clean Job Rate for that reason.
  agent_tool_denial_rate: 'down',
  // More prompt-free sessions = deeper pre-approved trust. Same pairing.
  agent_auto_approved_rate: 'up',
  // Whole-program spend, like raw spend: a rise can be adoption, not waste.
  total_cost_of_ai: 'neutral',
  // The trust curve — up = more work shipping at Delegated/Autonomous. The
  // default dashboard seats it beside Clean Job Rate so a rise is never read
  // without its quality guardrail.
  agent_delegated_share: 'up',
};

export function betterDirectionFor(metric: string | undefined): BetterDirection {
  if (!metric) return 'up';
  return METRIC_BETTER_DIRECTION[metric] ?? 'up';
}

// ============================================================================
// Derived Metrics
// ============================================================================

/**
 * A derived metric is computed from two built-in metrics (numerator / denominator).
 * These are pre-composed ratios available in the widget config dialog.
 */
interface DerivedMetric {
  id: string;
  name: string;
  description: string;
  numerator: WidgetMetric;
  denominator: WidgetMetric;
}

export const DERIVED_METRICS: readonly DerivedMetric[] = [
  {
    id: 'cost_per_request',
    name: 'Cost per Request',
    description: 'Average cost of each request',
    numerator: 'total_cost',
    denominator: 'request_count',
  },
  {
    id: 'tokens_per_request',
    name: 'Tokens per Request',
    description: 'Average tokens consumed per request',
    numerator: 'total_tokens',
    denominator: 'request_count',
  },
  {
    id: 'cost_per_token',
    name: 'Cost per Token',
    description: 'Average cost per token',
    numerator: 'total_cost',
    denominator: 'total_tokens',
  },
  {
    id: 'cost_per_error',
    name: 'Cost per Error',
    description: 'Average cost wasted per error',
    numerator: 'total_cost',
    denominator: 'error_count',
  },
  {
    id: 'success_rate',
    name: 'Success Rate (%)',
    description: 'Percentage of non-error requests',
    numerator: 'request_count',
    denominator: 'request_count',
    // Computed specially: (requests - errors) / requests * 100
  },
  {
    id: 'requests_per_user',
    name: 'Requests per User',
    description: 'Average requests per unique user',
    numerator: 'request_count',
    denominator: 'unique_users',
  },
  {
    id: 'cost_per_user',
    name: 'Cost per User',
    description: 'Average cost per unique user',
    numerator: 'total_cost',
    denominator: 'unique_users',
  },
  {
    id: 'tokens_per_user',
    name: 'Tokens per User',
    description: 'Average tokens per unique user',
    numerator: 'total_tokens',
    denominator: 'unique_users',
  },
  {
    id: 'errors_per_user',
    name: 'Errors per User',
    description: 'Average errors per unique user',
    numerator: 'error_count',
    denominator: 'unique_users',
  },
  {
    id: 'latency_cost_ratio',
    name: 'Latency/Cost Ratio',
    description: 'Milliseconds of latency per dollar spent',
    numerator: 'avg_latency',
    denominator: 'avg_cost',
  },
] as const;

export function getDerivedMetric(id: string): DerivedMetric | undefined {
  return DERIVED_METRICS.find((m) => m.id === id);
}

export function isDerivedMetric(metric: string): boolean {
  return DERIVED_METRICS.some((m) => m.id === metric);
}

/** All valid metric IDs (built-in + derived). */
export const ALL_METRIC_IDS: readonly string[] = [
  ...BUILT_IN_METRICS,
  ...DERIVED_METRICS.map((m) => m.id),
];

// ============================================================================
// Visualization Types
// ============================================================================

export type VisualizationType = 'line' | 'bar' | 'area' | 'stat';

export const VISUALIZATION_TYPES: readonly VisualizationType[] = [
  'line',
  'bar',
  'area',
  'stat',
] as const;

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Built-in promoted filter fields (native ClickHouse columns).
 */
type PromotedFilterField = 'model' | 'user_id' | 'status';

/** Check whether a filter field targets a metadata key. */
export function isMetadataField(field: string): field is `metadata.${string}` {
  return field.startsWith('metadata.');
}

/** Extract the metadata key from a 'metadata.<key>' field string. */
export function getMetadataKey(field: string): string {
  return field.slice('metadata.'.length);
}

/** The set of promoted fields that map to native ClickHouse columns. */
export const PROMOTED_FILTER_FIELDS: readonly PromotedFilterField[] = [
  'model',
  'user_id',
  'status',
] as const;

interface WidgetFilter {
  // Loose `string` intentionally — the OpenAPI-generated Widget type (the
  // wire contract for API responses) carries a plain `string` for filter
  // fields. Runtime validation via Zod on the server side + `isMetadataField`
  // type guards cover the template-literal semantics at use sites, so
  // matching the wire shape here lets hand-authored and generated types
  // interoperate without casts.
  field: string;
  operator: string;
  value: string;
}

export type TimeGranularity = 'hour' | 'day' | 'auto';

// ============================================================================
// Layout Types
// ============================================================================

export interface LayoutItem {
  widgetId: string;
  x: number;
  y: number;
  w: number; // Width in grid units (1-12)
  h: number; // Height in grid units
}

// ============================================================================
// Widget Environment Config
// ============================================================================

/**
 * How a widget resolves its env scope at query time:
 *  - `inherit` — follow the dashboard-level env filter (the default; the
 *    widget shows whatever env the dashboard view is scoped to).
 *  - `override` — ignore the dashboard env and use the widget's own
 *    `environments` list. A single entry pins the widget to one env; multiple
 *    entries surface a cross-env comparison ("prod vs staging") in one widget.
 */
type WidgetEnvironmentMode = 'inherit' | 'override';

export interface WidgetEnvironmentConfig {
  mode: WidgetEnvironmentMode;
  /**
   * Env names this widget is pinned to. Only meaningful when `mode` is
   * `override`. Empty / absent for `inherit`.
   */
  environments?: string[];
}

/** Default env config — a widget with no explicit config inherits. */
const DEFAULT_WIDGET_ENVIRONMENT_CONFIG: WidgetEnvironmentConfig = {
  mode: 'inherit',
};

/**
 * Normalizes a persisted (possibly null / legacy) env config into a concrete
 * value. NULL rows — widgets persisted before env config existed — resolve to `inherit`.
 */
export function resolveWidgetEnvironmentConfig(
  config: WidgetEnvironmentConfig | null | undefined,
): WidgetEnvironmentConfig {
  if (!config || config.mode !== 'override') {
    return DEFAULT_WIDGET_ENVIRONMENT_CONFIG;
  }
  return {
    mode: 'override',
    environments: (config.environments ?? []).filter(
      (e): e is string => typeof e === 'string' && e.length > 0,
    ),
  };
}

// ============================================================================
// Widget Types
// ============================================================================

export interface Widget {
  id: string;
  dashboardId: string;
  title: string;
  metric: WidgetMetric;
  visualization: VisualizationType;
  filters: WidgetFilter[];
  groupBy: string | null;
  timeGranularity: TimeGranularity;
  /** Score name for score_histogram, score_trend, and score_comparison widgets. */
  scoreName?: string;
  /** Second score name for score_comparison widgets. */
  scoreNameB?: string;
  /**
   * Env dimension. Absent ⇒ `inherit` — the widget
   * follows the dashboard-level env filter.
   */
  environmentConfig?: WidgetEnvironmentConfig;
  createdAt: string;
  updatedAt: string | null;
}

// ============================================================================
// Dashboard Types
// ============================================================================

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  globalTimeRange: string;
  layout: LayoutItem[];
  widgets: Widget[];
  createdAt: string;
  updatedAt: string | null;
}

export interface DashboardSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  widgetCount: number;
  globalTimeRange: string;
  createdAt: string;
  updatedAt: string | null;
}

// ============================================================================
// Request Types
// ============================================================================

export interface CreateDashboardRequest {
  name: string;
  description?: string;
  isDefault?: boolean;
  templateId?: string;
}

export interface UpdateDashboardRequest {
  name?: string;
  description?: string | null;
  isDefault?: boolean;
  globalTimeRange?: string;
  layout?: LayoutItem[];
}

export interface CreateWidgetRequest {
  title: string;
  metric: WidgetMetric;
  visualization?: VisualizationType;
  filters?: WidgetFilter[];
  groupBy?: string | null;
  timeGranularity?: TimeGranularity;
  scoreName?: string;
  scoreNameB?: string;
  environmentConfig?: WidgetEnvironmentConfig;
}

export interface UpdateWidgetRequest {
  title?: string;
  metric?: WidgetMetric;
  visualization?: VisualizationType;
  filters?: WidgetFilter[];
  groupBy?: string | null;
  timeGranularity?: TimeGranularity;
  scoreName?: string;
  scoreNameB?: string;
  environmentConfig?: WidgetEnvironmentConfig;
}

export interface WidgetDataRequest {
  metric: WidgetMetric;
  filters?: WidgetFilter[];
  groupBy?: string | null;
  timeGranularity?: TimeGranularity;
  scoreName?: string;
  scoreNameB?: string;
  /**
   * Resolved env scope for this widget's query.
   * Empty / absent ⇒ no env filter. A single entry scopes to one env;
   * multiple entries are a cross-env comparison. The dashboard view resolves
   * `inherit` widgets to the dashboard-level env before sending.
   */
  environments?: string[];
  /**
   * True when the single resolved env is the app's default env — drives the
   * legacy-row (`Environment = ''`) inclusion rule.
   */
  environmentIsDefault?: boolean;
  timeRange: {
    preset?: '24h' | '7d' | '30d' | '90d';
    start?: string;
    end?: string;
  };
}

// ============================================================================
// Response Types
// ============================================================================

// Widget Data Responses (union type)

export interface WidgetTimeSeriesResponse {
  type: 'timeSeries';
  series: {
    name: string;
    data: { x: string; y: number }[];
  }[];
  summary?: {
    total: number;
    average: number;
  };
}

export interface WidgetStatResponse {
  type: 'stat';
  value: number;
  label: string;
  change?: {
    value: number;
    direction: 'up' | 'down' | 'flat';
  };
  /**
   * The prior window had no baseline to compute a percent change against
   * (value 0 with a non-zero current). `change` is omitted in that case —
   * a fabricated "+100%" reads as data; the card shows "no prior data"
   * instead. Absent whenever a real change (or a true 0→0 flat) exists.
   */
  priorEmpty?: boolean;
  /**
   * The metric is a ratio whose DENOMINATOR was zero this window (e.g.
   * cost-per-merged-PR with nothing merged). `value` is a meaningless
   * placeholder — the card renders an em-dash + `reason`, never the number,
   * because "$0" on a cost-per-outcome tile reads as best-case when it's
   * actually worst-case (spend, no outcome). Same honesty stance as
   * `priorEmpty`, one level up (the value itself, not just its change).
   */
  unavailable?: { reason: string };
  /**
   * A small context line under the figure — sample size, denominator, or
   * scope the headline number hides on its own. A single percentage-point
   * lift looks identical off 4 data points or 400; the caption is what makes
   * the reader distinguish signal from noise. Rendered verbatim, muted, below
   * the value and above any delta row. Omit when the number stands alone.
   */
  caption?: string;
}

export interface WidgetRankingResponse {
  type: 'ranking';
  items: { name: string; value: number }[];
}

export interface WidgetScoreSummaryResponse {
  type: 'scoreSummary';
  aggregations: import('@/lib/analytics/types').ScoreAggregation[];
}

export interface WidgetScoreHistogramResponse {
  type: 'scoreHistogram';
  data: import('@/lib/analytics/types').ScoreHistogramResponse;
}

export interface WidgetScoreTrendResponse {
  type: 'scoreTrend';
  data: import('@/lib/analytics/types').ScoreTrendResponse;
}

export interface WidgetScoreComparisonResponse {
  type: 'scoreComparison';
  comparison?: import('@/lib/analytics/types').ScoreComparisonResponse;
  scatter?: import('@/lib/analytics/types').ScoreScatterResponse;
}

export type WidgetDataResponse =
  | WidgetTimeSeriesResponse
  | WidgetStatResponse
  | WidgetRankingResponse
  | WidgetScoreSummaryResponse
  | WidgetScoreHistogramResponse
  | WidgetScoreTrendResponse
  | WidgetScoreComparisonResponse;

// ============================================================================
// Template Types
// ============================================================================

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  widgetCount: number;
  widgets: {
    title: string;
    metric: WidgetMetric;
    visualization: VisualizationType;
  }[];
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  widgets: CreateWidgetRequest[];
  layout: LayoutItem[];
}

// ============================================================================
// Database Row Types (internal, maps to Supabase table shape)
// ============================================================================

export interface DashboardRow {
  id: string;
  /** @deprecated Nullable legacy column — dashboards are now org-scoped via tenant_id. */
  user_id: string | null;
  app_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  layout: LayoutItem[];
  global_time_range: string;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
}

export interface DashboardWidgetRow {
  id: string;
  dashboard_id: string;
  tenant_id: string;
  title: string;
  metric: string;
  visualization: string;
  filters: WidgetFilter[];
  group_by: string | null;
  time_granularity: string;
  sort_order: number;
  score_name: string | null;
  score_name_b: string | null;
  /** NULL ⇒ widget inherits the dashboard-level env. */
  environment_config: WidgetEnvironmentConfig | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_DASHBOARDS_PER_APP = 10;
export const MAX_DASHBOARDS_PER_ORG = 100;
// 25 fits the default Executive Overview (22 widgets incl. its heading bands)
// with headroom to add a few, while still bounding the per-page query fan-out
// (every widget is a live query on load; lazy in-viewport fetching keeps the
// initial burst well under the cap).
export const MAX_WIDGETS_PER_DASHBOARD = 25;
export const MAX_DASHBOARD_NAME_LENGTH = 100;
export const MAX_DASHBOARD_DESCRIPTION_LENGTH = 500;
export const MAX_WIDGET_TITLE_LENGTH = 100;
