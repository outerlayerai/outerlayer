/**
 * Trace Topics enrichment — Stages 1–3 + classification, per trace (056).
 *
 * Runs from the every-minute scheduled handler (cron poll, not a
 * second queue — the poll IS the trace-completion debounce). Per tick:
 *
 *   candidates (quiet ≥ N min, no facet row yet, bounded batch)
 *     → Stage 1 preprocess (blob previews accepted)
 *     → Stage 2 ONE batched facet call {task, sentiment+label, issues}
 *     → Stage 3 embed task/issues summaries (client normalizes)
 *     → classify vs active topic-map centroids (no model call)
 *     → INSERT trace_facets rows
 *
 * Failure isolation: a facet error lands as Status='error' on that facet's
 * row; an embedding failure keeps the summary (Status='ok') but records the
 * error and leaves Embedding empty. Rows are ALWAYS written for attempted
 * traces — that is the loop-prevention: enriched-or-errored traces never
 * re-enter the candidate scan.
 */

import {
  BATCHED_EXTRACTOR_VERSION,
  DEFAULT_ASSIGN_MAX_DISTANCE,
  FACET_NONE_SENTINEL,
  MAX_STEERING_CORRECTIONS,
  STEERING_FACET,
  STEERING_NONE_SENTINEL,
  isFacetNoneSentinel,
  isHarnessOnlySession,
  isRetryableModelErrorMessage,
  classifyEmbedding,
  createTopicsModelClientsFromEnv,
  embedFacetSummaries,
  preprocessTraceToText,
  resolveTopicsModelSelection,
  summarizeFacetsBatched,
  type BatchFacetSummaries,
  type EmbeddingClient,
  type FacetEmbeddingResult,
  type FacetSpec,
  type StructuredModelClient,
  type TopicCentroid,
  type TopicsModelEnv,
  type TracePreprocessorSpan,
} from "@repo/trace-topics";
import type {
  EnrichmentSpanRow,
  FacetCentroids,
  TopicsStore,
  TraceFacetRow,
  TraceScope,
} from "../stores/clickhouse/topics-store";

/**
 * A queued enrichment failed on something worth redelivering (rate limit,
 * timeout, transport drop). Thrown BEFORE any rows are written, so the trace
 * stays non-terminal and the queue's retry owns the next attempt.
 */
export class RetryableEnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableEnrichmentError";
  }
}

/** Terminal outcomes of one queued-enrichment attempt (throws are the rest). */
export type QueuedEnrichmentOutcome =
  | "enriched"
  | "already_enriched"
  | "trace_missing"
  | "trace_not_quiet";

/** Facets that produce embeddings and participate in clustering. */
export const CLUSTERED_FACETS = ["task", "issues"] as const;

/** Traces enriched concurrently within one tick (Workers subrequest budget). */
const TRACE_CONCURRENCY = 3;

/**
 * Per-tick wall-clock budgets. The passes run sequentially on an
 * every-minute cron, so their budgets must sum to LESS than the cron
 * interval: a pass that runs unbounded (a full batch of large transcripts is
 * minutes of LLM latency) eats the whole invocation and everything sequenced
 * after it never executes — a backlog of thousands then drains at
 * single-digit traces per hour while looking "enabled". Budgets are checked
 * at chunk boundaries; anything unprocessed re-enters the next tick's scan.
 * The trace caps bound subrequests when a tick is all cheap marker rows
 * rather than LLM-paced extractions.
 */
const LIVE_TICK_BUDGET_MS = 20_000;
const SWEEP_TICK_BUDGET_MS = 15_000;
const SWEEP_CONCURRENCY = 6;
const MAX_SWEEP_TRACES_PER_TICK = 200;
/**
 * Batched-facet refresh runs full-transcript LLM calls (live-pass-sized, not
 * steering-sized), so it gets the live pass's concurrency and the tail of
 * the tick after the live pass and the steering sweep.
 */
const REFRESH_TICK_BUDGET_MS = 15_000;
const REFRESH_CONCURRENCY = 3;
const MAX_REFRESH_TRACES_PER_TICK = 60;

/**
 * Token budget for the batched facet call's rendering. Head+tail truncation
 * in the preprocessor turns any transcript, however many spans it carries,
 * into a bounded ~32k-token call that still sees the session's opening AND
 * its ending. Summary quality plateaus far below the model's context window,
 * so a bigger budget buys only latency, cost, and hang exposure.
 */
const ENRICHMENT_TOKEN_LIMIT = 32_000;

/**
 * Last-resort tripwire, not a routine gate: with bounded rendering every
 * realistic transcript gets a real model call, so this fires only on truly
 * pathological payloads (a corrupt or adversarial ingest). Firing is an
 * anomaly worth investigating, and the refused trace gets TERMINAL
 * error/marker rows so it looks refused instead of silently absent. A refusal
 * that leaves no row is indistinguishable from a trace that was never
 * enriched, which hides the stall instead of surfacing it.
 */
