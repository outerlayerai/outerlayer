/**
 * Analytics Service Types
 * Feature: 007-analytics-architecture-evaluation
 *
 * These types define the contract for the analytics service layer,
 * including API request/response shapes and internal data structures.
 */

// ============================================================================
// Branded Types
// ============================================================================

declare const __brand: unique symbol;
export type VerifiedAppId = string & { readonly [__brand]: 'VerifiedAppId' };

// Re-import TenantContext for the IAnalyticsService interface
import type { TenantContext } from './tenant-context';

// ============================================================================
// Common Types
// ============================================================================

/**
 * Date range for analytics queries.
 * Supports preset ranges or custom date selection.
 *
 * App-internal camelCase shape — distinct from api-schemas's wire-format
 * `DateRangeParamsSchema` (snake_case `start_date` / `end_date`, both
 * optional). Kept here because no Zod schema describes this exact shape.
 */
export interface DateRange {
  start: string; // ISO date string (YYYY-MM-DD)
  end: string; // ISO date string (YYYY-MM-DD)
}

/**
 * Preset date range values for quick selection.
 *
 * App-internal narrower union — api-schemas's `DateRangePreset` adds
 * a `'yesterday'` value not used by this surface. Kept local to avoid
 * loosening consumer expectations.
 */
export type DateRangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';

/**
 * Standard pagination parameters.
 *
 * Sourced from api-schemas's `PaginationParamsSchema` (z.infer<>) —
 * both packages agree on `{ limit: number; offset: number }`, so the
 * canonical shape lives in api-schemas and this file re-exports it
 * to stay in lockstep with the wire contract.
 */
import type { PaginationParams as _PaginationParams } from '@repo/api-schemas';
export type PaginationParams = _PaginationParams;

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Summary metrics for the dashboard header.
 * Aggregated from otel_traces.
 */
export interface MetricsSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  uniqueUsers: number;
}

/**
 * Time series data point for dashboard charts.
 * Hourly granularity, bucketed from otel_traces.
 */
export interface TimeSeriesPoint {
  date: string; // ISO date string
  hour: number; // 0-23
  requests: number;
  successes: number;
  errors: number;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  uniqueUsers: number;
}

/**
 * Complete metrics response including summary and time series.
 */
export interface MetricsResponse {
  summary: MetricsSummary;
  timeSeries: TimeSeriesPoint[];
}

// ============================================================================
// Model Stats Types
// ============================================================================

/**
 * Statistics for a single model.
 * Aggregated from otel_traces (see buildFilteredModelStatsQuery).
 */
export interface ModelStats {
  model: string;
  requests: number;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  successRate: number;
}

/**
 * Response for top models query.
 */
export interface ModelStatsResponse {
  models: ModelStats[];
}

// ============================================================================
// Prompt Version Stats Types
// ============================================================================

/**
 * A single ranking item for dimension-grouped queries.
 * Used by getRankingData to return data grouped by any dimension
 * (model, user_id, metadata fields).
 */
export interface RankingDataItem {
  dimensionValue: string;
  requests: number;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  successRate: number;
}

/**
 * Response for dimension-grouped ranking queries.
 */
export interface RankingDataResponse {
  items: RankingDataItem[];
}

// ============================================================================
// Agent Fleet Types
// ============================================================================

/**
 * A current-vs-prior-period delta for one agent-fleet tile metric.
 * `prior` is the immediately preceding period of equal length to the
 * requested date range (e.g. requesting the last 7 days compares against
 * the 7 days before that).
 */
export interface AgentFleetTile {
  current: number;
  prior: number;
}

/**
 * Query scope for agent-fleet and PR-lifecycle reads.
 *  - `app` (default): the app's dominant repo — the established "app = one
 *    repo" convention every fleet query has always used.
 *  - `org`: the whole tenant — every app and repo, for org-level executive
 *    rollups. Sweeps more data and requires repo-qualified labels wherever a
 *    branch name surfaces (branch names collide across repos).
 * Both scopes preserve the privacy invariant: aggregates only, `ActorId`
 * never leaves `uniqExact()`.
 */
export type AgentFleetScope = 'app' | 'org';

export interface AgentFleetQueryOptions {
  scope?: AgentFleetScope;
}

/**
 * One entry in the agent-fleet model-mix ranking — a count of sessions
 * that used a given model, never attributed to an individual actor.
 */
export interface AgentFleetModelMixItem {
  model: string;
  sessions: number;
}

/**
 * Fleet-level rollup for the Agent Fleet Overview dashboard template.
 * Every field is an aggregate (a count, a rate, or a ranking by an
 * impersonal dimension) — this response intentionally carries no
 * per-actor/per-developer breakdown. See the dashboards privacy
 * constraint test (`apps/tenant-dashboard/src/lib/dashboards/__tests__/privacy-constraints.test.ts`).
 */
