import { GatewayScheduleContext } from "@repo/gateway-core/types";
import { createLoggerFromContext } from "../services/logger";
import { isSyntheticStripeCustomerId } from "../billing/synthetic-customer";

const BYTES_PER_GB = 1_000_000_000;

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface IClickHouseClient {
  query(params: { query: string; format: string }): Promise<{ json<T>(): Promise<T[]> }>;
  close(): Promise<void>;
}

export interface IStripeClient {
  billing: {
    meterEvents: {
      create(
        params: { event_name: string; payload: { value: string; stripe_customer_id: string } },
        options: { idempotencyKey: string },
      ): Promise<unknown>;
    };
  };
}

export interface StorageMeteringDeps {
  clickhouse: IClickHouseClient;
  stripe: IStripeClient;
}

export const storageMeteringHandler = async (
  { env, event }: GatewayScheduleContext,
  { clickhouse, stripe }: StorageMeteringDeps,
) => {
  const logger = createLoggerFromContext(env, {
    source: "scheduled:storage-metering",
  });

  const jobTime = event.scheduledTime / 1000;
  const jobTimeWith1MinBuffer = jobTime - 60;

  logger.info("storage metering handler started", {
    jobTime,
    jobTimeWith1MinBuffer,
    cron: event.cron,
  });

  try {
    // Delta metering: query bytes ingested in the last 60-second window,
    // convert to fractional GB, send to Stripe meter.
    // Cap enforcement is handled lazily by StorageCapService (queries Stripe meter).
    // Sums the PayloadBytes materialized column rather than re-deriving the
    // size from the payload columns: summing them in the query forces this
    // read to pull `Input`, `Output` and three Maps for every span in the
    // window, which peaks in the GiB range and intermittently blows the
    // client's per-query cap — and a metering run that dies leaves that
    // minute's storage unmetered. The column holds the identical expression,
    // computed at insert, so the billed number is unchanged. FINAL stays: it
    // collapses retried spans, and double-counting one would over-bill.
    const deltaResult = await clickhouse.query({
      query: `
        SELECT
          StripeCustomerId as stripeCustomerId,
          SUM(PayloadBytes) AS deltaBytes
        FROM otel_traces FINAL
        WHERE CreatedAt < ${jobTime} AND CreatedAt >= ${jobTimeWith1MinBuffer}
          AND IsDeleted = 0
          AND StripeCustomerId != ''
        GROUP BY StripeCustomerId
      `,
      format: "JSONEachRow",
    });

    type DeltaRow = {
      stripeCustomerId: string;
      deltaBytes: string;
    };

    const deltaRows = await deltaResult.json<DeltaRow>();

    logger.info("storage delta query completed", {
      customerCount: deltaRows.length,
    });

    if (deltaRows.length > 0) {
      let eventsSent = 0;

      for (const row of deltaRows) {
        // Synthetic (test/fixture) customers have no Stripe customer behind
        // their id (see isSyntheticStripeCustomerId); metering their storage
        // delta always 404s and logs an error for a customer that was never
        // real. Skip them — same root cause as the usage-meter guard.
        if (isSyntheticStripeCustomerId(row.stripeCustomerId)) continue;

        const deltaBytes = Number(row.deltaBytes) || 0;
        if (deltaBytes === 0) continue;

        const deltaGb = deltaBytes / BYTES_PER_GB;

        try {
          await stripe.billing.meterEvents.create(
            {
              // Job only runs when billing is enabled (gated in index.ts scheduled).
              event_name: env.STRIPE_STORAGE_METER_KEY!,
              payload: {
                value: `${deltaGb}`,
                stripe_customer_id: row.stripeCustomerId,
              },
            },
            {
              idempotencyKey: `storage-${row.stripeCustomerId}-${jobTime}`,
            }
          );

          logger.info("storage meter event sent", {
            stripeCustomerId: row.stripeCustomerId,
            deltaBytes,
            deltaGb,
            idempotencyKey: `storage-${row.stripeCustomerId}-${jobTime}`,
          });

          eventsSent++;
        } catch (err) {
          logger.error(
            err instanceof Error
              ? err
              : new Error("Stripe storage meter event creation failed"),
            {
              stripeCustomerId: row.stripeCustomerId,
              deltaBytes,
              deltaGb,
            }
          );
          continue;
        }
      }

      logger.info("storage delta metering completed", {
        totalEventsSent: eventsSent,
        totalCustomers: deltaRows.length,
      });
    }
  } catch (err) {
    logger.error(
      err instanceof Error ? err : new Error("storage metering handler failed"),
      { jobTime }
    );
    await logger.flush();
    throw err;
  } finally {
    await clickhouse.close().catch(() => {});
  }

  await logger.flush();
};
