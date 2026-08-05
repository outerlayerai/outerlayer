import "server-only";

/**
 * AgentSessionsService — the domain's ClickHouse + Supabase reads. Every
 * method is scoped by the caller's `AgentSessionsContext` (the verified
 * tenant+app pair plus the RLS-scoped `db` the request-context resolver
 * opened) — `createTenantReadClient` enforces the ClickHouse tenant
 * boundary, and `resolveAgentSessionScope` enforces the actor-privacy seam
 * that has no RLS backstop. The service never opens a Supabase client
 * itself; `ctx.db` is resolved once at the request boundary
 * (`request-context.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTenantReadClient } from "@/lib/analytics/client";
import { tenantChQuery, fetchSessionOutcomeScores, getSessionListOutcomes } from "@/lib/adapters";
import { OAUTH_STATE_SECRET } from "@/config-global.server";
import type { TenantContext } from "@/lib/analytics/tenant-context";

import { signImageRefs } from "./blob-url";
import { resolveAgentSessionScope, scopedActorId } from "./scope";
import { resolveActorNames } from "./resolve-actor-names";
import { findEditRetryLoop } from "./trajectory-signals";
import { ORIGIN_LITERALS, type ListSessionsQuery } from "./list-query";
import type { AgentSessionDetail, AgentFinding, AgentFindingsResponse, SessionsPage } from "./types";

/** The verified tenant context plus the RLS-scoped client to run Supabase
 * reads through — the service takes both, never constructs either. */
export interface AgentSessionsContext extends TenantContext {
  db: SupabaseClient;
}

// The UI never renders more than ~4k chars of any single input/output (it
// slices to 4000). Shipping more is pure waste that makes a large session's
// detail response — and the browser parse of it — huge. Cap a hair above the
// display slice so nothing visible is lost.
const IO_CAP = 4096;
const REASONING_CAP = 1024;
/** UTF8-safe char cap, so the wire payload of one span is bounded. */
const capText = (s: string | null, max: number): string | null =>
  s && s.length > max ? [...s].slice(0, max).join("") : s;

/**
 * The converter stores turn/tool I/O in the OTLP gen_ai messages shape —
 * `[{"role":"user","content":"…"}]` — because the Input/Output columns are
 * shared with every other span producer. The transcript UI wants the words,
 * not the wire shape: unwrap a messages array to its joined content strings.
 * Anything that isn't that exact shape passes through untouched (plain
 * strings, tool JSON payloads, legacy rows).
 */
function unwrapMessages(raw: string | null): string | null {
  if (!raw || raw[0] !== "[") return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (m) => typeof m === "object" && m !== null && "role" in m && "content" in m,
      )
    ) {
      return (parsed as { content: unknown }[])
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
    }
  } catch {
    /* not JSON — return as-is */
  }
  return raw;
}

/**
 * Image refs ride Metadata['images'] as a JSON array ({sha256, mediaType});
 * the bytes are served separately by the blob route. Parse it into a typed
 * field so the client renders <img> without touching raw metadata. The
 * detail response then stamps each ref with a signed, expiring token
 * (`blob-url.ts`) — the sha256 alone does not open the bytes.
 */
function parseImages(m: Record<string, string>): { sha256: string; mediaType: string }[] {
  if (!m.images) return [];
  try {
    const arr = JSON.parse(m.images) as { sha256?: unknown; mediaType?: unknown }[];
    return arr
      .filter((i) => typeof i?.sha256 === "string")
      .map((i) => ({
        sha256: String(i.sha256),
        mediaType: typeof i.mediaType === "string" ? i.mediaType : "image/png",
      }));
  } catch {
    return [];
  }
}

/**
 * Sortable columns — a closed map from API name to column expression. Caller
 * input never reaches the SQL string directly: `list-query.ts`'s zod enum
 * rejects an unknown sort key before it gets here, and the ORDER BY is
 * looked up in this map only.
 */