const OVERSIZED_PAYLOAD_BYTES = 5_000_000;

/**
 * Absolute per-pass deadlines within one tick, measured from tick start. The
 * handler passes these so an idle pass DONATES its slack to the passes
 * behind it: when live and the steering sweep have nothing to do, the
 * batched refresh gets ~48s of the minute instead of its 15s floor — the
 * difference between an overnight history re-drain and a couple of hours.
 * The last deadline stays under the 60s cadence so invocations don't stack.
 */
export const TICK_DEADLINES_MS = {
  live: 20_000,
  sweep: 35_000,
  refresh: 50_000,
} as const;

function isOversizedTranscript(
  spans: readonly { Input: string; Output: string }[],
): boolean {
  let bytes = 0;
  for (const span of spans) {
    bytes += span.Input.length + span.Output.length;
    if (bytes > OVERSIZED_PAYLOAD_BYTES) return true;
  }
  return false;
}

/** Resolved enrichment configuration (from env, all defaults overridable). */
export interface TopicsEnrichmentConfig {
  enabled: boolean;
  tenantAllowlist: string[];
  debounceMinutes: number;
  lookbackHours: number;
  batchLimit: number;
  facetModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  assignMaxDistance: number;
}

/** Env slice the config resolver reads — structural, so tests stay simple. */
export interface TopicsEnv extends TopicsModelEnv {
  TOPICS_ENRICHMENT_ENABLED?: string;
  TOPICS_TENANT_ALLOWLIST?: string;
  TOPICS_DEBOUNCE_MINUTES?: string;
  TOPICS_BATCH_LIMIT?: string;
  TOPICS_LOOKBACK_HOURS?: string;
}