export interface AgentFleetOverviewResponse {
  sessions: AgentFleetTile;
  toolErrorRate: AgentFleetTile;
  /**
   * Share of sessions with zero tool-call errors. Named deliberately —
   * this is a floor ("didn't obviously fail"), not a success claim. There is
   * no reliable "task succeeded" signal in the data available across the
   * industry, so this does not attempt to be one.
   */
  cleanSessionRate: AgentFleetTile;
  /**
   * Share of INTERACTIVE sessions that needed mid-session human steering —
   * UserTurnCount > 1 (more than the initial task hand-off). This is the most
   * direct independence signal: how often a human had to step in while the
   * agent was working. Higher = less autonomous. Like every behavior rate
   * here, both numerator and denominator exclude agent-origin and worker-run
   * sessions — an SDK run's extra "user" turns are programmatic, not human
   * steering, and worker runs are their own population on the Workers
   * surface. Read alongside durability (revert rate): a
   * low hands-on rate paired with poor durability is the "walked away" trap,
   * not proof of autonomy.
   */
  handsOnRate: AgentFleetTile;
  /** Count of distinct actors active in the period — a bare number, never a list. */
  activeActors: AgentFleetTile;
  /**
   * Total agent-session spend (USD) for the period — the fleet-wide sum of
   * `agent_session_summary.CostUsd`, with a prior-period comparison like the
   * other tiles. The headline spend number; the per-dimension breakdown (by
   * branch/agent type) lives in the Repo Activity template. Reads the SAME
   * agent-session population as every other tile here, NOT the per-LLM-call
   * `Type = 'GENERATION'` population — the two do not reconcile.
   */
  totalCost: AgentFleetTile;
  /**
   * Human-denied tool calls as a share of INTERACTIVE sessions' tool calls —
   * the human saw a permission prompt and said no. Headless/worker runs never
   * see a prompt, so both sides of the ratio exclude them. The inverse trust
   * signal to `autoApprovedRate`: falling denial with flat quality (clean job
   * rate) reads as growing, warranted trust; falling denial with degrading
   * quality is rubber-stamping. Sessions ingested before the steering-signal
   * columns existed count zero denials, so the rate is understated across
   * that boundary and honest within any window after it.
   */
  toolDenialRate: AgentFleetTile;
  /**
   * Share of INTERACTIVE sessions that ran without a single permission
   * prompt — the agent never had to stop and ask a human before acting.
   * Rises as teams pre-approve more of the agent's toolkit (the strongest
   * published revealed-preference autonomy signal). Agent-origin and
   * worker-run sessions are excluded from both sides: they auto-approve by
   * construction, which would peg this rate at 100% and bury the
   * interactive signal. Same legacy-rows caveat as `toolDenialRate`:
   * pre-column sessions read as prompt-free.
   */
  autoApprovedRate: AgentFleetTile;
  modelMix: AgentFleetModelMixItem[];
}

/**
 * The impersonal dimensions fleet metrics break cost/sessions down by.
 * `worker_kind` is the run-origin taxonomy (`seat | cloud | ci | shared`,
 * stamped at ingest) — a work-shaped dimension like branch/agent type,
 * never an identity: it says WHERE a session ran, not WHO ran it.
 */
export type AgentFleetDimension = 'branch' | 'agent_type' | 'worker_kind';

/**
 * One entry in a dimension breakdown — cost, session count, AND tool-error
 * rate for a branch or agent type. `toolErrorRate` rides alongside cost/
 * sessions specifically so a spend ranking is never shown without a quality
 * signal for the same row (a branch burning unusual cost AND showing an
 * elevated error rate is a different story than one just burning cost).
 * Never keyed by an individual actor/developer.
 */
export interface AgentFleetDimensionItem {
  dimensionValue: string;
  sessions: number;
  costUsd: number;
  toolErrorRate: number;
}

export interface AgentFleetDimensionResponse {
  items: AgentFleetDimensionItem[];
}

/** One day's percentile snapshot — the building block of a percentile TREND, never a lone number. */
export interface AgentFleetPercentileTrendPoint {
  date: string;
  costP50: number;
  costP95: number;
  durationP50Ms: number;
  durationP95Ms: number;
  durationP99Ms: number;
  turnCountP95: number;
  /**
   * Mean human interventions per session that day — `max(UserTurnCount − 1, 0)`
   * averaged over the day's sessions (human turns beyond the initial prompt).
   * The finer-grained companion to the hands-on-rate tile (which is the binary
   * "was steered at all" share): this trends HOW MUCH steering sessions need.
   * A mean, not a percentile, so the many-zeros distribution doesn't render as
   * a flat p50 of 0 while total steering load is actually shifting.
   */
  interventionsMean: number;
}

/**
 * Session-grain percentiles for the Agent Execution Health template, as a
 * daily trend — never a single blended number for the whole date range.
 * A blended percentile hides exactly what percentiles exist to catch (a
 * spike buried in an otherwise-calm week reads identical to a flat line);
 * percentile widgets default to time-series across observability tooling
 * for this reason. `sessionDurationMs` is `EndedAt - StartedAt` per session.
 */
export interface AgentFleetPercentileTrendResponse {
  points: AgentFleetPercentileTrendPoint[];
}

/** One day's distinct-actor count — a bare number per day, never a list. */
export interface AgentFleetActiveActorTrendPoint {
  date: string;
  activeActors: number;
}

/**
 * Daily active-actor count over the period — an adoption TREND, not just a
 * current-vs-prior snapshot. This is a count trend, not a %-of-org-seats
 * adoption RATE (that denominator lives in Postgres org membership, not
 * ClickHouse) — labeled accordingly wherever it's shown.
 */
export interface AgentFleetActiveActorTrendResponse {
  points: AgentFleetActiveActorTrendPoint[];
}

/**
 * One branch flagged as burning unusual spend: `recentCostUsd` (the latest
 * day in the requested range) is more than 2 standard deviations above
 * `baselineMeanUsd` (the mean of the preceding days in the same range).
 * SQL-only heuristic (trailing mean + stddev, no ML) — see
 * `buildAgentFleetCostAnomalyQuery`.
 */
export interface AgentFleetCostAnomalyItem {
  dimensionValue: string;
  recentCostUsd: number;
  baselineMeanUsd: number;
  deltaUsd: number;
}