const SORT_COLUMNS = {
  startedAt: "StartedAt",
  cost: "CostUsd",
  errors: "ErrorCount",
  turns: "TurnCount",
  steering: "UserTurnCount",
  // Failed tool calls ÷ tool calls, zero when nothing ran — the same
  // definition (and divide-by-zero rule) the fleet dashboards use, so a
  // session's rate here matches the rate its branch shows there.
  toolErrorRate: "if(ToolCallCount > 0, ErrorCount / ToolCallCount, 0)",
} as const;

/**
 * Trajectory-signal filter token → SQL predicate over the summary columns.
 * A closed map like ORIGIN_LITERALS: the zod enum rejects anything else, and
 * the WHERE clause is assembled from these predicates only. The tokens are a
 * fixed taxonomy (documented in packages/observability-service/docs/
 * trajectory-signals.md), not a data-driven vocabulary: every bucket exists
 * for every fleet, matched or not. Tokens name the observable event, never
 * an interpretation: `hands-on` means a human typed again after the initial
 * ask (a correction, an answer, or a new task all match — the counter can't
 * tell them apart, so the name doesn't claim to). `provider-errors` counts
 * api_error session events — the model provider failing, not the agent's
 * own tool calls (that's `tool-errors`). `clean` is the conjunction of every
 * other bucket's negation — a session is clean only when NO signal fired.
 */
const SIGNAL_PREDICATES = {
  "hands-on": "UserTurnCount > 1",
  denied: "RejectedToolCallCount > 0",
  "tool-errors": "ErrorCount > 0",
  "provider-errors": "ApiErrorCount > 0",
  clean: "UserTurnCount <= 1 AND RejectedToolCallCount = 0 AND ErrorCount = 0 AND ApiErrorCount = 0",
} as const;

interface FindingRow {
  id: string;
  detector_id: string;
  severity: string;
  summary: string;
  suggestion: string | null;
  cost_usd: number | null;
  session_count: number;
  session_ids: unknown;
  project: string | null;
  computed_at: string;
}

