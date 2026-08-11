/**
 * Context-overview queries — the Overview view's aggregate reads. Same read
 * posture as the adoption queries: every skill read hits the
 * `skill_activation_by_day` / `skill_activation_sessions` rollups and every
 * MCP read hits `mcp_tool_use`, never raw `otel_traces` — these back an
 * interactive page.
 *
 * Window semantics: `rangeDays` is the user-selected window, and each query
 * also returns the equal-length PRIOR window (`[2·range, range)` days ago)
 * for the period-over-period deltas. `recentDays`/`lookbackDays` are the
 * fixed adoption thresholds (active/quiet/never) — the status verdict must
 * not change when the user flips the range selector, so those windows ride
 * alongside the range-scoped counts. The WHERE scan window is
 * `max(lookbackDays, 2·rangeDays)` so both the prior period and the full
 * lookback are inside it.
 *
 * No actor identity anywhere: everything aggregates at skill/server/session
 * grain only.
 */

export interface ContextOverviewQueryInput {
  tenantId: string;
  appId: string;
  /** The user-selected window the headline counts use. */
  rangeDays: number;
  /** Recent-activity threshold separating "active" from "quiet". */
  recentDays: number;
  /** Total adoption horizon past which an artifact counts as never used. */
  lookbackDays: number;
}

export interface ContextOverviewQueryResult {
  query: string;
  params: Record<string, unknown>;
}

/** The WHERE scan window: wide enough for both the prior period and the lookback. */
function scanDays(input: ContextOverviewQueryInput): number {
  return Math.max(input.lookbackDays, 2 * input.rangeDays);
}

function windowParams(input: ContextOverviewQueryInput): Record<string, unknown> {
  return {
    tenantId: input.tenantId,
    appId: input.appId,
    rangeDays: input.rangeDays,
    priorDays: 2 * input.rangeDays,
    recentDays: input.recentDays,
    lookbackDays: input.lookbackDays,
    scanDays: scanDays(input),
  };
}

export interface SkillOverviewRow {
  skill: string;
  rangeActivations: number;
  rangeSessions: number;
  priorActivations: number;
  recentActivations: number;
  lookbackActivations: number;
  lookbackSessions: number;
  lastActivatedAt: string;
}

export function buildSkillOverviewQuery(
  input: ContextOverviewQueryInput,
): ContextOverviewQueryResult {
  return {
    query: `SELECT
  Skill AS skill,
  uniqExactMergeIf(Activations, Day >= today() - {rangeDays:UInt32}) AS rangeActivations,
  uniqExactMergeIf(Sessions, Day >= today() - {rangeDays:UInt32}) AS rangeSessions,
  uniqExactMergeIf(Activations, Day >= today() - {priorDays:UInt32} AND Day < today() - {rangeDays:UInt32}) AS priorActivations,
  uniqExactMergeIf(Activations, Day >= today() - {recentDays:UInt32}) AS recentActivations,
  uniqExactMergeIf(Activations, Day >= today() - {lookbackDays:UInt32}) AS lookbackActivations,
  uniqExactMergeIf(Sessions, Day >= today() - {lookbackDays:UInt32}) AS lookbackSessions,
  if(maxIf(LastActivatedAt, Day >= today() - {lookbackDays:UInt32}) = 0, '', toString(toDateTime(maxIf(LastActivatedAt, Day >= today() - {lookbackDays:UInt32})))) AS lastActivatedAt
FROM skill_activation_by_day
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Day >= today() - {scanDays:UInt32}
GROUP BY Skill
ORDER BY rangeActivations DESC, lookbackActivations DESC
LIMIT 500`,
    params: windowParams(input),
  };
}

export interface McpOverviewRow {
  server: string;
  rangeCalls: number;
  rangeSessions: number;
  priorCalls: number;
  recentCalls: number;
  lookbackCalls: number;
  lookbackSessions: number;
  /** Distinct tools CALLED in the lookback — mcp.json doesn't carry definitions. */
  lookbackTools: number;
  lastUsedAt: string;
}

export function buildMcpOverviewQuery(
  input: ContextOverviewQueryInput,
): ContextOverviewQueryResult {
  return {
    query: `SELECT
  Server AS server,
  uniqExactMergeIf(Calls, Day >= today() - {rangeDays:UInt32}) AS rangeCalls,
  uniqExactIf(TraceId, Day >= today() - {rangeDays:UInt32}) AS rangeSessions,
  uniqExactMergeIf(Calls, Day >= today() - {priorDays:UInt32} AND Day < today() - {rangeDays:UInt32}) AS priorCalls,
  uniqExactMergeIf(Calls, Day >= today() - {recentDays:UInt32}) AS recentCalls,
  uniqExactMergeIf(Calls, Day >= today() - {lookbackDays:UInt32}) AS lookbackCalls,
  uniqExactIf(TraceId, Day >= today() - {lookbackDays:UInt32}) AS lookbackSessions,
  uniqExactIf(Tool, Day >= today() - {lookbackDays:UInt32}) AS lookbackTools,
  if(maxIf(LastUsedAt, Day >= today() - {lookbackDays:UInt32}) = 0, '', toString(toDateTime(maxIf(LastUsedAt, Day >= today() - {lookbackDays:UInt32})))) AS lastUsedAt
FROM mcp_tool_use
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Day >= today() - {scanDays:UInt32}
GROUP BY Server
ORDER BY rangeCalls DESC, lookbackCalls DESC
LIMIT 500`,
    params: windowParams(input),
  };
}

