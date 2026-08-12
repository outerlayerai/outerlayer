/**
 * Topics read path — the active topic map for one app + facet. Shared by the
 * dashboard's Topics card and the gateway's `/v1/topics` route (and the
 * `list_topics` MCP tool), so it takes an {@link IClickHouseQuery} rather
 * than the Node-only `@clickhouse/client` type and reads NOTHING from
 * `process.env` — Workers have no ambient env, so every runtime knob comes in
 * through {@link TopicsRuntimeConfig}, built by each host from its own
 * config source (the dashboard from `process.env`, the gateway from its
 * bound `Env`).
 *
 * Generation (Stage 4 clustering + naming) stays with the dashboard — it
 * needs the clustering service, the model-provider clients, and a writable
 * ClickHouse identity, none of which a read-only gateway route has. This
 * module owns only what a read needs: the active map, its live counts, and
 * the samplable-row count that feeds the cold-start/regenerate gate.
 *
 * Listing reads the active (max MapVersion) map and counts live assignments
 * from trace_facets — so traces classified by the enrichment cron AFTER
 * generation are included. Counts are SESSION-denominated: every facet row is
 * attributed to its root agent session via the agent_session_summary rollup
 * (a subagent transcript credits its parent), so a workflow that fans out N
 * children counts once and the list matches what the sessions drill-down
 * shows. The task facet goes further and drops subagent rows entirely — task
 * topics describe what users ran, not the agent's internal chores — while
 * issues keep them (a failure inside a child is the session's failure).
 * Outcome metrics (error rate / latency / cost) are NOT live: generation
 * computes them over the sampled member traces and stores them on the map
 * row, so the list route reads them with zero otel_traces joins. The
 * topics-over-time trend uses the same rollup join for each session's start
 * time — no otel_traces span scan — and buckets over the data's own span
 * rather than a now()-relative window, so a backfilled corpus still charts.
 */

import type { TopicFacet, TopicsList } from '@repo/api-schemas';
import type { TopicsModelEnv } from '@repo/trace-topics';
import {
  resolveTopicsModelSelection,
  NO_MATCH_TOPIC_ID,
  BATCHED_EXTRACTOR_VERSION,
  STEERING_EXTRACTOR_VERSION,
} from '@repo/trace-topics';
import type { IClickHouseQuery } from '../client';
import { QUERY_TIMEOUT_SETTINGS } from '../shared';
import { generationFloorForFacet } from '@repo/api-schemas';

/** Safety cap on map rows fetched per generation, not a real limit — a map
 * targets tens of topics by design (resolve_min_cluster_size in
 * apps/topics-clustering/app/clustering.py keeps clusters at ~<=50-topic
 * granularity even at its 50k-vector ceiling). The list route must rank ALL
 * of a facet's topics by live session count before truncating to the
 * caller's limit (see {@link TopicsService.listTopics}), so this can't be
 * that limit — it exists only to bound a pathological map. */
export const MAX_MAP_TOPICS = 1000;

/** ClickHouse resource caps every lifted query in this module carries, on
 * top of {@link QUERY_TIMEOUT_SETTINGS} — bounds the blast radius of a
 * misbehaving query on the shared analytics cluster (see
 * `scripts/ci/check-clickhouse-client-guardrails.mjs`, which asserts every
 * `query(` call site here sets both). */
export const TOPICS_QUERY_SETTINGS = {
  ...QUERY_TIMEOUT_SETTINGS,
  max_memory_usage: 1_000_000_000,
  max_rows_to_read: 10_000_000,
} as const;

export interface TopicsScope {
  tenantId: string;
  appId: string;
  environment: string;
  /**
   * When scoping to the app's default environment, legacy rows stamped with
   * Environment='' belong to its view (same semantics as
   * buildEnvironmentWhereClause). Applies to trace_facets reads;
   * trace_topic_maps rows are always written with the canonical env name, so
   * map reads stay exact-match.
   */
  environmentIsDefault: boolean;
}

