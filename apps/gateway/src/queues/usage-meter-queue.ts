/**
 * Usage-meter queue consumer.
 *
 * The per-minute Stripe usage-meter cron aggregates ALL customers in three
 * ClickHouse GROUP BY queries and enqueues one {@link UsageMeterQueueMessage}
 * per customer (see jobs/stripe-meter-event-handler). This consumer makes the
 * actual `meterEvents.create` call per message, so:
 *
 *  - The cron invocation's subrequest count does not scale with tenant count
 *    (N/100 `sendBatch` calls instead of N Stripe calls).
 *  - One customer's failure retries independently (max_retries + backoff in
 *    wrangler.toml) instead of aborting anyone else.
 *  - Exhausted retries land on `usage-meter-dlq`, whose handler logs an
 *    operator alert — a dead-lettered message means one customer's minute of
 *    usage was NOT metered and needs a human.
 *
 * Exactly-once metering: delivery is at-least-once, so a message can be
 * consumed twice (retry after a success whose ack was lost, duplicate
 * delivery). The Stripe idempotency key `${stripeCustomerId}-${jobTime}` is
 * derived from the MESSAGE (the cron's scheduled window, not "now"), so every
 * attempt for the same (customer, window) sends the same key and Stripe
 * dedupes it — identical to the key the inline fallback path uses.
 */

import type { MessageBatch, Message, ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from '@repo/gateway-core/types';
import type { UsageMeterQueueMessage } from '@repo/gateway-core/types/queue-messages';
import Stripe from 'stripe';
import { createLoggerFromContext, type ILoggerService } from '../services/logger';
import { isSyntheticStripeCustomerId } from '../billing/synthetic-customer';

/**
 * Consumer for the `usage-meter` queue: one Stripe meter event per message.
 * Success → ack. Failure → retry (wrangler max_retries=5 with backoff, then
 * the platform moves the message to `usage-meter-dlq`).
 */
export async function handleUsageMeterQueue(
  batch: MessageBatch<UsageMeterQueueMessage>,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const logger = createLoggerFromContext(env, { source: 'usage-meter-queue' }, ctx);

  // Messages only exist when the billing-gated producer enqueued them, so
  // STRIPE_* are set on this deployment. If they ever aren't (misconfig), the
  // create throws → retry → DLQ, which is exactly the alert path we want.
  const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { maxNetworkRetries: 3 });

  for (const msg of batch.messages) {
    const meter = msg.body;

    // Synthetic (test/fixture) customers have no Stripe customer behind their
    // id (see isSyntheticStripeCustomerId). The producer filters them out, but
    // this consumer must too: a queued message that predates the producer's
    // guard, or a manual redrive, must NOT be metered. The create would 404,
    // exhaust retries, and dead-letter into a CRITICAL false page. Ack it as
    // a terminal no-op.
    if (isSyntheticStripeCustomerId(meter.stripeCustomerId)) {
      logger.info('skipped synthetic customer meter event', {
        stripeCustomerId: meter.stripeCustomerId,
        totalValue: meter.totalValue,
        jobTime: meter.jobTime,
        attemptNumber: msg.attempts,
      });
      msg.ack();
      continue;
    }

    const idempotencyKey = `${meter.stripeCustomerId}-${meter.jobTime}`;

    try {
      await stripe.billing.meterEvents.create(
        {
          event_name: env.STRIPE_SPAN_METER_KEY!,
          payload: {
            value: `${meter.totalValue}`,
            stripe_customer_id: meter.stripeCustomerId,
          },
        },
        { idempotencyKey }
      );

      logger.info('stripe meter event sent', {
        stripeCustomerId: meter.stripeCustomerId,
        spans: meter.spans,
        traces: meter.traces,
        scores: meter.scores,
        totalValue: meter.totalValue,
        idempotencyKey,
        attemptNumber: msg.attempts,
      });

      msg.ack();
    } catch (err) {
      logger.error(
        err instanceof Error ? err : new Error('Stripe meter event creation failed'),
        {
          stripeCustomerId: meter.stripeCustomerId,
          totalValue: meter.totalValue,
          jobTime: meter.jobTime,
          idempotencyKey,
          attemptNumber: msg.attempts,
        }
      );
      msg.retry();
    }
  }

  await logger.flush();
}

/**
 * Consumer for `usage-meter-dlq` — messages that exhausted every retry.
 * Terminal: each one is a (customer, minute) window of usage that was NOT
 * metered. Logged as a critical alert for operator follow-up (the idempotency
 * key in the log is what a manual replay would reuse), then acked.
 */
export async function handleUsageMeterDlq(
  batch: MessageBatch<UsageMeterQueueMessage>,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const logger = createLoggerFromContext(env, { source: 'usage-meter-dlq' }, ctx);

  for (const msg of batch.messages) {
    // A synthetic (test/fixture) customer that dead-lettered — e.g. a message
    // enqueued before the producer/consumer guards shipped — is NOT a real
    // under-metering incident: there is no Stripe customer to meter. Record it
    // at info WITHOUT the _alert/_metric flags so it never pages an operator or
    // inflates the DLQ counter; a genuine customer still fires the critical alert.
    if (isSyntheticStripeCustomerId(msg.body.stripeCustomerId)) {
      logSkippedSyntheticDlq(msg, logger);
    } else {
      logDeadLetteredMeterEvent(msg, logger);
    }
    // Always acknowledge DLQ messages — they're terminal.
    msg.ack();
  }

  await logger.flush();
}

/**
 * Non-paging counterpart to {@link logDeadLetteredMeterEvent} for synthetic
 * (test/fixture) customers: same searchable fields, but logged at `info` with
 * NO `_alert`/`_metric` so it never pages an operator or feeds the
 * `billing.usage_meter.dlq` counter.
 */
function logSkippedSyntheticDlq(
  msg: Message<UsageMeterQueueMessage>,
  logger: ILoggerService
): void {
  const meter = msg.body;
  logger.info('dead-lettered synthetic customer meter event (no alert)', {
    stripeCustomerId: meter.stripeCustomerId,
    totalValue: meter.totalValue,
    jobTime: meter.jobTime,
    idempotencyKey: `${meter.stripeCustomerId}-${meter.jobTime}`,
    attemptCount: msg.attempts,
  });
}

function logDeadLetteredMeterEvent(
  msg: Message<UsageMeterQueueMessage>,
  logger: ILoggerService
): void {
  const meter = msg.body;
  logger.error(
    new Error(
      `Stripe meter event failed permanently: ${meter.stripeCustomerId} window ${meter.jobTime} (${meter.totalValue} units un-metered)`
    ),
    {
      // Structured fields for alerting/searching
      _alert: true,
      severity: 'critical',
      alert_type: 'usage_meter_failure',

      // Metric for tracking
      _metric: true,
      metric_name: 'billing.usage_meter.dlq',
      metric_value: 1,

      stripeCustomerId: meter.stripeCustomerId,
      totalValue: meter.totalValue,
      spans: meter.spans,
      traces: meter.traces,
      scores: meter.scores,
      jobTime: meter.jobTime,
      idempotencyKey: `${meter.stripeCustomerId}-${meter.jobTime}`,
      attemptCount: msg.attempts,
    }
  );
}
