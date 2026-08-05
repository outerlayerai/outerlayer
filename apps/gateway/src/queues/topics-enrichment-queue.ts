/**
 * Topics-enrichment queue: scheduled-scan producer + consumer.
 *
 * The scheduled scan discovers enrichment work by re-querying ClickHouse
 * every minute inside a fixed tick budget — throughput is capped by the tick,
 * regardless of backlog. A version bump re-drains history via
 * {@link enqueueTopicsBackfillBatch}: the scan enqueues one job-tagged
 * message per candidate trace so a full-corpus re-run is consumer-throughput
 * bound (hours) instead of cron-tick bound (days), and transient model
 * failures redeliver instead of terminally mislabeling a trace. There is no
 * DLQ on this queue: the authoritative retry-of-last-resort is the scan
 * itself, which re-discovers any trace whose message was lost or expired.
 *
 * Delivery is at-least-once; the consumer is idempotent (a task facet row for
 * the trace means some path already owns it) and re-verifies the debounce
 * quiet window before extracting, so early-exported roots of still-streaming
 * sessions are retried later rather than frozen as partial summaries.
 *
 * Retry semantics — the reason this path exists beyond throughput: the scan's
 * loop-prevention REQUIRES rows for every attempted trace, so a transient
 * model failure (429, timeout, transport drop) lands there as a TERMINAL
 * error row. Here the service throws {@link RetryableEnrichmentError} before
 * writing anything, the message redelivers with backoff, and only the final
 * attempt records the failure terminally.
 */

