/**
 * SQL Query Strings — Agent Fleet dashboards (Agent Fleet Overview, Repo
 * Activity, Agent Execution Health).
 *
 * Reads `agent_session_summary` — a flat rollup written at ingest alongside
 * the span tree in `otel_traces` (migration 26), with GitRepo/GitBranch/
 * AgentType/ActorId/CostUsd/TurnCount/ToolCallCount/ErrorCount/Models/
 * StartedAt/EndedAt already aggregated, so no CTE over raw spans is needed.
 * This is a DIFFERENT table from `queries.ts`'s metrics queries, which scope
 * to `otel_traces` rows where `Type = 'GENERATION'` (one row = one LLM
 * completion call).
 *
 * GRAIN — read this before adding a per-session figure. One row is one TRACE,
 * NOT one session. A session spans several rows: a long run resumes across
 * traces, and each subagent it delegates to writes its own row under its own
 * `SessionId`. Locally that runs ~3 rows per session. So `count()` is a trace
 * count, and an average or percentile over raw rows silently answers
 * "per trace" while the widget label promises "per session" — with delegated
 * runs being many and individually cheap, that collapses a spend distribution
 * toward the cost of one delegated step. Group by {@link ROOT_SESSION_KEY}
 * first for anything denominated in sessions; see
 * `buildAgentFleetPercentileTrendQuery`. Fleet-wide TOTALS (sum of spend, tool
 * volume) are unaffected — a sum over every row is the same sum either way.
 *
 * Repo scoping: this table's ORDER BY leads with (TenantId, AppId, GitRepo),
 * and the established convention across the Agents API (see
 * `apps/tenant-dashboard/src/app/api/agents/sessions/route.ts`) is "app =
 * one repo" — scope every query to the app's dominant repo (by cost) unless
 * one is named. `buildAgentFleetDominantRepoQuery` mirrors that route's
 * inline resolution so both surfaces can't drift.
 *
 * No retention-cutoff filtering: `agent_session_summary` has no TTL by
 * design (migration 28) and no existing caller in this codebase applies one
 * — matched here rather than inventing a new convention for one table.
 *
 * Percentiles are TRENDS, never a single blended number for the whole date
 * range — a blended p95 hides exactly what percentiles exist to catch (a
 * spike buried in an otherwise-calm week reads identical to a flat line).
 * See `buildAgentFleetPercentileTrendQuery`.
 *
 * Privacy constraint (see project decision — dashboards must never rank or
 * aggregate individual developers, gated or not): every query here reads
 * `ActorId` ONLY to feed `uniqExact(ActorId)` — a bare COUNT of distinct
 * actors — never a per-actor breakdown, filter, or groupBy. There is no
 * query in this file, and there must never be one added to it, that SELECTs
 * or GROUPs BY an actor/developer identity.
 */

import type { AgentFleetDimension, AgentFleetScope } from './types';
import { STATUS_ERROR_VALUES_SQL } from './queries';

export interface AgentFleetQueryResult {
  query: string;
  params: Record<string, unknown>;
}

export interface AgentFleetRepoScope {
  appId: string;
  tenantId: string;
  /** Empty string means "resolve the dominant repo" — the caller already did. */
  repo: string;
  /** `app` (default) pins (AppId, GitRepo); `org` sweeps the whole tenant. */
  scope?: AgentFleetScope;
}

/**
 * The WHERE prefix every fleet query starts with. `app` scope pins the
 * table's ORDER BY prefix (TenantId, AppId, GitRepo) — the "app = one repo"
 * convention; `org` scope pins TenantId alone, sweeping every app and repo
 * in the tenant for org-level rollups. Still parameter-bound either way.
 */
function scopeWhere(input: AgentFleetRepoScope): string {
  return input.scope === 'org'
    ? `TenantId = {tenantId:String}`
    : `TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND GitRepo = {repo:String}`;
}

function scopeParams(input: AgentFleetRepoScope): Record<string, unknown> {
  return input.scope === 'org'
    ? { tenantId: input.tenantId }
    : { tenantId: input.tenantId, appId: input.appId, repo: input.repo };
}