/**
 * Runtime knobs a host must inject — no `process.env` read lives in this
 * package. `modelEnv` feeds the embedding-dimension lookup the samplable-row
 * count needs (read-only; generation's own model-client construction is the
 * dashboard's concern). `minSummariesOverride` mirrors the dashboard's
 * `TOPICS_MIN_SUMMARIES` env var, resolved by the host before injection.
 */
export interface TopicsRuntimeConfig {
  modelEnv: TopicsModelEnv;
  minSummariesOverride?: number;
}

/** trace_facets env predicate — default env sweeps in legacy '' rows. */
export function facetsEnvClause(scope: TopicsScope): string {
  return scope.environmentIsDefault
    ? "(Environment = {environment:String} OR Environment = '')"
    : 'Environment = {environment:String}';
}

function scopeParams(scope: TopicsScope): Record<string, string> {
  return {
    tenantId: scope.tenantId,
    appId: scope.appId,
    environment: scope.environment,
  };
}

/**
 * The extractor version a generation pass requires of its sample (and that a
 * samplable-row count must match). Facet prompts version independently
 * (batched task/issues vs steering's own-pass extraction), and a version bump
 * re-drains history through the backfill sweeps — during which the corpus
 * holds BOTH generations of summary side by side. Rows written under an
 * older prompt encode different semantics, so counting them would promise a
 * map generation can't deliver.
 */
export function minExtractorVersionForFacet(facet: TopicFacet): number {
  return facet === 'steering' ? STEERING_EXTRACTOR_VERSION : BATCHED_EXTRACTOR_VERSION;
}

/**
 * Task and steering topics describe what USERS ran/typed, so subagent
 * transcripts are excluded from their counting; an unmatched LEFT JOIN row
 * carries ParentSessionId = '', so non-agent traces still pass. Issues keeps
 * subagent rows and attributes them to the parent via ROOT_SESSION_KEY.
 */
function facetRowScopeClause(facet: TopicFacet): string {
  return facet === 'issues' ? '' : "AND s.ParentSessionId = ''";
}

/**
 * Agent-origin exclusion is scoped to task/steering only — those facets
 * describe what USERS ran/typed, so templated agent fan-outs skew them.
 * Issues stays origin-blind: a failure inside an agent run is still a real
 * failure, so its counts and clustering include every origin.
 */
function agentOriginScopeClause(facet: TopicFacet): string {
  return facet === 'issues' ? '' : `AND ${NON_AGENT_ROOT_CLAUSE}`;
}

/**
 * Root-session attribution key for a trace_facets row `f` joined to the
 * agent_session_summary rollup as `s`: a subagent transcript credits its
 * parent (ParentSessionId is the parent's SessionId), a top-level session
 * credits itself, and a trace with no rollup row at all (plain OTLP traffic —
 * the LEFT JOIN filled '' defaults) stands as its own unit.
 */
const ROOT_SESSION_KEY =
  "if(s.ParentSessionId != '', s.ParentSessionId, if(s.SessionId != '', s.SessionId, f.TraceId))";

/**
 * Drops rows whose ROOT session was initiated programmatically (Origin='agent')
 * from the counting/trend population: those runs are templated fan-outs that
 * would otherwise dominate the per-topic session counts. The predicate keys on
 * the ROOT session's Origin, resolved through the root-session set — NOT on the
 * current trace's own Origin.
 */
const NON_AGENT_ROOT_CLAUSE = `${ROOT_SESSION_KEY} NOT IN (
        SELECT SessionId FROM agent_session_summary FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND ParentSessionId = ''
          AND SessionId != ''
          AND Origin = 'agent'
      )`;

/**
 * The rollup side of the attribution join, collapsed to one row per TraceId
 * (the ReplacingMergeTree key includes GitRepo/StartedAt, so FINAL alone
 * can't guarantee per-trace uniqueness) so the join never fans facet rows
 * out.
 */
const SESSION_ROLLUP_SUBQUERY = `
        SELECT TraceId,
               any(SessionId) AS SessionId,
               any(ParentSessionId) AS ParentSessionId,
               min(StartedAt) AS StartedAt
        FROM agent_session_summary FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
        GROUP BY TraceId`;