export interface AgentFleetCostAnomalyResponse {
  items: AgentFleetCostAnomalyItem[];
}

/** One day's session count for one worker kind — a bucket of the autonomy-mix trend. */
export interface AgentFleetAutonomyMixTrendPoint {
  date: string;
  /** Run-origin: `seat | cloud | ci | shared` (legacy unlabeled rows are excluded, never guessed). */
  workerKind: string;
  sessions: number;
}

/**
 * Daily session counts split by worker kind — the "are we becoming more
 * agentic" trend: the share of work executed by cloud/CI workers vs. human
 * seats over time. Run-origin only (a work-shaped dimension); never a
 * per-actor breakdown.
 */
export interface AgentFleetAutonomyMixTrendResponse {
  points: AgentFleetAutonomyMixTrendPoint[];
}

/** One day's trajectory-signal rates — a bucket of the trajectory-signal trend. */
export interface AgentFleetTrajectorySignalTrendPoint {
  date: string;
  /** Failed tool calls ÷ all tool calls that day, every origin (0..1). */
  toolErrorRate: number;
  /**
   * Human-denied tool calls ÷ tool calls that day, interactive-origin
   * sessions only (0..1) — headless and worker runs never see a prompt.
   */
  denialRate: number;
  /**
   * Hands-on sessions (any human follow-up: UserTurnCount > 1) ÷
   * interactive-origin sessions that day (0..1). The binary companion to
   * `interventionsMean` on the percentile trend (whose display name is
   * "follow-ups per session"): this is HOW MANY sessions a human touched
   * again, that one is HOW OFTEN they did.
   */
  handsOnShare: number;
}

/**
 * Daily trajectory-signal rates over the period — tool-error rate, denial
 * rate, and hands-on-session share as one trend, so drift in HOW sessions
 * run (not what they cost) is visible at fleet grain. Rates only, never a
 * per-actor breakdown.
 */
export interface AgentFleetTrajectorySignalTrendResponse {
  points: AgentFleetTrajectorySignalTrendPoint[];
}

/**
 * The session→PR attribution set for an app's dominant repo: every distinct
 * branch a coding-agent session ran on, and every PR number a session
 * explicitly linked via a `pr-link` outcome. A `pull_request` row is
 * "agent-attributed" when its `pr_number` is in `prNumbers` OR its
 * `head_branch` is in `branches`. Deliberately NOT time-windowed — the
 * session that produced a PR can long predate the window its merge lands in.
 * Bare identifiers only (branch names, PR numbers) — never actor identity.
 */
export interface AgentPrAttributionResponse {
  branches: string[];
  prNumbers: number[];
  /**
   * PR numbers whose linked agent session(s) needed mid-session human steering
   * (any session with UserTurnCount > 1). Feeds the autonomy composite
   * `agent_clean_job_rate` — a "clean job" needs no steering. A PR absent here
   * had no steered session (or no linked session at all, which counts as
   * un-steered: we never assert steering we can't observe).
   */
  steeredPrNumbers: number[];
  /**
   * The same attribution set as repo-qualified rows. Under `app` scope every
   * row carries the one dominant repo; under `org` scope rows span every repo
   * in the tenant, and the flat sets above are UNSAFE to match against
   * (branch names and PR numbers collide across repos) — org-scope consumers
   * must match within `repo`.
   */
  items: AgentPrAttributionItem[];
}

/** One repo-qualified attribution row: a `(repo, branch, prNumber)` session group. */
export interface AgentPrAttributionItem {
  repo: string;
  branch: string;
  prNumber: number;
  /** True when any session in the group had UserTurnCount > 1 (mid-session steering). */
  steered: boolean;
}

/**
 * Per-(branch, PR-number) agent SESSION spend for the dominant repo — the
 * numerator behind DIRECT cost-per-merged-PR. Each item is
 * one `(GitBranch, PrNumber)` group's summed `CostUsd`; a session belongs to
 * exactly one group, so summing a disjoint set of items never double-counts.
 * Like `AgentPrAttributionResponse`, NOT time-windowed (a PR accrues cost
 * from every session that touched it, including ones predating its merge) and
 * bare identifiers only — never actor identity.
 */
/**
 * Autonomy Ladder attribution: for every `(repo, branch, prNumber)` session
 * group, the LOWEST per-session autonomy level in the group — a PR inherits
 * the most-supervised session that touched it (steering anywhere in the
 * chain means the work wasn't delegated end-to-end).
 *
 * Levels (cut points fixed by the published methodology, computed from
 * ingest-stamped telemetry only):
 *   1 assisted    — interventions ≥ 3 or denials ≥ 3 (human is driving)
 *   2 supervised  — interventions 1–2 or denials 1–2 (nudged, not driven)
 *   3 delegated   — zero interventions, zero denials (hand-off ran clean;
 *                   APPROVED permission prompts do not demote)
 *   4 autonomous  — delegated AND machine-run (cloud/ci worker)
 * where interventions = max(UserTurnCount − 1, 0), denials =
 * RejectedToolCallCount.
 *
 * `minLevel = 0` means the group has NO classifiable session: interactive
 * sessions ingested before the steering columns existed are excluded rather
 * than guessed (a seat session always records the initial ask as a user
 * turn, so `seat ∧ UserTurnCount = 0` can only be a legacy row).
 */
export interface AgentAutonomyLadderAttributionResponse {
  items: AgentAutonomyLadderItem[];
}

export interface AgentAutonomyLadderItem {
  repo: string;
  branch: string;
  prNumber: number;
  /** 1–4, or 0 when no session in the group is classifiable. */
  minLevel: number;
  /** How many of the group's sessions were classifiable (the verdict's sample). */
  classifiedSessions: number;
}