/**
 * The population whose PROMPTING behavior is meaningful: sessions a human
 * drives. SDK-spawned and headless runs (`Origin = 'agent'`) and cloud
 * worker runs (`'worker'`) never stop at a permission prompt — they
 * auto-approve by construction — so counting them pegs the approval rate
 * and dilutes the steering rates, burying the interactive signal. Legacy
 * rows (`Origin = ''`, ingested before origin classification) count as
 * interactive — they are overwhelmingly human and heal on re-sync. Spend,
 * session-count, actor, and error metrics deliberately do NOT use this
 * predicate: they are cost/activity/quality truth and stay all-inclusive.
 */
const INTERACTIVE_ORIGINS = `('', 'interactive')`;
const INTERACTIVE_ORIGIN = `Origin IN ${INTERACTIVE_ORIGINS}`;

/**
 * The session a summary row belongs to. `agent_session_summary` is one row per
 * TRACE, and a session spans several: a long run resumes across traces, and
 * every subagent it delegates to writes its own row under its own `SessionId`.
 * Grouping by this expression is what turns those rows back into the session a
 * human would describe — a delegated run credits its parent, and a row with
 * neither a parent nor a session id stands alone.
 *
 * Exported because any surface reporting a per-session figure has to agree on
 * where a session's boundaries are; two definitions in two places is how the
 * same number comes out differently on two screens.
 */
export const ROOT_SESSION_KEY = `if(ParentSessionId != '', ParentSessionId, if(SessionId != '', SessionId, TraceId))`;

/**
 * Ordering key that makes `argMax` pick a session's ROOT row — the human-facing
 * transcript — over the subagent rows grouped with it, breaking ties on the
 * longest transcript. A tree whose root fell outside the queried range still
 * yields its busiest row rather than nothing.
 */
const ROOT_ROW_FIRST = `ParentSessionId = '', TurnCount`;

/**
 * Resolves the app's dominant repo (by total session cost) — the same query
 * `sessions/route.ts` runs inline. Returns at most one row; the caller falls
 * back to `''` when the app has no repo-tagged sessions yet.
 */
export function buildAgentFleetDominantRepoQuery(input: { appId: string; tenantId: string }): AgentFleetQueryResult {
  return {
    query: `SELECT GitRepo AS repo
FROM agent_session_summary FINAL
WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND GitRepo != ''
GROUP BY GitRepo
ORDER BY sum(CostUsd) DESC
LIMIT 1`,
    params: { appId: input.appId, tenantId: input.tenantId },
  };
}

export interface AgentFleetTilesQueryInput extends AgentFleetRepoScope {
  /** Start of the CURRENT period, inclusive (`YYYY-MM-DD`). */
  startDate: string;
  /** End of the CURRENT period, inclusive (`YYYY-MM-DD`). */
  endDate: string;
  /** Start of the PRIOR period, inclusive (`YYYY-MM-DD`) — see `computePriorPeriod`. */
  priorStart: string;
}

/**
 * Session tiles: sessions / tool-call inputs / clean-session count /
 * active-actor count, bucketed into `current` vs `prior` period in one scan.
 * `cleanSessions` (ErrorCount = 0) backs `cleanSessionRate` — a floor
 * ("didn't obviously fail"), not a success claim; there's no reliable
 * task-success signal available in this kind of data industry-wide.
 *
 * Two aggregate groups: the all-inclusive block (sessions/actors/tool
 * volume/errors/cost — activity and quality truth for the WHOLE fleet), then
 * the `interactive*` block backing the behavior rates (auto-approve, denial,
 * hands-on). The behavior numerators AND their denominators both scope to
 * `INTERACTIVE_ORIGIN` so each rate is a rate OVER the population that can
 * actually exhibit the behavior — a headless run that can't prompt must not
 * count as an "auto-approved" session.
 */
