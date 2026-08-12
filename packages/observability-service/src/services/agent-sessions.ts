/**
 * Agent-sessions read path — session list + transcript detail, shared by the
 * dashboard's Sessions views and the gateway's future `/v1/sessions` routes
 * (and `list_sessions`/`get_session` MCP tools). Takes an
 * {@link IClickHouseQuery} rather than the Node-only `@clickhouse/client`
 * type and reads NOTHING from `process.env` or Supabase — every host-specific
 * concern (actor-privacy policy, developer display names, PR-outcome scores,
 * signed image URLs) arrives through the ports below, resolved by the host
 * BEFORE calling in — no Supabase client, actor-name resolver, PR-outcome
 * join, or cookie-based scope resolution lives in this module itself.
 */

import type {
  AgentSessionDetail,
  AgentSpan,
  ListSessionsQuery,
  SessionPrOutcome,
  SessionsPage,
  SignedImageRef,
} from '@repo/api-schemas';
import { MAX_SESSION_SPANS, ORIGIN_LITERALS } from '@repo/api-schemas';
import { ValidationError } from '../errors';
import type { IClickHouseQuery } from '../client';
import { findEditRetryLoop } from './trajectory-signals';

/**
 * The identity a session read runs as.
 *
 * `dashboard-member` keeps today's dashboard behavior exactly: self-pinned
 * (every row/transcript restricted to `membershipId`) unless `canSeeTeam`,
 * in which case the read is team-wide and actor names resolve normally.
 *
 * `machine-key` ALWAYS returns team-scoped rows — a key has no seat to pin
 * to. When `canSeeTeamActors` is false, actor identity is masked (names
 * replaced with {@link ANONYMOUS_ACTOR_LABEL}) and an explicit `actorId`
 * filter is rejected with a {@link ValidationError} rather than silently
 * ignored or silently narrowing to nothing.
 */
export type SessionAccessPolicy =
  | { kind: 'dashboard-member'; membershipId: string; canSeeTeam: boolean }
  | { kind: 'machine-key'; canSeeTeamActors: boolean };

/** Membership-UUID/`key:*` ActorId → display label. */
export interface ActorNameResolver {
  resolve(actorIds: string[]): Promise<Record<string, string>>;
}

/**
 * PR-outcome scores for a page of sessions (or a single one, called with a
 * one-element array) — Postgres-backed on every known host (`ctx.db` on the
 * dashboard, `getScopedSupabase` on the gateway), so it stays a port rather
 * than an inline query here.
 *
 * One method serves both call shapes: the list read passes the page's trace
 * ids and looks up each row's outcomes from the returned function; the
 * detail read passes a single trace id and calls the function once. This
 * mirrors the dashboard's actual `getSessionListOutcomes`/
 * `fetchSessionOutcomeScores` split (batched-lookup vs single-trace) more
 * closely than a `forSessions(prNumbers)` signature would — a session's PR
 * outcomes are looked up by the TRACE that produced them, not by a PR
 * number the caller doesn't have yet.
 */
export interface PrOutcomeReader {
  forSessions(traceIds: readonly string[]): Promise<(traceId: string) => SessionPrOutcome[]>;
}

/** Mints the signed, expiring URLs a transcript's pasted images ride —
 * content-addressed bytes carry no actor, so the binding to a caller lives
 * in this token, not on the row (see the dashboard's `blob-url.ts`). */
export interface ImageRefSigner {
  sign(images: { sha256: string; mediaType: string }[]): Promise<SignedImageRef[]>;
}

export interface AgentSessionsPorts {
  actorNames: ActorNameResolver;
  prOutcomes: PrOutcomeReader;
  images: ImageRefSigner;
}

export interface AgentSessionsScope {
  tenantId: string;
  appId: string;
}

/** Label every machine-key read without `agents.sessions.team.read` sees in
 * place of a real actor name — the row itself stays visible (machine keys
 * are always team-scoped), only identity is masked. */
export const ANONYMOUS_ACTOR_LABEL = 'anonymous';

const IO_CAP = 4096;
const REASONING_CAP = 1024;
const capText = (s: string | null, max: number): string | null =>
  s && s.length > max ? [...s].slice(0, max).join('') : s;