/**
 * WHERE fragment selecting exactly the rows a generation pass samples: ok
 * status, an embedding in the dimension generation clusters in, summaries
 * written by the facet's CURRENT extractor version, and — for task/steering —
 * no subagent transcripts or top-level programmatic runs. Issues keeps every
 * origin because a failure inside a child is a real failure of the session.
 *
 * The samplable-row count compiles from THIS fragment too (see
 * {@link TopicsService.countSamplableRows}), so the cold-start/regenerate gate
 * can never promise a map generation then refuse.
 */
export function samplableRowsClause(scope: TopicsScope, facet: TopicFacet): string {
  return `TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND ${facetsEnvClause(scope)}
        AND Facet = {facet:String}
        AND Status = 'ok'
        AND length(Embedding) = {dimension:UInt32}
        AND ExtractorVersion >= {minExtractorVersion:UInt32}
        AND IsDeleted = 0
        ${
          facet !== 'issues'
            ? `AND TraceId NOT IN (
          SELECT TraceId FROM agent_session_summary FINAL
          WHERE TenantId = {tenantId:String}
            AND AppId = {appId:String}
            AND (ParentSessionId != '' OR Origin = 'agent')
        )`
            : ''
        }`;
}

/**
 * Generation floor: the facet's default unless the host's config overrides
 * it — allows an environment with a thin-but-real corpus to opt into
 * earlier, thinner maps. Values below 5 can't form clusters at all and fall
 * back to the facet default.
 */
export function resolveGenerationFloor(facet: TopicFacet, minSummariesOverride?: number): number {
  return minSummariesOverride !== undefined && minSummariesOverride >= 5
    ? minSummariesOverride
    : generationFloorForFacet(facet);
}

/**
 * Embedding dimension for the samplable count, resolved from the injected
 * model env WITHOUT constructing model clients — reads must never require
 * model config. An invalid provider falls back to the provider defaults so a
 * misconfig breaks generation loudly, never the Topics GET.
 */
export function resolveCountDimension(modelEnv: TopicsModelEnv): number {
  try {
    return resolveTopicsModelSelection(modelEnv).embeddingDimension;
  } catch {
    return resolveTopicsModelSelection({}).embeddingDimension;
  }
}

/** Topics-over-time granularity bounds. */
const TREND_HOURLY_MAX_HOURS = 48;
const TREND_MAX_BUCKETS = 90;

/**
 * Fold per-topic-per-hour trend rows onto a data-anchored axis: the span from
 * the earliest to the latest bucket actually present, zero-filling gaps so
 * every topic's series is the same length as the returned `trendDays`.
 * Granularity adapts to that span — hourly while it fits within
 * {@link TREND_HOURLY_MAX_HOURS}, daily once it's wider (a backfill) — and the
 * axis keeps its most recent {@link TREND_MAX_BUCKETS} buckets.
 */
function buildTopicTrend(rows: { TopicId: string; bucket: string; c: string }[]): {
  trendDays: string[];
  trendByTopic: Map<string, number[]>;
  noMatchTrend: number[];
  trendBucket: 'hour' | 'day';
} {
  if (rows.length === 0) {
    return { trendDays: [], trendByTopic: new Map(), noMatchTrend: [], trendBucket: 'hour' };
  }

  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;
  const parse = (b: string) => new Date(`${b.replace(' ', 'T')}Z`).getTime();
  const fmt = (ms: number) => `${new Date(ms).toISOString().slice(0, 13).replace('T', ' ')}:00:00`;

  const times = rows.map((r) => parse(r.bucket));
  const spanHours = (Math.max(...times) - Math.min(...times)) / HOUR_MS;
  const trendBucket: 'hour' | 'day' = spanHours <= TREND_HOURLY_MAX_HOURS ? 'hour' : 'day';

  const step = trendBucket === 'hour' ? HOUR_MS : DAY_MS;
  const snap = (ms: number) => Math.floor(ms / step) * step;

  const axis: string[] = [];
  for (let ms = snap(Math.min(...times)); ms <= snap(Math.max(...times)); ms += step) {
    axis.push(fmt(ms));
  }
  const trendDays = axis.length > TREND_MAX_BUCKETS ? axis.slice(-TREND_MAX_BUCKETS) : axis;
  const bucketIndex = new Map(trendDays.map((b, i) => [b, i]));

  const byTopic = new Map<string, number[]>();
  for (const r of rows) {
    const i = bucketIndex.get(fmt(snap(parse(r.bucket))));
    if (i === undefined) continue;
    let series = byTopic.get(r.TopicId);
    if (!series) {
      series = new Array<number>(trendDays.length).fill(0);
      byTopic.set(r.TopicId, series);
    }
    series[i] = (series[i] ?? 0) + Number(r.c);
  }
  const noMatchTrend =
    byTopic.get(NO_MATCH_TOPIC_ID) ?? new Array<number>(trendDays.length).fill(0);
  return { trendDays, trendByTopic: byTopic, noMatchTrend, trendBucket };
}