export function buildAgentFleetTilesQuery(input: AgentFleetTilesQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  multiIf(toDate(StartedAt) >= {startDate:Date}, 'current', 'prior') AS period,
  count() AS sessions,
  uniqExact(ActorId) AS actors,
  sum(ToolCallCount) AS toolCalls,
  sum(ErrorCount) AS toolErrors,
  countIf(ErrorCount = 0) AS cleanSessions,
  sum(CostUsd) AS costUsd,
  countIf(${INTERACTIVE_ORIGIN}) AS interactiveSessions,
  sumIf(ToolCallCount, ${INTERACTIVE_ORIGIN}) AS interactiveToolCalls,
  sumIf(RejectedToolCallCount, ${INTERACTIVE_ORIGIN}) AS interactiveRejectedToolCalls,
  countIf(PermissionPromptCount = 0 AND ${INTERACTIVE_ORIGIN}) AS interactiveAutoApprovedSessions,
  countIf(UserTurnCount > 1 AND ${INTERACTIVE_ORIGIN}) AS interactiveSteeredSessions
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND toDate(StartedAt) >= {priorStart:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY period`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
      priorStart: input.priorStart,
    },
  };
}

export interface AgentFleetModelMixQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
  limit: number;
}

/**
 * Sessions per model. `Models` is an `Array(String)` per session (a session
 * can use more than one model across its turns), so `ARRAY JOIN` fans each
 * session out to one row per model it used before grouping.
 */
export function buildAgentFleetModelMixQuery(input: AgentFleetModelMixQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  model,
  uniqExact(TraceId) AS sessions
FROM agent_session_summary FINAL
ARRAY JOIN Models AS model
WHERE ${scopeWhere(input)}
  AND model != ''
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY model
ORDER BY sessions DESC
LIMIT {limit:UInt32}`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
    },
  };
}

const DIMENSION_COLUMNS: ReadonlyMap<AgentFleetDimension, string> = new Map<
  AgentFleetDimension,
  string
>([
  ['branch', 'GitBranch'],
  ['agent_type', 'AgentType'],
  // Run-origin (seat | cloud | ci | shared, stamped at ingest) — a
  // work-shaped dimension like the other two, never an identity: it says
  // WHERE a session ran, not WHO ran it.
  ['worker_kind', 'WorkerKind'],
]);

export interface AgentFleetDimensionQueryInput extends AgentFleetRepoScope {
  dimension: AgentFleetDimension;
  startDate: string;
  endDate: string;
  limit: number;
}

/**
 * Cost + session count + tool-error-rate grouped by an impersonal dimension
 * (branch or agent type — never an identity dimension; see the file
 * header). The error rate rides alongside cost/sessions in the SAME row
 * deliberately: a spend ranking should never be shown without a quality
 * signal for the same row — a branch burning unusual cost AND showing an
 * elevated error rate is a different story than one just burning cost.
 *
 * `toolErrorRate` is errors ÷ tool calls — the SAME definition the overview
 * tiles use (`buildAgentFleetTilesQuery`: sum(ErrorCount) /
 * sum(ToolCallCount)) — one label, one definition, so a branch view and the
 * tile never show conflicting numbers under the same label. Zero tool
 * calls → 0, matching the tiles' divide-by-zero rule.
 *
 * `dimension` selects the grouping column from the fixed `DIMENSION_COLUMNS`
 * map, never from caller-supplied SQL text, so there's no injection surface
 * despite the column name being interpolated (ClickHouse doesn't
 * parameter-bind column names). A dimension the map doesn't hold throws
 * instead of building a query.
 */
export function buildAgentFleetDimensionQuery(input: AgentFleetDimensionQueryInput): AgentFleetQueryResult {
  // Throw rather than interpolate `undefined`: the column is spliced into
  // GROUP BY and a WHERE, so an unknown dimension must not produce a query at
  // all. The type says this is unreachable; the check makes it so at runtime.
  const column = DIMENSION_COLUMNS.get(input.dimension);
  if (!column) {
    throw new Error(`buildAgentFleetDimensionQuery: unknown dimension "${input.dimension}"`);
  }
  // Org scope sweeps every repo, and branch names collide across repos
  // (`main` is `main` everywhere) — qualify branch labels with their repo so
  // rankings don't silently merge unrelated branches. Rows with no repo tag
  // are excluded from the qualified ranking: an unattributable branch would
  // render as a bare ':branch' merging every untagged repo's activity.
  // agent_type / worker_kind are global taxonomies and need no qualification.
  const qualifyBranch = input.scope === 'org' && input.dimension === 'branch';
  const labelExpr = qualifyBranch ? `concat(GitRepo, ':', ${column})` : column;
  const repoGuard = qualifyBranch ? `\n  AND GitRepo != ''` : '';
  return {
    query: `SELECT
  ${labelExpr} AS dimensionValue,
  count() AS sessions,
  sum(CostUsd) AS costUsd,
  if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND ${column} != ''${repoGuard}
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY dimensionValue
ORDER BY costUsd DESC
LIMIT {limit:UInt32}`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
    },
  };
}

export interface AgentFleetModelBreakdownQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
  limit: number;
}

