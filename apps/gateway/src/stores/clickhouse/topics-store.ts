/**
 * ClickHouse store for the Trace Topics enrichment job.
 *
 * Read side: candidate discovery + span fetch from otel_traces, active
 * topic-map centroids from trace_topic_maps. Write side: trace_facets rows.
 * Uses the same client-web + JSONEachRow conventions as the ingestion path
 * (services/clickhouse-service.ts) and async inserts with durability
 * confirmation so a cron tick can't ack work that was never persisted.
 */

import { createClient } from "@clickhouse/client-web";
import { TRACE_ID_TIME_RANGE_QUERY } from "@repo/observability-service";

/**
 * Client-level guardrails on every enrichment query: the every-minute cron
 * shares its instance with ingest, dashboards, and billing, so no single
 * enrichment query may approach the SERVER-wide memory ceiling — a query
 * over this cap fails fast by itself instead of pushing total usage past the
 * server limit and killing every concurrent workload's queries with it.
 * Spill-to-disk keeps the wide candidate scans under the cap rather than
 * failing them.
 */
export const ENRICHMENT_QUERY_SETTINGS = {
  max_memory_usage: "1200000000",
  max_bytes_before_external_group_by: "600000000",
  max_bytes_before_external_sort: "600000000",
} as const;

/**
 * Hard ceiling on any single enrichment read. Comfortably above a healthy
 * span fetch on the largest transcripts the preprocessor accepts, and below
 * the point where a stalled read would strand the queue invocation carrying it.
 */
export const ENRICHMENT_REQUEST_TIMEOUT_MS = 30_000;

/** One trace awaiting enrichment. */
export interface TraceScope {
  tenantId: string;
  appId: string;
  environment: string;
  traceId: string;
}

/** Span projection consumed by the Stage 1 preprocessor. */
export interface EnrichmentSpanRow {
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  Type: string;
  Timestamp: string;
  Input: string;
  Output: string;
}

/** Active topic-map centroids for one facet of a scope. */
export interface FacetCentroids {
  facet: string;
  mapVersion: number;
  centroids: { topicId: string; centroid: number[] }[];
}

/** Row written to trace_facets (column names match the table exactly). */
export interface TraceFacetRow {
  TenantId: string;
  AppId: string;
  Environment: string;
  TraceId: string;
  Facet: string;
  /**
   * Discriminates multiple summaries of one (trace × facet) — the steering
   * facet writes one row per correction. Part of the ReplacingMergeTree
   * sorting key, so re-extraction replaces item-for-item.
   */
  ItemIndex: number;
  /** Extraction prompt/shape version that produced this row (0 = legacy). */
  ExtractorVersion: number;
  Summary: string;
  Label: string;
  Embedding: number[];
  EmbeddingModel: string;
  TopicId: string;
  TopicDistance: number;
  MapVersion: number;
  Status: string;
  Error: string;
  /**
   * Soft-delete flag (table default 0). Set to 1 only on tombstone rows the
   * steering re-extraction writes to supersede stale fan-out items —
   * ReplacingMergeTree(UpdatedAt, IsDeleted) folds them away at merge.
   */
  IsDeleted?: number;
}

export interface TopicsStore {
  findUnenrichedTraces(opts: {
    debounceMinutes: number;
    lookbackHours: number;
    limit: number;
    tenantAllowlist: string[];
  }): Promise<TraceScope[]>;
  /**
   * Steering backfill: traces the live path already enriched (they have a
   * task facet row) whose steering rows are missing OR were written by an
   * older extractor version. The live candidate scan excludes any trace with
   * facet rows, so history can only gain (or refresh) steering rows through
   * this scan; bumping the extractor version in code re-drains history
   * exactly once.
   */
  findSteeringBackfillCandidates(opts: {
    lookbackHours: number;
    limit: number;
    tenantAllowlist: string[];
    extractorVersion: number;
  }): Promise<TraceScope[]>;
  /**
   * Batched-facet refresh: traces whose task/sentiment/issues rows were
   * written by an extractor OLDER than the current batched version. Bumping
   * the version in code re-drains history under the new prompt exactly once
   * — the refresh replaces the rows version-stamped, which is what makes
   * every processed candidate terminal.
   */
  findBatchedRefreshCandidates(opts: {
    lookbackHours: number;
    limit: number;
    tenantAllowlist: string[];
    extractorVersion: number;
  }): Promise<TraceScope[]>;
  /**
   * Whether ANY task facet row (any version, any status, marker or error
   * included) exists for the trace — the queue consumer's idempotency check
   * under at-least-once delivery. A task row proves some path already owns
   * this trace: the live scan wrote it, a duplicate message got there first,
   * or the refresh pass is mid-upgrade (version bumps are the refresh scan's
   * job, so the queue path never re-does old-version rows).
   */
  hasTaskFacetRow(scope: TraceScope): Promise<boolean>;
  /**
   * Version-aware presence for the queue-driven BACKFILL jobs, mirroring the
   * scans' anti-join semantics: a row of the facet at >= the given extractor
   * version means this trace is already current — a duplicate or stale
   * message is a cheap no-op, which is what makes at-least-once delivery and
   * scan re-enqueues safe.
   */
  hasFacetRowsAtVersion(
    scope: TraceScope,
    facet: string,
    extractorVersion: number,
  ): Promise<boolean>;
  fetchTraceSpans(scope: TraceScope): Promise<EnrichmentSpanRow[]>;
  fetchActiveCentroids(scope: {
    tenantId: string;
    appId: string;
    environment: string;
  }): Promise<FacetCentroids[]>;
  insertFacetRows(rows: TraceFacetRow[]): Promise<void>;
}

