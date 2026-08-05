/**
 * Topics service — Stage 4 generation + topic listing.
 *
 * Generation:
 *   pull ≤50k ok facet embeddings from trace_facets
 *     → POST the clustering service (UMAP+HDBSCAN, shared-secret auth)
 *     → centroids = normalized member means in the ORIGINAL 1024-D space
 *     → reconcile against the previous map (cosine ≥ 0.9 reuses TopicId)
 *     → name new clusters (chunked LLM calls; keyword fallback)
 *     → re-INSERT the sampled facet rows with their assignments in bounded
 *       batches (ReplacingMergeTree upsert), then INSERT trace_topic_maps
 *       (MapVersion+1) LAST — the new version activates only once its
 *       assignments exist, so a mid-write failure leaves the old map serving.
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
 *
 * Cold start: generation refuses below 100 ok summaries per facet.
 *
 * Scale note: re-inserting sampled rows moves the embeddings back through
 * the app once per generation. Fine at the current tier caps (≤100K
 * spans/month ⇒ thousands of traces); the 50k ceiling is the same bound the
 * clustering POST already carries. A ClickHouse-side mutation is the
 * escalation path if generation ever outgrows this.
 */

import 'server-only';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  STATUS_ERROR_VALUES_SQL,
  ServiceUnavailableError,
} from '@repo/observability-service';
import {
  BATCHED_EXTRACTOR_VERSION,
  DEFAULT_ASSIGN_MAX_DISTANCE,
  FACET_NAMING_GUIDANCE,
  MAX_TOPIC_DESCRIPTION_LENGTH,
  NO_MATCH_TOPIC_ID,
  STEERING_EXTRACTOR_VERSION,
  cosineDistance,
  createTopicsModelClientsFromEnv,
  nameTopics,
  normalizedCentroid,
  reconcileTopics,
  resolveTopicsModelSelection,
  type PreviousTopic,
  type TopicsModelClients,
  type TopicsModelEnv,
} from '@repo/trace-topics';

/**
 * Model-provider env slice read straight from process.env (env.ts zod defaults
 * are dead on Vercel — see resolveTopicsRuntimeConfig). Generation must select
 * the SAME provider the gateway enrichment used, so the naming model matches
 * the client and the embedding dimension matches what was written.
 */
function readTopicsModelEnv(): TopicsModelEnv {
  return {
    TOPICS_MODEL_PROVIDER: process.env.TOPICS_MODEL_PROVIDER,
    TOPICS_MODEL_API_KEY: process.env.TOPICS_MODEL_API_KEY,
    TOPICS_MODEL_BASE_URL: process.env.TOPICS_MODEL_BASE_URL,
    TOPICS_FACET_MODEL: process.env.TOPICS_FACET_MODEL,
    TOPICS_EMBEDDING_MODEL: process.env.TOPICS_EMBEDDING_MODEL,
    TOPICS_NAMING_MODEL: process.env.TOPICS_NAMING_MODEL,
    TOPICS_EMBEDDING_DIMENSION: process.env.TOPICS_EMBEDDING_DIMENSION,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    TOPICS_MOCK_MODEL: process.env.TOPICS_MOCK_MODEL,
  };
}

// Client-safe contracts (types + constants) live in topics-shared.ts —
// consumers import them from there; this module owns only the server side.
import {
  generationFloorForFacet,
  type GenerateOutcome,
  type TopicFacet,
  type TopicsList,
} from '@/lib/analytics/topics/topics-shared';

/** Clustering sample ceiling per generation pass. */
const MAX_GENERATION_SAMPLE = 50_000;

/**
 * Sample share above which a cluster is treated as a suspected junk drawer
 * and given one sub-clustering attempt (see splitGiantClusters). High enough
 * that a genuinely dominant workload (a third of traffic doing one thing)
 * isn't second-guessed on every generation, and above 30% at most three
 * clusters can ever qualify — the threshold doubles as the attempt bound.
 */
const GIANT_CLUSTER_SHARE = 0.3;

/**
 * The LARGEST cluster is probed regardless of share (one extra clustering
 * call), once it has enough members for a sub-pass to find structure in.
 * The residual blob concentrates in the top cluster while sitting under the
 * share threshold — dominant on the page (shares are session-denominated)
 * yet invisible to a row-share trigger.
 */
const MIN_TOP_CLUSTER_PROBE_MEMBERS = 20;

/**
 * Mean member-to-centroid cosine distance above which a topic is DIFFUSE —
 * a residual bag, not a pattern. Calibrated on live data: the one known
 * grab-bag measured 0.494; every legitimate topic measured ≤ 0.43.
 */
const DIFFUSE_TOPIC_MEAN_DISTANCE = 0.45;

/** Fixed honest label for diffuse topics — never the namer, never carried. */
export const MIXED_TOPIC_NAME = 'Mixed one-off items';
export const MIXED_TOPIC_DESCRIPTION =
  'A residual group with no shared subject — its members are dissimilar one-offs. Treat its size as the signal, not its label.';

/**
 * Generation floor: the facet's default unless TOPICS_MIN_SUMMARIES overrides
 * it — read straight from process.env (env.ts zod defaults are dead on
 * Vercel), so an environment with a thin-but-real corpus can opt into
 * earlier, thinner maps. Values below 5 can't form clusters at all and fall
 * back to the facet default.
 */