/**
 * Cost + session count + tool-error-rate per model — the `model` arm of the
 * unified metrics breakdown, same row shape as `buildAgentFleetDimensionQuery`
 * but `ARRAY JOIN`ed like `buildAgentFleetModelMixQuery` (`Models` is
 * `Array(String)` per session). A session that used more than one model
 * counts its FULL cost and tool-error totals against each model it touched,
 * the same over-counting-by-design tradeoff `buildAgentFleetModelMixQuery`
 * already makes for `sessions` — a per-model ranking, not a partition of
 * total spend.
 */
export function buildAgentFleetModelBreakdownQuery(input: AgentFleetModelBreakdownQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  model AS dimensionValue,
  uniqExact(TraceId) AS sessions,
  sum(CostUsd) AS costUsd,
  if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate
FROM agent_session_summary FINAL
ARRAY JOIN Models AS model
WHERE ${scopeWhere(input)}
  AND model != ''
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY dimensionValue
ORDER BY costUsd DESC
LIMIT {limit:UInt32}`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
    },
  };
}

export interface AgentFleetToolBreakdownQueryInput {
  appId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  limit: number;
}

/**
 * Calls + errors + error rate per tool, from `otel_traces` (NOT
 * `agent_session_summary` — a tool call has no row in the session rollup of
 * its own). Scoped to `TenantId` + `AppId` only, unlike every other builder
 * in this file: tool spans aren't necessarily repo-tagged the way a session
 * root is, so this deliberately does not apply the "app = dominant repo"
 * convention `scopeWhere` encodes for the other queries.
 *
 * Tool spans are named `agent.tool.<name>` (see `agent-sessions.ts`'s
 * `errorCount`/`toolCallCount` fields, which read the same prefix);
 * `substringUTF8` strips the fixed-length prefix rather than a
 * runtime-computed offset, so the split can't drift from the LIKE filter
 * above it. Error rate uses the canonical `STATUS_ERROR_VALUES_SQL` set
 * (numeric `'2'` plus the legacy string variants), the broader definition
 * `queries.ts` uses fleet-wide — not the narrower raw `StatusCode = '2'`
 * check `agent-sessions.ts` applies to one already-normalized session's spans.
 */
export function buildAgentFleetToolBreakdownQuery(input: AgentFleetToolBreakdownQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  substringUTF8(SpanName, 12) AS dimensionValue,
  count() AS requests,
  countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) AS errors
FROM otel_traces FINAL
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND SpanName LIKE 'agent.tool.%'
  AND toDate(Timestamp) >= {startDate:Date}
  AND toDate(Timestamp) <= {endDate:Date}
GROUP BY dimensionValue
ORDER BY requests DESC
LIMIT {limit:UInt32}`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.limit,
    },
  };
}

export interface AgentFleetDailyTrendQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
}

/**
 * Daily sessions + spend + tool-error rate + clean-session rate — one
 * population (`agent_session_summary`, the all-inclusive block
 * `buildAgentFleetTilesQuery` also reads), bucketed per day instead of into
 * a current/prior pair. Backs `GET /v1/metrics/trends`'s cost-per-day
 * series: deliberately NOT `queries.ts`'s `otel_traces` GENERATION-row cost
 * trend, which is a different population that this file's header says does
 * not reconcile with session-grain figures under the same label.
 */