/** Spans fetched per trace — matches the preprocessor's 128K-token cap scale. */
const MAX_SPANS_PER_TRACE = 1000;

/**
 * SQL for the un-enriched candidate scan. Exported so the predicate that
 * decides which recency the scan keys on is unit-testable without a live
 * ClickHouse.
 *
 * Keyed on `CreatedAt` (INGEST time), NOT `Timestamp` (session wall-clock).
 * A backfill/replay imports historical sessions whose spans carry OLD
 * Timestamps but land with `CreatedAt = now()`; a Timestamp-windowed scan
 * would never see them (they're already outside the window at ingest), so an
 * entire imported corpus would never be enriched. Keying on arrival makes
 * enrichment react to what recently INGESTED — live sessions (ingested when
 * they happen) are unaffected; backfilled ones are picked up within the same
 * window of their import. The completion/debounce heuristic stays on
 * `Timestamp` (a trace is "done" when no NEW spans arrive), which is correct
 * for both: a backfill's spans all share old Timestamps, so `max(Timestamp)`
 * is far past the debounce and the trace qualifies immediately.
 *
 * Cost note: `CreatedAt` is not the partition key (`toDate(Timestamp)`), so
 * this scan cannot prune partitions and reads wider than a Timestamp-keyed
 * one would. That is affordable while enrichment is allowlist-gated and off
 * by default; a `minmax` skip index on `CreatedAt` restores part-level
 * pruning when it opens up.
 *
 * Ordered human-first for the same reason as the steering sweep below: a
 * backlog dominated by subagent/programmatic transcripts otherwise consumes
 * every tick before the sessions task/steering generation can actually
 * sample are ever reached.
 */
export function buildUnenrichedCandidatesSql(hasAllowlist: boolean): string {
  const allowlistClause = hasAllowlist
    ? "AND TenantId IN ({allowlist:Array(String)})"
    : "";
  return `
        SELECT
          TenantId,
          AppId,
          any(Environment) AS Environment,
          TraceId
        FROM otel_traces FINAL
        WHERE IsDeleted = 0
          AND TraceId != ''
          AND CreatedAt >= now() - INTERVAL {lookbackHours:UInt32} HOUR
          ${allowlistClause}
          AND TraceId NOT IN (
            SELECT TraceId
            FROM trace_facets
            WHERE CreatedAt >= now64(3) - INTERVAL {lookbackHours:UInt32} HOUR
          )
        GROUP BY TenantId, AppId, TraceId
        HAVING max(Timestamp) <= now64(9) - INTERVAL {debounceMinutes:UInt32} MINUTE
        ORDER BY
          TraceId IN (
            SELECT TraceId
            FROM agent_session_summary
            WHERE (ParentSessionId != '' OR Origin = 'agent')
              ${allowlistClause}
          ) ASC,
          max(Timestamp) ASC
        LIMIT {limit:UInt32}
        `;
}