export class TopicsService {
  constructor(
    private readonly client: IClickHouseQuery,
    private readonly config: TopicsRuntimeConfig,
  ) {}

  private async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: TOPICS_QUERY_SETTINGS,
    });
    return result.json<T>();
  }

  /**
   * `limit` truncates the ranked topic list to the caller's page size. It is
   * OPT-IN, not defaulted here: the gateway REST route and MCP tool schemas
   * (`ListTopicsQuerySchema`) carry their own explicit `.default(20)`, so
   * those callers always pass a number. The dashboard adapter passes none —
   * clustering already caps a facet at roughly 50 topics
   * (resolve_min_cluster_size in apps/topics-clustering/app/clustering.py),
   * and the dashboard's list view and trend chart are built to show every
   * topic in that range, not a paginated slice — so an absent `limit`
   * returns the full ranked set rather than silently truncating it.
   */
  async listTopics(scope: TopicsScope, facet: TopicFacet, limit?: number): Promise<TopicsList> {
    const mapRows = await this.query<{
      TopicId: string;
      Name: string;
      Description: string;
      MapVersion: number;
      GeneratedAt: string;
      AvgLatencyMs: number;
      AvgCostUsd: number;
      ErrorRate: number;
    }>(
      `
      SELECT TopicId, Name, Description, MapVersion, GeneratedAt,
             AvgLatencyMs, AvgCostUsd, ErrorRate
      FROM trace_topic_maps FINAL
      WHERE TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND Environment = {environment:String}
        AND Facet = {facet:String}
        AND IsDeleted = 0
        AND MapVersion = (
          SELECT max(MapVersion)
          FROM trace_topic_maps FINAL
          WHERE TenantId = {tenantId:String}
            AND AppId = {appId:String}
            AND Environment = {environment:String}
            AND Facet = {facet:String}
            AND IsDeleted = 0
        )
      ORDER BY TopicId
      LIMIT {mapRowsCap:UInt32}
      `,
      { ...scopeParams(scope), facet, mapRowsCap: MAX_MAP_TOPICS },
    );

    if (mapRows.length === 0) {
      const samplable = await this.countSamplableRows(scope, facet);
      return {
        facet,
        mapVersion: 0,
        generatedAt: null,
        topics: [],
        noMatchCount: 0,
        samplableCount: samplable,
        required: resolveGenerationFloor(facet, this.config.minSummariesOverride),
        trendDays: [],
        noMatchTrend: [],
        trendBucket: 'hour',
      };
    }

    const mapVersion = mapRows[0]!.MapVersion;
    const activeFacetRowsSql = `
      FROM trace_facets AS f FINAL
      LEFT JOIN (${SESSION_ROLLUP_SUBQUERY}
      ) AS s ON f.TraceId = s.TraceId
      WHERE f.TenantId = {tenantId:String}
        AND f.AppId = {appId:String}
        AND ${facetsEnvClause(scope)}
        AND f.Facet = {facet:String}
        AND f.IsDeleted = 0
        AND f.MapVersion = {mapVersion:UInt32}
        ${facetRowScopeClause(facet)}
        ${agentOriginScopeClause(facet)}`;
    const countParams = { ...scopeParams(scope), facet, mapVersion };

    const [countRows, denominatorRows, trendRows, samplableCount] = await Promise.all([
      this.query<{ TopicId: string; c: string }>(
        `
      SELECT f.TopicId AS TopicId, toString(uniqExact(${ROOT_SESSION_KEY})) AS c
      ${activeFacetRowsSql}
      GROUP BY f.TopicId
      `,
        countParams,
      ),
      this.query<{ c: string }>(
        `
      SELECT toString(uniqExact(${ROOT_SESSION_KEY})) AS c
      ${activeFacetRowsSql}
      `,
        countParams,
      ),
      this.query<{ TopicId: string; bucket: string; c: string }>(
        `
      SELECT TopicId, toString(toStartOfHour(t)) AS bucket, toString(count()) AS c
      FROM (
        SELECT f.TopicId AS TopicId,
               ${ROOT_SESSION_KEY} AS rootKey,
               min(s.StartedAt) AS t
        FROM trace_facets AS f FINAL
        INNER JOIN (${SESSION_ROLLUP_SUBQUERY}
        ) AS s ON f.TraceId = s.TraceId
        WHERE f.TenantId = {tenantId:String}
          AND f.AppId = {appId:String}
          AND ${facetsEnvClause(scope)}
          AND f.Facet = {facet:String}
          AND f.IsDeleted = 0
          AND f.MapVersion = {mapVersion:UInt32}
          ${facetRowScopeClause(facet)}
          ${agentOriginScopeClause(facet)}
        GROUP BY f.TopicId, rootKey
      )
      GROUP BY TopicId, bucket
      `,
        countParams,
      ),
      this.countSamplableRows(scope, facet),
    ]);
    const countByTopic = new Map(countRows.map((r) => [r.TopicId, Number(r.c)]));
    const noMatchCount = countByTopic.get(NO_MATCH_TOPIC_ID) ?? 0;
    const totalClassified = Number(denominatorRows[0]?.c ?? 0);
    const { trendDays, trendByTopic, noMatchTrend, trendBucket } = buildTopicTrend(trendRows);

    const sortedTopics = mapRows
      .map((row) => {
        const sessionCount = countByTopic.get(row.TopicId) ?? 0;
        return {
          topicId: row.TopicId,
          name: row.Name,
          description: row.Description,
          sessionCount,
          share: totalClassified > 0 ? sessionCount / totalClassified : 0,
          avgLatencyMs: Number(row.AvgLatencyMs),
          avgCostUsd: Number(row.AvgCostUsd),
          errorRate: Number(row.ErrorRate),
          trend: trendByTopic.get(row.TopicId) ?? new Array(trendDays.length).fill(0),
        };
      })
      .sort((a, b) => b.sessionCount - a.sessionCount || a.topicId.localeCompare(b.topicId));
    const topics = limit === undefined ? sortedTopics : sortedTopics.slice(0, limit);

    return {
      facet,
      mapVersion,
      generatedAt: mapRows[0]!.GeneratedAt,
      topics,
      noMatchCount,
      samplableCount,
      required: resolveGenerationFloor(facet, this.config.minSummariesOverride),
      trendDays,
      noMatchTrend,
      trendBucket,
    };
  }

  /**
   * Counts the rows a generation pass would sample right now — compiled from
   * the SAME {@link samplableRowsClause} the dashboard's generation sample
   * pull uses, so the progress figure this returns is the floor generation
   * enforces.
   */
  private async countSamplableRows(scope: TopicsScope, facet: TopicFacet): Promise<number> {
    const rows = await this.query<{ c: string }>(
      `
      SELECT toString(count()) AS c
      FROM trace_facets FINAL
      WHERE ${samplableRowsClause(scope, facet)}
      `,
      {
        ...scopeParams(scope),
        facet,
        dimension: resolveCountDimension(this.config.modelEnv),
        minExtractorVersion: minExtractorVersionForFacet(facet),
      },
    );
    return Number(rows[0]?.c ?? 0);
  }
}

/** Route-facing factory: env-configured service on the caller's ClickHouse client. */
export function buildTopicsService(
  client: IClickHouseQuery,
  config: TopicsRuntimeConfig,
): TopicsService {
  return new TopicsService(client, config);
}
