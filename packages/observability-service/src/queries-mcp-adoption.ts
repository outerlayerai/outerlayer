/**
 * MCP-adoption queries — which MCP servers (and which of their tools) the
 * app's sessions actually call. All reads hit the `mcp_tool_use` rollup
 * (populated at ingest by its materialized view over `agent.tool.mcp__*`
 * spans), NOT raw `otel_traces`: the raw SpanName scan reads every span
 * granule for the tenant window, and these queries back the interactive
 * Context adoption overlay.
 *
 * Counts stay exact despite span re-ingests: the rollup's Calls states are
 * uniqExact keyed by SpanId, so replayed span versions collapse at merge
 * time — no FINAL, no read-time dedupe. TraceId is a key column, so session
 * counts are plain uniqExact over it.
 *
 * Windows are day-grained: adoption is a days-since-used signal.
 *
 * No actor identity anywhere: adoption aggregates at server/tool/session
 * grain only.
 */

export interface McpAdoptionQueryInput {
  tenantId: string;
  appId: string;
  /** Total scan window (the "gone quiet" horizon). */
  lookbackDays: number;
  /** Recent-activity window the headline counts use. */
  recentDays: number;
}

export interface McpQueryResult {
  query: string;
  params: Record<string, unknown>;
}

export interface McpServerRow {
  server: string;
  recentCalls: number;
  recentSessions: number;
  totalCalls: number;
  totalSessions: number;
  lastUsedAt: string;
}

export function buildMcpAdoptionQuery(
  input: McpAdoptionQueryInput,
): McpQueryResult {
  return {
    query: `SELECT
  Server AS server,
  uniqExactMergeIf(Calls, Day >= today() - {recentDays:UInt32}) AS recentCalls,
  uniqExactIf(TraceId, Day >= today() - {recentDays:UInt32}) AS recentSessions,
  uniqExactMerge(Calls) AS totalCalls,
  uniqExact(TraceId) AS totalSessions,
  toString(toDateTime(max(LastUsedAt))) AS lastUsedAt
FROM mcp_tool_use
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Day >= today() - {lookbackDays:UInt32}
GROUP BY Server
ORDER BY recentCalls DESC, totalCalls DESC
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
 * Per-server drill-down: tool breakdown, trend, activating sessions.
 * ------------------------------------------------------------------------- */

export interface McpServerDrilldownInput extends McpAdoptionQueryInput {
  server: string;
}

/** One tool of the server — the unused-tool tail is the actionable signal. */
export interface McpToolRow {
  tool: string;
  recentCalls: number;
  totalCalls: number;
  sessions: number;
  lastUsedAt: string;
}

export interface McpTrendRow {
  day: string;
  calls: number;
  sessions: number;
}

export interface McpSessionRow {
  traceId: string;
  title: string;
  calls: number;
  lastUsedAt: string;
}

export function buildMcpServerToolsQuery(
  input: McpServerDrilldownInput,
): McpQueryResult {
  return {
    query: `SELECT
  Tool AS tool,
  uniqExactMergeIf(Calls, Day >= today() - {recentDays:UInt32}) AS recentCalls,
  uniqExactMerge(Calls) AS totalCalls,
  uniqExact(TraceId) AS sessions,
  toString(toDateTime(max(LastUsedAt))) AS lastUsedAt
FROM mcp_tool_use
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Server = {server:String}
  AND Day >= today() - {lookbackDays:UInt32}
GROUP BY Tool
ORDER BY totalCalls DESC
LIMIT 200`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      server: input.server,
      lookbackDays: input.lookbackDays,
      recentDays: input.recentDays,
    },
  };
}

export function buildMcpServerTrendQuery(
  input: Omit<McpServerDrilldownInput, 'recentDays'>,
): McpQueryResult {
  return {
    query: `SELECT
  toString(Day) AS day,
  uniqExactMerge(Calls) AS calls,
  uniqExact(TraceId) AS sessions
FROM mcp_tool_use
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND Server = {server:String}
  AND Day >= today() - {lookbackDays:UInt32}
GROUP BY Day
ORDER BY Day`,
    params: {
      tenantId: input.tenantId,
      appId: input.appId,
      server: input.server,
      lookbackDays: input.lookbackDays,
    },
  };
}

export interface McpServerSessionsInput
  extends Omit<McpServerDrilldownInput, 'recentDays'> {
  limit: number;
}

export function buildMcpServerSessionsQuery(
  input: McpServerSessionsInput,
): McpQueryResult {
  return {
    // Aggregate per trace FIRST, then title from agent_session_summary — a
    // LEFT join, because a session whose summary row hasn't landed still
    // called the server and must not vanish. Titles only; no ActorId.
    query: `SELECT
  a.TraceId AS traceId,
  s.Title AS title,
  a.calls AS calls,
  a.lastUsedAt AS lastUsedAt
FROM (
  SELECT
    TraceId,
    uniqExactMerge(Calls) AS calls,
    toString(toDateTime(max(LastUsedAt))) AS lastUsedAt,
    max(LastUsedAt) AS lastTs
  FROM mcp_tool_use
  WHERE TenantId = {tenantId:String}
    AND AppId = {appId:String}
    AND Server = {server:String}
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
      server: input.server,
      lookbackDays: input.lookbackDays,
      limit: input.limit,
    },
  };
}