/**
 * Steering-backfill candidate scan. Keyed on trace_facets alone (never
 * otel_traces): a `task` row proves the live path finished this trace, and
 * the anti-join on CURRENT-version `steering` rows is what makes every
 * processed candidate terminal — the sweep writes steering rows (real or a
 * NONE marker) stamped with the current extractor version for each, so
 * candidates never re-enter. Rows written by an OLDER extractor don't block,
 * which is the whole re-extraction mechanism: bump the version constant and
 * the sweep drains history once under the new prompt/shape. Both sides share
 * the same lookback window; a steering row older than the window merely
 * causes one redundant, harmless re-process (ReplacingMergeTree replaces
 * item-for-item).
 *
 * Ordered human-first: transcripts NOT owned by a subagent or programmatic
 * run drain before agent-internal history, because they are the only rows
 * task/steering topic generation samples — the generation floor rises as
 * early as possible instead of after thousands of never-samplable agent
 * transcripts. Within each class, oldest arrival first. Priority membership
 * is unscoped by tenant without an allowlist (same W3C-collision rationale
 * as the NOT IN — a collision at worst reorders one trace).
 */
export function buildSteeringBackfillCandidatesSql(hasAllowlist: boolean): string {
  const allowlistClause = hasAllowlist
    ? "AND TenantId IN ({allowlist:Array(String)})"
    : "";
  return `
        SELECT
          TenantId,
          AppId,
          any(Environment) AS Environment,
          TraceId
        FROM trace_facets
        WHERE Facet = 'task'
          AND IsDeleted = 0
          AND CreatedAt >= now64(3) - INTERVAL {lookbackHours:UInt32} HOUR
          ${allowlistClause}
          AND TraceId NOT IN (
            SELECT TraceId
            FROM trace_facets
            WHERE Facet = 'steering'
              AND ExtractorVersion >= {extractorVersion:UInt16}
              AND CreatedAt >= now64(3) - INTERVAL {lookbackHours:UInt32} HOUR
          )
        GROUP BY TenantId, AppId, TraceId
        ORDER BY
          TraceId IN (
            SELECT TraceId
            FROM agent_session_summary
            WHERE (ParentSessionId != '' OR Origin = 'agent')
              ${allowlistClause}
          ) ASC,
          min(CreatedAt) ASC
        LIMIT {limit:UInt32}
  `;
}

/**
 * Batched-refresh candidate scan: traces whose `task` row (the batched
 * trio's marker of completion) predates the current batched extractor
 * version. The anti-join keys on the PRESENCE of a current-version task row
 * rather than the absence of a stale one: the refresh REPLACES rows at the same
 * ReplacingMergeTree key, and until parts merge both versions coexist — an
 * absence test would re-pick (and re-pay for) every trace until the merge
 * happened to run. Human-first order for the same reason as the steering
 * sweep: human transcripts are the rows task/steering generation samples.
 */
export function buildBatchedRefreshCandidatesSql(hasAllowlist: boolean): string {
  const allowlistClause = hasAllowlist
    ? "AND TenantId IN ({allowlist:Array(String)})"
    : "";
  return `
        SELECT
          TenantId,
          AppId,
          any(Environment) AS Environment,
          TraceId
        FROM trace_facets
        WHERE Facet = 'task'
          AND IsDeleted = 0
          AND CreatedAt >= now64(3) - INTERVAL {lookbackHours:UInt32} HOUR
          ${allowlistClause}
          AND TraceId NOT IN (
            SELECT TraceId
            FROM trace_facets
            WHERE Facet = 'task'
              AND ExtractorVersion >= {extractorVersion:UInt16}
              AND CreatedAt >= now64(3) - INTERVAL {lookbackHours:UInt32} HOUR
          )
        GROUP BY TenantId, AppId, TraceId
        ORDER BY
          TraceId IN (
            SELECT TraceId
            FROM agent_session_summary
            WHERE (ParentSessionId != '' OR Origin = 'agent')
              ${allowlistClause}
          ) ASC,
          min(CreatedAt) ASC
        LIMIT {limit:UInt32}
  `;
}

/**
 * Span fetch for ONE trace. `bounded` injects the trace's [min, max]
 * Timestamp resolved from the `otel_traces_trace_id_ts` lookup: otel_traces
 * is partitioned by toDate(Timestamp) and sorted by
 * (TenantId, AppId, toUnixTimestamp(Timestamp), …), so a by-TraceId read
 * with NO Timestamp predicate FINAL-merges across the tenant's whole
 * retention window — hundreds of MB per trace, and at enrichment concurrency
 * enough to pin a small instance at its server memory ceiling (every other
 * workload's queries then die as collateral). Bounded, the read touches only
 * the trace's own partitions/granules. The unbounded form stays as the
 * fallback when the lookup misses (rows predating the lookup MV) or fails —
 * identical results, only slower.
 *
 * The projection `toString(Timestamp) AS Timestamp` SHADOWS the raw column
 * in WHERE/ORDER BY (ClickHouse prefers select-list aliases), so the time
 * predicates must reference the qualified `spans.Timestamp` — the unqualified
 * name would compare the String alias against DateTime64 and fail.
 */