function unwrapMessages(raw: string | null): string | null {
  if (!raw || raw[0] !== '[') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((m) => typeof m === 'object' && m !== null && 'role' in m && 'content' in m)
    ) {
      return (parsed as { content: unknown }[])
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
    }
  } catch {
    /* not JSON — return as-is */
  }
  return raw;
}

function parseImages(m: Record<string, string>): { sha256: string; mediaType: string }[] {
  if (!m.images) return [];
  try {
    const arr = JSON.parse(m.images) as { sha256?: unknown; mediaType?: unknown }[];
    return arr
      .filter((i) => typeof i?.sha256 === 'string')
      .map((i) => ({
        sha256: String(i.sha256),
        mediaType: typeof i.mediaType === 'string' ? i.mediaType : 'image/png',
      }));
  } catch {
    return [];
  }
}

const SORT_COLUMNS = {
  startedAt: 'StartedAt',
  cost: 'CostUsd',
  errors: 'ErrorCount',
  turns: 'TurnCount',
  steering: 'UserTurnCount',
  toolErrorRate: 'if(ToolCallCount > 0, ErrorCount / ToolCallCount, 0)',
} as const;

const SIGNAL_PREDICATES = {
  'hands-on': 'UserTurnCount > 1',
  denied: 'RejectedToolCallCount > 0',
  'tool-errors': 'ErrorCount > 0',
  'provider-errors': 'ApiErrorCount > 0',
  clean: 'UserTurnCount <= 1 AND RejectedToolCallCount = 0 AND ErrorCount = 0 AND ApiErrorCount = 0',
} as const;

/** ClickHouse resource caps on every query this service issues. */
export const AGENT_SESSIONS_QUERY_SETTINGS = {
  max_execution_time: 30,
  do_not_merge_across_partitions_select_final: 1,
  max_memory_usage: 1_000_000_000,
  max_rows_to_read: 1e7,
} as const;

const knownCost = (v: number): number | null => (Number.isFinite(v) && v > 0 ? v : null);

async function queryRows<T>(
  client: IClickHouseQuery,
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const result = await client.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: AGENT_SESSIONS_QUERY_SETTINGS,
  });
  return result.json<T>();
}

/** Resolves the row-scoping predicate + the actor a `machine-key` read must
 * reject filtering by. `null` pin means unpinned (team-wide). */
function pinnedActorFor(policy: SessionAccessPolicy): string | null {
  if (policy.kind === 'dashboard-member') return policy.canSeeTeam ? null : policy.membershipId;
  return null; // machine keys have no seat to pin to — always team-scoped rows
}

function scopeLabel(policy: SessionAccessPolicy): 'self' | 'team' {
  return policy.kind === 'dashboard-member' && !policy.canSeeTeam ? 'self' : 'team';
}

/** Whether actor identity must be masked in the response. Dashboard-member
 * reads never mask names — privacy there is enforced by row pinning, not by
 * hiding who a visible row belongs to. */
function mustMaskActors(policy: SessionAccessPolicy): boolean {
  return policy.kind === 'machine-key' && !policy.canSeeTeamActors;
}

// ---------------------------------------------------------------------------
// Identity-bearing Metadata redaction (masked reads only)
// ---------------------------------------------------------------------------

/** Metadata keys dropped wholesale on a masked read — anything shaped like a
 * per-person identifier, not just the ones {@link agent-session-converter.ts}
 * currently writes, so a future metadata field with one of these names is
 * caught without a matching edit here. */
const IDENTITY_METADATA_KEY_PATTERN = /email|actor|user(name)?|home(dir)?/i;

/** The leaf path segment, OS-agnostic. env.cwd rides Metadata as a full
 * absolute path (/Users/name/…, /home/name/…, C:\Users\name\…) that embeds
 * the OS username in a PARENT segment — masking the key isn't enough, the
 * value itself must be cut down. */
function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Redacts identity-bearing values from a span's Metadata map for a masked
 * read: cwd collapses to its basename (the leaf directory — e.g. the repo
 * folder — without the parent path that carries the username), and any key
 * matching {@link IDENTITY_METADATA_KEY_PATTERN} is dropped entirely. */
function maskIdentityMetadata(meta: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (IDENTITY_METADATA_KEY_PATTERN.test(key)) continue;
    masked[key] = key === 'cwd' ? pathBasename(value) : value;
  }
  return masked;
}

