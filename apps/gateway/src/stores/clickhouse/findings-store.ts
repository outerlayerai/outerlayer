/**
 * Findings store — the ClickHouse reads behind the nightly agent-findings
 * compute job. Two queries:
 *
 *  - active scopes: which (tenant, app) pairs had agent sessions inside the
 *    detection window (from the summary rollup — cheap).
 *  - detection sessions: one windowed pass over `agent.%` spans for a scope,
 *    folded trace-by-trace into @outerlayer/insights-core DetectionSession
 *    shapes.
 *
 * FINAL alone is not enough for agent spans: the table's sort key includes
 * toUnixTimestamp(Timestamp), and re-ingests of a live session drift a span's
 * Timestamp, so the same logical span (its SpanId is deterministic and
 * stable) survives as several row versions. The span query therefore also
 * dedupes with `ORDER BY UpdatedAt DESC LIMIT 1 BY TraceId, SpanId` — newest
 * ingest of each logical span wins.
 */

import { createClient } from "@clickhouse/client-web";
import type { DetectionSession, DetectionTurn, ActivatedSkillUse } from "@outerlayer/insights-core";
import { buildSkillAdoptionQuery, type SkillAdoptionRow } from "@repo/observability-service";

export interface FindingsScope {
  tenantId: string;
  appId: string;
}

export interface FindingsStore {
  /** (tenant, app) pairs with ≥1 agent session inside the window. */
  listActiveScopes(lookbackDays: number): Promise<FindingsScope[]>;
  /** All detection sessions for a scope inside the window. */
  loadDetectionSessions(
    scope: FindingsScope,
    lookbackDays: number,
  ): Promise<DetectionSession[]>;
  /**
   * Skills activated ≥1 time in the window, with counts — the input both skill
   * findings share (unused subtracts the names from the repo inventory;
   * unversioned keeps the counts to rank promote-candidates). Its own window,
   * longer than the detection window and matching the dashboard adoption
   * overlay, so a monthly-use skill isn't misread as dead.
   */
  loadActivatedSkills(
    scope: FindingsScope,
    lookbackDays: number,
  ): Promise<ActivatedSkillUse[]>;
}

/** One span row off the windowed pass — only the columns detection needs. */
interface SpanRow {
  TraceId: string;
  SpanId: string;
  SpanName: string;
  Ts: string; // "YYYY-MM-DD HH:MM:SS.n{1,9}" (UTC)
  StatusCode: string;
  StatusMessage: string;
  Model: string;
  Cost: number;
  InputTokens: number;
  OutputTokens: number;
  cacheRead: string;
  cacheCreation: string;
  turnIndex: string;
  toolName: string;
  toolStatus: string;
  isEdit: string;
  file: string;
  gitRepo: string;
  cwd: string;
  parentSessionId: string;
  SessionId: string;
  ActorId: string;
  eventNames: string[];
  eventTimestamps: string[];
}

/** Hard row cap per scope pass — a Workers-memory backstop, logged when hit. */
export const MAX_SPAN_ROWS = 200_000;

/** ClickHouse UTC "YYYY-MM-DD HH:MM:SS.n{1,9}" → ISO-8601 at ms precision. */
const toIso = (ch: string): string => `${ch.slice(0, 23).replace(" ", "T")}Z`;

/**
 * Fold one trace's deduped spans into a DetectionSession. Null for orphan
 * traces without an `agent.session` root (not a session). Exported for tests.
 */
export function toDetectionSession(
  traceId: string,
  spans: SpanRow[],
): DetectionSession | null {
  const root = spans.find((s) => s.SpanName === "agent.session") ?? null;
  if (!root) return null;
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const models = new Set<string>();
  const turns = new Map<number, DetectionTurn>();
  const turnFor = (index: number): DetectionTurn => {
    let turn = turns.get(index);
    if (!turn) {
      // Tool span arrived before (or without) its turn span — synthesize the
      // holder so its calls still feed detection; a later turn span fills
      // role/ts.
      turn = { index, role: "assistant", ts: null, toolCalls: [] };
      turns.set(index, turn);
    }
    return turn;
  };
  for (const row of spans) {
    costUsd += row.Cost;
    if (row.SpanName === "agent.turn.user" || row.SpanName === "agent.turn.assistant") {
      const index = Number.parseInt(row.turnIndex, 10);
      const turn = turnFor(Number.isNaN(index) ? -1 : index);
      turn.role = row.SpanName === "agent.turn.user" ? "user" : "assistant";
      turn.ts = toIso(row.Ts);
      tokens.input += row.InputTokens;
      tokens.output += row.OutputTokens;
      tokens.cacheRead += Number.parseInt(row.cacheRead, 10) || 0;
      tokens.cacheCreation += Number.parseInt(row.cacheCreation, 10) || 0;
      if (row.Model) models.add(row.Model);
    } else if (row.SpanName.startsWith("agent.tool.")) {
      const index = Number.parseInt(row.turnIndex, 10);
      turnFor(Number.isNaN(index) ? -1 : index).toolCalls.push({
        name: row.toolName || row.SpanName.slice("agent.tool.".length),
        status: row.toolStatus || (row.StatusCode === "2" ? "error" : "ok"),
        isEdit: row.isEdit === "1",
        file: row.file || null,
        errorSignature: row.StatusMessage || null,
      });
    }
  }
  return {
    id: root.SessionId || traceId,
    actorId: root.ActorId || null,
    project: root.gitRepo || root.cwd || null,
    startedAt: toIso(root.Ts),
    models: [...models],
    costUsd: costUsd > 0 ? costUsd : null,
    tokens,
    isSubagent: root.parentSessionId !== "" ? 1 : 0,
    turns: [...turns.values()].sort((a, b) => a.index - b.index),
    events: root.eventNames.map((name, i) => ({
      type: name,
      ts: root.eventTimestamps[i] ? toIso(root.eventTimestamps[i]!) : null,
    })),
  };
}

