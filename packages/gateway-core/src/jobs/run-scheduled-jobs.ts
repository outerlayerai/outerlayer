/**
 * The scheduled (cron) job runner — runtime-neutral.
 *
 * Runs the billing metering jobs the injected `BillingService` contributes
 * (StripeBillingService returns both Stripe jobs; self-host's
 * SelfHostBillingService returns none), each wrapped with `waitUntil` +
 * per-source error logging. Extracting the loop here keeps the Cloudflare
 * Worker `scheduled()` and the node self-host cron from drifting in which
 * jobs run, their order, or the fire-and-forget error shape.
 *
 * `logError` is injected because error logging stays entrypoint-owned: it
 * fans out to each runtime's transports (the Worker adds Sentry + an explicit
 * flush; node logs to stdout).
 */
import type { GatewayContext } from "../runtime/gateway-context";
import type { GatewayScheduleContext } from "../types";

export interface ScheduledJobDeps {
  /** Per-source error sink. Returns a Promise so the caller drains it via
   *  `waitUntil` — the Worker flushes BetterStack + Sentry inside it. */
  logError: (error: Error, source: string) => Promise<void>;
}

export function runScheduledJobs(
  gtx: GatewayContext,
  cron: GatewayScheduleContext,
  { logError }: ScheduledJobDeps,
): void {
  const { ctx } = cron;

  // Billing metering (hosted only — self-host contributes an empty list). Each
  // job is fire-and-forget: run in the background, and on failure schedule the
  // error log in the background too, so one job's failure never blocks another.
  for (const task of gtx.billing.meteringTasks(cron)) {
    // `Promise.resolve().then(run)` so a SYNCHRONOUS throw from `task.run()`
    // lands in the same `.catch` as an async rejection — a sync throw called
    // bare (`task.run().catch`) would escape the loop and drop every remaining
    // job (and the other tasks below).
    ctx.waitUntil(
      Promise.resolve()
        .then(() => task.run())
        .catch((e) => {
          ctx.waitUntil(logError(e as Error, task.source));
        }),
    );
  }
}