/** The session-level project field's gitRepo→cwd fallback, applying the
 * same cwd-basename redaction as {@link maskIdentityMetadata} on a masked
 * read — this field is derived separately from the span Metadata map it
 * reads from, so it needs the same treatment applied independently. */
function projectFrom(meta: Record<string, string>, masked: boolean): string | null {
  if (meta.gitRepo) return meta.gitRepo;
  if (!meta.cwd) return null;
  return masked ? pathBasename(meta.cwd) : meta.cwd;
}

export class AgentSessionsService {
  constructor(private readonly client: IClickHouseQuery) {}

  /**
   * Full span tree + rollup identity for one trace. Returns `null` both when
   * the trace genuinely doesn't exist AND when a `dashboard-member` caller
   * without team scope requests another actor's session — there is no
   * existence oracle for a transcript the caller cannot see.
   */
  async getSessionDetail(
    scope: AgentSessionsScope,
    traceId: string,
    policy: SessionAccessPolicy,
    ports: AgentSessionsPorts,
  ): Promise<AgentSessionDetail | null> {
    const { tenantId, appId } = scope;
    const params: Record<string, unknown> = { tenantId, appId, traceId };
    let identity =
      'TenantId = {tenantId:String} AND AppId = {appId:String} AND TraceId = {traceId:String}';

    // FINAL on otel_traces cannot prune by TraceId (not a sort-key prefix), so
    // an unbounded read FINAL-merges entire monthly partitions. The scan is
    // bounded by the trace's [min, max] Timestamp from the tiny
    // otel_traces_trace_id_ts lookup; a lookup miss/failure falls back to the
    // unbounded query — identical behavior, worst-case identical cost.
    try {
      const rangeRows = await queryRows<{ start: string; end: string }>(
        this.client,
        `
        SELECT min(Start) AS start, max(End) AS end
        FROM otel_traces_trace_id_ts
        WHERE TraceId = {traceId:String} AND AppId = {appId:String} AND TenantId = {tenantId:String}
        GROUP BY TraceId`,
        params,
      );
      if (rangeRows[0]?.start && rangeRows[0]?.end) {
        identity += ' AND Timestamp >= {tsRangeStart:DateTime64(9)} AND Timestamp <= {tsRangeEnd:DateTime64(9)}';
        params.tsRangeStart = rangeRows[0].start;
        params.tsRangeEnd = rangeRows[0].end;
      }
    } catch {
      // unbounded fallback — never turn a lookup failure into a 500
    }

    const [allRows, summaryRows] = await Promise.all([
      queryRows<Record<string, unknown>>(
        this.client,
        `
        SELECT SpanId AS spanId, ParentSpanId AS parentSpanId, SpanName AS name, Timestamp AS startTime,
               Duration AS durationMs, StatusCode AS statusCode, StatusMessage AS statusMessage,
               Model AS model, Cost AS cost, InputTokens AS inputTokens, OutputTokens AS outputTokens,
               -- Payload cap (perf): tool I/O is plain text, truncated at the CH
               -- boundary; turn I/O carries the gen_ai messages-array JSON that
               -- unwrapMessages must parse whole, so it stays intact here and is
               -- capped in JS after unwrapping.
               if(SpanName LIKE 'agent.tool.%', substringUTF8(Input, 1, 2048), Input) AS input,
               if(SpanName LIKE 'agent.tool.%', substringUTF8(Output, 1, ${IO_CAP}), Output) AS output,
               substringUTF8(SpanAttributes['outerlayer.reasoning'], 1, ${REASONING_CAP}) AS reasoning,
               CaptureTier AS captureTier, AgentType AS agentType, ActorId AS actorId,
               Metadata AS metadata
        FROM otel_traces FINAL
        -- Explicit PREWHERE (memory): under FINAL, ClickHouse does NOT
        -- auto-move WHERE conditions to PREWHERE, so a plain WHERE reads every
        -- selected column — including the multi-KB Input/Output/SpanAttributes/
        -- Metadata payloads — for the ENTIRE scanned range before filtering to
        -- this trace. PREWHERE filters on the skinny identity columns first.
        -- Only sort-key columns belong here — they're identical across
        -- ReplacingMergeTree row versions, which is what makes pre-merge
        -- filtering correct under FINAL. SpanName is not in the sort key.
        PREWHERE ${identity}
        WHERE SpanName LIKE 'agent.%'
        ORDER BY Timestamp ASC, SpanName ASC
        LIMIT {spanLimit:UInt32}`,
        { ...params, spanLimit: MAX_SESSION_SPANS + 1 },
      ),
      queryRows<Record<string, unknown>>(
        this.client,
        `
        SELECT SessionId AS sessionId, WorkerKind AS workerKind, CostUsd AS costUsd,
               if(EndedAt > StartedAt, dateDiff('millisecond', StartedAt, EndedAt), 0) AS durationMs,
               TurnCount AS turnCount, ToolCallCount AS toolCallCount, ErrorCount AS errorCount, Models AS models,
               UserTurnCount AS userTurnCount, RejectedToolCallCount AS rejectedToolCallCount,
               PermissionPromptCount AS permissionPromptCount, ApiErrorCount AS apiErrorCount,
               HookExecutionCount AS hookExecutionCount, HookDurationMs AS hookDurationMs,
               HookUnreportedCount AS hookUnreportedCount, SlowestHookMs AS slowestHookMs,
               SlowestHookCommand AS slowestHookCommand
        FROM agent_session_summary FINAL
        WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND TraceId = {traceId:String}
        LIMIT 1`,
        params,
      ),
    ]);

    if (allRows.length === 0) return null;
    const truncated = allRows.length > MAX_SESSION_SPANS;
    const rows = truncated ? allRows.slice(0, MAX_SESSION_SPANS) : allRows;
    const summary = summaryRows[0] ?? null;
    const root = rows.find((r) => r.name === 'agent.session') ?? rows[0]!;

    // Actor privacy: a `dashboard-member` caller without team scope may only
    // read their own transcripts. Machine keys are always team-scoped (no
    // seat to pin to), so this guard never applies to them.
    const pinnedActor = pinnedActorFor(policy);
    if (pinnedActor !== null && (root.actorId as string) !== pinnedActor) return null;

    const meta = (root.metadata as Record<string, string>) ?? {};
    const iso = (t: unknown) => new Date(String(t).replace(' ', 'T') + 'Z').toISOString();
    const masked = mustMaskActors(policy);

    const spans: AgentSpan[] = await Promise.all(
      rows.map(async (r) => {
        const m = (r.metadata as Record<string, string>) ?? {};
        const images = await ports.images.sign(parseImages(m));
        return {
          spanId: r.spanId as string,
          parentSpanId: (r.parentSpanId as string) || null,
          name: r.name as string,
          startTime: iso(r.startTime),
          durationMs: Number(r.durationMs) || null,
          statusCode: r.statusCode as string,
          statusMessage: (r.statusMessage as string) || null,
          model: (r.model as string) || null,
          cost: Number(r.cost) || null,
          inputTokens: Number(r.inputTokens) || null,
          outputTokens: Number(r.outputTokens) || null,
          input: capText(unwrapMessages((r.input as string) || null), IO_CAP),
          output: capText(unwrapMessages((r.output as string) || null), IO_CAP),
          reasoning: (r.reasoning as string) || null,
          metadata: masked ? maskIdentityMetadata(m) : m,
          images,
        };
      }),
    );

    const turns = rows.filter((r) => String(r.name).startsWith('agent.turn.'));
    const spanCostSum = turns.reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const summaryCost = summary ? Number(summary.costUsd) : 0;
    const summaryDuration = summary ? Number(summary.durationMs) : 0;
    const rootDuration = Number(root.durationMs) || 0;

    const actorId = root.actorId as string;
    const actorNames = masked
      ? { [actorId]: ANONYMOUS_ACTOR_LABEL }
      : await ports.actorNames.resolve([actorId]);

    const num = (v: unknown) => Number(v) || 0;
    const rejectedFromSpans = rows.filter(
      (r) =>
        String(r.name).startsWith('agent.tool.') &&
        ((r.metadata as Record<string, string>) ?? {}).toolStatus === 'rejected',
    ).length;
    const editRetryLoop = findEditRetryLoop(
      rows.map((r) => ({
        name: String(r.name),
        statusCode: String(r.statusCode),
        metadata: (r.metadata as Record<string, string>) ?? {},
      })),
    );

    const outcomeLookup = await ports.prOutcomes.forSessions([traceId]);

    return {
      prOutcomes: outcomeLookup(traceId),
      truncated,
      session: {
        traceId,
        sessionId: (summary?.sessionId as string) || traceId,
        title: meta.title || null,
        agentType: root.agentType as string,
        actorId,
        actorName: actorNames[actorId] ?? actorId,
        workerKind: (summary?.workerKind as string) || meta.workerKind || null,
        project: projectFrom(meta, masked),
        startedAt: iso(root.startTime),
        durationMs: summaryDuration > 0 ? summaryDuration : rootDuration > 0 ? rootDuration : null,
        // turnCount/toolCallCount/errorCount/models prefer the rollup, the
        // same as every other summary-backed field below — it's written from
        // the full session at ingest, so it stays accurate past the span
        // read's MAX_SESSION_SPANS cap. Falls back to counting the (possibly
        // truncated) returned spans only when no rollup row exists yet.
        turnCount: summary ? num(summary.turnCount) : turns.length,
        toolCallCount: summary
          ? num(summary.toolCallCount)
          : rows.filter((r) => String(r.name).startsWith('agent.tool.')).length,
        errorCount: summary
          ? num(summary.errorCount)
          : rows.filter((r) => String(r.name).startsWith('agent.tool.') && r.statusCode === '2').length,
        costUsd: knownCost(summaryCost > 0 ? summaryCost : spanCostSum),
        models:
          summary && Array.isArray(summary.models)
            ? (summary.models as string[])
            : [...new Set(turns.map((r) => r.model as string).filter(Boolean))],
        captureTier: (root.captureTier as string) || 'full',
        userTurnCount: summary ? num(summary.userTurnCount) : turns.filter((r) => r.name === 'agent.turn.user').length,
        rejectedToolCallCount: summary ? num(summary.rejectedToolCallCount) : rejectedFromSpans,
        permissionPromptCount: summary ? num(summary.permissionPromptCount) : 0,
        apiErrorCount: summary ? num(summary.apiErrorCount) : 0,
        editRetryLoop,
        hookExecutionCount: summary ? num(summary.hookExecutionCount) : 0,
        hookDurationMs: summary ? num(summary.hookDurationMs) : 0,
        hookUnreportedCount: summary ? num(summary.hookUnreportedCount) : 0,
        slowestHookMs: summary ? num(summary.slowestHookMs) : 0,
        slowestHookCommand: (summary?.slowestHookCommand as string) || '',
      },
      spans,
    };
  }

