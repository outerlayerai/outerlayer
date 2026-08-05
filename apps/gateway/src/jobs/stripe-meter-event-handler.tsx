import { GatewayScheduleContext } from "@repo/gateway-core/types";
import type { UsageMeterQueueMessage } from "@repo/gateway-core/types/queue-messages";
import { createLoggerFromContext } from "../services/logger";
import { isSyntheticStripeCustomerId } from "../billing/synthetic-customer";
import { createMeteringClickHouseClient } from "../billing/metering-clickhouse";
import Stripe from "stripe";

/** Cloudflare Queues' `sendBatch` cap — messages per call. */
const QUEUE_SEND_BATCH_SIZE = 100;

export const stripeMeterEventHandler = async ({
  env,
  ctx: _ctx,
  event,
}: GatewayScheduleContext) => {
  const logger = createLoggerFromContext(env, {
    source: "scheduled:stripe-meter-handler",
  });

  const jobTime = event.scheduledTime / 1000;
  const jobTimeWith1MinBuffer = jobTime - 60;

  logger.info("stripe meter handler started", {
    jobTime,
    jobTimeWith1MinBuffer,
    bufferSeconds: 60,
    cron: event.cron,
  });

  const clickhouse = createMeteringClickHouseClient(env);

  try {
    // Query all three metrics in parallel using the TenantId→StripeCustomerId
    // mapping from otel_traces (single source of truth for customer mapping)
    const [spansResult, tracesResult, scoresResult] = await Promise.all([
      // 1. Span count per customer
      clickhouse.query({
        query: `
          SELECT StripeCustomerId as stripeCustomerId, COUNT(*) as count
          FROM otel_traces FINAL
          WHERE IsDeleted = 0
            AND CreatedAt < ${jobTime} AND CreatedAt >= ${jobTimeWith1MinBuffer}
            AND StripeCustomerId != ''
          GROUP BY StripeCustomerId
        `,
        format: 'JSONEachRow',
      }),
      // 2. Distinct trace count per customer
      clickhouse.query({
        query: `
          SELECT StripeCustomerId as stripeCustomerId, COUNT(DISTINCT TraceId) as count
          FROM otel_traces FINAL
          WHERE IsDeleted = 0
            AND CreatedAt < ${jobTime} AND CreatedAt >= ${jobTimeWith1MinBuffer}
            AND StripeCustomerId != ''
          GROUP BY StripeCustomerId
        `,
        format: 'JSONEachRow',
      }),
      // 3. Score count per customer (join via TenantId to get StripeCustomerId)
      clickhouse.query({
        query: `
          SELECT t.StripeCustomerId as stripeCustomerId, COUNT(*) as count
          FROM scores s FINAL
          INNER JOIN (
            SELECT DISTINCT TenantId, StripeCustomerId
            FROM otel_traces FINAL
            WHERE IsDeleted = 0 AND StripeCustomerId != ''
          ) t ON s.TenantId = t.TenantId
          WHERE s.IsDeleted = 0
            AND s.CreatedAt < ${jobTime} AND s.CreatedAt >= ${jobTimeWith1MinBuffer}
          GROUP BY t.StripeCustomerId
        `,
        format: 'JSONEachRow',
      }),
    ]);

    type CountRow = { stripeCustomerId: string; count: number };

    const spansData = await spansResult.json<CountRow>();
    const tracesData = await tracesResult.json<CountRow>();
    const scoresData = await scoresResult.json<CountRow>();

    await clickhouse.close();

    // Merge all counts per customer
    const totals = new Map<string, { spans: number; traces: number; scores: number }>();

    for (const row of spansData) {
      if (!totals.has(row.stripeCustomerId)) {
        totals.set(row.stripeCustomerId, { spans: 0, traces: 0, scores: 0 });
      }
      totals.get(row.stripeCustomerId)!.spans = Number(row.count);
    }

    for (const row of tracesData) {
      if (!totals.has(row.stripeCustomerId)) {
        totals.set(row.stripeCustomerId, { spans: 0, traces: 0, scores: 0 });
      }
      totals.get(row.stripeCustomerId)!.traces = Number(row.count);
    }

    for (const row of scoresData) {
      if (!totals.has(row.stripeCustomerId)) {
        totals.set(row.stripeCustomerId, { spans: 0, traces: 0, scores: 0 });
      }
      totals.get(row.stripeCustomerId)!.scores = Number(row.count);
    }

    // Drop synthetic (test/fixture) customers before any enqueue/meter. Their
    // trace usage lands here like any tenant's, but their stripe_customer_id has
    // no Stripe customer behind it (see isSyntheticStripeCustomerId), so
    // metering it always 404s → the usage-meter queue dead-letters → a CRITICAL
    // false "usage_meter_failure" page. Filtering at this single choke point
    // covers both the queue path and the inline fallback below.
    for (const stripeCustomerId of [...totals.keys()]) {
      if (isSyntheticStripeCustomerId(stripeCustomerId)) {
        totals.delete(stripeCustomerId);
      }
    }

    logger.info("clickhouse queries completed", {
      customerCount: totals.size,
      customerIds: [...totals.keys()],
    });

    if (totals.size > 0) {
      // Queue fan-out: when the usage-meter queue
      // binding exists, enqueue one message per customer and let the queue
      // consumer make the Stripe calls — per-customer retries + DLQ, and the
      // cron invocation costs N/100 `sendBatch` subrequests instead of N
      // Stripe calls (the ~1k-subrequest Worker ceiling stops being a function
      // of customer count). `jobTime` rides in each message so the consumer
      // derives the SAME `${customerId}-${jobTime}` idempotency key on every
      // retry — at-least-once delivery + Stripe's dedup = exactly-once metering.
      //
      // Binding absent (self-host, local dev without queues) → inline loop below.
      const usageMeterQueue = env.USAGE_METER_QUEUE;
      if (usageMeterQueue) {
        const messages: { body: UsageMeterQueueMessage }[] = [];
        for (const [stripeCustomerId, counts] of totals) {
          const totalValue = counts.spans + counts.traces + counts.scores;
          if (totalValue === 0) continue;
          messages.push({
            body: {
              stripeCustomerId,
              totalValue,
              spans: counts.spans,
              traces: counts.traces,
              scores: counts.scores,
              jobTime,
            },
          });
        }

        for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE) {
          await usageMeterQueue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_SIZE));
        }

        logger.info("stripe meter events enqueued", {
          enqueued: messages.length,
          totalCustomers: totals.size,
          jobTime,
        });
        // Early return skips the function-tail flush — flush here instead.
        await logger.flush();
        return;
      }

      // This job only runs when billing is enabled (gated in index.ts scheduled),
      // so STRIPE_* are guaranteed set despite being optional in the env schema.
      const stripe = new Stripe(env.STRIPE_SECRET_KEY!, {
        maxNetworkRetries: 3,
      });

      let eventsSent = 0;
      // Per-customer failure isolation: one customer's failed meter event must
      // not abort the tail, because every customer after the failure would then
      // go silently un-metered for the window and be under-billed. Failures are
      // collected and the FIRST underlying error is rethrown after the loop, so
      // the job still rejects and still alerts. Same pattern as
      // storage-metering-handler's per-row continue.
      const failures: { stripeCustomerId: string; error: unknown }[] = [];

      for (const [stripeCustomerId, counts] of totals) {
        const totalValue = counts.spans + counts.traces + counts.scores;
        if (totalValue === 0) continue;

        try {
          await stripe.billing.meterEvents.create(
            {
              event_name: env.STRIPE_SPAN_METER_KEY!,
              payload: {
                value: `${totalValue}`,
                stripe_customer_id: stripeCustomerId,
              },
            },
            {
              idempotencyKey: `${stripeCustomerId}-${jobTime}`,
            }
          );

          logger.info("stripe meter event sent", {
            stripeCustomerId,
            spans: counts.spans,
            traces: counts.traces,
            scores: counts.scores,
            totalValue,
            idempotencyKey: `${stripeCustomerId}-${jobTime}`,
          });

          eventsSent++;
        } catch (err) {
          failures.push({ stripeCustomerId, error: err });
          logger.error(
            err instanceof Error
              ? err
              : new Error("Stripe meter event creation failed"),
            {
              stripeCustomerId,
              spans: counts.spans,
              traces: counts.traces,
              scores: counts.scores,
              totalValue,
            }
          );
        }
      }

      if (failures.length > 0) {
        logger.error(
          new Error(
            `stripe meter handler: ${failures.length}/${totals.size} meter events failed (${eventsSent} sent)`
          ),
          {
            failedCustomerIds: failures.map((f) => f.stripeCustomerId),
            eventsSent,
            totalCustomers: totals.size,
          }
        );
        await logger.flush();
        // Rethrow the first underlying Stripe error so callers/alerting see the
        // real failure cause — the same rejection shape as before the isolation.
        throw failures[0]!.error;
      }

      logger.info("stripe meter handler completed", {
        totalEventsSent: eventsSent,
        totalCustomers: totals.size,
      });
    }
  } catch (err) {
    logger.error(
      err instanceof Error ? err : new Error("stripe meter handler failed"),
      { jobTime, jobTimeWith1MinBuffer }
    );
    await logger.flush();
    throw err;
  }

  await logger.flush();
};