/** Exported for tests: the windowed, deduped span query. */
export function buildSpanScanSql(): string {
  return `
      SELECT * FROM (
        SELECT
          TraceId,
          SpanId,
          SpanName,
          toString(Timestamp) AS Ts,
          StatusCode,
          StatusMessage,
          Model,
          Cost,
          InputTokens,
          OutputTokens,
          SpanAttributes['gen_ai.usage.cache_read.input_tokens'] AS cacheRead,
          SpanAttributes['gen_ai.usage.cache_creation.input_tokens'] AS cacheCreation,
          Metadata['turnIndex'] AS turnIndex,
          Metadata['toolName'] AS toolName,
          Metadata['toolStatus'] AS toolStatus,
          Metadata['isEdit'] AS isEdit,
          Metadata['file'] AS file,
          Metadata['gitRepo'] AS gitRepo,
          Metadata['cwd'] AS cwd,
          Metadata['parentSessionId'] AS parentSessionId,
          SessionId,
          ActorId,
          Events.Name AS eventNames,
          Events.Timestamp AS eventTimestamps
        FROM otel_traces FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND SpanName LIKE 'agent.%'
          AND Timestamp >= now() - INTERVAL {lookbackDays:UInt32} DAY
        ORDER BY UpdatedAt DESC
        LIMIT 1 BY TraceId, SpanId
      )
      ORDER BY TraceId, Ts
      LIMIT {maxRows:UInt32}
  `;
}

/** Exported for tests: which scopes had sessions inside the window. */
export function buildActiveScopesSql(): string {
  return `
      SELECT TenantId AS tenantId, AppId AS appId
      FROM agent_session_summary FINAL
      WHERE StartedAt >= now() - INTERVAL {lookbackDays:UInt32} DAY
      GROUP BY TenantId, AppId
      ORDER BY count() DESC
  `;
}

export const createFindingsStore = (config: {
  url: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  username?: string;
  password: string;
  onRowCapHit?: (scope: FindingsScope, rows: number) => void;
}): FindingsStore => {
  const client = createClient({
    url: config.url,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
  });

  const query = async <T>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> => {
    const result = await client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    return result.json<T>();
  };

  return {
    async listActiveScopes(lookbackDays) {
      return query<FindingsScope>(buildActiveScopesSql(), { lookbackDays });
    },

    async loadDetectionSessions(scope, lookbackDays) {
      const rows = await query<SpanRow>(buildSpanScanSql(), {
        tenantId: scope.tenantId,
        appId: scope.appId,
        lookbackDays,
        maxRows: MAX_SPAN_ROWS,
      });
      if (rows.length >= MAX_SPAN_ROWS) {
        // Never truncate silently — a capped pass means findings describe a
        // subset of the window.
        config.onRowCapHit?.(scope, rows.length);
      }
      const sessions: DetectionSession[] = [];
      let currentTraceId: string | null = null;
      let buffer: SpanRow[] = [];
      const flush = (): void => {
        if (currentTraceId === null) return;
        const session = toDetectionSession(currentTraceId, buffer);
        if (session) sessions.push(session);
        buffer = [];
      };
      for (const row of rows) {
        if (row.TraceId !== currentTraceId) {
          flush();
          currentTraceId = row.TraceId;
        }
        buffer.push(row);
      }
      flush();
      return sessions;
    },

    async loadActivatedSkills(scope, lookbackDays) {
      // recentDays is irrelevant here (both findings work off the full-window
      // totals, not the recent split), so it rides along equal to the window.
      const { query: sql, params } = buildSkillAdoptionQuery({
        tenantId: scope.tenantId,
        appId: scope.appId,
        lookbackDays,
        recentDays: lookbackDays,
      });
      const rows = await query<SkillAdoptionRow>(sql, params);
      return rows.map((r) => ({
        skillName: r.skill,
        totalActivations: Number(r.totalActivations),
        totalSessions: Number(r.totalSessions),
      }));
    },
  };
};