interface ThemeRow {
  id: string;
  label: string;
  description: string;
  severity: string;
  evidence_session_ids: unknown;
  computed_at: string;
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

class AgentSessionsService {
  /**
   * Full span tree + rollup identity for one trace, tier-aware. Returns
   * `null` both when the trace genuinely doesn't exist AND when the caller
   * lacks `team.read` and the session belongs to another actor — the
   * caller (a React Server Component (RSC) page, via `notFound()`) must not distinguish the two, so
   * there is no existence oracle for another developer's transcript.
   */
  async getSessionDetail(ctx: AgentSessionsContext, traceId: string): Promise<AgentSessionDetail | null> {
    // Row-policy-scoped read: tenant + app pinned from the verified
    // context — ClickHouse enforces the tenant boundary.
    const ch = createTenantReadClient({ tenantId: ctx.tenantId, appId: ctx.appId });
    if (!ch) throw new Error("ClickHouse not configured");
    const { tenantId, appId } = ctx;
    const params: Record<string, unknown> = { tenantId, appId, traceId };
    // Identity predicates only — sort-key columns, version-stable, so PREWHERE
    // under FINAL keeps them correct and they cut the scan; see the span query.
    let identity =
      "TenantId = {tenantId:String} AND AppId = {appId:String} AND TraceId = {traceId:String}";

    // FINAL on otel_traces cannot prune by TraceId (not a sort-key prefix), so
    // an unbounded read FINAL-merges entire monthly partitions, and at backfill
    // scale that can exceed the read role's per-query memory limit. The scan is
    // therefore bounded by the trace's [min, max] Timestamp from the tiny
    // otel_traces_trace_id_ts lookup, the same way the gateway trace routes
    // bound theirs. A lookup miss/failure falls back to the unbounded query —
    // identical behavior, worst-case identical cost.
    try {
      const rangeRows = await ch
        .query({
          query: `
          SELECT min(Start) AS start, max(End) AS end
          FROM otel_traces_trace_id_ts
          WHERE TraceId = {traceId:String} AND AppId = {appId:String} AND TenantId = {tenantId:String}
          GROUP BY TraceId`,
          query_params: params,
          format: "JSONEachRow",
        })
        .then((r) => r.json<{ start: string; end: string }>());
      if (rangeRows[0]?.start && rangeRows[0]?.end) {
        identity += " AND Timestamp >= {tsRangeStart:DateTime64(9)} AND Timestamp <= {tsRangeEnd:DateTime64(9)}";
        params.tsRangeStart = rangeRows[0].start;
        params.tsRangeEnd = rangeRows[0].end;
      }
    } catch {
      // unbounded fallback — never turn a lookup failure into a 500
    }

    const [rows, summaryRows] = await Promise.all([
      ch
        .query({
          query: `
          SELECT SpanId AS spanId, ParentSpanId AS parentSpanId, SpanName AS name, Timestamp AS startTime,
                 Duration AS durationMs, StatusCode AS statusCode, StatusMessage AS statusMessage,
                 Model AS model, Cost AS cost, InputTokens AS inputTokens, OutputTokens AS outputTokens,
                 -- Payload cap (perf): a mega-session (thousands of tool calls,
                 -- each with a multi-KB Bash/Read output) ships megabytes of I/O
                 -- the UI never shows. Tool I/O is plain text, so truncate it at
                 -- the CH boundary. Turn I/O carries the gen_ai messages-array
                 -- JSON that unwrapMessages must parse whole, so it stays intact
                 -- here and is capped in JS after unwrapping. UTF8-safe substring
                 -- avoids splitting a codepoint.
                 if(SpanName LIKE 'agent.tool.%', substringUTF8(Input, 1, 2048), Input) AS input,
                 if(SpanName LIKE 'agent.tool.%', substringUTF8(Output, 1, ${IO_CAP}), Output) AS output,
                 substringUTF8(SpanAttributes['outerlayer.reasoning'], 1, ${REASONING_CAP}) AS reasoning,
                 CaptureTier AS captureTier, AgentType AS agentType, ActorId AS actorId,
                 Metadata AS metadata
          FROM otel_traces FINAL
          -- Explicit PREWHERE (memory): under FINAL, ClickHouse does NOT
          -- auto-move WHERE conditions to PREWHERE, so a plain WHERE reads
          -- every selected column — including the multi-KB Input/Output/
          -- SpanAttributes/Metadata payloads — for the ENTIRE scanned range
          -- of the tenant+app before filtering to this trace. Over a range
          -- spanning a busy multi-day window that allocation alone can exceed
          -- the read role's per-query memory limit. PREWHERE filters on the
          -- skinny identity columns first, so the fat payloads are
          -- decompressed only for this trace's rows. Only sort-key columns
          -- belong here: they are identical across ReplacingMergeTree row
          -- versions, which is what makes pre-merge filtering correct under
          -- FINAL. SpanName is not in the sort key, so it stays in WHERE.
          PREWHERE ${identity}
          WHERE SpanName LIKE 'agent.%'
          ORDER BY Timestamp ASC, SpanName ASC`,
          query_params: params,
          format: "JSONEachRow",
        })
        .then((r) => r.json<Record<string, unknown>>()),
      // The rollup row is the ingest-stamped truth for identity, origin, cost
      // and duration — the list reads it, so the detail MUST agree.
      ch
        .query({
          query: `
          SELECT SessionId AS sessionId, WorkerKind AS workerKind, CostUsd AS costUsd,
                 if(EndedAt > StartedAt, dateDiff('millisecond', StartedAt, EndedAt), 0) AS durationMs,
                 UserTurnCount AS userTurnCount, RejectedToolCallCount AS rejectedToolCallCount,
                 PermissionPromptCount AS permissionPromptCount, ApiErrorCount AS apiErrorCount,
                 HookExecutionCount AS hookExecutionCount, HookDurationMs AS hookDurationMs,
                 HookUnreportedCount AS hookUnreportedCount, SlowestHookMs AS slowestHookMs,
                 SlowestHookCommand AS slowestHookCommand
          FROM agent_session_summary FINAL
          WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND TraceId = {traceId:String}
          LIMIT 1`,
          query_params: params,
          format: "JSONEachRow",
        })
        .then((r) => r.json<Record<string, unknown>>()),
    ]);

    if (rows.length === 0) return null;
    const summary = summaryRows[0] ?? null;

    const root = rows.find((r) => r.name === "agent.session") ?? rows[0]!;

    // Actor privacy: a transcript belongs to its developer. Without
    // team.read, a session attributed to another seat is indistinguishable
    // from a nonexistent one — same null, no existence oracle.
    const sessionScope = await resolveAgentSessionScope(ctx);
    if (sessionScope.kind === "self" && (root.actorId as string) !== sessionScope.actorId) {
      return null;
    }
    const meta = (root.metadata as Record<string, string>) ?? {};
    const iso = (t: unknown) => new Date(String(t).replace(" ", "T") + "Z").toISOString();

    // Image URLs are minted for THIS caller and expire (see blob-url.ts), so
    // the transcript a member is served can't be replayed by a colleague who
    // finds one of its links.
    const imageBinding = { tenantId, appId, userId: ctx.userId };

    const spans = await Promise.all(rows.map(async (r) => {
      const m = (r.metadata as Record<string, string>) ?? {};
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
        // Turn I/O arrives whole (unwrapMessages needs the full messages-array
        // JSON); cap the unwrapped words here so a giant assistant/user message
        // doesn't ride the wire. Tool I/O was already capped in SQL.
        input: capText(unwrapMessages((r.input as string) || null), IO_CAP),
        output: capText(unwrapMessages((r.output as string) || null), IO_CAP),
        reasoning: (r.reasoning as string) || null,
        metadata: m,
        images: await signImageRefs(OAUTH_STATE_SECRET, parseImages(m), imageBinding),
      };
    }));

