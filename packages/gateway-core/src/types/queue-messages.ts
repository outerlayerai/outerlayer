/**
 * Queue Message Types
 *
 * TypeScript interfaces + zod schemas for the messages flowing through this
 * gateway's Cloudflare Queues: the Stripe usage-meter fan-out and the topics
 * enrichment nomination queue. Each is the wire contract for its own
 * producer/consumer pair, so a change here changes the on-queue format for
 * both sides.
 */

import { z } from 'zod';

// =============================================================================
// Usage-meter fan-out
// =============================================================================

/**
 * One customer's usage for one metering window, enqueued by the per-minute
 * Stripe usage-meter cron and consumed by the usage-meter queue consumer.
 *
 * The producer aggregates ALL customers in three ClickHouse GROUP BY queries
 * (ClickHouse does the tenant-proportional work), then fans out one message
 * per customer so each Stripe `meterEvents.create` runs in its own consumer
 * slot — per-customer retries + DLQ instead of a tenant-count-proportional
 * loop inside a single cron invocation.
 *
 * `jobTime` is the cron's scheduled window (epoch SECONDS), carried in the
 * message so the consumer derives the exact same
 * `${stripeCustomerId}-${jobTime}` Stripe idempotency key on every retry —
 * at-least-once queue delivery + Stripe's 24h idempotency dedup gives
 * exactly-once metering per (customer, window).
 */
export interface UsageMeterQueueMessage {
  stripeCustomerId: string;
  /** spans + traces + scores for the window — the metered value. */
  totalValue: number;
  /** Per-metric breakdown, carried for consumer-side logging only. */
  spans: number;
  traces: number;
  scores: number;
  /** Cron window (epoch seconds) — the idempotency-key half. */
  jobTime: number;
}

/**
 * One trace nominated for topics enrichment, enqueued by the ingest consumer
 * when a batch it just persisted contains that trace's ROOT span (OTel SDKs
 * export a span when it ends, and the root ends last — so root arrival is the
 * trace-completion signal). Messages are sent with a delivery delay equal to
 * the enrichment debounce window so straggler child spans land first; the
 * consumer re-verifies quiet before extracting. The scheduled scan remains
 * behind this path as gap repair, so a lost or expired message is never lost
 * work — the same trace is re-discovered by the scan.
 */
export interface TopicsEnrichmentQueueMessage {
  tenantId: string;
  appId: string;
  /** Environment stamped on the root span's row ('' for legacy ingest). */
  environment: string;
  traceId: string;
  /** When the message was enqueued (epoch milliseconds) — for latency metrics. */
  enqueuedAt: number;
  /**
   * Which enrichment job this trace is nominated for. Absent → 'live'
   * (first-time enrichment of a newly ingested trace). The backfill jobs are
   * enqueued by the scheduled scans when a version bump re-drains history —
   * through the queue a full-corpus re-run is consumer-throughput bound
   * (hours) instead of cron-tick bound (days), and transient model failures
   * redeliver instead of terminally mislabeling a trace.
   */
  job?: 'live' | 'batched_refresh' | 'steering_sweep';
}

export const TopicsEnrichmentQueueMessageSchema = z.object({
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  environment: z.string(),
  traceId: z.string().min(1),
  enqueuedAt: z.number().positive(),
  job: z.enum(['live', 'batched_refresh', 'steering_sweep']).optional(),
});