import type { MessageBatch, Message, ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from '@repo/gateway-core/types';
import {
  TopicsEnrichmentQueueMessageSchema,
  type TopicsEnrichmentQueueMessage,
} from '@repo/gateway-core/types/queue-messages';
import type { QueueMessageSendRequest } from '@repo/gateway-core/runtime';
import { createLoggerFromContext, type ILoggerService } from '../services/logger';
import { createTopicsStore } from '../stores/clickhouse/topics-store';
import { clickHouseWriteAuth } from '@repo/gateway-core/stores/clickhouse/write-identity';
import {
  RetryableEnrichmentError,
  TopicsEnrichmentService,
  createTopicsModelClients,
  resolveTopicsConfig,
  type QueuedEnrichmentOutcome,
  type TopicsEnrichmentConfig,
} from '../services/topics-enrichment-service';

/**
 * Delivery cap, mirrored in wrangler.toml (`max_retries`). Higher than the
 * ingest queue's 5 because retries here are routine, not exceptional: a
 * still-streaming session re-delivers once per debounce window until quiet,
 * and a provider outage should ride out tens of minutes of backoff before
 * anything is recorded terminally.
 */
export const TOPICS_MAX_RETRY_ATTEMPTS = 20;

/** Cloudflare Queues sendBatch limit. */
const SEND_BATCH_LIMIT = 100;

/** Error-retry backoff: linear in attempts, capped at 15 minutes. */
function errorRetryDelaySeconds(attempts: number): number {
  return Math.min(120 * attempts, 900);
}

/**
 * Enqueue backfill work discovered by the scheduled scans: one job-tagged
 * message per candidate trace, no delivery delay (history is already quiet).
 * The scans' version anti-joins stop re-discovering a trace once its rows
 * land, and the consumer's version-aware presence check makes any overlap
 * duplicate a cheap no-op — which is what makes scan-cadence enqueueing safe
 * without coordination state.
 */
export async function enqueueTopicsBackfillBatch(
  queue: NonNullable<Env['TOPICS_QUEUE']>,
  logger: ILoggerService,
  scopes: readonly {
    tenantId: string;
    appId: string;
    environment: string;
    traceId: string;
  }[],
  job: 'batched_refresh' | 'steering_sweep',
): Promise<void> {
  if (scopes.length === 0) return;
  try {
    const requests: QueueMessageSendRequest<TopicsEnrichmentQueueMessage>[] =
      scopes.map((scope) => ({
        body: {
          tenantId: scope.tenantId,
          appId: scope.appId,
          environment: scope.environment,
          traceId: scope.traceId,
          enqueuedAt: Date.now(),
          job,
        },
      }));
    for (let i = 0; i < requests.length; i += SEND_BATCH_LIMIT) {
      await queue.sendBatch(requests.slice(i, i + SEND_BATCH_LIMIT));
    }
    logger.info('[topics-queue] Backfill batch enqueued', {
      _metric: true,
      metric_name: 'topics.backfill_enqueued',
      metric_value: requests.length,
      job,
    });
  } catch (err) {
    logger.warn('[topics-queue] Backfill enqueue failed (scan will repair)', {
      job,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Optional dependency overrides for {@link handleTopicsEnrichmentQueue}.
 * Cloudflare only ever calls the handler with `(batch, env, ctx)`; tests
 * inject doubles here instead of standing up ClickHouse + model clients.
 */
export interface TopicsEnrichmentQueueDeps {
  service?: Pick<
    TopicsEnrichmentService,
    'enrichQueuedTrace' | 'refreshQueuedTrace' | 'sweepQueuedTrace'
  >;
  config?: TopicsEnrichmentConfig;
}

/**
 * Consumer for the `topics-enrichment` queue: one trace fully enriched per
 * message. Success/no-op → ack. Still-streaming trace → redeliver after a
 * debounce window. Transient failure → redeliver with backoff; the final
 * attempt lets the service record the failure terminally, then acks.
 */
export async function handleTopicsEnrichmentQueue(
  batch: MessageBatch<TopicsEnrichmentQueueMessage>,
  env: Env,
  ctx?: ExecutionContext,
  deps?: TopicsEnrichmentQueueDeps,
): Promise<void> {
  if (batch.messages.length === 0) return;

  const logger = createLoggerFromContext(env, { source: 'topics-enrichment-queue' }, ctx);
  const config = deps?.config ?? resolveTopicsConfig(env);

  // Disabled ⇒ drain quietly. The producer is gated by the same flag, so
  // messages here mean topics was just switched off — the scan won't process
  // them either, and parking them through 20 redeliveries only makes noise.
  if (!config.enabled) {
    for (const msg of batch.messages) msg.ack();
    await logger.flush();
    return;
  }

  let service = deps?.service;
  if (!service) {
    const { structured, embedding } = createTopicsModelClients(env);
    service = new TopicsEnrichmentService(
      createTopicsStore({
        url: env.CLICKHOUSE_HOST,
        ...clickHouseWriteAuth(env),
      }),
      { structured, embedding },
      config,
    );
  }

  await Promise.allSettled(
    batch.messages.map((msg) => processMessage(msg, service, config, logger)),
  );

  await logger.flush();
}

async function processMessage(
  msg: Message<TopicsEnrichmentQueueMessage>,
  service: Pick<
    TopicsEnrichmentService,
    'enrichQueuedTrace' | 'refreshQueuedTrace' | 'sweepQueuedTrace'
  >,
  config: TopicsEnrichmentConfig,
  logger: ILoggerService,
): Promise<void> {
  const parsed = TopicsEnrichmentQueueMessageSchema.safeParse(msg.body);
  if (!parsed.success) {
    logger.warn('[topics-queue] Invalid message dropped', {
      messageId: msg.id,
      error: parsed.error.message,
    });
    msg.ack();
    return;
  }
  const body = parsed.data;

  // Allowlist re-check: the list can change between enqueue and delivery.
  if (
    config.tenantAllowlist.length > 0 &&
    !config.tenantAllowlist.includes(body.tenantId)
  ) {
    msg.ack();
    return;
  }

  const scope = {
    tenantId: body.tenantId,
    appId: body.appId,
    environment: body.environment,
    traceId: body.traceId,
  };
  const finalAttempt = msg.attempts >= TOPICS_MAX_RETRY_ATTEMPTS;

  let outcome: QueuedEnrichmentOutcome;
  try {
    // Dispatch by job: live = first-time enrichment (default, and what every
    // pre-`job` in-flight message means); the backfill jobs re-run one facet
    // family under the current extractor version.
    switch (body.job) {
      case 'batched_refresh':
        outcome = await service.refreshQueuedTrace(scope, { finalAttempt });
        break;
      case 'steering_sweep':
        outcome = await service.sweepQueuedTrace(scope, { finalAttempt });
        break;
      default:
        outcome = await service.enrichQueuedTrace(scope, { finalAttempt });
    }
  } catch (err) {
    if (finalAttempt) {
      // Defensive: finalAttempt asks the service to record failures as rows,
      // so a throw here is infrastructure (ClickHouse read/write). Ack and
      // leave the trace rowless — the scan re-picks it.
      logger.error(
        err instanceof Error ? err : new Error('[topics-queue] enrichment failed'),
        { traceId: body.traceId, tenantId: body.tenantId, attempts: msg.attempts },
      );
      msg.ack();
      return;
    }
    msg.retry({ delaySeconds: errorRetryDelaySeconds(msg.attempts) });
    logger.warn('[topics-queue] Retrying after failure', {
      _metric: true,
      metric_name: 'topics.retried',
      metric_value: 1,
      traceId: body.traceId,
      tenantId: body.tenantId,
      attempts: msg.attempts,
      retryable: err instanceof RetryableEnrichmentError,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  switch (outcome) {
    case 'enriched':
      msg.ack();
      logger.info('[topics-queue] Trace enriched', {
        _metric: true,
        metric_name: 'topics.enriched',
        metric_value: 1,
        traceId: body.traceId,
        tenantId: body.tenantId,
        attempts: msg.attempts,
        queueLatencyMs: Date.now() - body.enqueuedAt,
      });
      return;
    case 'already_enriched':
      msg.ack();
      return;
    case 'trace_not_quiet':
      // Root exported but spans still arriving (live-streaming session).
      // Wait another debounce window; when attempts run out the scan owns it
      // (its HAVING clause applies the same quiet rule at scan time).
      if (finalAttempt) msg.ack();
      else msg.retry({ delaySeconds: config.debounceMinutes * 60 });
      return;
    case 'trace_missing':
      // Spans not readable yet (insert visibility lag) or trace deleted.
      // A couple of short retries covers lag; after that the scan owns it.
      if (finalAttempt) msg.ack();
      else msg.retry({ delaySeconds: errorRetryDelaySeconds(msg.attempts) });
      return;
  }
}