export function buildAgentFleetDailyTrendQuery(input: AgentFleetDailyTrendQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  toDate(StartedAt) AS date,
  count() AS sessions,
  sum(CostUsd) AS costUsd,
  if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate,
  if(count() > 0, countIf(ErrorCount = 0) / count(), 0) AS cleanSessionRate
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY date
ORDER BY date ASC`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
    },
  };
}

export interface AgentFleetPercentileTrendQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
}

/**
 * Session-grain percentiles as a DAILY TREND — cost per session (p50/p95),
 * session duration in ms (p50/p95/p99), and turn count (p95) — one row per
 * day, never collapsed to a single number for the whole range. See the file
 * header for why: percentile widgets default to time-series across
 * observability tooling for this exact reason.
 *
 * The inner GROUP BY is what makes these SESSION-grain: `agent_session_summary`
 * holds one row per TRACE, and a session that delegates writes an extra row per
 * subagent. Taking percentiles over raw rows would enter each subagent as its
 * own "session" — and since delegated runs are many and individually cheap,
 * they dominate the population and collapse the distribution toward the cost of
 * a single delegated step. Rolling up to the root session first restores the
 * unit the widget claims to plot: spend SUMS across the tree, the span runs
 * from the first start to the last end, and turn count comes from the root
 * transcript (a subagent's turns are programmatic, not conversation).
 *
 * A session lands wholly on the day it STARTED, so a long session is one point
 * rather than a smear across days; the range bounds still clip traces, exactly
 * as a per-day trend requires.
 *
 * `interventionsMean` rides the same daily scan: the mean of
 * `max(UserTurnCount − 1, 0)` — human turns beyond the initial prompt — per
 * INTERACTIVE session that day (`INTERACTIVE_ORIGIN`): a headless run's
 * extra "user" turns are programmatic, and a flood of single-prompt agent
 * runs would crush the mean toward zero while actual steering load moves.
 * A mean, not a percentile, because most sessions have zero interventions
 * and a p50 of the distribution would sit at 0 while the steering load
 * actually moves. `ifNotFinite` covers a day with only agent-run sessions
 * (avgIf over zero rows is NaN): reported as zero steering load, keeping
 * the point on the chart instead of a hole.
 */
export function buildAgentFleetPercentileTrendQuery(input: AgentFleetPercentileTrendQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  date,
  quantile(0.5)(sessionCostUsd) AS costP50,
  quantile(0.95)(sessionCostUsd) AS costP95,
  quantile(0.5)(sessionDurationMs) AS durationP50,
  quantile(0.95)(sessionDurationMs) AS durationP95,
  quantile(0.99)(sessionDurationMs) AS durationP99,
  quantile(0.95)(rootTurnCount) AS turnCountP95,
  ifNotFinite(avgIf(greatest(rootUserTurnCount - 1, 0), rootOrigin IN ${INTERACTIVE_ORIGINS}), 0) AS interventionsMean
FROM (
  SELECT
    toDate(min(StartedAt)) AS date,
    sum(CostUsd) AS sessionCostUsd,
    dateDiff('millisecond', min(StartedAt), max(EndedAt)) AS sessionDurationMs,
    argMax(TurnCount, (${ROOT_ROW_FIRST})) AS rootTurnCount,
    argMax(UserTurnCount, (${ROOT_ROW_FIRST})) AS rootUserTurnCount,
    argMax(Origin, (${ROOT_ROW_FIRST})) AS rootOrigin
  FROM agent_session_summary FINAL
  WHERE ${scopeWhere(input)}
    AND toDate(StartedAt) >= {startDate:Date}
    AND toDate(StartedAt) <= {endDate:Date}
  GROUP BY ${ROOT_SESSION_KEY}
)
GROUP BY date
ORDER BY date`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
    },
  };
}

export interface AgentFleetAutonomyMixTrendQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
}

/**
 * Daily session counts split by `WorkerKind` (run-origin: seat | cloud | ci |
 * shared) — the autonomy-mix trend behind "are we becoming more agentic".
 * WorkerKind is a bounded ingest-stamped enum, so the series count is capped
 * by construction. Legacy rows with `WorkerKind = ''` (pre-labeling ingests)
 * are excluded, matching the dimension query's `!= ''` rule — an unlabeled
 * session is unknown-origin, and guessing would fabricate an autonomy signal.
 */