function resolveGenerationFloor(facet: TopicFacet): number {
  const parsed = Number.parseInt(process.env.TOPICS_MIN_SUMMARIES ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5 ? parsed : generationFloorForFacet(facet);
}

/**
 * The extractor version a generation pass requires of its sample. Facet
 * prompts version independently (batched task/issues vs steering's own-pass
 * extraction), and a version bump re-drains history through the backfill
 * sweeps — during which the corpus holds BOTH generations of summary side by
 * side. Clustering must see only the current version: rows written under an
 * older prompt encode different semantics (an issues prompt that narrates
 * clean runs as prose yields narrations that cluster into top-of-page
 * "issues" which are really success stories), so a mixed sample rebuilds
 * exactly the map the current prompt avoids. Pinning also makes the samplable
 * count an honest re-extraction progress meter while a drain is in flight.
 */
function minExtractorVersionForFacet(facet: TopicFacet): number {
  return facet === 'steering' ? STEERING_EXTRACTOR_VERSION : BATCHED_EXTRACTOR_VERSION;
}

/** Exemplar summaries per cluster handed to the namer. */
const NAMING_EXEMPLARS_PER_CLUSTER = 8;

/**
 * Facet rows per re-insert batch. A row carries its 1024-float embedding
 * (~20KB as JSON), so this bounds each insert at ~5MB — comfortably inside
 * the memory budget of the smallest ClickHouse tier.
 */
const FACET_REINSERT_BATCH = 250;

/**
 * Topics-over-time granularity. The axis is anchored to the data's own span
 * (earliest→latest assigned-trace bucket), not wall-clock now, so a backfilled
 * corpus that ended weeks ago still charts. Hourly buckets while the span fits
 * within a couple of days of activity; daily once it stretches past this (a
 * backfill), capped so a wide corpus keeps its most recent buckets.
 */
const TREND_HOURLY_MAX_HOURS = 48;
const TREND_MAX_BUCKETS = 90;

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
 * current trace's own Origin. A subagent transcript always carries
 * Origin='agent', but it credits its parent via ROOT_SESSION_KEY; when that
 * parent is interactive/worker the parent's SessionId is absent from the set
 * below, so the subagent stays counted. Legacy '' and interactive roots stay
 * (only 'agent' is excluded).
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
 * (the ReplacingMergeTree key includes GitRepo/StartedAt, so FINAL alone can't
 * guarantee per-trace uniqueness) so the join never fans facet rows out.
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
 * Task and steering topics describe what USERS ran/typed, so subagent
 * transcripts are excluded from their counting/clustering; an unmatched LEFT
 * JOIN row carries ParentSessionId = '', so non-agent traces still pass.
 * Issues facet keeps subagent rows and attributes them to the parent via
 * ROOT_SESSION_KEY.
 */
function facetRowScopeClause(facet: TopicFacet): string {
  return facet === 'issues' ? '' : "AND s.ParentSessionId = ''";
}

/**
 * Agent-origin exclusion is scoped to task/steering only — those facets
 * describe what USERS ran/typed, so templated agent fan-outs skew them. Issues
 * stays origin-blind: a failure inside an agent run is still a real failure, so
 * its counts and clustering include every origin.
 */
function agentOriginScopeClause(facet: TopicFacet): string {
  return facet === 'issues' ? '' : `AND ${NON_AGENT_ROOT_CLAUSE}`;
}

/**
 * WHERE fragment selecting exactly the rows a generation pass samples: ok
 * status, an embedding in the dimension generation clusters in, summaries
 * written by the facet's CURRENT extractor version (older-version rows are
 * mid-re-extraction leftovers whose summaries encode retired prompt
 * semantics — see minExtractorVersionForFacet), and — for task/steering — no
 * subagent transcripts or top-level programmatic runs (Origin='agent'). Both are templated fan-outs that would dominate the
 * manifold and produce topics about the agent's plumbing instead of what
 * users ran/typed; issues keeps every origin because a failure inside a
 * child is a real failure of the session.
 *
 * The cold-start/regenerate counter compiles from THIS fragment too. If the
 * two predicates diverge, the page promises maps generation then refuses —
 * "127 of 100 collected" beside a "12 of 100 required" refusal.
 */
function samplableRowsClause(scope: TopicsScope, facet: TopicFacet): string {
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
 * Embedding dimension for the samplable count on the READ path, resolved from
 * env WITHOUT constructing model clients — reads must never require model
 * config. An invalid TOPICS_MODEL_PROVIDER falls back to the provider
 * defaults so a misconfig breaks generation loudly, never the Topics GET.
 */
function resolveCountDimension(): number {
  try {
    return resolveTopicsModelSelection(readTopicsModelEnv()).embeddingDimension;
  } catch {
    return resolveTopicsModelSelection({}).embeddingDimension;
  }
}

interface TopicsScope {
  tenantId: string;
  appId: string;
  environment: string;
  /**
   * When scoping to the app's default environment, legacy rows stamped with
   * Environment='' belong to its view (same semantics as
   * buildEnvironmentWhereClause in @repo/observability-service). Applies to
   * trace_facets reads; trace_topic_maps rows are always written with the
   * canonical env name, so map reads stay exact-match.
   */
  environmentIsDefault: boolean;
}


/** Full trace_facets row shape pulled for generation (re-inserted verbatim + assignment). */
interface FacetRowFull {
  TenantId: string;
  AppId: string;
  Environment: string;
  TraceId: string;
  Facet: string;
  ItemIndex: number;
  ExtractorVersion: number;
  Summary: string;
  Label: string;
  Embedding: number[];
  EmbeddingModel: string;
  Status: string;
  Error: string;
  CreatedAt: string;
}

/**
 * Clustering unit id for one facet row. A facet can fan out into several rows
 * per trace (steering writes one row per correction, discriminated by
 * ItemIndex), so TraceId alone is NOT unique across the generation sample —
 * clustering member ids, assignment lookups, and the re-insert all key on
 * this composite instead. Trace ids are hex, so ':' never collides.
 */
function facetUnitId(row: Pick<FacetRowFull, 'TraceId' | 'ItemIndex'>): string {
  return `${row.TraceId}:${row.ItemIndex}`;
}

/** The TraceId component of a {@link facetUnitId} (for otel_traces lookups). */
function unitTraceId(unitId: string): string {
  return unitId.slice(0, unitId.lastIndexOf(':'));
}

interface ClusteringServiceResponse {
  clusters: { id: string; name: string; memberIds: string[] }[];
  noise: string[];
  generationMs: number;
}

/**
 * Session-level outcome pulled once at generation, folded over every trace in
 * the root session. Per-trace semantics match TRACES_LIST_QUERY
 * (packages/observability-service): a trace errored if ANY of its spans
 * carries an error StatusCode; latency is max(Duration) in ms; cost sums
 * GENERATION spans. Across the session those fold as OR / max / sum — the
 * session failed if anything in it did, ran as long as its widest span, and
 * cost what all of its traces cost together.
 */
interface SessionOutcome {
  /** Root session the trace belongs to; its own id when it has no rollup row. */
  rootKey: string;
  isError: boolean;
  latencyMs: number;
  /** Model spend across EVERY trace in the root session, subagents included. */
  costUsd: number;
}

/**
 * Root-session key over an unaliased `agent_session_summary` row — the same
 * attribution {@link ROOT_SESSION_KEY} applies on the facet-join side, so a
 * subagent credits its parent and a rollup-less trace stands alone.
 */
const ROLLUP_ROOT_KEY =
  "if(ParentSessionId != '', ParentSessionId, if(SessionId != '', SessionId, TraceId))";

interface TopicsServiceDeps {
  client: ClickHouseClient;
  clusteringUrl: string;
  clusteringSecret?: string;
  /**
   * Lazy on purpose: only generation consumes model clients, and
   * createTopicsModelClientsFromEnv throws on missing config (no silent mock
   * fallback). Reads must never require model configuration, so the clients
   * are built at the point of use rather than in the constructor.
   */
  models: () => TopicsModelClients;
  fetchFn?: typeof fetch;
}

/**
 * Runtime config, read directly from process.env with inline fallbacks —
 * NOT via env.ts zod defaults, which are dead on Vercel under `skipValidation`
 * (see env-default-invariant.test.ts).
 */
export function resolveTopicsRuntimeConfig(): {
  clusteringUrl: string;
  clusteringSecret?: string;
} {
  return {
    clusteringUrl: process.env.TOPICS_CLUSTERING_URL ?? 'http://localhost:8080',
    clusteringSecret: process.env.TOPICS_CLUSTERING_SECRET || undefined,
  };
}

/** Route-facing factory: env-configured service on the default CH client. */
export function buildTopicsService(client: ClickHouseClient): TopicsService {
  return new TopicsService({
    client,
    ...resolveTopicsRuntimeConfig(),
    // Resolved by generateTopics, never by listTopics — and a model misconfig
    // surfaces as a 503 with the factory's actionable message, not a bare 500.
    models: () => {
      try {
        return createTopicsModelClientsFromEnv(readTopicsModelEnv());
      } catch (error) {
        throw new ServiceUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

export class TopicsService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: TopicsServiceDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await this.deps.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return result.json<T>();
  }

  async listTopics(scope: TopicsScope, facet: TopicFacet): Promise<TopicsList> {
    const mapRows = await this.query<{
      TopicId: string;
      Name: string;
      Description: string;
      MapVersion: number;
      GeneratedAt: string;
      AvgLatencyMs: number;
      AvgCostUsd: number;
    }>(
      `
      SELECT TopicId, Name, Description, MapVersion, GeneratedAt,
             AvgLatencyMs, AvgCostUsd
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
      `,
      { ...scopeParams(scope), facet },
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
        required: resolveGenerationFloor(facet),
        trendDays: [],
        noMatchTrend: [],
        trendBucket: 'hour',
      };
    }

    const mapVersion = mapRows[0]!.MapVersion;
    // Every live-count read shares the same shape: the map's facet rows,
    // attributed to root sessions via the rollup (LEFT JOIN, so plain OTLP
    // traces with no session row still count as themselves), task facet
    // restricted to top-level transcripts. trace_facets carries the env
    // scope; the rollup has no Environment column, so the join inherits env
    // from the facet side.
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

    // Three aggregates over that row set, fired concurrently:
    // per-topic distinct sessions; the share denominator (distinct sessions
    // across ALL classified rows — per-topic counts can't just be summed,
    // because one session's transcripts may land in several issues topics);
    // and the topics-over-time trend, which buckets each root session ONCE
    // per topic by its earliest transcript start (INNER join on StartedAt —
    // a facet trace with no rollup row has no start time to bucket by, same
    // as before). buildTopicTrend anchors the axis to the data's own span
    // (no now()-relative window, so a backfill still charts) and downsamples
    // hourly→daily when the span is wide. The fourth read is the samplable
    // count gating Regenerate — generation's own predicate over ALL map
    // versions, not an aggregate of this map's row set.
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

    const topics = mapRows
      .map((row) => {
        const sessionCount = countByTopic.get(row.TopicId) ?? 0;
        return {
          topicId: row.TopicId,
          name: row.Name,
          description: row.Description,
          sessionCount,
          share: totalClassified > 0 ? sessionCount / totalClassified : 0,
          // Snapshot columns written by generateTopics (as of GeneratedAt);
          // maps generated before migration 24 carry the DEFAULT 0s.
          avgLatencyMs: Number(row.AvgLatencyMs),
          avgCostUsd: Number(row.AvgCostUsd),
          trend: trendByTopic.get(row.TopicId) ?? new Array(trendDays.length).fill(0),
        };
      })
      .sort((a, b) => b.sessionCount - a.sessionCount || a.topicId.localeCompare(b.topicId));

    return {
      facet,
      mapVersion,
      generatedAt: mapRows[0]!.GeneratedAt,
      topics,
      noMatchCount,
      samplableCount,
      required: resolveGenerationFloor(facet),
      trendDays,
      noMatchTrend,
      trendBucket,
    };
  }

  /**
   * Counts the rows generateTopics would sample right now — compiled from the
   * SAME samplableRowsClause as the sample query, so the progress the page
   * renders is the floor generation enforces. A looser predicate here (bare
   * Status='ok', any embedding length, no origin exclusion) counts rows
   * generation can never cluster — checked-but-clean markers, embeddings from
   * a previous provider's dimension, subagent/agent-origin transcripts — and
   * each one promises maps the floor can't deliver.
   */
  private async countSamplableRows(
    scope: TopicsScope,
    facet: TopicFacet,
  ): Promise<number> {
    const rows = await this.query<{ c: string }>(
      `
      SELECT toString(count()) AS c
      FROM trace_facets FINAL
      WHERE ${samplableRowsClause(scope, facet)}
      `,
      {
        ...scopeParams(scope),
        facet,
        dimension: resolveCountDimension(),
        minExtractorVersion: minExtractorVersionForFacet(facet),
      },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async generateTopics(scope: TopicsScope, facet: TopicFacet): Promise<GenerateOutcome> {
    // Resolve model clients first: generation is the path that needs them, and
    // a misconfigured environment should fail loudly here — before any
    // ClickHouse reads or clustering work — never fall back to a silent mock.
    const models = this.deps.models();

    // 1. Pull the sample — newest first so the map tracks current traffic.
    // The WHERE is the shared samplableRowsClause, so the count feeding the
    // page's "X of Y collected" and the rows pulled here can never diverge.
    const rows = await this.query<FacetRowFull>(
      `
      SELECT TenantId, AppId, Environment, TraceId, Facet, ItemIndex,
             ExtractorVersion, Summary, Label, Embedding, EmbeddingModel,
             Status, Error, toString(CreatedAt) AS CreatedAt
      FROM trace_facets FINAL
      WHERE ${samplableRowsClause(scope, facet)}
      ORDER BY CreatedAt DESC
      LIMIT ${MAX_GENERATION_SAMPLE}
      `,
      {
        ...scopeParams(scope),
        facet,
        dimension: models.models.embeddingDimension,
        minExtractorVersion: minExtractorVersionForFacet(facet),
      },
    );

    const floor = resolveGenerationFloor(facet);
    if (rows.length < floor) {
      return {
        status: 'not_enough_data',
        facet,
        sampleSize: rows.length,
        required: floor,
      };
    }

    // 2. Cluster (geometry only — the service returns member ids + noise).
    const clustering = await this.callClusteringService(rows);
    const rowByUnitId = new Map(rows.map((row) => [facetUnitId(row), row]));

    // 2b. Giant clusters get ONE sub-clustering attempt. HDBSCAN over a mixed
    // corpus reliably produces a junk drawer: one diffuse blob near the
    // center of mass that absorbs a dominant share and then gets confidently
    // mis-named (observed live at 86% of a map). Sub-clustering is
    // self-guarding — a COHERENT giant has no internal density structure, so
    // the attempt finds nothing and the cluster stays whole; only a genuine
    // grab-bag splits into its dense cores.
    const memberClusters = await this.splitGiantClusters(
      clustering.clusters.map((c) => ({ memberIds: c.memberIds })),
      rows.length,
      rowByUnitId,
    );

    // 3. Centroids in the original embedding space. Member ids are
    // facet UNIT ids (trace:item), matching what callClusteringService sent.
    const clusters = memberClusters.map((cluster) => ({
      centroid: normalizedCentroid(
        cluster.memberIds.map((id) => rowByUnitId.get(id)!.Embedding),
      ),
      memberIds: cluster.memberIds,
    }));

    // All-noise result: HDBSCAN found no dense region. Writing an empty map
    // (bumping the version) would strand the previous topics and rewrite every
    // sampled summary to no_match. Leave the prior map untouched instead.
    if (clusters.length === 0) {
      return { status: 'no_clusters', facet, sampleSize: rows.length };
    }

    // 4. Reconcile against the previous map.
    const previous = await this.fetchPreviousMap(scope, facet);
    const mapVersion = previous.version + 1;
    const reconciled = reconcileTopics(clusters, previous.topics, { mapVersion });

    // 4b. Diffuseness, measured per topic as the mean member-to-centroid
    // cosine distance. A cluster whose members sit far from its own center
    // has no shared subject — it's the residual the density pass couldn't
    // resolve — and ANY specific name on it is a lie: the namer sees the
    // core exemplars and confidently labels the whole bag (a live 64%-share
    // "topic" measured 0.494 here while every real topic sat ≤ 0.43).
    // Diffuse topics get a fixed honest label instead of an LLM name, and a
    // carried name is overridden for the same reason.
    const meanDistanceByTopic = new Map(
      reconciled.map((topic) => [
        topic.topicId,
        topic.memberIds.reduce(
          (sum, id) => sum + cosineDistance(rowByUnitId.get(id)!.Embedding, topic.centroid),
          0,
        ) / Math.max(topic.memberIds.length, 1),
      ]),
    );
    const isDiffuse = (topicId: string): boolean =>
      (meanDistanceByTopic.get(topicId) ?? 0) > DIFFUSE_TOPIC_MEAN_DISTANCE;

    // 5. Name what reconciliation didn't carry over, and pull the
    //    member traces' outcomes — the map stores error rate / latency / cost
    //    as snapshot columns so the list route never joins otel_traces.
    //    Independent of naming, so they run concurrently.
    //    Carried topics whose current description is DEGRADED — a keyword
    //    fallback or a legacy mid-word truncation — are re-named too
    //    (TopicId stability is reconciliation's job; carrying a degraded
    //    name forward would make it immortal). Diffuse topics never go to
    //    the namer — their label is fixed, so exemplars can't mislead it.
    const needNames = reconciled.filter(
      (topic) =>
        !isDiffuse(topic.topicId) &&
        (topic.name === null || isDegradedDescription(facet, topic.description)),
    );
    const [named, outcomeByTraceId] = await Promise.all([
      nameTopics(
        // Exemplars are the members NEAREST the centroid — the cluster's
        // core, not whatever happened to be newest in the sample. Newest-N
        // exemplars from a diffuse cluster describe its stragglers, and the
        // namer then confidently mislabels a junk drawer with a specific
        // name (a 46%-share topic once shipped named after ~4 of its 113
        // members).
        needNames.map((topic) => ({
          topicId: topic.topicId,
          summaries: [...topic.memberIds]
            .map((id) => ({
              id,
              distance: cosineDistance(rowByUnitId.get(id)!.Embedding, topic.centroid),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, NAMING_EXEMPLARS_PER_CLUSTER)
            .map((entry) => rowByUnitId.get(entry.id)!.Summary),
        })),
        {
          client: models.structured,
          model: models.models.namingModel,
          // Per-facet description guidance: one issues-flavored namer serving
          // every facet is how task topics shipped with "Pattern: …; fix by…"
          // remediation advice as their descriptions.
          guidance: FACET_NAMING_GUIDANCE[facet],
          // Surface naming failures instead of shipping keyword-salad names
          // silently — Vercel captures stderr, and the fallback count lands
          // in Params below so a degraded map is diagnosable after the fact.
          onError: (error, topicIds) =>
            console.error(
              `[topics] naming call failed for ${topicIds.length} cluster(s); using keyword fallback`,
              error,
            ),
        },
      ),
      this.fetchTraceOutcomes(
        scope,
        [...new Set(reconciled.flatMap((topic) => topic.memberIds.map(unitTraceId)))],
      ),
    ]);
    const nameByTopic = new Map(named.map((n) => [n.topicId, n]));

    // Namer-declared duplicates (sameAs) fold into their canonical topic:
    // the absorbed cluster's members join the root, whose centroid and
    // diffuseness recompute over the union, and the absorbed topic never
    // reaches the map. Geometry cannot make this call — on live embeddings,
    // phrasing variants of ONE steering rule peak at ~0.88 centroid
    // similarity while genuinely distinct issues topics reach ~0.93 — so the
    // namer, which reads the exemplars side by side, owns it.
    const absorbedInto = new Map<string, string>();
    for (const n of named) {
      if (n.sameAs && !isDiffuse(n.topicId)) absorbedInto.set(n.topicId, n.sameAs);
    }
    const finalTopics = reconciled.filter((t) => !absorbedInto.has(t.topicId));
    if (absorbedInto.size > 0) {
      const byId = new Map(finalTopics.map((t) => [t.topicId, t]));
      const touchedRoots = new Set<string>();
      for (const [absorbedId, rootId] of absorbedInto) {
        const absorbed = reconciled.find((t) => t.topicId === absorbedId)!;
        const root = byId.get(rootId);
        if (!root) continue; // defensive: the namer roots sameAs chains, so the target should stand
        root.memberIds.push(...absorbed.memberIds);
        touchedRoots.add(rootId);
      }
      for (const rootId of touchedRoots) {
        const root = byId.get(rootId)!;
        root.centroid = normalizedCentroid(
          root.memberIds.map((id) => rowByUnitId.get(id)!.Embedding),
        );
        meanDistanceByTopic.set(
          rootId,
          root.memberIds.reduce(
            (sum, id) => sum + cosineDistance(rowByUnitId.get(id)!.Embedding, root.centroid),
            0,
          ) / Math.max(root.memberIds.length, 1),
        );
      }
    }

    const now = clickhouseNow();
    const params = JSON.stringify({
      algorithm: 'umap+hdbscan',
      assignMaxDistance: DEFAULT_ASSIGN_MAX_DISTANCE,
      sampleSize: rows.length,
      mode: models.mode,
      clusteringMs: Math.round(clustering.generationMs),
      namingFallbackCount: named.filter((n) => n.fallback).length,
      diffuseTopicCount: finalTopics.filter((t) => isDiffuse(t.topicId)).length,
    });

    const mapInserts = finalTopics.map((topic) => {
      const fresh = nameByTopic.get(topic.topicId);
      const metrics = topicOutcomeMetrics(topic.memberIds, outcomeByTraceId);
      return {
        TenantId: scope.tenantId,
        AppId: scope.appId,
        Environment: scope.environment,
        Facet: facet,
        MapVersion: mapVersion,
        TopicId: topic.topicId,
        // A topic that went to the namer (new, or carried with only a
        // fallback name) takes the namer's output; other reconciled topics
        // keep their prior name/description. Never silently blank on regen.
        // Diffuse topics take the fixed honest label FIRST — over carried
        // and namer output alike — so a residual can never wear a specific
        // name, this generation or by inheritance from a past one.
        Name: isDiffuse(topic.topicId)
          ? MIXED_TOPIC_NAME
          : (fresh?.name ?? topic.name ?? `Topic ${topic.topicId}`),
        Description: isDiffuse(topic.topicId)
          ? MIXED_TOPIC_DESCRIPTION
          : (fresh?.description ?? topic.description ?? ''),
        Centroid: topic.centroid,
        MemberCount: topic.memberIds.length,
        ErrorRate: metrics.errorRate,
        AvgLatencyMs: metrics.avgLatencyMs,
        AvgCostUsd: metrics.avgCostUsd,
        Params: params,
        GeneratedAt: now,
        UpdatedAt: now,
      };
    });
    // 6. Re-assign every sampled facet row on the new map version. The
    // re-insert spreads the full row — ItemIndex included — so fan-out rows
    // keep their sorting-key identity; dropping it would collapse a trace's
    // corrections onto item 0 at the ReplacingMergeTree merge.
    const assignmentByUnitId = new Map<string, { topicId: string; distance: number }>();
    for (const topic of finalTopics) {
      for (const memberId of topic.memberIds) {
        const row = rowByUnitId.get(memberId)!;
        assignmentByUnitId.set(memberId, {
          topicId: topic.topicId,
          distance: cosineDistance(row.Embedding, topic.centroid),
        });
      }
    }
    const facetInserts = rows.map((row) => {
      const assignment = assignmentByUnitId.get(facetUnitId(row));
      return {
        ...row,
        TopicId: assignment?.topicId ?? NO_MATCH_TOPIC_ID,
        TopicDistance: assignment?.distance ?? 1,
        MapVersion: mapVersion,
        UpdatedAt: now,
      };
    });
    // Assignments land BEFORE the map row, in bounded batches. Each row
    // carries its full embedding (the ReplacingMergeTree upsert must re-send
    // every column), so a large sample as ONE insert can exceed ClickHouse's
    // memory limit mid-generation, leaving an already-written map version
    // with zero assignments, i.e. a live Topics page of zeros.
    // With the map written LAST, a failed batch aborts activation and the
    // previous version keeps serving.
    for (let i = 0; i < facetInserts.length; i += FACET_REINSERT_BATCH) {
      await this.deps.client.insert({
        table: 'trace_facets',
        values: facetInserts.slice(i, i + FACET_REINSERT_BATCH),
        format: 'JSONEachRow',
      });
    }

    // 7. Activate the new version: the map row is the last write.
    await this.deps.client.insert({
      table: 'trace_topic_maps',
      values: mapInserts,
      format: 'JSONEachRow',
    });

    return {
      status: 'generated',
      facet,
      mapVersion,
      topicCount: finalTopics.length,
      sampleSize: rows.length,
      noiseCount: clustering.noise.length,
      mode: models.mode,
      generationMs: Math.round(clustering.generationMs),
    };
  }

  /**
   * Per-SESSION outcomes for the generation sample: one query resolves the
   * sampled traces to the sessions they belong to, a second reads the spans of
   * every trace in those sessions. Both are bounded by the (TenantId, AppId)
   * sort-key prefix plus the TraceId bloom-filter index — never a whole-table
   * otel_traces join. Runs once per generation, not per page load.
   *
   * The second IN list carries the EXPANDED set — every trace of every
   * sampled session, which on fan-out-heavy data runs several times the
   * sample. At the MAX_GENERATION_SAMPLE ceiling that is order-100k ids, a
   * few MB as a query param: still trivial next to the embeddings this job
   * already moves, and an explicit id list keeps the read bounded rather
   * than re-deriving session membership inside a scan. Passing ids also
   * keeps the query independent of the facet re-insert's merge visibility.
   *
   * No Environment predicate: TraceIds are globally unique and already came
   * from env-scoped facet rows; otel_traces' legacy-env semantics differ, so
   * an env clause could only wrongly drop rows.
   */
  private async fetchTraceOutcomes(
    scope: TopicsScope,
    traceIds: string[],
  ): Promise<Map<string, SessionOutcome>> {
    if (traceIds.length === 0) return new Map();

    // Expand every member trace to the traces sharing its ROOT session. A
    // subagent's spend lands on its own transcript, which the session count
    // already folds into the parent, so summing only the member's own spans
    // would price a fan-out topic as though its children were free.
    const tree = await this.query<{ TraceId: string; rootKey: string }>(
      `
      SELECT TraceId, ${ROLLUP_ROOT_KEY} AS rootKey
      FROM agent_session_summary FINAL
      WHERE TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND ${ROLLUP_ROOT_KEY} IN (
          SELECT ${ROLLUP_ROOT_KEY}
          FROM agent_session_summary FINAL
          WHERE TenantId = {tenantId:String}
            AND AppId = {appId:String}
            AND TraceId IN {traceIds:Array(String)}
        )
      `,
      { tenantId: scope.tenantId, appId: scope.appId, traceIds },
    );

    const rootByTrace = new Map(tree.map((row) => [row.TraceId, row.rootKey]));
    // Plain OTLP traffic has no rollup row; such a trace is its own session.
    for (const traceId of traceIds) {
      if (!rootByTrace.has(traceId)) rootByTrace.set(traceId, traceId);
    }

    const rows = await this.query<{
      TraceId: string;
      isError: number;
      latencyMs: number;
      costUsd: number;
    }>(
      `
      SELECT TraceId,
             countIf(StatusCode IN ${STATUS_ERROR_VALUES_SQL}) > 0 AS isError,
             toFloat64(max(Duration)) AS latencyMs,
             sumIf(Cost, Type = 'GENERATION') AS costUsd
      FROM otel_traces FINAL
      WHERE TenantId = {tenantId:String}
        AND AppId = {appId:String}
        AND IsDeleted = 0
        AND TraceId IN {traceIds:Array(String)}
      GROUP BY TraceId
      `,
      { tenantId: scope.tenantId, appId: scope.appId, traceIds: [...rootByTrace.keys()] },
    );

    // Fold the tree into one figure per session: spend SUMS across children,
    // wall clock takes the widest span (the root outlives what it spawned).
    const bySession = new Map<string, { isError: boolean; latencyMs: number; costUsd: number }>();
    for (const row of rows) {
      const rootKey = rootByTrace.get(row.TraceId) ?? row.TraceId;
      const agg = bySession.get(rootKey) ?? { isError: false, latencyMs: 0, costUsd: 0 };
      agg.isError = agg.isError || Number(row.isError) > 0;
      agg.latencyMs = Math.max(agg.latencyMs, Number(row.latencyMs));
      agg.costUsd += Number(row.costUsd);
      bySession.set(rootKey, agg);
    }

    // Keyed by the MEMBER trace so callers look up what a topic actually holds.
    const outcomes = new Map<string, SessionOutcome>();
    for (const traceId of traceIds) {
      const rootKey = rootByTrace.get(traceId)!;
      const agg = bySession.get(rootKey);
      if (agg) outcomes.set(traceId, { rootKey, ...agg });
    }
    return outcomes;
  }

  /**
   * Re-cluster any cluster holding more than {@link GIANT_CLUSTER_SHARE} of
   * the sample — plus the LARGEST cluster regardless of share — depth 1.
   * With the share above 30% at most three clusters qualify, and the
   * largest-cluster rule adds at most one more probe per generation — the
   * triggers themselves bound the extra latency and cost.
   * A split is accepted only when the sub-pass finds ≥ 2 dense cores — the
   * signature of a grab-bag; anything the sub-pass leaves as noise stays
   * behind as a residual cluster (it was clustered before, and demoting it to
   * no_match would silently shrink every count). The residual usually keeps
   * the giant's TopicId at reconciliation and, having collapsed in size,
   * trips the name-carry guard — so it gets re-named for what remains. A
   * failed sub-call keeps the giant whole: splitting is an improvement, never
   * a precondition.
   */
  private async splitGiantClusters(
    clusters: { memberIds: string[] }[],
    sampleSize: number,
    rowByUnitId: Map<string, FacetRowFull>,
  ): Promise<{ memberIds: string[] }[]> {
    const largestSize = clusters.reduce(
      (max, c) => Math.max(max, c.memberIds.length),
      0,
    );
    let largestProbed = false;
    const result: { memberIds: string[] }[] = [];
    for (const cluster of clusters) {
      // sampleSize is ≥ the generation floor whenever clusters exist, so the
      // ratio is always finite. The largest cluster is probed even under the
      // share threshold (first one at the max size wins on ties).
      const overShare = cluster.memberIds.length / sampleSize > GIANT_CLUSTER_SHARE;
      const probeAsLargest =
        !largestProbed &&
        cluster.memberIds.length === largestSize &&
        cluster.memberIds.length >= MIN_TOP_CLUSTER_PROBE_MEMBERS;
      if (!overShare && !probeAsLargest) {
        result.push(cluster);
        continue;
      }
      if (probeAsLargest) largestProbed = true;
      let sub: ClusteringServiceResponse;
      try {
        sub = await this.callClusteringService(
          cluster.memberIds.map((id) => rowByUnitId.get(id)!),
        );
      } catch {
        result.push(cluster);
        continue;
      }
      // Restrict every sub-cluster to the giant's own members: the service
      // contract is to return only sent ids, but an id leaking in from
      // elsewhere would land one unit in two topics and silently corrupt
      // counts and assignments. Filtered-empty sub-clusters drop out before
      // the ≥ 2 acceptance check.
      const giantMembers = new Set(cluster.memberIds);
      const subClusters = sub.clusters
        .map((c) => ({ memberIds: c.memberIds.filter((id) => giantMembers.has(id)) }))
        .filter((c) => c.memberIds.length > 0);
      if (subClusters.length < 2) {
        result.push(cluster); // coherent giant — no internal structure
        continue;
      }
      const inSubCluster = new Set(subClusters.flatMap((c) => c.memberIds));
      result.push(...subClusters);
      const residual = cluster.memberIds.filter((id) => !inSubCluster.has(id));
      if (residual.length > 0) result.push({ memberIds: residual });
    }
    return result;
  }

  private async callClusteringService(
    rows: FacetRowFull[],
  ): Promise<ClusteringServiceResponse> {
    const post = () =>
      this.fetchFn(`${this.deps.clusteringUrl}/cluster`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.deps.clusteringSecret
            ? { 'x-topics-secret': this.deps.clusteringSecret }
            : {}),
        },
        body: JSON.stringify({
          // Unit ids, not TraceIds: a fanned-out facet has several rows per
          // trace and the clustering service requires unique member ids.
          embeddings: rows.map((row) => ({ id: facetUnitId(row), vector: row.Embedding })),
        }),
      });

    // The clustering service scales to zero between generations, and the
    // first request after an idle stretch can land while the machine is
    // still resuming — a transient network failure or 5xx that a single
    // delayed retry absorbs. 4xx (bad payload, bad secret) never retries.
    let response: Response;
    try {
      response = await post();
    } catch {
      await sleep(CLUSTERING_RETRY_DELAY_MS);
      response = await post();
    }
    if (!response.ok && response.status >= 500) {
      await sleep(CLUSTERING_RETRY_DELAY_MS);
      response = await post();
    }
    if (!response.ok) {
      const excerpt = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(
        `Clustering service failed with HTTP ${response.status}: ${excerpt}`,
      );
    }
    return (await response.json()) as ClusteringServiceResponse;
  }

  private async fetchPreviousMap(
    scope: TopicsScope,
    facet: TopicFacet,
  ): Promise<{ version: number; topics: PreviousTopic[] }> {
    const rows = await this.query<{
      TopicId: string;
      Name: string;
      Description: string;
      Centroid: number[];
      MapVersion: number;
      MemberCount: number;
    }>(
      `
      SELECT TopicId, Name, Description, Centroid, MapVersion, MemberCount
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
      `,
      { ...scopeParams(scope), facet },
    );
    return {
      version: rows[0]?.MapVersion ?? 0,
      topics: rows.map((row) => ({
        topicId: row.TopicId,
        name: row.Name,
        description: row.Description,
        centroid: row.Centroid,
        // Size-drift signal for the reconciler's name-carry guard.
        memberCount: Number(row.MemberCount),
      })),
    };
  }
}

function scopeParams(scope: TopicsScope): Record<string, string> {
  return {
    tenantId: scope.tenantId,
    appId: scope.appId,
    environment: scope.environment,
  };
}

/** trace_facets env predicate — default env sweeps in legacy '' rows. */
function facetsEnvClause(scope: TopicsScope): string {
  return scope.environmentIsDefault
    ? "(Environment = {environment:String} OR Environment = '')"
    : 'Environment = {environment:String}';
}

/**
 * Snapshot metrics for one topic: averages over the member TRACES found in
 * otel_traces. Member ids are facet unit ids and several can share one trace
 * (fan-out facets), so they dedupe to traces first — a trace's outcome counts
 * once however many of its corrections landed in the topic. Members whose
 * trace is missing (TTL'd out, or its spans not flushed yet) are excluded
 * from the denominator rather than zero-diluting the averages; a topic with
 * no surviving traces gets zeros.
 */
/**
 * `errorRate` is stored but deliberately NOT surfaced. It counts a session as
 * errored when ANY of its spans carries an error status, so it measures
 * session LENGTH rather than quality: error spans hold flat near 1.6% of all
 * spans at every session size, yet the share of sessions tripping the flag
 * climbs from 3.7% (6-20 spans) to 97.7% (500+). A 3,158-span session with two
 * transient failures scores identically to one that failed outright. Surfacing
 * it read as "86% of these sessions went wrong" when almost none had. Judging
 * whether a session achieved its goal needs the transcript, not span statuses.
 */
function topicOutcomeMetrics(
  memberIds: string[],
  outcomes: Map<string, SessionOutcome>,
): { errorRate: number; avgLatencyMs: number; avgCostUsd: number } {
  // Keyed by SESSION, not trace: several member traces of one session (a
  // parent and the subagents it spawned) describe one unit of work and carry
  // the same session-wide figures, so counting each would divide the same
  // spend by an inflated denominator. This is the unit the Sessions column
  // counts, which keeps the two columns talking about the same thing.
  const bySession = new Map<string, SessionOutcome>();
  for (const traceId of new Set(memberIds.map(unitTraceId))) {
    const outcome = outcomes.get(traceId);
    if (!outcome) continue;
    bySession.set(outcome.rootKey, outcome);
  }
  const found = bySession.size;
  if (found === 0) return { errorRate: 0, avgLatencyMs: 0, avgCostUsd: 0 };
  let errored = 0;
  let latencySum = 0;
  let costSum = 0;
  for (const outcome of bySession.values()) {
    if (outcome.isError) errored += 1;
    latencySum += outcome.latencyMs;
    costSum += outcome.costUsd;
  }
  return {
    errorRate: errored / found,
    avgLatencyMs: latencySum / found,
    avgCostUsd: costSum / found,
  };
}

/**
 * Recognizes DEGRADED topic descriptions that deserve another shot at the
 * namer on regeneration instead of being carried forward forever:
 *
 * - the keyword-fallback templates ("Sessions about x, y, z.", the older
 *   "Traces about …" wording, and the no-keywords variants) — matched on the
 *   description (a fixed template) rather than the name (arbitrary keywords)
 *   to keep false positives out;
 * - legacy mid-word truncation: descriptions written before truncation cut
 *   at a word boundary were hard-sliced at the cap, so they brush the length
 *   limit and end without terminal punctuation ("…callbacks with the").
 *   Healthy descriptions end with punctuation; re-truncated ones end with an
 *   ellipsis, which counts as terminal here;
 * - remediation framing on non-issues facets ("Pattern: …", "…; fix by …"):
 *   written when one issues-flavored namer served every facet. Carried
 *   forward it is immortal — reconciliation keeps the name and description
 *   of any stable cluster — so it re-names under the facet's own guidance.
 */
function isDegradedDescription(
  facet: TopicFacet,
  description: string | null | undefined,
): boolean {
  if (!description) return false;
  if (
    description.startsWith('Sessions about ') ||
    description.startsWith('Traces about ') ||
    description === 'Sessions sharing a common pattern.' ||
    description === 'Traces sharing a common pattern.'
  ) {
    return true;
  }
  if (
    facet !== 'issues' &&
    (description.startsWith('Pattern:') || description.includes('; fix by'))
  ) {
    return true;
  }
  return (
    description.length >= MAX_TOPIC_DESCRIPTION_LENGTH - 10 &&
    !/[.!?…]$/.test(description)
  );
}

/** Pause before retrying a cold-resuming clustering service. */
const CLUSTERING_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ClickHouse DateTime64(3)-compatible "now" (UTC, millisecond precision). */
function clickhouseNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Fold per-topic-per-hour trend rows onto a data-anchored axis: the span from
 * the earliest to the latest bucket actually present (oldest→newest), zero-
 * filling gaps so every topic's series is the same length as {@link trendDays}.
 * Granularity adapts to that span — hourly while it fits within
 * {@link TREND_HOURLY_MAX_HOURS}, daily once it's wider (a backfill) — and the
 * axis keeps its most recent {@link TREND_MAX_BUCKETS} buckets. Anchoring to the
 * data rather than now() is what lets a corpus that ended weeks ago still chart.
 * Bucket keys match ClickHouse toStartOfHour()/toStartOfDay() → "YYYY-MM-DD
 * HH:00:00" (UTC).
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

  // Epoch is UTC midnight, so flooring by the step lands on an hour/day grid.
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
    if (i === undefined) continue; // trimmed off the front of a capped axis
    let series = byTopic.get(r.TopicId);
    if (!series) {
      series = new Array<number>(trendDays.length).fill(0);
      byTopic.set(r.TopicId, series);
    }
    // += folds multiple hourly rows into one daily bucket.
    series[i] = (series[i] ?? 0) + Number(r.c);
  }
  const noMatchTrend =
    byTopic.get(NO_MATCH_TOPIC_ID) ?? new Array<number>(trendDays.length).fill(0);
  return { trendDays, trendByTopic: byTopic, noMatchTrend, trendBucket };
}