    const turns = rows.filter((r) => String(r.name).startsWith("agent.turn."));
    // Cost: the rollup CostUsd is what the LIST shows (the session's exact
    // total) — prefer it so the two surfaces agree. The span sum backfills
    // traces with no rollup row (older ingests) AND rollup rows carrying no
    // cost, where the spans are the only remaining evidence.
    const spanCostSum = rows
      .filter((r) => String(r.name).startsWith("agent.turn."))
      .reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const summaryCost = summary ? Number(summary.costUsd) : 0;
    const summaryDuration = summary ? Number(summary.durationMs) : 0;
    const rootDuration = Number(root.durationMs) || 0;
    const actorNames = await resolveActorNames(tenantId, [root.actorId as string]);

    // Trajectory signals. Counters come from the rollup (the ingest-stamped
    // truth the list shows, so the two surfaces agree); rows ingested before
    // the steering columns existed read 0 there, matching the list. Denials
    // fall back to the span tree's toolStatus (metrics-tier metadata), which
    // predates the rollup column. The edit-retry loop can only come from the
    // span sequence — the rollup deliberately keeps no ordering.
    const num = (v: unknown) => Number(v) || 0;
    const rejectedFromSpans = rows.filter(
      (r) =>
        String(r.name).startsWith("agent.tool.") &&
        ((r.metadata as Record<string, string>) ?? {}).toolStatus === "rejected",
    ).length;
    const editRetryLoop = findEditRetryLoop(
      rows.map((r) => ({
        name: String(r.name),
        statusCode: String(r.statusCode),
        metadata: (r.metadata as Record<string, string>) ?? {},
      })),
    );

    // PR outcomes for the PR(s) this session produced — grouped by PR, keyed
    // on this trace. Rides the session payload (no second round-trip); a
    // failure here must not blank the whole session page, so it degrades to []
    // and the strip doesn't render.
    const chQuery = tenantChQuery({ tenantId, appId });
    const prOutcomes = chQuery
      ? await fetchSessionOutcomeScores(ctx.db, chQuery, {
          tenantId,
          appId,
          traceId,
        }).catch(() => [])
      : [];