export function buildAgentFleetAutonomyMixTrendQuery(input: AgentFleetAutonomyMixTrendQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  toDate(StartedAt) AS date,
  WorkerKind AS workerKind,
  count() AS sessions
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND WorkerKind != ''
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY date, workerKind
ORDER BY date, workerKind`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
    },
  };
}

export interface AgentFleetTrajectorySignalTrendQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
}

/**
 * Daily trajectory-signal rates — HOW sessions ran, as one trend:
 *
 *  - `toolErrorRate`: failed tool calls ÷ all tool calls, every origin.
 *    Tool failures are quality truth for the whole fleet, same stance as
 *    the tiles query.
 *  - `denialRate`: human-denied tool calls ÷ tool calls, `INTERACTIVE_ORIGIN`
 *    numerator AND denominator — a headless run never sees a prompt, so
 *    counting its calls would dilute the rate toward zero.
 *  - `handsOnShare`: sessions with any human follow-up (UserTurnCount > 1)
 *    ÷ interactive sessions. The binary companion to the percentile trend's
 *    `interventionsMean` (how many sessions were touched vs. how often).
 *
 * Row-grain is fine here (no ROOT_SESSION_KEY rollup): the tool-call rates
 * are ratios of SUMS, identical either way, and handsOnShare over rows only
 * differs for interactive sessions that resume across traces — a share of
 * transcripts that saw a human follow-up is the honest reading of what we
 * count.
 * Sparse days simply have no row; the widget route zero-fills nothing —
 * a day with no sessions has no rate, not a zero.
 */
export function buildAgentFleetTrajectorySignalTrendQuery(
  input: AgentFleetTrajectorySignalTrendQueryInput,
): AgentFleetQueryResult {
  return {
    query: `SELECT
  toDate(StartedAt) AS date,
  if(sum(ToolCallCount) > 0, sum(ErrorCount) / sum(ToolCallCount), 0) AS toolErrorRate,
  if(sumIf(ToolCallCount, ${INTERACTIVE_ORIGIN}) > 0,
     sumIf(RejectedToolCallCount, ${INTERACTIVE_ORIGIN}) / sumIf(ToolCallCount, ${INTERACTIVE_ORIGIN}), 0) AS denialRate,
  if(countIf(${INTERACTIVE_ORIGIN}) > 0,
     countIf(UserTurnCount > 1 AND ${INTERACTIVE_ORIGIN}) / countIf(${INTERACTIVE_ORIGIN}), 0) AS handsOnShare
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY date
ORDER BY date`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
    },
  };
}

export interface AgentFleetActiveActorTrendQueryInput extends AgentFleetRepoScope {
  startDate: string;
  endDate: string;
}

/**
 * Daily distinct-actor COUNT — an adoption trend, never a list of who.
 * Deliberately not a %-of-org-seats adoption RATE: that denominator (total
 * developer seats) lives in Postgres org membership, not ClickHouse: this
 * is a count trend, labeled as such wherever it's rendered.
 */
export function buildAgentFleetActiveActorTrendQuery(input: AgentFleetActiveActorTrendQueryInput): AgentFleetQueryResult {
  return {
    query: `SELECT
  toDate(StartedAt) AS date,
  uniqExact(ActorId) AS activeActors
FROM agent_session_summary FINAL
WHERE ${scopeWhere(input)}
  AND toDate(StartedAt) >= {startDate:Date}
  AND toDate(StartedAt) <= {endDate:Date}
GROUP BY date
ORDER BY date`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      endDate: input.endDate,
    },
  };
}

export interface AgentFleetCostAnomalyQueryInput extends AgentFleetRepoScope {
  /** Start of the BASELINE window, inclusive. Everything up to (not including) `latestDate` feeds the mean/stddev. */
  startDate: string;
  /** The single most recent day, compared against the baseline. */
  latestDate: string;
  /** Minimum dollar floor before a delta is flagged — avoids noise on trivial branches. */
  minDeltaUsd: number;
  limit: number;
}

/**
 * Branches whose latest-day cost is a statistical outlier vs. their own
 * trailing baseline — `recentCost > baselineMean + 2*stddev`, plus a dollar
 * floor so a $2 branch spiking to $6 doesn't rank above a $500/day branch's
 * real anomaly. SQL-only (window aggregates, no ML) — mirrors the pattern
 * Vantage's cost-anomaly-alerts and AWS Cost Anomaly Detection's own
 * documented heuristic both use (trailing mean + threshold), the simplest
 * version that's still real. `stddevPop` (population, not sample) is
 * intentional: the baseline IS the full population of days being compared
 * against, not a sample estimating a larger population.
 */
export function buildAgentFleetCostAnomalyQuery(input: AgentFleetCostAnomalyQueryInput): AgentFleetQueryResult {
  // Org scope: repo-qualify branch labels (see buildAgentFleetDimensionQuery)
  // so `main` in two repos keeps two separate baselines instead of blending.
  const branchExpr = input.scope === 'org' ? `concat(GitRepo, ':', GitBranch)` : 'GitBranch';
  const repoGuard = input.scope === 'org' ? `\n    AND GitRepo != ''` : '';
  return {
    query: `WITH daily AS (
  SELECT
    ${branchExpr} AS branch,
    toDate(StartedAt) AS date,
    sum(CostUsd) AS dailyCost
  FROM agent_session_summary FINAL
  WHERE ${scopeWhere(input)}
    AND GitBranch != ''${repoGuard}
    AND toDate(StartedAt) >= {startDate:Date}
    AND toDate(StartedAt) <= {latestDate:Date}
  GROUP BY branch, date
),
stats AS (
  SELECT
    branch,
    avgIf(dailyCost, date < {latestDate:Date}) AS baselineMean,
    stddevPopIf(dailyCost, date < {latestDate:Date}) AS baselineStddev,
    sumIf(dailyCost, date = {latestDate:Date}) AS recentCost,
    countIf(date < {latestDate:Date}) AS baselineDays
FROM daily
  GROUP BY branch
)
SELECT
  branch AS dimensionValue,
  recentCost AS recentCostUsd,
  baselineMean AS baselineMeanUsd,
  recentCost - baselineMean AS deltaUsd
FROM stats
WHERE baselineDays >= 3
  AND baselineStddev > 0
  AND recentCost > baselineMean + (2 * baselineStddev)
  AND (recentCost - baselineMean) >= {minDeltaUsd:Float64}
ORDER BY deltaUsd DESC
LIMIT {limit:UInt32}`,
    params: {
      ...scopeParams(input),
      startDate: input.startDate,
      latestDate: input.latestDate,
      minDeltaUsd: input.minDeltaUsd,
      limit: input.limit,
    },
  };
}

/**
 * A session's complete linked-PR set: the union of the `PrNumbers` array
 * (every `pr-link`) and the scalar `PrNumber` — rows written before the
 * array column existed carry only the scalar, and the union keeps them
 * attributing without a backfill.
 */
const SESSION_PRS_EXPR =
  'arrayDistinct(arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers))';

/**
 * The session→PR attribution set: every distinct branch a session ran on and
 * every PR number a session explicitly linked (`pr-link` outcome), for the
 * dominant repo (`app` scope) or the whole tenant (`org` scope). A session
 * can link MANY PRs (stacked PRs, long seat sessions) — `LEFT ARRAY JOIN`
 * expands one session row into one row per linked PR, and a session with no
 * links keeps one row with `prNumber = 0` (branch-only attribution, the
 * LEFT-join default). Backs the PR-lifecycle metrics: a `pull_request` row
 * is agent-attributed when its number or head branch appears here. `GitRepo`
 * rides every row so org-scope consumers can match within a repo — branch
 * names and PR numbers collide across repos (under `app` scope it's the one
 * pinned repo on every row). Deliberately NOT date-filtered — the session
 * that produced a PR can long predate the window its merge lands in. LIMIT
 * is a runaway bound, not pagination: distinct branches per repo are
 * naturally small.
 */
export function buildAgentPrAttributionQuery(input: AgentFleetRepoScope): AgentFleetQueryResult {
  return {
    query: `WITH ${SESSION_PRS_EXPR} AS sessionPrs
SELECT
  GitRepo AS repo,
  GitBranch AS branch,
  pn AS prNumber,
  max(UserTurnCount) AS maxUserTurns
FROM agent_session_summary FINAL
LEFT ARRAY JOIN sessionPrs AS pn
WHERE ${scopeWhere(input)}
  AND (GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))