export interface AgentPrCostAttributionResponse {
  /** `repo` qualifies each group; under `org` scope groups span every repo in
   * the tenant and matching must happen within `repo` (names collide). */
  items: { repo: string; branch: string; prNumber: number; costUsd: number }[];
}

// ============================================================================
// Traces Types
// ============================================================================

// ============================================================================
// Saved Filter Config Types
// ============================================================================

/**
 * V1 saved filter config — search-only. Still read because saved configs
 * persisted in this shape must keep loading.
 */
export interface SavedFilterConfigV1 {
  search?: string;
  searchField?: string;
}

/**
 * V2 saved filter config — supports all filter dimensions.
 */
export interface SavedFilterConfig {
  version: 2;
  filters?: AnalyticsFilter[];
  userId?: string;
  dateRange?: { preset?: string; start?: string; end?: string };
  sortBy?: { field: string; order: 'asc' | 'desc' };
}

/**
 * Type guard for v2 saved filter configs.
 */
export function isFilterConfigV2(
  config: SavedFilterConfigV1 | SavedFilterConfig | SavedViewConfig
): config is SavedFilterConfig {
  return 'version' in config && config.version === 2;
}

// ============================================================================
// Saved View Config Types (v3 — for Requests page saved views)
// ============================================================================

/**
 * Display mode for the requests page.
 */
export type RequestsDisplayMode = 'list' | 'aggregate';

/**
 * V3 saved view config — supports display mode, groupBy, and column visibility.
 * Used by the Requests page saved views system.
 */
export interface SavedViewConfig {
  version: 3;
  displayMode: RequestsDisplayMode;
  groupBy?: string;
  filters?: AnalyticsFilter[];
  dateRange?: { preset?: string; start?: string; end?: string };
  sortBy?: { field: string; order: 'asc' | 'desc' };
  columns?: Array<{ field: string; visible: boolean }>;
  /**
   * Env-scoped saved filter. An array of env
   * *name* strings (NOT ids — names are immutable and match the
   * trace-tag mechanism). Multi-select so "prod OR staging" round-trips.
   * The evaluator translates this to `Environment IN (...)`. A saved view
   * naming a deleted/renamed env keeps working — it matches historical
   * traces tagged with that name; the editor surfaces a non-blocking note
   * but never invalidates or auto-edits the field.
   */
  environments?: string[];
}

/**
 * Type guard for v3 saved view configs.
 */
export function isViewConfigV3(
  config: SavedFilterConfigV1 | SavedFilterConfig | SavedViewConfig
): config is SavedViewConfig {
  return 'version' in config && config.version === 3;
}

// ============================================================================
// Aggregate Requests Types
// ============================================================================

/**
 * A single row in the aggregate requests table.
 * Groups requests by a dimension (model, user_id, metadata key).
 */
export interface AggregateRequestsRow {
  dimensionValue: string;
  requests: number;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  successRate: number;
}

/**
 * Paginated response for aggregate requests.
 */