    return {
      prOutcomes,
      session: {
        traceId,
        sessionId: (summary?.sessionId as string) || traceId,
        title: meta.title || null,
        agentType: root.agentType as string,
        actorId: root.actorId as string,
        actorName: actorNames[root.actorId as string] ?? (root.actorId as string),
        workerKind: (summary?.workerKind as string) || meta.workerKind || null,
        project: meta.gitRepo || meta.cwd || null,
        startedAt: iso(root.startTime),
        durationMs: summaryDuration > 0 ? summaryDuration : rootDuration > 0 ? rootDuration : null,
        turnCount: turns.length,
        toolCallCount: rows.filter((r) => String(r.name).startsWith("agent.tool.")).length,
        errorCount: rows.filter((r) => String(r.name).startsWith("agent.tool.") && r.statusCode === "2").length,
        costUsd: knownCost(summaryCost > 0 ? summaryCost : spanCostSum),
        models: [...new Set(turns.map((r) => r.model as string).filter(Boolean))],
        captureTier: (root.captureTier as string) || "full",
        userTurnCount: summary ? num(summary.userTurnCount) : turns.filter((r) => r.name === "agent.turn.user").length,
        rejectedToolCallCount: summary ? num(summary.rejectedToolCallCount) : rejectedFromSpans,
        permissionPromptCount: summary ? num(summary.permissionPromptCount) : 0,
        apiErrorCount: summary ? num(summary.apiErrorCount) : 0,
        editRetryLoop,
        hookExecutionCount: summary ? num(summary.hookExecutionCount) : 0,
        hookDurationMs: summary ? num(summary.hookDurationMs) : 0,
        hookUnreportedCount: summary ? num(summary.hookUnreportedCount) : 0,
        slowestHookMs: summary ? num(summary.slowestHookMs) : 0,
        slowestHookCommand: (summary?.slowestHookCommand as string) || "",
      },
      spans,
    };
  }