GROUP BY GitRepo, GitBranch, pn
LIMIT 10000`,
    params: scopeParams(input),
  };
}

/**
 * Like `buildAgentPrAttributionQuery` but carries each `(branch, prNumber)`
 * group's summed session cost — the numerator for DIRECT cost-per-merged-PR.
 * Same repo scope, same deliberate absence of a date filter
 * (a PR's cost includes sessions that predate the window its merge lands in),
 * same runaway `LIMIT`. A multi-PR session's cost is SPLIT EVENLY across its
 * linked PRs (`CostUsd / length(sessionPrs)`), so summing any subset of rows
 * never counts a dollar twice and summing a session's every row recovers
 * exactly its cost.
 */
export function buildAgentPrCostAttributionQuery(input: AgentFleetRepoScope): AgentFleetQueryResult {
  return {
    query: `WITH ${SESSION_PRS_EXPR} AS sessionPrs
SELECT
  GitRepo AS repo,
  GitBranch AS branch,
  pn AS prNumber,
  sum(CostUsd / greatest(1, length(sessionPrs))) AS costUsd
FROM agent_session_summary FINAL
LEFT ARRAY JOIN sessionPrs AS pn
WHERE ${scopeWhere(input)}
  AND (GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))
GROUP BY GitRepo, GitBranch, pn
LIMIT 10000`,
    params: scopeParams(input),
  };
}

/**
 * Autonomy Ladder attribution: the LOWEST per-session autonomy level per
 * `(GitRepo, GitBranch, prNumber)` group — a PR inherits its most-supervised
 * session, and a multi-PR session confers its level on EVERY PR it linked
 * (same `LEFT ARRAY JOIN` expansion as the other attribution queries).
 * Level per session (the published cut points), evaluated top-down:
 *
 *   4 autonomous  — FIRST, `Origin = 'agent'` (SDK-spawned / headless runs):
 *                   machine-run by construction. Classified before the
 *                   steering arms because these runs' extra "user" turns and
 *                   tool denials are programmatic (multi-turn SDK loops,
 *                   auto-deny permission rules), not human steering —
 *                   autonomy must not be inferred from behavior the run
 *                   can't exhibit.
 *   0 unknown     — WorkerKind unlabeled on a non-worker-origin row, or an
 *                   interactive session with UserTurnCount = 0: a seat
 *                   session always records the initial ask as a user turn,
 *                   so that combination can only be a row ingested before
 *                   the steering columns existed — excluded rather than
 *                   guessed. Worker-origin rows never land here: their
 *                   columns postdate origin stamping and are trustworthy.
 *   1 assisted    — interventions ≥ 3 or denials ≥ 3 (human is driving)
 *   2 supervised  — interventions or denials in 1–2 (nudged, not driven)
 *   4 autonomous  — zero steering AND machine-run (cloud/ci WorkerKind, or
 *                   `Origin = 'worker'`). Unlike agent-origin runs, a worker
 *                   CAN receive human follow-up prompts, so the steering
 *                   arms above still demote a steered worker run.
 *   3 delegated   — zero steering, human-initiated. Approved permission
 *                   prompts deliberately do NOT demote: demoting on prompts
 *                   would make delegation unreachable for orgs with safe
 *                   default permission configs — an incentive against
 *                   guardrails.
 *
 * where interventions = greatest(UserTurnCount − 1, 0) and denials =
 * RejectedToolCallCount. `minIf(level, level > 0)` returns 0 when a group
 * has no classifiable session at all. Same scope/no-date-filter/LIMIT
 * posture as the other attribution queries. Aggregates only — no ActorId.
 */
export function buildAutonomyLadderAttributionQuery(input: AgentFleetRepoScope): AgentFleetQueryResult {
  return {
    query: `SELECT
  GitRepo AS repo,
  GitBranch AS branch,
  pn AS prNumber,
  minIf(level, level > 0) AS minLevel,
  countIf(level > 0) AS classifiedSessions