export function buildTraceSpansSql(bounded: boolean): string {
  return `
        SELECT SpanId, ParentSpanId, SpanName, Type, toString(Timestamp) AS Timestamp, Input, Output
        FROM otel_traces AS spans FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND Environment = {environment:String}
          AND TraceId = {traceId:String}
          AND IsDeleted = 0
          ${
            bounded
              ? `AND spans.Timestamp >= {tsRangeStart:DateTime64(9)}
          AND spans.Timestamp <= {tsRangeEnd:DateTime64(9)}`
              : ""
          }
        ORDER BY spans.Timestamp ASC
        LIMIT ${MAX_SPANS_PER_TRACE}
        `;
}

export const createTopicsStore = (config: {
  url: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  username?: string;
  password: string;
}): TopicsStore => {
  const client = createClient({
    url: config.url,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
    clickhouse_settings: ENRICHMENT_QUERY_SETTINGS,
    // Enrichment runs inside a queue consumer: an unbounded read can outlive
    // its invocation and hang the whole batch, costing every trace in it.
    // Failing one trace's fetch is recoverable — the message redelivers.
    request_timeout: ENRICHMENT_REQUEST_TIMEOUT_MS,
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
    /**
     * Traces with no trace_facets row, quiet for at least the debounce
     * window (no trace-completion signal exists — spans stream in across
     * queue batches, so "no new spans for N minutes" is the completion
     * heuristic), bounded to a recent INGEST lookback (see
     * buildUnenrichedCandidatesSql for why arrival, not wall-clock).
     *
     * Already-enriched traces are excluded IN the query, not after the
     * LIMIT: a post-limit diff starves fresh traces as soon as enriched
     * ones dominate the lookback window (oldest-first candidates are then
     * all enriched and the batch comes back empty forever). The NOT IN
     * subquery is bounded by trace_facets' own lookback-window CreatedAt —
     * every row written for a window trace is at most lookback old.
     * (W3C trace ids make cross-tenant TraceId collisions a non-concern;
     * a collision's worst case is one skipped enrichment.)
     */
    async findUnenrichedTraces(opts) {
      const candidates = await query<{
        TenantId: string;
        AppId: string;
        Environment: string;
        TraceId: string;
      }>(buildUnenrichedCandidatesSql(opts.tenantAllowlist.length > 0), {
        lookbackHours: opts.lookbackHours,
        debounceMinutes: opts.debounceMinutes,
        limit: opts.limit,
        ...(opts.tenantAllowlist.length > 0
          ? { allowlist: opts.tenantAllowlist }
          : {}),
      });

      return candidates.map((c) => ({
        tenantId: c.TenantId,
        appId: c.AppId,
        environment: c.Environment,
        traceId: c.TraceId,
      }));
    },

    async findSteeringBackfillCandidates(opts) {
      const candidates = await query<{
        TenantId: string;
        AppId: string;
        Environment: string;
        TraceId: string;
      }>(buildSteeringBackfillCandidatesSql(opts.tenantAllowlist.length > 0), {
        lookbackHours: opts.lookbackHours,
        limit: opts.limit,
        extractorVersion: opts.extractorVersion,
        ...(opts.tenantAllowlist.length > 0
          ? { allowlist: opts.tenantAllowlist }
          : {}),
      });

      return candidates.map((c) => ({
        tenantId: c.TenantId,
        appId: c.AppId,
        environment: c.Environment,
        traceId: c.TraceId,
      }));
    },

    async findBatchedRefreshCandidates(opts) {
      const candidates = await query<{
        TenantId: string;
        AppId: string;
        Environment: string;
        TraceId: string;
      }>(buildBatchedRefreshCandidatesSql(opts.tenantAllowlist.length > 0), {
        lookbackHours: opts.lookbackHours,
        limit: opts.limit,
        extractorVersion: opts.extractorVersion,
        ...(opts.tenantAllowlist.length > 0
          ? { allowlist: opts.tenantAllowlist }
          : {}),
      });

      return candidates.map((c) => ({
        tenantId: c.TenantId,
        appId: c.AppId,
        environment: c.Environment,
        traceId: c.TraceId,
      }));
    },

    async hasTaskFacetRow(scope) {
      // Full sorting-key-prefix point lookup — (TenantId, AppId, Environment,
      // Facet, TraceId) leads trace_facets' ORDER BY. No FINAL: superseded
      // row versions and tombstones still prove ownership.
      const rows = await query<{ one: number }>(
        `
        SELECT 1 AS one
        FROM trace_facets
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND Environment = {environment:String}
          AND Facet = 'task'
          AND TraceId = {traceId:String}
        LIMIT 1
        `,
        {
          tenantId: scope.tenantId,
          appId: scope.appId,
          environment: scope.environment,
          traceId: scope.traceId,
        },
      );
      return rows.length > 0;
    },

    async hasFacetRowsAtVersion(scope, facet, extractorVersion) {
      // Same point-lookup shape as hasTaskFacetRow, narrowed to the current
      // extractor version — the backfill jobs' terminality predicate.
      // Tombstones count: the sweep writes them version-stamped alongside
      // the surviving rows, so their presence proves the re-extraction ran.
      const rows = await query<{ one: number }>(
        `
        SELECT 1 AS one
        FROM trace_facets
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND Environment = {environment:String}
          AND Facet = {facet:String}
          AND TraceId = {traceId:String}
          AND ExtractorVersion >= {extractorVersion:UInt32}
        LIMIT 1
        `,
        {
          tenantId: scope.tenantId,
          appId: scope.appId,
          environment: scope.environment,
          facet,
          traceId: scope.traceId,
          extractorVersion,
        },
      );
      return rows.length > 0;
    },

    async fetchTraceSpans(scope) {
      // Scope by Environment too: if the same TraceId ever appears under two
      // environments (e.g. a replayed/promoted trace), fetching by
      // TraceId alone would mix both envs' spans into one preprocessed text and
      // classify them under whichever env the candidate scan happened to pick.
      //
      // The time-range lookup is a pure optimization (see buildTraceSpansSql)
      // — a miss or failure degrades to the unbounded read, never to a wrong
      // answer.
      let range: { start: string; end: string } | null = null;
      try {
        const rows = await query<{ start: string; end: string }>(
          TRACE_ID_TIME_RANGE_QUERY,
          {
            tenantId: scope.tenantId,
            appId: scope.appId,
            traceId: scope.traceId,
          },
        );
        range = rows[0]?.start && rows[0]?.end ? rows[0]! : null;
      } catch {
        range = null;
      }
      return query<EnrichmentSpanRow>(
        buildTraceSpansSql(range !== null),
        {
          ...(range ? { tsRangeStart: range.start, tsRangeEnd: range.end } : {}),
          tenantId: scope.tenantId,
          appId: scope.appId,
          environment: scope.environment,
          traceId: scope.traceId,
        },
      );
    },

    /** Latest map version per facet for the scope, with all its centroids. */
    async fetchActiveCentroids(scope) {
      const rows = await query<{
        Facet: string;
        MapVersion: number;
        TopicId: string;
        Centroid: number[];
      }>(
        `
        SELECT Facet, MapVersion, TopicId, Centroid
        FROM trace_topic_maps FINAL
        WHERE TenantId = {tenantId:String}
          AND AppId = {appId:String}
          AND Environment = {environment:String}
          AND IsDeleted = 0
          AND (Facet, MapVersion) IN (
            SELECT Facet, max(MapVersion)
            FROM trace_topic_maps FINAL
            WHERE TenantId = {tenantId:String}
              AND AppId = {appId:String}
              AND Environment = {environment:String}
              AND IsDeleted = 0
            GROUP BY Facet
          )
        ORDER BY Facet, TopicId
        `,
        {
          tenantId: scope.tenantId,
          appId: scope.appId,
          environment: scope.environment,
        },
      );

      const byFacet = new Map<string, FacetCentroids>();
      for (const row of rows) {
        let entry = byFacet.get(row.Facet);
        if (!entry) {
          entry = { facet: row.Facet, mapVersion: row.MapVersion, centroids: [] };
          byFacet.set(row.Facet, entry);
        }
        entry.centroids.push({ topicId: row.TopicId, centroid: row.Centroid });
      }
      return [...byFacet.values()];
    },

    async insertFacetRows(rows) {
      if (rows.length === 0) return;
      await client.insert({
        table: "trace_facets",
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: {
          // Durability before ack, same rationale as trace ingestion.
          async_insert: 1,
          wait_for_async_insert: 1,
        },
      });
    },
  };
};