  /**
   * Findings + error themes for one app — a Supabase/RLS read, no
   * ClickHouse. Rows are computed offline by the gateway's nightly findings
   * job (the only writer); this is a read-only projection.
   */
  async getFindings(ctx: AgentSessionsContext): Promise<AgentFindingsResponse> {
    const supabase = ctx.db;

    const [findingsRes, themesRes] = await Promise.all([
      supabase
        .from("agent_finding")
        .select(
          "id, detector_id, severity, summary, suggestion, cost_usd, session_count, session_ids, project, computed_at",
        )
        .eq("app_id", ctx.appId)
        // Dollars first, nulls last — the same order the detectors rank by.
        .order("cost_usd", { ascending: false, nullsFirst: false })
        .order("session_count", { ascending: false }),
      supabase
        .from("agent_theme")
        .select("id, label, description, severity, evidence_session_ids, computed_at")
        .eq("app_id", ctx.appId)
        .order("severity", { ascending: true }),
    ]);
    if (findingsRes.error) throw new Error(`agent_finding read: ${findingsRes.error.message}`);
    if (themesRes.error) throw new Error(`agent_theme read: ${themesRes.error.message}`);

    const findings = (findingsRes.data ?? []) as FindingRow[];
    const themes = (themesRes.data ?? []) as ThemeRow[];
    const computedAt =
      [...findings, ...themes]
        .map((r) => r.computed_at)
        .sort()
        .at(-1) ?? null;

    return {
      findings: findings.map(
        (f): AgentFinding => ({
          id: f.id,
          detectorId: f.detector_id,
          severity: f.severity,
          summary: f.summary,
          suggestion: f.suggestion,
          costUsd: f.cost_usd === null ? null : Number(f.cost_usd),
          sessionCount: f.session_count,
          sessionIds: asStringArray(f.session_ids),
          project: f.project,
        }),
      ),
      themes: themes.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        severity: t.severity,
        evidenceSessionIds: asStringArray(t.evidence_session_ids),
      })),
      computedAt,
    };
  }

  /**
   * Sessions list, app = REPO. Reads the flat `agent_session_summary` rollup
   * (one row/session) — a bounded, paginated, repo-scoped scan instead of
   * grouping the whole span table. Scoped to the app's dominant repo (or an
   * explicit `repo`) so the list matches the overview; filterable by branch +
   * agent + developer + date range, searchable by title, sortable by the
   * numeric columns.
   */
  async listSessions(ctx: AgentSessionsContext, query: ListSessionsQuery): Promise<SessionsPage> {
    const ch = createTenantReadClient({ tenantId: ctx.tenantId, appId: ctx.appId });
    if (!ch) throw new Error("ClickHouse not configured");
    const { tenantId, appId } = ctx;
    const { limit, offset, branch, agentType, model, workerKind, q, from, to, sort, dir, includeSubagents, origin, signal, topicId, topicFacet } = query;
    // A topic drill-down shows the whole cluster, so it spans repos rather than
    // pinning to the app's dominant repo.
    const topicActive = Boolean(topicId && topicFacet);

    // Actor privacy: without team.read, `?actor=` is NOT a free
    // filter — the list is pinned to the caller's own seat, whatever the
    // query said. See scope.ts for the policy.
    const scope = await resolveAgentSessionScope(ctx);
    const pinnedActor = scopedActorId(scope);
    const actor = pinnedActor ?? query.actor;

    // dominant repo unless one is named — same scope rule as the overview.
    // Also actor-pinned under self scope: "the repo the TEAM spends most on"
    // is team data; a self-scoped caller's default repo is their own.
    // A topic drill-down spans repos, so it neither pins a repo nor needs the
    // dominant-repo scan (nor the repo-scoped filter vocabularies below).
    const repoPin = pinnedActor !== null ? " AND ActorId={actor:String}" : "";
    const repo = topicActive
      ? ""
      : query.repo ??
        (
          await rows<{ repo: string }>(
            ch,
            `SELECT GitRepo AS repo FROM agent_session_summary FINAL
             WHERE TenantId={tenantId:String} AND AppId={appId:String} AND GitRepo != ''${repoPin}
             GROUP BY GitRepo ORDER BY sum(CostUsd) DESC LIMIT 1`,
            { tenantId, appId, ...(pinnedActor !== null ? { actor: pinnedActor } : {}) },
          )
        )[0]?.repo ??
        "";

    const filters = ["TenantId={tenantId:String}", "AppId={appId:String}"];
    // Repo-pin the list normally; a topic drill-down deliberately spans repos.
    if (!topicActive) filters.push("GitRepo={repo:String}");
    // Top-level sessions only, unless children are explicitly requested.
    // Subagent rows carry the parent's SessionId in ParentSessionId; they
    // belong inside the parent's detail view, not as list siblings.
    if (!includeSubagents) filters.push("ParentSessionId = ''");
    // The caller's origin filter stays OUT of `filters`: the segment badges
    // need per-origin counts over the otherwise-filtered population, so the
    // base WHERE excludes it and only the list/count queries append it.
    // Topic drill-down: keep only ROOT sessions attributed to this topic
    // under the facet's active map version — the same attribution the Topics
    // page counts, so the list length matches the topic's session count.
    // Enrichment classifies every transcript (subagents included), so for
    // the issues facet a session qualifies when its OWN trace matched OR any
    // of its subagent transcripts did (children carry the parent's SessionId
    // in ParentSessionId). Task topics count top-level transcripts only, so
    // the own-trace match alone is the whole set.
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
        topicFacet === "issues"
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
      // Task/steering topic counts exclude agent-origin ROOT sessions
      // (templated fan-outs), so those drill-downs and their counts must too —
      // otherwise the list length wouldn't match the number on the Topics page.
      // Issues stays origin-blind (a failure in an agent run is a real failure),
      // so no exclusion there. The guard targets top-level agent runs only: a
      // subagent row always carries Origin='agent', so the OR-guard keeps it
      // eligible and leaves subagent visibility to includeSubagents (which drops
      // the ParentSessionId pin). Under the default root-only pin the guard is
      // equivalent to a bare Origin != 'agent', so the count==list contract
      // holds. Composes with an explicit origin filter: `origin=agent` in a
      // drill-down legitimately empties.
      if (topicFacet !== "issues") filters.push("(Origin != 'agent' OR ParentSessionId != '')");
    }
    if (branch) filters.push("GitBranch={branch:String}");
    if (agentType) filters.push("AgentType={agentType:String}");
    // In the base WHERE (not alongside origin): the segment badges promise
    // "the list under that segment", so they must reflect an active signal
    // filter like any other filter.
    if (signal) filters.push(`(${SIGNAL_PREDICATES[signal]})`);
    if (model) filters.push("has(Models, {model:String})");
    if (workerKind) filters.push("WorkerKind={workerKind:String}");
    if (actor) filters.push("ActorId={actor:String}");
    // positionCaseInsensitive over ILIKE: the needle is a literal, so a user
    // typing % or _ searches for those characters instead of wildcarding.
    if (q) filters.push("positionCaseInsensitive(Title, {q:String}) > 0");
    if (from) filters.push("StartedAt >= parseDateTimeBestEffort({from:String})");
    if (to) filters.push("StartedAt <= parseDateTimeBestEffort({to:String})");
    const baseWhere = filters.join(" AND ");
    // Optional origin filter, composed independently of includeSubagents:
    // origin=agent lists top-level agent runs, origin=agent&includeSubagents=1
    // adds their subagents. Tokens select literals from ORIGIN_LITERALS —
    // validated by list-query.ts, so only our own literals land in the SQL.
    // `.get()` on an unknown token yields undefined and filters out, so only
    // literals this module owns can reach the clause.
    const originLiterals = origin
      ? [...new Set(origin.split(","))]
          .map((t) => ORIGIN_LITERALS.get(t))
          .filter((literal): literal is string => literal !== undefined)
      : [];
    const originClause = originLiterals.length ? `Origin IN (${originLiterals.join(", ")})` : "";
    const where = originClause ? `${baseWhere} AND ${originClause}` : baseWhere;
    const orderBy = `${SORT_COLUMNS[sort]} ${dir === "asc" ? "ASC" : "DESC"}`;
    // Filter vocabularies obey the same scope: a self-scoped caller's
    // dropdowns describe THEIR sessions, not the team's.
    const vocabWhere =
      "TenantId={tenantId:String} AND AppId={appId:String} AND GitRepo={repo:String}" +
      (pinnedActor !== null ? " AND ActorId={actor:String}" : "");
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

    // Fire the list + count first so they run concurrently with the filter
    // vocabularies below (or alone, under a topic drill-down).
    const listPromise = rows<Record<string, unknown>>(
      ch,
      `SELECT TraceId AS traceId, SessionId AS sessionId, Title AS title, AgentType AS agentType, ActorId AS actorId,
              WorkerKind AS workerKind, GitRepo AS project, GitBranch AS branch, toString(StartedAt) AS startedAt,
              if(EndedAt > StartedAt, dateDiff('millisecond', StartedAt, EndedAt), 0) AS durationMs,
              TurnCount AS turnCount, ToolCallCount AS toolCallCount, ErrorCount AS errorCount, CostUsd AS costUsd, Models AS models,
              UserTurnCount AS userTurnCount, RejectedToolCallCount AS rejectedToolCallCount, Origin AS origin
       FROM agent_session_summary FINAL WHERE ${where}
       ORDER BY ${orderBy} LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      params,
    );
    const totalPromise = rows<{ total: string }>(
      ch,
      `SELECT count() AS total FROM agent_session_summary FINAL WHERE ${where}`,
      params,
    );
    // Per-origin totals for the People | Agents | All segment badges. Runs the
    // base WHERE without the caller's origin filter, so each badge shows
    // exactly how many rows that segment would list under the other active
    // filters. Skipped under a topic drill-down: the segments aren't shown
    // there, and the topic subqueries make an extra scan expensive.
    const originCountsPromise = topicActive
      ? Promise.resolve([] as { interactive: string; agent: string; worker: string }[])
      : rows<{ interactive: string; agent: string; worker: string }>(
          ch,
          `SELECT countIf(Origin IN ('', 'interactive')) AS interactive,
                  countIf(Origin = 'agent') AS agent,
                  countIf(Origin = 'worker') AS worker
           FROM agent_session_summary FINAL WHERE ${baseWhere}`,
          params,
        );

    // The five filter vocabularies are repo-scoped, so a cross-repo topic
    // drill-down neither pins a repo nor uses them — skip those five FINAL
    // scans entirely under a topic filter (empty dropdowns; the topic chip is
    // the active filter). This is the bulk of the query fan-out.
    const vocab = topicActive
      ? { branches: [] as string[], actors: [] as string[], agentTypes: [] as string[], models: [] as string[], workerKinds: [] as string[] }
      : await (async () => {
          const [branches, actors, agentTypes, models, workerKinds] = await Promise.all([
            rows<{ branch: string }>(
              ch,
              `SELECT GitBranch AS branch FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND GitBranch != ''
               GROUP BY GitBranch ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            rows<{ actor: string }>(
              ch,
              `SELECT ActorId AS actor FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND ActorId != ''
               GROUP BY ActorId ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            // The supported-agent set is open (one adapter per agent) — the filter
            // vocabulary comes from the DATA, never a UI enum, so a new agent's
            // sessions are filterable the moment they land.
            rows<{ agentType: string }>(
              ch,
              `SELECT AgentType AS agentType FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND AgentType != ''
               GROUP BY AgentType ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            rows<{ model: string }>(
              ch,
              `SELECT arrayJoin(Models) AS model FROM agent_session_summary FINAL
               WHERE ${vocabWhere} AND notEmpty(Models)
               GROUP BY model ORDER BY count() DESC LIMIT 25`,
              vocabParams,
            ),
            rows<{ workerKind: string }>(
              ch,
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

    const actorNames = await resolveActorNames(tenantId, [
      ...vocab.actors,
      ...list.map((r) => r.actorId as string),
    ]);

    // Per-session PR outcomes for the list's Outcome column — ONE batched
    // read over this page's traces (wiring + failure handling live in
    // getSessionListOutcomes so they stay testable off the request path).
    const outcomeOf = await getSessionListOutcomes(ctx, ctx.db, list);

    return {
      repo,
      scope: scope.kind,
      total: Number(totalRow[0]?.total ?? 0),
      // Omitted (not zeroed) under a topic drill-down — the rollup didn't run.
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
        startedAt: new Date(String(r.startedAt).replace(" ", "T") + "Z").toISOString(),
        durationMs: Number(r.durationMs) > 0 ? Number(r.durationMs) : null,
        turnCount: Number(r.turnCount),
        toolCallCount: Number(r.toolCallCount),
        errorCount: Number(r.errorCount),
        userTurnCount: Number(r.userTurnCount),
        rejectedToolCallCount: Number(r.rejectedToolCallCount),
        costUsd: knownCost(Number(r.costUsd)),
        models: (r.models as string[]) ?? [],
        // Raw stored run origin ('' on legacy pre-Origin-column rows,
        // else interactive|agent|worker). The list UI labels rows from it.
        origin: (r.origin as string) ?? "",
        // PR outcomes for the PR(s) this session produced, grouped by PR.
        // Empty for the majority of sessions that never opened a PR.
        prOutcomes: outcomeOf(r.traceId as string),
      })),
    };
  }
}

/**
 * A stored cost of exactly 0 means "nothing priced this session", not "this
 * session was free": a session with turns always cost the provider something,
 * and the ingest stores 0 for a session whose model no price map knew. Reading
 * it back as null makes the UI render "—" instead of a confident `$0.00` — the
 * distinction matters, because a fabricated zero silently deflates every
 * cost-per-session and cost-per-repo rollup built on these rows.
 */
const knownCost = (v: number): number | null => (Number.isFinite(v) && v > 0 ? v : null);

type CH = NonNullable<ReturnType<typeof createTenantReadClient>>;
const rows = async <T>(ch: CH, query: string, params: Record<string, unknown>): Promise<T[]> =>
  (await ch.query({ query, query_params: params, format: "JSONEachRow" })).json<T>();

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const agentSessionsService = new AgentSessionsService();