FROM (
  SELECT
    GitRepo,
    GitBranch,
    pn,
    multiIf(
      Origin = 'agent', 4,
      Origin != 'worker' AND (WorkerKind = '' OR (WorkerKind NOT IN ('cloud', 'ci') AND UserTurnCount = 0)), 0,
      greatest(UserTurnCount - 1, 0) >= 3 OR RejectedToolCallCount >= 3, 1,
      greatest(UserTurnCount - 1, 0) >= 1 OR RejectedToolCallCount >= 1, 2,
      WorkerKind IN ('cloud', 'ci') OR Origin = 'worker', 4,
      3
    ) AS level
  FROM agent_session_summary FINAL
  LEFT ARRAY JOIN ${SESSION_PRS_EXPR} AS pn
  WHERE ${scopeWhere(input)}
    AND (GitBranch != '' OR PrNumber > 0 OR notEmpty(PrNumbers))
)
GROUP BY GitRepo, GitBranch, pn
LIMIT 10000`,
    params: scopeParams(input),
  };
}

/**
 * The prior period is the immediately preceding window of equal length to
 * `[startDate, endDate]` — e.g. requesting the last 7 days compares against
 * the 7 days before that. Pure date-string arithmetic (UTC, whole days) so
 * it's cheap to unit test without a ClickHouse round-trip.
 */
export function computePriorPeriod(startDate: string, endDate: string): { priorStart: string } {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periodMs = Math.max(end.getTime() - start.getTime(), 0);
  const priorEnd = new Date(start.getTime() - DAY_MS);
  const priorStart = new Date(priorEnd.getTime() - periodMs);
  return { priorStart: priorStart.toISOString().split('T')[0]! };
}