export interface SessionCoverageRow {
  rangeSessions: number;
  rangeSessionsWithSkill: number;
  priorSessions: number;
  priorSessionsWithSkill: number;
  lookbackSessions: number;
}

/**
 * Session coverage: how many sessions ran per window, and how many of them
 * activated at least one skill. Membership comes from the session-grain
 * activation rollup; the session's window placement comes from its own
 * `StartedAt` (the activation happens inside the session, so no per-window
 * re-join is needed). `lookbackSessions` doubles as the first-run gate — the
 * `never` verdict is only earned once the app has run a session at all.
 */
export function buildSessionCoverageQuery(
  input: ContextOverviewQueryInput,
): ContextOverviewQueryResult {
  return {
    query: `SELECT
  uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {rangeDays:UInt32}) AS rangeSessions,
  uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {rangeDays:UInt32} AND w.TraceId != '') AS rangeSessionsWithSkill,
  uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {priorDays:UInt32} AND toDate(s.StartedAt) < today() - {rangeDays:UInt32}) AS priorSessions,
  uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {priorDays:UInt32} AND toDate(s.StartedAt) < today() - {rangeDays:UInt32} AND w.TraceId != '') AS priorSessionsWithSkill,
  uniqExactIf(s.TraceId, toDate(s.StartedAt) >= today() - {lookbackDays:UInt32}) AS lookbackSessions
FROM agent_session_summary AS s FINAL
LEFT JOIN (
  SELECT DISTINCT TraceId
  FROM skill_activation_sessions
  WHERE TenantId = {tenantId:String}
    AND AppId = {appId:String}
    AND Day >= today() - {scanDays:UInt32}
) AS w ON w.TraceId = s.TraceId
WHERE s.TenantId = {tenantId:String}
  AND s.AppId = {appId:String}
  AND toDate(s.StartedAt) >= today() - {scanDays:UInt32}`,
    params: windowParams(input),
  };
}

export interface TopicRollupRow {
  topicId: string;
  name: string;
  sessions: number;
}

/**
 * Cross-skill topic rollup: the task topics that skill-activating sessions
 * cluster under, over ALL skills in the range window. Same join shape as the
 * per-skill drill-down topics query, grouped once instead of per skill.
 */
export function buildTopicRollupQuery(
  input: ContextOverviewQueryInput,
): ContextOverviewQueryResult {
  return {
    query: `SELECT
  f.TopicId AS topicId,
  any(m.Name) AS name,
  uniqExact(f.TraceId) AS sessions
FROM trace_facets AS f FINAL
INNER JOIN (
  SELECT TopicId, argMax(Name, MapVersion) AS Name
  FROM trace_topic_maps
  WHERE TenantId = {tenantId:String}
    AND AppId = {appId:String}
    AND Facet = 'task'
    AND IsDeleted = 0
  GROUP BY TopicId
) AS m ON m.TopicId = f.TopicId
WHERE f.TenantId = {tenantId:String}
  AND f.AppId = {appId:String}
  AND f.Facet = 'task'
  AND f.IsDeleted = 0
  AND f.TopicId != ''
  AND f.TraceId IN (
    SELECT TraceId
    FROM skill_activation_sessions
    WHERE TenantId = {tenantId:String}
      AND AppId = {appId:String}
      AND Day >= today() - {rangeDays:UInt32}
  )
GROUP BY f.TopicId
ORDER BY sessions DESC
LIMIT 8`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      rangeDays: input.rangeDays,
    },
  };
}

export interface SkillTrendByDayRow {
  skill: string;
  day: string;
  activations: number;
}

/**
 * Per-skill day series for the table sparklines, in ONE grouped read over the
 * range window — never N per-skill drill-down calls.
 */
export function buildSkillTrendByDayQuery(
  input: Pick<ContextOverviewQueryInput, 'tenantId' | 'appId' | 'rangeDays'>,
): ContextOverviewQueryResult {
  return {
    query: `SELECT
  Skill AS skill,
  toString(Day) AS day,
  uniqExactMerge(Activations) AS activations
FROM skill_activation_by_day
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Day >= today() - {rangeDays:UInt32}
GROUP BY Skill, Day
ORDER BY Skill, Day`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      rangeDays: input.rangeDays,
    },
  };
}