  /**
   * Sessions list, app = REPO. Reads the flat `agent_session_summary` rollup
   * (one row/session) — a bounded, paginated, repo-scoped scan.
   */
  async listSessions(
    scope: AgentSessionsScope,
    query: ListSessionsQuery,
    policy: SessionAccessPolicy,
    ports: AgentSessionsPorts,
  ): Promise<SessionsPage> {
    const { tenantId, appId } = scope;
    const { limit, offset, branch, agentType, model, workerKind, q, from, to, sort, dir, includeSubagents, origin, signal, topicId, topicFacet } = query;
    const topicActive = Boolean(topicId && topicFacet);

    const pinnedActor = pinnedActorFor(policy);
    if (mustMaskActors(policy) && query.actor) {
      throw new ValidationError(
        'This key cannot filter sessions by actor — it lacks agents.sessions.team.read.',
        'actor',
      );
    }
    const actor = pinnedActor ?? query.actor;

    const repoPin = pinnedActor !== null ? ' AND ActorId={actor:String}' : '';
    const repo = topicActive
      ? ''
      : query.repo ??
        (
          await queryRows<{ repo: string }>(
            this.client,
            `SELECT GitRepo AS repo FROM agent_session_summary FINAL
             WHERE TenantId={tenantId:String} AND AppId={appId:String} AND GitRepo != ''${repoPin}
             GROUP BY GitRepo ORDER BY sum(CostUsd) DESC LIMIT 1`,
            { tenantId, appId, ...(pinnedActor !== null ? { actor: pinnedActor } : {}) },
          )
        )[0]?.repo ??
        '';

    const filters = ['TenantId={tenantId:String}', 'AppId={appId:String}'];
    if (!topicActive) filters.push('GitRepo={repo:String}');
    if (!includeSubagents) filters.push("ParentSessionId = ''");
    if (topicActive) {
      const assignedTraces = `
           SELECT TraceId FROM trace_facets
           WHERE TenantId={tenantId:String} AND AppId={appId:String}
             AND Facet={topicFacet:String} AND TopicId={topicId:String} AND IsDeleted=0
             AND MapVersion=(
               SELECT max(MapVersion) FROM trace_topic_maps FINAL
               WHERE TenantId={tenantId:String} AND AppId={appId:String}
                 AND Facet={topicFacet:String} AND IsDeleted=0
             )`;
      filters.push(
        topicFacet === 'issues'
          ? `(TraceId IN (${assignedTraces}
         ) OR SessionId IN (
           SELECT ParentSessionId FROM agent_session_summary FINAL
           WHERE TenantId={tenantId:String} AND AppId={appId:String}
             AND ParentSessionId != '' AND TraceId IN (${assignedTraces}
             )
         ))`
          : `TraceId IN (${assignedTraces}
         )`,
      );
      if (topicFacet !== 'issues') filters.push("(Origin != 'agent' OR ParentSessionId != '')");
    }
    if (branch) filters.push('GitBranch={branch:String}');
    if (agentType) filters.push('AgentType={agentType:String}');
    if (signal) filters.push(`(${SIGNAL_PREDICATES[signal]})`);
    if (model) filters.push('has(Models, {model:String})');
    if (workerKind) filters.push('WorkerKind={workerKind:String}');
    if (actor) filters.push('ActorId={actor:String}');
    if (q) filters.push('positionCaseInsensitive(Title, {q:String}) > 0');
    if (from) filters.push('StartedAt >= parseDateTimeBestEffort({from:String})');
    if (to) filters.push('StartedAt <= parseDateTimeBestEffort({to:String})');
    const baseWhere = filters.join(' AND ');
    const originLiterals = origin
      ? [...new Set(origin.split(','))]
          .map((t) => ORIGIN_LITERALS.get(t))
          .filter((literal): literal is string => literal !== undefined)
      : [];
    const originClause = originLiterals.length ? `Origin IN (${originLiterals.join(', ')})` : '';
    const where = originClause ? `${baseWhere} AND ${originClause}` : baseWhere;
    const orderBy = `${SORT_COLUMNS[sort]} ${dir === 'asc' ? 'ASC' : 'DESC'}`;
    const vocabWhere =
      'TenantId={tenantId:String} AND AppId={appId:String} AND GitRepo={repo:String}' +
      (pinnedActor !== null ? ' AND ActorId={actor:String}' : '');
    const vocabParams = { tenantId, appId, repo, ...(pinnedActor !== null ? { actor: pinnedActor } : {}) };
    const params = {
      tenantId,
      appId,
      repo,
      limit,
      offset,
      ...(branch ? { branch } : {}),
      ...(agentType ? { agentType } : {}),
      ...(model ? { model } : {}),
      ...(workerKind ? { workerKind } : {}),
      ...(actor ? { actor } : {}),
      ...(q ? { q } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(topicActive ? { topicId, topicFacet } : {}),
    };

    const listPromise = queryRows<Record<string, unknown>>(
      this.client,
      `SELECT TraceId AS traceId, SessionId AS sessionId, Title AS title, AgentType AS agentType, ActorId AS actorId,
              WorkerKind AS workerKind, GitRepo AS project, GitBranch AS branch, toString(StartedAt) AS startedAt,
              if(EndedAt > StartedAt, dateDiff('millisecond', StartedAt, EndedAt), 0) AS durationMs,
              TurnCount AS turnCount, ToolCallCount AS toolCallCount, ErrorCount AS errorCount, CostUsd AS costUsd, Models AS models,
              UserTurnCount AS userTurnCount, RejectedToolCallCount AS rejectedToolCallCount, Origin AS origin
       FROM agent_session_summary FINAL WHERE ${where}
       ORDER BY ${orderBy} LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      params,
    );
    const totalPromise = queryRows<{ total: string }>(
      this.client,
      `SELECT count() AS total FROM agent_session_summary FINAL WHERE ${where}`,
      params,
    );
    const originCountsPromise = topicActive
      ? Promise.resolve([] as { interactive: string; agent: string; worker: string }[])
      : queryRows<{ interactive: string; agent: string; worker: string }>(
          this.client,
          `SELECT countIf(Origin IN ('', 'interactive')) AS interactive,
                  countIf(Origin = 'agent') AS agent,
                  countIf(Origin = 'worker') AS worker
           FROM agent_session_summary FINAL WHERE ${baseWhere}`,
          params,
        );

    const vocab = topicActive
      ? { branches: [] as string[], actors: [] as string[], agentTypes: [] as string[], models: [] as string[], workerKinds: [] as string[] }
      : await (async () => {
          const [branches, actors, agentTypes, models, workerKinds] = await Promise.all([
            queryRows<{ branch: string }>(
              this.client,
              `SELECT GitBranch AS branch FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND GitBranch != ''
               GROUP BY GitBranch ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            queryRows<{ actor: string }>(
              this.client,
              `SELECT ActorId AS actor FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND ActorId != ''
               GROUP BY ActorId ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            queryRows<{ agentType: string }>(
              this.client,
              `SELECT AgentType AS agentType FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND AgentType != ''
               GROUP BY AgentType ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            queryRows<{ model: string }>(
              this.client,
              `SELECT arrayJoin(Models) AS model FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND notEmpty(Models)
               GROUP BY model ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            queryRows<{ workerKind: string }>(
              this.client,
              `SELECT WorkerKind AS workerKind FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND WorkerKind != ''
               GROUP BY WorkerKind ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
          ]);
          return {
            branches: branches.map((b) => b.branch),
            actors: actors.map((a) => a.actor),
            agentTypes: agentTypes.map((a) => a.agentType),
            models: models.map((m) => m.model),
            workerKinds: workerKinds.map((w) => w.workerKind),
          };
        })();

    const [list, totalRow, originCountRows] = await Promise.all([listPromise, totalPromise, originCountsPromise]);
    const originCountRow = originCountRows[0];

    const actorIds = [...new Set([...vocab.actors, ...list.map((r) => r.actorId as string)])];
    const actorNames = mustMaskActors(policy)
      ? Object.fromEntries(actorIds.map((id) => [id, ANONYMOUS_ACTOR_LABEL]))
      : await ports.actorNames.resolve(actorIds);

    const outcomeOf = await ports.prOutcomes.forSessions(list.map((r) => r.traceId as string));

    return {
      repo,
      scope: scopeLabel(policy),
      total: Number(totalRow[0]?.total ?? 0),
      ...(originCountRow
        ? {
            originCounts: {
              interactive: Number(originCountRow.interactive ?? 0),
              agent: Number(originCountRow.agent ?? 0),
              worker: Number(originCountRow.worker ?? 0),
            },
          }
        : {}),
      branches: vocab.branches,
      actors: vocab.actors,
      actorNames,
      agentTypes: vocab.agentTypes,
      models: vocab.models,
      workerKinds: vocab.workerKinds,
      sessions: list.map((r) => ({
        traceId: r.traceId as string,
        sessionId: (r.sessionId as string) || (r.traceId as string),
        title: (r.title as string) || null,
        agentType: r.agentType as string,
        actorId: r.actorId as string,
        workerKind: (r.workerKind as string) || null,
        project: (r.project as string) || null,
        branch: (r.branch as string) || null,
        startedAt: new Date(String(r.startedAt).replace(' ', 'T') + 'Z').toISOString(),
        durationMs: Number(r.durationMs) > 0 ? Number(r.durationMs) : null,
        turnCount: Number(r.turnCount),
        toolCallCount: Number(r.toolCallCount),
        errorCount: Number(r.errorCount),
        userTurnCount: Number(r.userTurnCount),
        rejectedToolCallCount: Number(r.rejectedToolCallCount),
        costUsd: knownCost(Number(r.costUsd)),
        models: (r.models as string[]) ?? [],
        origin: (r.origin as string) ?? '',
        prOutcomes: outcomeOf(r.traceId as string),
      })),
    };
  }
}
