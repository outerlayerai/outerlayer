/**
 * Skill-adoption query — which Claude Code skills the app's sessions
 * actually invoke. Reads the `skill_activation_by_day` rollup (populated at
 * ingest by its materialized view over root-span `skill_activated` events),
 * NOT raw `otel_traces`: the raw scan reads every span granule for the
 * tenant/app window just to find root spans — seconds on a busy app — and
 * this query backs the interactive Context adoption overlay. The rollup
 * read is an indexed aggregate over (TenantId, AppId, Skill, Day).
 *
 * Counts stay exact despite span re-ingests: the rollup's uniqExact states
 * are keyed by (TraceId, SpanId, eventIdx), so replayed event arrays
 * collapse at merge time — no FINAL, no LIMIT 1 BY, no read-time dedupe.
 *
 * Windows are day-grained (`Day >= today() - N`): adoption is a
 * days-since-used signal, so sub-day boundary precision buys nothing.
 *
 * No actor identity anywhere: adoption aggregates at skill grain only.
 */

export interface SkillAdoptionQueryInput {
  tenantId: string;
  appId: string;
  /** Total scan window (the "gone quiet" horizon). */
  lookbackDays: number;
  /** Recent-activity window the headline counts use. */
  recentDays: number;
}

export interface SkillAdoptionQueryResult {
  query: string;
  params: Record<string, unknown>;
}

export interface SkillAdoptionRow {
  skill: string;
  recentActivations: number;
  recentSessions: number;
  totalActivations: number;
  totalSessions: number;
  lastActivatedAt: string;
}

export function buildSkillAdoptionQuery(
  input: SkillAdoptionQueryInput,
): SkillAdoptionQueryResult {
  return {
    query: `SELECT
  Skill AS skill,
  uniqExactMergeIf(Activations, Day >= today() - {recentDays:UInt32}) AS recentActivations,
  uniqExactMergeIf(Sessions, Day >= today() - {recentDays:UInt32}) AS recentSessions,
  uniqExactMerge(Activations) AS totalActivations,
  uniqExactMerge(Sessions) AS totalSessions,
  toString(toDateTime(max(LastActivatedAt))) AS lastActivatedAt
FROM skill_activation_by_day
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Day >= today() - {lookbackDays:UInt32}
GROUP BY Skill
ORDER BY recentActivations DESC, totalActivations DESC
LIMIT 500`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      lookbackDays: input.lookbackDays,
      recentDays: input.recentDays,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Per-skill drill-down: trend, activating sessions, topic breakdown.
 * Trend reads the day rollup (already day-keyed). Enumeration reads the
 * session-grain companion table `skill_activation_sessions` — merged agg
 * states can be counted but not enumerated, which is why the companion
 * exists. Neither touches raw otel_traces; that stays the perf contract.
 * ------------------------------------------------------------------------- */

export interface SkillDrilldownQueryInput {
  tenantId: string;
  appId: string;
  skill: string;
  /** Scan window for the drill-down (matches the adoption lookback). */
  lookbackDays: number;
}

/** One point of the per-skill activation trend (day grain, gaps = zero days). */
export interface SkillTrendRow {
  day: string;
  activations: number;
  sessions: number;
}

/** One session that activated the skill, titled from the session summary. */
export interface SkillSessionRow {
  traceId: string;
  title: string;
  activations: number;
  lastActivatedAt: string;
}

/** One topic the activating sessions cluster under (task facet). */
export interface SkillTopicRow {
  topicId: string;
  name: string;
  sessions: number;
}

export function buildSkillTrendQuery(
  input: SkillDrilldownQueryInput,
): SkillAdoptionQueryResult {
  return {
    query: `SELECT
  toString(Day) AS day,
  uniqExactMerge(Activations) AS activations,
  uniqExactMerge(Sessions) AS sessions
FROM skill_activation_by_day
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Skill = {skill:String}
  AND Day >= today() - {lookbackDays:UInt32}
GROUP BY Day
ORDER BY Day`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      skill: input.skill,
      lookbackDays: input.lookbackDays,
    },
  };
}

export interface SkillSessionsQueryInput extends SkillDrilldownQueryInput {
  limit: number;
}

export function buildSkillSessionsQuery(
  input: SkillSessionsQueryInput,
): SkillAdoptionQueryResult {
  return {
    // Aggregate the activation states per trace FIRST, then title the result
    // from agent_session_summary — a LEFT join, because a session whose
    // summary row hasn't landed (or was retention-pruned) still activated
    // the skill and must not vanish from the list. Titles only; no ActorId —
    // adoption stays at skill/session grain with no per-person dimension.
    query: `SELECT
  a.TraceId AS traceId,
  s.Title AS title,
  a.activations AS activations,
  a.lastActivatedAt AS lastActivatedAt
FROM (
  SELECT
    TraceId,
    uniqExactMerge(Activations) AS activations,
    toString(toDateTime(max(LastActivatedAt))) AS lastActivatedAt,
    max(LastActivatedAt) AS lastTs
  FROM skill_activation_sessions
  WHERE TenantId = {tenantId:String}
    AND AppId = {appId:String}
    AND Skill = {skill:String}
    AND Day >= today() - {lookbackDays:UInt32}
  GROUP BY TraceId
  ORDER BY lastTs DESC
  LIMIT {limit:UInt32}
) AS a
LEFT JOIN (
  SELECT TraceId, argMax(Title, InsertedAt) AS Title
  FROM agent_session_summary
  WHERE TenantId = {tenantId:String}
    AND AppId = {appId:String}
  GROUP BY TraceId
) AS s ON s.TraceId = a.TraceId
ORDER BY a.lastTs DESC`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      skill: input.skill,
      lookbackDays: input.lookbackDays,
      limit: input.limit,
    },
  };
}

export function buildSkillTopicsQuery(
  input: SkillDrilldownQueryInput,
): SkillAdoptionQueryResult {
  return {
    // Task-facet topic breakdown of the activating sessions. Assignments come
    // from trace_facets (bloom-indexed on TraceId); names resolve per TopicId
    // at the highest map version carrying it — TopicId is the stable identity
    // across map regenerations, the Name is a disposable label.
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
      AND Skill = {skill:String}
      AND Day >= today() - {lookbackDays:UInt32}
  )
GROUP BY f.TopicId
ORDER BY sessions DESC
LIMIT 10`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      skill: input.skill,
      lookbackDays: input.lookbackDays,
    },
  };
}