export interface AggregateRequestsResponse {
  items: AggregateRequestsRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Parameters for aggregate requests query.
 */
export interface AggregateRequestsParams extends PaginationParams {
  dimension: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: AnalyticsFilter[];
  startDate?: string;
  endDate?: string;
  /**
   * Env scoping. Aggregations must be computed over a single environment's
   * rows — an unscoped groupBy silently sums every env's traffic into one
   * table. Undefined means "no env filter" (legacy callers only).
   */
  env?: EnvironmentQueryScope;
}

/**
 * Environment scoping for analytics list queries. `name` is the env tag
 * stamped on `otel_traces.Environment` / `scores.Environment` by the gateway.
 * `isDefault` drives the legacy-row rule: rows with `Environment = ''`
 * (ingested before env tagging) are included ONLY
 * when scoping to the app's default env — for any non-default env those
 * legacy rows are excluded.
 */
export interface EnvironmentScope {
  name: string;
  isDefault: boolean;
}

/**
 * Combined env scope for analytics metric queries.
 * Composes the single-env {@link EnvironmentScope} with the multi-env
 * allow-list, mirroring the `environment` + `environments` field pair on
 * {@link TracesParams} / {@link ScoresParams}. Used by the dashboard widget
 * metric methods (`getMetrics`, `getModelStats`, `getRankingData`,
 * `getPercentiles`) so a built-in or custom widget can be scoped to one env
 * or — for cross-env comparison widgets — an env allow-list. Undefined on a
 * call means "no env filter".
 */
export interface EnvironmentQueryScope {
  /** Single-env scope (env-selector default / dashboard-view env). */
  environment?: EnvironmentScope;
  /** Multi-env allow-list — translates to `Environment IN (...)`. */
  environments?: string[];
}

/**
 * Parameters for listing traces.
 */
export interface TracesParams extends PaginationParams {
  model?: string;
  userId?: string;
  status?: 'OK' | 'ERROR';
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  name?: string;
  tags?: string[];
  commitSha?: string;
  /**
   * AND of leaves and one-level OR-groups (see {@link AnalyticsFilterNode}).
   * Plain `AnalyticsFilter[]` callers keep working unchanged.
   */
  filters?: AnalyticsFilterNode[];
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Single-env scoping. Undefined = no env filter. */
  environment?: EnvironmentScope;
  /**
   * Env-name allow-list from a saved filter's `environments` JSONB field.
   * When set, translates to `Environment IN (...)`. Takes
   * precedence over the single-env `environment` scope when both are present.
   */
  environments?: string[];
}

/**
 * Summary of a trace for list views.
 */
export interface TraceSummary {
  id: string;
  name: string;
  status: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  latencyMs: number;
  cost: number;
  tokens: number;
  spanCount: number;
  tags?: string[];
  /** Env tag. `''` marks legacy/no-pin rows. */
  environment?: string;
  /** Env version at ingest. `0` marks legacy/no-pin rows. */
  environmentVersion?: number;
  /**
   * Truncated preview of the trace's input — the root span's input, falling
   * back to the first GENERATION span (canonical `deriveTraceIO` semantics).
   * Absent/`null` when the trace has no input. This is a trace-level value:
   * one logical input per trace, NOT a per-span field.
   */
  inputPreview?: string | null;
  /**
   * Truncated preview of the trace's output — the root span's output, falling
   * back to the last GENERATION span. Absent/`null` when the trace has no
   * output.
   */
  outputPreview?: string | null;
}

/**
 * Paginated response for trace listing.
 */
export interface TracesResponse {
  traces: TraceSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Individual span within a trace.
 * Includes all available fields from ClickHouse for trace inspection.
 */
export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  status: string;
  statusMessage: string;
  durationMs: number;
  timestamp: string; // ISO datetime
  type: 'SPAN' | 'GENERATION' | 'EVENT';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  input: string;
  output: string;
  outputObject: string | null;
  toolCalls: string | null;
  finishReason: string | null;
  settings: string | null;
  reasoningTokens: number;
  metadata: Record<string, string>;
  props: string | null;
  spanKind: string;
  serviceName: string;
  /**
   * JSON array of pointers to oversized field payloads offloaded to object
   * storage: `[{field,blob_id,size}]`. Empty/absent when nothing was offloaded.
   * When present, the matching inline column (input/output/...) holds only a
   * preview; the full value is fetched from storage by blob_id.
   */
  blobRefs?: string;
}

/**
 * I/O payload for a single span, fetched on demand.
 */
export interface SpanIO {
  input: string;
  output: string;
  outputObject: string | null;
  toolCalls: string | null;
  /**
   * JSON array of pointers to oversized field payloads offloaded to object
   * storage: `[{field,blob_id,size}]`. When present, the inline columns hold
   * previews and the full values are fetched from storage by blob_id.
   */
  blobRefs?: string;
  /**
   * Custom per-span metadata (raw map; reserved namespaces stripped at the API
   * boundary). Optional on the internal type so existing producers/mocks need
   * not be updated wholesale; the wire shapes (SpanIOSchema / SpanIOWire) keep
   * it required and the gateway + CLI always populate it.
   */
  metadata?: Record<string, string>;
}

/**
 * Complete trace detail with all spans.
 * spanScores is a map from span ID -> scores for that span,
 * populated by a parallel batch query against the scores table.
 */
export interface TraceDetail {
  id: string;
  name: string;
  status: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  latencyMs: number;
  cost: number;
  tokens: number;
  input?: string;
  output?: string;
  spans: Span[];
  /** Eval scores keyed by span ID, batch-fetched in parallel with spans. */
  spanScores?: Record<string, Score[]>;
  /** True when the span scores query failed; scores will be empty in that case. */
  spanScoresError?: boolean;
  userId?: string;
  sessionId?: string;
}

// ============================================================================
// Percentiles Types
// ============================================================================

/**
 * Supported metrics for percentile calculations.
 *
 * Sourced from api-schemas's `PERCENTILE_METRICS` const tuple — exact
 * match for the literal union, so api-types re-exports the canonical
 * type to keep the two packages in lockstep.
 */
import type { PercentileMetric as _PercentileMetric } from '@repo/api-schemas';
export type PercentileMetric = _PercentileMetric;

/**
 * Parameters for percentiles query.
 */
export interface PercentilesParams {
  range: DateRangePreset;
  startDate?: string;
  endDate?: string;
  metric: PercentileMetric;
}

/**
 * Percentile data point for time series.
 */
export interface PercentilePoint {
  timestamp: string; // ISO datetime (hourly)
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * Response for percentiles query.
 */
export interface PercentilesResponse {
  metric: PercentileMetric;
  data: PercentilePoint[];
}

// ============================================================================
// Health Check Types
// ============================================================================

/**
 * Status of a dependency.
 */
export type DependencyStatus = 'up' | 'down';

/**
 * Health status of the analytics service.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Health check response.
 */
export interface HealthResponse {
  status: HealthStatus;
  timestamp: string; // ISO datetime
  dependencies: {
    clickhouse: {
      status: DependencyStatus;
      latencyMs?: number;
      error?: string;
    };
  };
}


// ============================================================================
// Score Tracking Types
// ============================================================================

import type { ScoreSourceType } from '@repo/api-schemas';

/**
 * Score `source` as returned on reads: the canonical write-side values
 * (`experiment | annotation | api`) plus two system values the write API
 * rejects — the legacy `eval` still stored on pre-rename rows, and `outcome`,
 * the system-computed PR-record scores (first-pass CI, merge fate, revert
 * durability).
 *
 * `source` records PROVENANCE — who emitted the score — and nothing else.
 * Whether a given score may be used as a correlation predictor is a separate
 * question answered per score NAME by `FATE_DERIVED_SCORE_NAMES` in the
 * outcome-scores writer, deliberately not by adding a source per exception.
 * Rejecting `outcome` at the write API is what keeps callers from spoofing
 * system outcomes.
 */
export type ScoreSource = ScoreSourceType | 'eval' | 'outcome';

/**
 * Score record from the scores table.
 * Scores can be attached to either traces or spans.
 */
export interface Score {
  id: string;
  resourceId: string;
  name: string;
  score: number;
  label: string;
  reason: string;
  source: ScoreSource;
  userId?: string;
  createdAt: string; // ISO datetime
}

/**
 * Parameters for querying scores.
 */
export interface ScoresParams extends Partial<PaginationParams> {
  resourceId?: string;
  resourceType?: 'trace' | 'span';
  name?: string;
  source?: ScoreSource;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  /**
   * Structured filters over scores-table fields (name, score, source,
   * user_id, resource_id, created_at) — AND of leaves and one-level
   * OR-groups. Ignored by resource-keyed lookups (`resourceId` set).
   */
  filters?: AnalyticsFilterNode[];
  /** Single-env scoping. Undefined = no env filter. */
  environment?: EnvironmentScope;
  /** Env-name allow-list from a saved filter. */
  environments?: string[];
}

/**
 * Paginated response for scores listing.
 */
export interface ScoresResponse {
  scores: Score[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Aggregated statistics for a score name.
 */
export interface ScoreAggregation {
  name: string;
  avgScore: number;
  count: number;
  minScore: number;
  maxScore: number;
  /**
   * Persisted score data type ("boolean" | "numeric" | "categorical"), or ""
   * when unknown (legacy rows written before DataType was stored). Drives
   * type-appropriate aggregation/display in the score analytics UI.
   */
  dataType?: string;
}

/**
 * Response for score aggregations query.
 */
export interface ScoreAggregationsResponse {
  aggregations: ScoreAggregation[];
}

/**
 * Response for distinct score names query.
 */
export interface ScoreNamesResponse {
  names: string[];
}

// ============================================================================
// Score Analytics Types
// ============================================================================

/**
 * Detected score type based on data analysis.
 * - 'numeric': scores with varying float values, no labels
 * - 'categorical': scores with non-empty string labels (not just true/false)
 * - 'boolean': scores with labels 'true' and/or 'false' only
 */
export type ScoreType = 'numeric' | 'categorical' | 'boolean';

/**
 * A single histogram bucket for numeric score distribution.
 */
export interface ScoreHistogramBucket {
  bucket: number;
  count: number;
}

/**
 * A single category count for categorical/boolean score distribution.
 */
export interface ScoreCategoryCount {
  label: string;
  count: number;
}

/**
 * Response for score histogram/distribution query.
 */
export interface ScoreHistogramResponse {
  name: string;
  type: ScoreType;
  buckets: ScoreHistogramBucket[];
  categories: ScoreCategoryCount[];
}

/**
 * A single data point in a score trend time series.
 */
export interface ScoreTrendPoint {
  timestamp: string;
  avgScore: number;
  count: number;
}

/**
 * Valid trend interval values.
 *
 * Sourced from api-schemas's `SCORE_TREND_INTERVALS` const tuple — exact
 * match for the literal union, so api-types re-exports the canonical
 * type to keep the two packages in lockstep.
 */
import type { ScoreTrendInterval as _ScoreTrendInterval } from '@repo/api-schemas';
export type ScoreTrendInterval = _ScoreTrendInterval;

/**
 * Response for score trend query.
 */
export interface ScoreTrendResponse {
  name: string;
  interval: ScoreTrendInterval;
  points: ScoreTrendPoint[];
}

/**
 * A cell in the confusion matrix for score comparison.
 */
export interface ScoreComparisonCell {
  labelA: string;
  labelB: string;
  count: number;
}

/**
 * Response for score comparison (confusion matrix) query.
 */
export interface ScoreComparisonResponse {
  nameA: string;
  nameB: string;
  type: ScoreType;
  matrix: ScoreComparisonCell[];
  totalMatched: number;
  totalA: number;
  totalB: number;
}

/**
 * A single point in the scatter plot (paired numeric scores).
 */
export interface ScoreScatterPoint {
  scoreA: number;
  scoreB: number;
}

/**
 * Response for numeric score scatter plot query.
 */
export interface ScoreScatterResponse {
  nameA: string;
  nameB: string;
  points: ScoreScatterPoint[];
  totalMatched: number;
  totalA: number;
  totalB: number;
}

// ============================================================================
// Analytics Filter Types (for dashboard filters)
// ============================================================================

/**
 * Filter for analytics queries from the dashboard.
 * Matches the format used by the filter context.
 */
export interface AnalyticsFilter {
  field: string;
  operator: string;
  value: string | string[];
}

/**
 * Disjunction of leaf predicates — matches rows satisfying ANY member.
 * One level deep by design: a filter list is an AND of leaves and OR-groups
 * (conjunctive normal form); members are always leaves, never nested groups.
 */
export interface AnalyticsFilterOrGroup {
  or: AnalyticsFilter[];
}

/**
 * One element of a filter list: a leaf predicate or an OR-group.
 * `AnalyticsFilter[]` stays assignable wherever `AnalyticsFilterNode[]` is
 * accepted, so existing AND-only callers are unaffected.
 */
export type AnalyticsFilterNode = AnalyticsFilter | AnalyticsFilterOrGroup;

/**
 * Type guard for OR-group nodes in a filter list.
 */
export function isAnalyticsFilterOrGroup(
  node: AnalyticsFilterNode
): node is AnalyticsFilterOrGroup {
  return typeof node === 'object' && node !== null && Array.isArray((node as AnalyticsFilterOrGroup).or);
}

/**
 * Supported filter fields for metrics queries.
 */
export type MetricsFilterField = 'model' | 'user_id' | 'status';

/**
 * Validated filter for metrics queries.
 * Ensures only supported fields are used.
 */
export interface ValidatedMetricsFilter {
  field: MetricsFilterField;
  operator: 'equals' | 'notEquals' | 'contains';
  value: string;
}

// ============================================================================
// Advanced Filtering Types
// ============================================================================

/**
 * String comparison operators for filtering.
 */
export type StringFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith';

/**
 * Number comparison operators for filtering.
 */
export type NumberFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte';

/**
 * Combined filter operator type.
 */
export type FilterOperator = StringFilterOperator | NumberFilterOperator;

/**
 * Filter condition for a string field.
 */
export interface StringFilter {
  operator: StringFilterOperator;
  value: string;
}

/**
 * Filter condition for a number field.
 */
export interface NumberFilter {
  operator: NumberFilterOperator;
  value: number;
}

/**
 * Extended trace parameters with advanced filtering support.
 */
export interface AdvancedTracesParams extends TracesParams {
  modelFilter?: StringFilter;
  userIdFilter?: StringFilter;
  latencyFilter?: NumberFilter;
  costFilter?: NumberFilter;
}

// ============================================================================
// Extended Metrics Summary
// ============================================================================

/**
 * Extended metrics summary with per-request averages.
 * Provides additional computed metrics for dashboard display.
 */
export interface ExtendedMetricsSummary extends MetricsSummary {
  avgCostPerRequest: number;
  avgInputTokensPerRequest: number;
  avgOutputTokensPerRequest: number;
  avgTotalTokensPerRequest: number;
  modelCount: number;
}

/**
 * Extended metrics response with per-request averages.
 */
export interface ExtendedMetricsResponse {
  summary: ExtendedMetricsSummary;
  timeSeries: TimeSeriesPoint[];
}


// ============================================================================
// Filter Column & Sort Types (for filter popover UI)
// ============================================================================

/**
 * Filter column definition for the filter popover UI.
 */
export interface FilterColumn {
  field: string;
  label: string;
  type: 'string' | 'number' | 'enum';
  operators: string[];
  enumValues?: string[];
}

/**
 * Sort configuration.
 */
export interface SortConfig {
  field: string;
  order: 'asc' | 'desc';
}

/**
 * Date range configuration for saved views.
 */
export interface DateRangeConfig {
  preset: 'today' | '7d' | '30d' | '90d' | 'custom';
  startDate?: string;
  endDate?: string;
}

// ============================================================================
// Trace Filter Config (v4 — for Traces and Sessions page saved views)
// ============================================================================

/**
 * V4 saved view config — supports traces and sessions pages.
 * Used by the Traces/Sessions page saved views system.
 */
export interface TraceFilterConfig {
  version: 4;
  filters?: AnalyticsFilter[];
  dateRange?: DateRangeConfig;
  sortBy?: SortConfig;
  search?: string;
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Analytics service interface.
 * Defines the contract for analytics data access.
 *
 * SECURITY: All methods require TenantContext to ensure both tenantId
 * and appId are provided, enforcing tenant isolation at compile time.
 */
export interface IAnalyticsService {
  // Health
  checkConnectivity(): Promise<boolean>;

  // Core metrics. `env` optionally scopes the query
  // to one env or — for cross-env comparison widgets — an env allow-list.
  getMetrics(ctx: TenantContext, dateRange: DateRange, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<MetricsResponse>;
  getExtendedMetrics(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ExtendedMetricsResponse>;
  getModelStats(ctx: TenantContext, dateRange: DateRange, limit?: number, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<ModelStatsResponse>;
  getTraces(ctx: TenantContext, params: TracesParams): Promise<TracesResponse>;
  getTraceDetail(ctx: TenantContext, traceId: string, env?: EnvironmentQueryScope): Promise<TraceDetail | null>;
  getTraceDetailLightweight(ctx: TenantContext, traceId: string, env?: EnvironmentQueryScope): Promise<TraceDetail | null>;
  getSpanIO(ctx: TenantContext, traceId: string, spanId: string, env?: EnvironmentQueryScope): Promise<SpanIO | null>;
  getPercentiles(ctx: TenantContext, params: PercentilesParams, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<PercentilesResponse>;

  // Score tracking
  getScores(ctx: TenantContext, params: ScoresParams): Promise<ScoresResponse>;
  getScoresBySpanIds(ctx: TenantContext, spanIds: string[]): Promise<Record<string, Score[]>>;
  getScoreAggregations(ctx: TenantContext, dateRange: DateRange, env?: EnvironmentQueryScope): Promise<ScoreAggregationsResponse>;
  getDistinctScoreNames(ctx: TenantContext, env?: EnvironmentQueryScope): Promise<ScoreNamesResponse>;
  detectScoreType(ctx: TenantContext, name: string): Promise<ScoreType>;
  getScoreHistogram(ctx: TenantContext, name: string, dateRange: DateRange, source?: string): Promise<ScoreHistogramResponse>;
  getScoreTrend(ctx: TenantContext, name: string, interval: ScoreTrendInterval, dateRange: DateRange, source?: string): Promise<ScoreTrendResponse>;
  getScoreComparison(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string): Promise<ScoreComparisonResponse>;
  getScoreScatter(ctx: TenantContext, nameA: string, nameB: string, dateRange: DateRange, source?: string): Promise<ScoreScatterResponse>;
  getDistinctMetadataKeys(ctx: TenantContext): Promise<string[]>;

  // Requests (individual LLM-call records, a.k.a. "generations")
  getRequests(ctx: TenantContext, params: RequestsParams): Promise<RequestsResponse>;

  // Dimension-grouped ranking data (for widget groupBy)
  getRankingData(ctx: TenantContext, dateRange: DateRange, dimension: string, limit?: number, filters?: AnalyticsFilter[], env?: EnvironmentQueryScope): Promise<RankingDataResponse>;

  // Aggregate requests (paginated ranking with sort)
  getAggregateRequests(ctx: TenantContext, params: AggregateRequestsParams): Promise<AggregateRequestsResponse>;

  // Span kind breakdown
  getSpanKindBreakdown(ctx: TenantContext, dateRange: { startDate: string; endDate: string }): Promise<SpanKindBreakdownRecord[]>;

  /**
   * Fleet-level agent-session rollup (sessions, tool-error-rate,
   * active-actor count, model mix) for the Agent Fleet Overview dashboard
   * template. Optional so existing implementers (e.g. the CLI's local
   * service) remain source-compatible; the cloud AnalyticsService
   * implements it.
   */
  getAgentFleetOverview?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetOverviewResponse>;

  /**
   * Cost + session count grouped by branch or agent type, for the Repo
   * Activity dashboard template. Optional for the same source-compatibility
   * reason as `getAgentFleetOverview`.
   */
  getAgentFleetDimensionBreakdown?(
    ctx: TenantContext,
    dateRange: DateRange,
    dimension: AgentFleetDimension,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentFleetDimensionResponse>;

  /**
   * Cost-per-session, session-duration, and turn-count percentiles as a
   * daily TREND (never a single blended snapshot — see
   * `AgentFleetPercentileTrendResponse`), for the Agent Execution Health
   * dashboard template. Optional for the same reason as `getAgentFleetOverview`.
   */
  getAgentFleetPercentileTrend?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetPercentileTrendResponse>;

  /**
   * Daily session counts split by worker kind (run-origin) — the
   * autonomy-mix trend on the Executive Overview. Optional for the same
   * reason as `getAgentFleetOverview`.
   */
  getAgentFleetAutonomyMixTrend?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetAutonomyMixTrendResponse>;

  /**
   * Daily active-actor count trend, for the Agent Fleet Overview template.
   * Optional for the same reason.
   */
  getAgentFleetActiveActorTrend?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetActiveActorTrendResponse>;

  /**
   * Daily trajectory-signal rates (tool-error rate, denial rate,
   * steered-session share) as one trend, for the Agent Operations template.
   * Optional for the same reason.
   */
  getAgentFleetTrajectorySignalTrend?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetTrajectorySignalTrendResponse>;

  /**
   * Branches whose latest-day spend is a statistical outlier vs. their own
   * trailing baseline, for the Repo Activity dashboard template. Optional
   * for the same reason.
   */
  getAgentFleetCostAnomalies?(ctx: TenantContext, dateRange: DateRange, options?: AgentFleetQueryOptions): Promise<AgentFleetCostAnomalyResponse>;

  /**
   * Session→PR attribution set (distinct session branches + pr-link PR
   * numbers) for the app's dominant repo — classifies `pull_request` rows as
   * agent-produced for the PR-lifecycle metrics. Optional for the
   * same reason as `getAgentFleetOverview`.
   */
  getAgentPrAttribution?(ctx: TenantContext, options?: AgentFleetQueryOptions): Promise<AgentPrAttributionResponse>;
  /**
   * Per-(branch, PR-number) agent session spend for the dominant repo — the
   * numerator for direct cost-per-merged-PR. Optional for the
   * same reason as `getAgentPrAttribution`.
   */
  getAgentPrCostAttribution?(ctx: TenantContext, options?: AgentFleetQueryOptions): Promise<AgentPrCostAttributionResponse>;
  /**
   * Per-(repo, branch, PR) minimum session autonomy level — the Autonomy
   * Ladder's session-side input (see AgentAutonomyLadderAttributionResponse).
   * Optional for the same reason as `getAgentPrAttribution`.
   */
  getAutonomyLadderAttribution?(
    ctx: TenantContext,
    options?: AgentFleetQueryOptions,
  ): Promise<AgentAutonomyLadderAttributionResponse>;
}

export interface SpanKindBreakdownRecord {
  kind: string;
  count: number;
  avgLatencyMs: number;
  totalCost: number;
  totalTokens: number;
}

// ============================================================================
// Requests Types
//
// A "request" is a single LLM-call record (a GENERATION-type trace with
// input/output) — what other observability tools call a "generation" or
// "run". Surfaced as `/v1/requests` on the local CLI dev server and
// `/api/analytics/requests` on the cloud dashboard.
// ============================================================================

/**
 * Parameters for listing requests.
 */
export interface RequestsParams extends PaginationParams {
  startDate?: string;
  endDate?: string;
  model?: string;
  userId?: string;
  status?: 'OK' | 'ERROR';
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: AnalyticsFilter[];
  /** Single-env scoping. Mirrors ScoresParams. Undefined = no env filter. */
  environment?: EnvironmentScope;
  /** Env-name allow-list from a saved filter. Mirrors ScoresParams. */
  environments?: string[];
}

/**
 * Request record (GENERATION-type trace with input/output).
 */
export interface RequestRecord {
  id: string;
  tenantId: string;
  appId: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  modelUsed: string;
  status: string;
  input: string;
  output: string | null;
  ts: string; // ISO datetime
  userId: string;
  traceId: string;
  statusMessage: string;
  props: string;
}

/**
 * Paginated response for requests listing.
 */
export interface RequestsResponse {
  requests: RequestRecord[];
  total: number;
  limit: number;
  offset: number;
}