export function resolveTopicsConfig(env: TopicsEnv): TopicsEnrichmentConfig {
  // Model names + embedding dimension follow the configured provider, so a
  // provider switch is a single env change (TOPICS_MODEL_PROVIDER) rather than
  // a code change — the summarizer/embedder just use whatever this resolves to.
  const models = resolveTopicsModelSelection(env);
  return {
    enabled: env.TOPICS_ENRICHMENT_ENABLED === "true",
    tenantAllowlist: (env.TOPICS_TENANT_ALLOWLIST ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    debounceMinutes: parsePositiveInt(env.TOPICS_DEBOUNCE_MINUTES, 5),
    // Ingest-recency window the candidate scan keys on (otel_traces.CreatedAt).
    // Default 24h keeps the live path cheap; a backfill whose sessions were
    // imported earlier needs this widened (up to physical retention) so the
    // historical corpus is eligible — otherwise it sits outside the window and
    // never enriches. The CreatedAt minmax skip index keeps a wide window from
    // scanning all parts.
    lookbackHours: parsePositiveInt(env.TOPICS_LOOKBACK_HOURS, 24),
    batchLimit: parsePositiveInt(env.TOPICS_BATCH_LIMIT, 25),
    facetModel: models.facetModel,
    embeddingModel: models.embeddingModel,
    embeddingDimension: models.embeddingDimension,
    assignMaxDistance: DEFAULT_ASSIGN_MAX_DISTANCE,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Both model seams, satisfied by one real or one mock instance. */
export interface TopicsModelClients {
  structured: StructuredModelClient;
  embedding: EmbeddingClient;
}

/**
 * Client selection — shared factory from @repo/trace-topics so the
 * gateway cron and the dashboard generation job pick identically.
 */
export function createTopicsModelClients(
  env: TopicsEnv,
): ReturnType<typeof createTopicsModelClientsFromEnv> {
  return createTopicsModelClientsFromEnv(env);
}

/** Per-tick outcome, logged by the handler when any work happened. */
export interface EnrichmentRunResult {
  scanned: number;
  enriched: number;
  failed: number;
}

export class TopicsEnrichmentService {
  constructor(
    private readonly store: TopicsStore,
    private readonly clients: TopicsModelClients,
    private readonly config: TopicsEnrichmentConfig,
    /**
     * Facets that run their OWN render + extract pass per trace (the
     * preprocessor seam) alongside the batched builtins. Injectable so a
     * custom facet is configuration, not service surgery.
     */
    private readonly ownPassFacets: readonly FacetSpec[] = [STEERING_FACET],
  ) {}

  async run(
    nowMs: () => number = () => Date.now(),
    deadlineAtMs?: number,
  ): Promise<EnrichmentRunResult> {
    const startedAt = nowMs();
    const cutoffAt = deadlineAtMs ?? startedAt + LIVE_TICK_BUDGET_MS;
    const candidates = await this.store.findUnenrichedTraces({
      debounceMinutes: this.config.debounceMinutes,
      lookbackHours: this.config.lookbackHours,
      limit: this.config.batchLimit,
      tenantAllowlist: this.config.tenantAllowlist,
    });

    const result: EnrichmentRunResult = {
      scanned: candidates.length,
      enriched: 0,
      failed: 0,
    };
    if (candidates.length === 0) return result;

    // Active centroids rarely differ trace-to-trace within a tick — cache
    // per (tenant, app, env) scope. The cache holds the PROMISE so traces of
    // the same scope running concurrently in one chunk share a single fetch.
    const centroidCache = new Map<string, Promise<FacetCentroids[]>>();

    for (let i = 0; i < candidates.length; i += TRACE_CONCURRENCY) {
      // Budget check between chunks: batchLimit is a cap, not a promise —
      // large transcripts are multi-second LLM calls, and the steering sweep
      // runs after this pass in the same invocation. Unprocessed candidates
      // still have no facet rows, so the next tick's scan re-picks them.
      if (nowMs() >= cutoffAt) {
        result.scanned = i;
        break;
      }
      const chunk = candidates.slice(i, i + TRACE_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        chunk.map((scope) => this.enrichTrace(scope, centroidCache)),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") result.enriched += 1;
        else result.failed += 1;
      }
    }
    return result;
  }

  /**
   * Steering backfill: a budgeted DRAIN over traces the live path enriched
   * BEFORE the steering facet existed (task row, no steering row). Unlike the
   * live pass's one-batch trickle (tuned for steady state), the sweep runs
   * batches back-to-back within a per-tick wall-clock budget — a historical
   * corpus of thousands drains in tens of minutes, not hours. Inserted rows
   * are visible to the next batch's anti-join, so batches don't re-pick
   * processed traces; the trace cap keeps a marker-heavy tick inside the
   * Workers subrequest budget alongside the live pass.
   *
   * Every processed candidate becomes terminal — eligible traces get the real
   * steering row, everything else (non-agent traces, single-turn sessions,
   * deleted traces, redacted text) gets a NONE-labeled marker row with no
   * embedding, so it never re-enters the scan and never counts toward the
   * generation floor. Shares the live pass's config: same enablement, same
   * allowlist, same lookback window (widen TOPICS_LOOKBACK_HOURS to reach a
   * historical corpus, exactly as for a facet backfill).
   */
  async runSteeringBackfill(
    nowMs: () => number = () => Date.now(),
    deadlineAtMs?: number,
  ): Promise<EnrichmentRunResult> {
    const startedAt = nowMs();
    const cutoffAt = deadlineAtMs ?? startedAt + SWEEP_TICK_BUDGET_MS;
    const result: EnrichmentRunResult = { scanned: 0, enriched: 0, failed: 0 };
    const centroidCache = new Map<string, Promise<FacetCentroids[]>>();

    while (nowMs() < cutoffAt && result.scanned < MAX_SWEEP_TRACES_PER_TICK) {
      const candidates = await this.store.findSteeringBackfillCandidates({
        lookbackHours: this.config.lookbackHours,
        limit: this.config.batchLimit,
        tenantAllowlist: this.config.tenantAllowlist,
        extractorVersion: STEERING_FACET.extractorVersion ?? 0,
      });
      if (candidates.length === 0) break;

      for (let i = 0; i < candidates.length; i += SWEEP_CONCURRENCY) {
        // Budget check per CHUNK, not just per batch: one batch is up to
        // batchLimit traces of LLM latency, so a between-batches check alone
        // lets a single batch blow through the invocation — the runtime then
        // kills the tick mid-flight (no logs, no clean exit), the same
        // starvation shape the budgets exist to prevent. Unprocessed
        // candidates re-enter the next tick's scan.
        if (nowMs() >= cutoffAt) break;
        const chunk = candidates.slice(i, i + SWEEP_CONCURRENCY);
        result.scanned += chunk.length;
        const outcomes = await Promise.allSettled(
          chunk.map((scope) => this.backfillSteeringTrace(scope, centroidCache)),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") result.enriched += 1;
          else result.failed += 1;
        }
      }

      // A short batch means the scan is drained (or nearly) — stop early
      // rather than paying another scan for scraps this tick.
      if (candidates.length < this.config.batchLimit) break;
    }
    return result;
  }

  private async backfillSteeringTrace(
    scope: TraceScope,
    centroidCache: Map<string, Promise<FacetCentroids[]>>,
    opts?: { throwOnRetryable?: boolean },
  ): Promise<void> {
    const spans = await this.store.fetchTraceSpans(scope);
    if (isOversizedTranscript(spans)) {
      // Terminal steering marker; the batched facets keep whatever they have
      // (this sweep owns only steering rows).
      await this.store.insertFacetRows([
        {
          ...emptyRow(scope, STEERING_FACET.key),
          Label: STEERING_NONE_SENTINEL,
          ExtractorVersion: STEERING_FACET.extractorVersion ?? 0,
        },
      ]);
      return;
    }
    const preprocessorSpans: TracePreprocessorSpan[] = spans.map((span) => ({
      id: span.SpanId,
      parentId: span.ParentSpanId,
      name: span.SpanName,
      type: span.Type,
      timestamp: span.Timestamp,
      input: span.Input,
      output: span.Output,
    }));

    const cacheKey = `${scope.tenantId}|${scope.appId}|${scope.environment}`;
    let pendingCentroids = centroidCache.get(cacheKey);
    if (!pendingCentroids) {
      pendingCentroids = this.store.fetchActiveCentroids(scope);
      centroidCache.set(cacheKey, pendingCentroids);
    }
    const centroidsByFacet = new Map(
      (await pendingCentroids).map((entry) => [entry.facet, entry]),
    );

    const steeringRows =
      spans.length > 0
        ? await this.buildOwnPassRows(STEERING_FACET, scope, preprocessorSpans, centroidsByFacet)
        : [];

    const written =
      steeringRows.length > 0
        ? steeringRows
        : [
            {
              ...emptyRow(scope, STEERING_FACET.key),
              Label: STEERING_NONE_SENTINEL,
              ExtractorVersion: STEERING_FACET.extractorVersion ?? 0,
            },
          ];
    // A re-extraction (extractor-version bump) can find FEWER corrections
    // than the previous pass wrote. Item rows above the new count keep their
    // (trace × facet × item) sorting-key identity and would survive as live
    // fan-out — stale summaries counting toward the floor and clustering.
    // Tombstone the tail up to the per-transcript cap: ReplacingMergeTree
    // (UpdatedAt, IsDeleted) folds them away, and FINAL readers skip them
    // immediately. The live pass needs none of this — it only touches traces
    // with no prior facet rows.
    const tombstones: TraceFacetRow[] = [];
    for (let index = written.length; index < MAX_STEERING_CORRECTIONS; index++) {
      tombstones.push({
        ...emptyRow(scope, STEERING_FACET.key),
        ItemIndex: index,
        ExtractorVersion: STEERING_FACET.extractorVersion ?? 0,
        IsDeleted: 1,
      });
    }

    // Queue path only: a transient model failure redelivers instead of
    // landing as a terminal error row (the scan path MUST record it — its
    // loop-prevention requires rows; the queue's is the presence check).
    if (opts?.throwOnRetryable) {
      const transient = written.find(
        (row) => row.Error !== "" && isRetryableModelErrorMessage(row.Error),
      );
      if (transient) throw new RetryableEnrichmentError(transient.Error);
    }

    await this.store.insertFacetRows([...written, ...tombstones]);
  }

  /**
   * Steering sweep for ONE trace, driven by a queue message. Same rows as
   * {@link backfillSteeringTrace} with the queue's delivery semantics: a
   * version-current steering row means done (duplicates and stale messages
   * no-op), and transient model failures throw for redelivery — only the
   * declared final attempt records them.
   */
  async sweepQueuedTrace(
    scope: TraceScope,
    opts: { finalAttempt: boolean },
  ): Promise<QueuedEnrichmentOutcome> {
    const alreadyCurrent = await this.store.hasFacetRowsAtVersion(
      scope,
      STEERING_FACET.key,
      STEERING_FACET.extractorVersion ?? 0,
    );
    if (alreadyCurrent) return "already_enriched";
    await this.backfillSteeringTrace(scope, new Map(), {
      throwOnRetryable: !opts.finalAttempt,
    });
    return "enriched";
  }

  /**
   * Batched-facet refresh for ONE trace, driven by a queue message — the
   * queue-semantics wrapper over {@link refreshBatchedTrace}, mirroring
   * {@link sweepQueuedTrace}.
   */
  async refreshQueuedTrace(
    scope: TraceScope,
    opts: { finalAttempt: boolean },
  ): Promise<QueuedEnrichmentOutcome> {
    const alreadyCurrent = await this.store.hasFacetRowsAtVersion(
      scope,
      "task",
      BATCHED_EXTRACTOR_VERSION,
    );
    if (alreadyCurrent) return "already_enriched";
    await this.refreshBatchedTrace(scope, new Map(), {
      throwOnRetryable: !opts.finalAttempt,
    });
    return "enriched";
  }

  /**
   * Backfill candidates for the queue lane, applying the service's own
   * config (lookback + allowlist) so the handler can enqueue them without
   * owning scan semantics. The version predicates are the same ones the
   * inline scans drain by, so an enqueued-and-processed trace never
   * re-qualifies.
   */
  async findRefreshCandidateScopes(limit: number): Promise<TraceScope[]> {
    return this.store.findBatchedRefreshCandidates({
      lookbackHours: this.config.lookbackHours,
      limit,
      tenantAllowlist: this.config.tenantAllowlist,
      extractorVersion: BATCHED_EXTRACTOR_VERSION,
    });
  }

  async findSweepCandidateScopes(limit: number): Promise<TraceScope[]> {
    return this.store.findSteeringBackfillCandidates({
      lookbackHours: this.config.lookbackHours,
      limit,
      tenantAllowlist: this.config.tenantAllowlist,
      extractorVersion: STEERING_FACET.extractorVersion ?? 0,
    });
  }

  private async enrichTrace(
    scope: TraceScope,
    centroidCache: Map<string, Promise<FacetCentroids[]>>,
  ): Promise<void> {
    const spans = await this.store.fetchTraceSpans(scope);
    if (spans.length === 0) return; // deleted between scan and fetch

    if (isOversizedTranscript(spans)) {
      await this.store.insertFacetRows(
        this.oversizedTraceRows(scope, spans.length, true),
      );
      return;
    }

    const rows = await this.buildAllRows(scope, spans, centroidCache);
    await this.store.insertFacetRows(rows);
  }

  /**
   * Full first-time enrichment of ONE trace, driven by a queue message rather
   * than the candidate scan. Same rows as {@link enrichTrace} — batched facets
   * plus every own-pass facet — with the queue's delivery semantics layered on:
   *
   * - Idempotent under at-least-once delivery: a task facet row (any version,
   *   any status) means some path already owns this trace, so the message is
   *   a no-op. Two in-flight duplicates that both pass the check write
   *   identical sorting keys and fold in the ReplacingMergeTree — harmless.
   * - Quiet re-verification: the message's delivery delay approximates the
   *   debounce, but a session whose root span was exported early (live
   *   streaming) can still be receiving spans — the caller retries later
   *   instead of freezing a partial transcript behind terminality.
   * - Transient model failures THROW ({@link RetryableEnrichmentError})
   *   instead of landing as terminal error rows, so queue redelivery gets to
   *   retry what the scan path must record permanently (its loop-prevention
   *   requires rows). Only the caller's declared final attempt writes the
   *   error rows, keeping the failure visible and the trace terminal.
   */
  async enrichQueuedTrace(
    scope: TraceScope,
    opts: { finalAttempt: boolean },
    nowMs: () => number = () => Date.now(),
  ): Promise<QueuedEnrichmentOutcome> {
    if (await this.store.hasTaskFacetRow(scope)) return "already_enriched";

    const spans = await this.store.fetchTraceSpans(scope);
    if (spans.length === 0) return "trace_missing";

    const latestSpanMs = latestSpanTimestampMs(spans);
    if (
      latestSpanMs !== null &&
      latestSpanMs > nowMs() - this.config.debounceMinutes * 60_000
    ) {
      return "trace_not_quiet";
    }

    if (isOversizedTranscript(spans)) {
      await this.store.insertFacetRows(
        this.oversizedTraceRows(scope, spans.length, true),
      );
      return "enriched";
    }

    const rows = await this.buildAllRows(scope, spans, new Map());
    if (!opts.finalAttempt) {
      const transient = rows.find(
        (row) => row.Error !== "" && isRetryableModelErrorMessage(row.Error),
      );
      if (transient) throw new RetryableEnrichmentError(transient.Error);
    }
    await this.store.insertFacetRows(rows);
    return "enriched";
  }

  /** Batched + own-pass rows for one trace — the full first-time row set. */
  private async buildAllRows(
    scope: TraceScope,
    spans: readonly EnrichmentSpanRow[],
    centroidCache: Map<string, Promise<FacetCentroids[]>>,
  ): Promise<TraceFacetRow[]> {
    const preprocessorSpans = toPreprocessorSpans(spans);
    const centroidsByFacet = await this.resolveCentroids(scope, centroidCache);

    const rows = await this.buildBatchedRows(scope, preprocessorSpans, centroidsByFacet);
    for (const spec of this.ownPassFacets) {
      rows.push(...(await this.buildOwnPassRows(spec, scope, preprocessorSpans, centroidsByFacet)));
    }
    return rows;
  }

  /**
   * Batched-facet refresh: re-extracts task/sentiment/issues for traces whose
   * batched rows were written by an OLDER extractor version, so bumping
   * {@link BATCHED_EXTRACTOR_VERSION} re-drains history under the new
   * prompt/shape exactly once. This is how a prompt change reaches rows that
   * were already written: without it, a corpus keeps whatever prose the old
   * prompt produced forever. Own-pass facets are
   * untouched: they version and re-drain through their own sweep.
   */
  async runBatchedRefresh(
    nowMs: () => number = () => Date.now(),
    deadlineAtMs?: number,
  ): Promise<EnrichmentRunResult> {
    const startedAt = nowMs();
    const cutoffAt = deadlineAtMs ?? startedAt + REFRESH_TICK_BUDGET_MS;
    const result: EnrichmentRunResult = { scanned: 0, enriched: 0, failed: 0 };
    const centroidCache = new Map<string, Promise<FacetCentroids[]>>();

    while (nowMs() < cutoffAt && result.scanned < MAX_REFRESH_TRACES_PER_TICK) {
      const candidates = await this.store.findBatchedRefreshCandidates({
        lookbackHours: this.config.lookbackHours,
        limit: this.config.batchLimit,
        tenantAllowlist: this.config.tenantAllowlist,
        extractorVersion: BATCHED_EXTRACTOR_VERSION,
      });
      if (candidates.length === 0) break;

      for (let i = 0; i < candidates.length; i += REFRESH_CONCURRENCY) {
        if (nowMs() >= cutoffAt) break;
        const chunk = candidates.slice(i, i + REFRESH_CONCURRENCY);
        result.scanned += chunk.length;
        const outcomes = await Promise.allSettled(
          chunk.map((scope) => this.refreshBatchedTrace(scope, centroidCache)),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") result.enriched += 1;
          else result.failed += 1;
        }
      }

      if (candidates.length < this.config.batchLimit) break;
    }
    return result;
  }

  private async refreshBatchedTrace(
    scope: TraceScope,
    centroidCache: Map<string, Promise<FacetCentroids[]>>,
    opts?: { throwOnRetryable?: boolean },
  ): Promise<void> {
    const spans = await this.store.fetchTraceSpans(scope);
    if (spans.length === 0) {
      // Trace deleted since the original enrichment. Terminality here is the
      // version predicate, so version-stamped markers must land or the
      // candidate re-enters every tick forever.
      await this.store.insertFacetRows(
        ["task", "sentiment", "issues"].map((facet) => ({
          ...emptyRow(scope, facet),
          Label: FACET_NONE_SENTINEL,
          ExtractorVersion: BATCHED_EXTRACTOR_VERSION,
        })),
      );
      return;
    }

    if (isOversizedTranscript(spans)) {
      await this.store.insertFacetRows(
        this.oversizedTraceRows(scope, spans.length, false),
      );
      return;
    }

    const preprocessorSpans = toPreprocessorSpans(spans);
    const centroidsByFacet = await this.resolveCentroids(scope, centroidCache);
    const rows = await this.buildBatchedRows(scope, preprocessorSpans, centroidsByFacet);
    // Queue path only (see backfillSteeringTrace): transient failures
    // redeliver instead of landing as terminal error rows. The deleted and
    // oversized branches above stay terminal by design — retrying can't
    // change either verdict.
    if (opts?.throwOnRetryable) {
      const transient = rows.find(
        (row) => row.Error !== "" && isRetryableModelErrorMessage(row.Error),
      );
      if (transient) throw new RetryableEnrichmentError(transient.Error);
    }
    await this.store.insertFacetRows(rows);
  }

  /**
   * Terminal rows for a transcript the pipeline refuses to model. Batched
   * facets record a visible error (queryable, and version-stamped so the
   * refresh scan retires the candidate); the steering marker keeps the
   * steering sweep from re-picking the trace. Visibility is the point — a
   * refused trace must look refused, never silently absent.
   */
  private oversizedTraceRows(
    scope: TraceScope,
    spanCount: number,
    includeSteering: boolean,
  ): TraceFacetRow[] {
    const error = `transcript exceeds enrichment bounds (${spanCount} spans, > ${OVERSIZED_PAYLOAD_BYTES} payload bytes)`;
    const rows: TraceFacetRow[] = ["task", "sentiment", "issues"].map((facet) => ({
      ...emptyRow(scope, facet),
      Status: "error",
      Error: error,
      ExtractorVersion: BATCHED_EXTRACTOR_VERSION,
    }));
    if (includeSteering) {
      rows.push({
        ...emptyRow(scope, STEERING_FACET.key),
        Label: STEERING_NONE_SENTINEL,
        ExtractorVersion: STEERING_FACET.extractorVersion ?? 0,
      });
    }
    return rows;
  }

  /**
   * Stages 1–3 for the batched facets on one trace: preprocess, one batched
   * summarization call, embed the clusterable summaries, classify against the
   * active maps. Shared verbatim by the live pass and the batched refresh so
   * a re-extraction can never drift from what first-time enrichment writes.
   */
  private async buildBatchedRows(
    scope: TraceScope,
    preprocessorSpans: readonly TracePreprocessorSpan[],
    centroidsByFacet: Map<string, FacetCentroids>,
  ): Promise<TraceFacetRow[]> {
    // Trivial-transcript gate: a session whose user turns are wholly harness
    // traffic (/clear envelopes, relayed peer messages, notifications) has
    // nothing to summarize — asked anyway, the model narrates the harness
    // mechanics and those narrations cluster into top task "topics". The
    // shape is mechanical, so it terminates here as NONE markers: no model
    // call, never embedded, and version-stamped so the refresh scans retire
    // the trace like any other.
    if (isHarnessOnlySession(preprocessorSpans)) {
      return ["task", "sentiment", "issues"].map((facet) => ({
        ...emptyRow(scope, facet),
        Label: FACET_NONE_SENTINEL,
        ExtractorVersion: BATCHED_EXTRACTOR_VERSION,
      }));
    }

    // Stage 1 — inline columns only; >32KB fields are 8KB previews,
    // and the rendering is budget-bounded with head+tail retention.
    const text = preprocessTraceToText([...preprocessorSpans], {
      tokenLimit: ENRICHMENT_TOKEN_LIMIT,
    });

    // Stage 2 — one batched call for all facets.
    const facets = await summarizeFacetsBatched(text, {
      client: this.clients.structured,
      model: this.config.facetModel,
    });

    // Stage 3 — embed only ok, NON-SENTINEL summaries of clustered facets. A
    // sentinel ("nothing to report") must never be embedded: embedded no-op
    // prose clusters like real signal and can dominate the map.
    const toEmbed = CLUSTERED_FACETS.flatMap((facet) => {
      const summary = facets[facet];
      return summary.status === "ok" && !isFacetNoneSentinel(summary.summary)
        ? [{ id: facet, summary: summary.summary }]
        : [];
    });
    const embedded = await embedFacetSummaries(toEmbed, {
      client: this.clients.embedding,
      model: this.config.embeddingModel,
      dimension: this.config.embeddingDimension,
    });
    const embeddingByFacet = new Map<string, FacetEmbeddingResult>(
      embedded.map((entry) => [entry.id, entry]),
    );

    return [
      this.buildClusteredRow(scope, "task", facets, embeddingByFacet, centroidsByFacet),
      this.buildSentimentRow(scope, facets),
      this.buildClusteredRow(scope, "issues", facets, embeddingByFacet, centroidsByFacet),
    ];
  }

  /**
   * Active-map centroids for a scope, cached per (tenant, app, env) as a
   * PROMISE so traces of the same scope running concurrently in one chunk
   * share a single fetch. Maps are stored under the CANONICAL env name
   * (dashboard generation); legacy traces stamped Environment='' therefore
   * find no map here and stay unassigned until the next generation pass
   * re-assigns them (a documented degradation of the env semantics).
   */
  private async resolveCentroids(
    scope: TraceScope,
    centroidCache: Map<string, Promise<FacetCentroids[]>>,
  ): Promise<Map<string, FacetCentroids>> {
    const cacheKey = `${scope.tenantId}|${scope.appId}|${scope.environment}`;
    let pendingCentroids = centroidCache.get(cacheKey);
    if (!pendingCentroids) {
      pendingCentroids = this.store.fetchActiveCentroids(scope);
      centroidCache.set(cacheKey, pendingCentroids);
    }
    const activeCentroids = await pendingCentroids;
    return new Map(activeCentroids.map((entry) => [entry.facet, entry]));
  }

  /**
   * One OWN-PASS facet on one trace: the spec's render shapes the document
   * (null = trace not eligible → no rows; the candidate scan is trace-grain,
   * so the builtin rows alone keep the trace out of re-scan), the spec's
   * extract yields 1..N summaries — each becomes its own row at its
   * ItemIndex, all embedded in one batched call, each classified
   * independently against the facet's active centroids. Steering is the
   * built-in instance: a user-turns-only rendering with per-correction
   * extraction (see steering-facet.ts).
   */
  private async buildOwnPassRows(
    spec: FacetSpec,
    scope: TraceScope,
    spans: readonly TracePreprocessorSpan[],
    centroidsByFacet: Map<string, FacetCentroids>,
  ): Promise<TraceFacetRow[]> {
    if (!spec.render || !spec.extract) return [];
    const document = spec.render(spans);
    if (document === null) return [];

    const base = (): TraceFacetRow => ({
      ...emptyRow(scope, spec.key),
      ExtractorVersion: spec.extractorVersion ?? 0,
    });
    const extraction = await spec.extract(document, {
      client: this.clients.structured,
      model: this.config.facetModel,
    });
    if (extraction.status === "error") {
      return [{ ...base(), Status: "error", Error: extraction.error }];
    }
    if (extraction.status === "none") {
      // Explicit "steered but no rule-shaped correction" — kept as a labeled
      // row so the share is queryable; never embedded, never clustered.
      return [{ ...base(), Label: STEERING_NONE_SENTINEL }];
    }

    // An item's kind rides the row's Label. When the spec declares
    // clusterableKinds, other kinds are STORED but never embedded — no
    // embedding means they can't enter the sample, the counts, or a topic,
    // which is the entire point: a one-off task direction is a real
    // correction but not a pattern, and embedding it manufactures fake ones.
    const kinds = extraction.kinds ?? [];
    const isClusterable = (index: number): boolean =>
      !spec.clusterableKinds || spec.clusterableKinds.includes(kinds[index] ?? "");

    const embedded = await embedFacetSummaries(
      extraction.summaries.flatMap((summary, index) =>
        isClusterable(index) ? [{ id: String(index), summary }] : [],
      ),
      {
        client: this.clients.embedding,
        model: this.config.embeddingModel,
        dimension: this.config.embeddingDimension,
      },
    );
    const embeddedById = new Map<string, FacetEmbeddingResult>(
      embedded.map((entry) => [entry.id, entry]),
    );
    const active = centroidsByFacet.get(spec.key);

    return extraction.summaries.map((summary, index) => {
      const row: TraceFacetRow = {
        ...base(),
        ItemIndex: index,
        Summary: summary,
        Label: kinds[index] ?? "",
      };
      if (!isClusterable(index)) return row;
      const item = embeddedById.get(String(index));
      if (!item || item.status === "error") {
        // Summary stands; this correction simply won't cluster (documented).
        return {
          ...row,
          Error: `embedding_failed: ${item?.status === "error" ? item.error : "no result"}`,
        };
      }
      row.Embedding = item.embedding;
      row.EmbeddingModel = item.model;

      if (active && active.centroids.length > 0) {
        const assignment = classifyEmbedding(
          item.embedding,
          active.centroids as TopicCentroid[],
          this.config.assignMaxDistance,
        );
        row.TopicId = assignment.topicId;
        row.TopicDistance = assignment.distance;
        row.MapVersion = active.mapVersion;
      }
      return row;
    });
  }

  private buildClusteredRow(
    scope: TraceScope,
    facet: (typeof CLUSTERED_FACETS)[number],
    facets: BatchFacetSummaries,
    embeddingByFacet: Map<string, FacetEmbeddingResult>,
    centroidsByFacet: Map<string, FacetCentroids>,
  ): TraceFacetRow {
    const base = { ...emptyRow(scope, facet), ExtractorVersion: BATCHED_EXTRACTOR_VERSION };
    const summary = facets[facet];
    if (summary.status === "error") {
      return { ...base, Status: "error", Error: summary.error };
    }

    // Nothing-to-report sentinel → a labeled marker row: terminal for the
    // candidate scans, visible for share queries, never embedded and never
    // counted toward the generation floor.
    if (isFacetNoneSentinel(summary.summary)) {
      return { ...base, Label: FACET_NONE_SENTINEL };
    }

    base.Summary = summary.summary;
    const embedding = embeddingByFacet.get(facet);
    if (!embedding || embedding.status === "error") {
      // Summary stands; topics simply won't see this trace (documented).
      return {
        ...base,
        Error: `embedding_failed: ${embedding?.status === "error" ? embedding.error : "no result"}`,
      };
    }

    base.Embedding = embedding.embedding;
    base.EmbeddingModel = embedding.model;

    const active = centroidsByFacet.get(facet);
    if (active && active.centroids.length > 0) {
      const assignment = classifyEmbedding(
        embedding.embedding,
        active.centroids as TopicCentroid[],
        this.config.assignMaxDistance,
      );
      base.TopicId = assignment.topicId;
      base.TopicDistance = assignment.distance;
      base.MapVersion = active.mapVersion;
    }
    return base;
  }

  private buildSentimentRow(
    scope: TraceScope,
    facets: BatchFacetSummaries,
  ): TraceFacetRow {
    const base = { ...emptyRow(scope, "sentiment"), ExtractorVersion: BATCHED_EXTRACTOR_VERSION };
    const sentiment = facets.sentiment;
    if (sentiment.status === "error") {
      return { ...base, Status: "error", Error: sentiment.error };
    }
    return { ...base, Summary: sentiment.summary, Label: sentiment.label };
  }
}

/**
 * Latest span Timestamp of a fetched transcript, in epoch ms — the queue
 * path's quiet check. Timestamps arrive as ClickHouse DateTime64 strings
 * (`YYYY-MM-DD HH:MM:SS.fffffffff`, UTC); `Date.parse` reads them once
 * normalized to ISO form (V8 truncates sub-ms digits). Unparseable values are
 * skipped; null means no span carried a usable timestamp — callers treat that
 * as quiet, matching the scan path (which never re-checks at fetch time).
 */
function latestSpanTimestampMs(
  spans: readonly { Timestamp: string }[],
): number | null {
  let latest: number | null = null;
  for (const span of spans) {
    const normalized = span.Timestamp.includes("T")
      ? span.Timestamp
      : span.Timestamp.replace(" ", "T");
    const ms = Date.parse(
      normalized.endsWith("Z") ? normalized : `${normalized}Z`,
    );
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** Span-row → preprocessor-span projection shared by every extraction path. */
function toPreprocessorSpans(
  spans: readonly { SpanId: string; ParentSpanId: string; SpanName: string; Type: string; Timestamp: string; Input: string; Output: string }[],
): TracePreprocessorSpan[] {
  return spans.map((span) => ({
    id: span.SpanId,
    parentId: span.ParentSpanId,
    name: span.SpanName,
    type: span.Type,
    timestamp: span.Timestamp,
    input: span.Input,
    output: span.Output,
  }));
}

function emptyRow(scope: TraceScope, facet: string): TraceFacetRow {
  return {
    TenantId: scope.tenantId,
    AppId: scope.appId,
    Environment: scope.environment,
    TraceId: scope.traceId,
    Facet: facet,
    ItemIndex: 0,
    ExtractorVersion: 0,
    Summary: "",
    Label: "",
    Embedding: [],
    EmbeddingModel: "",
    TopicId: "",
    TopicDistance: 0,
    MapVersion: 0,
    Status: "ok",
    Error: "",
  };
}
