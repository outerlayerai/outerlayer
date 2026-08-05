/**
 * The scheduled-jobs boundary for the node self-host runtime.
 *
 * `node-cron` replaces the Cloudflare cron trigger, firing every minute and
 * running the SAME `runScheduledJobs` loop the Worker's `scheduled()` uses. On
 * self-host that loop is currently a no-op — `SelfHostBillingService`
 * contributes no metering tasks (`meteringTasks() === []`), so no Stripe work
 * fires. The loop stays wired so future core jobs run on both runtimes.
 * Errors are logged to stdout (no Sentry).
 */
import cron, { type ScheduledTask } from "node-cron";
import { runScheduledJobs } from "@repo/gateway-core/jobs/run-scheduled-jobs";
import { initCache } from "@repo/gateway-core/utils";
import { memory } from "@repo/gateway-core/cache-store";
import { NodeLogger } from "@repo/gateway-core/runtime/adapters/node-logger";
import type { Env, GatewayScheduleContext, GatewayScheduleEvent } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime/execution";
import { buildGatewayContext } from "./context";

const CRON_EXPRESSION = "* * * * *"; // every minute, matching the Worker trigger
const loggerFactory = new NodeLogger();

/** Start the minute cron. Returns the task so the entrypoint can stop it on drain. */
export function startCron(env: Env): ScheduledTask {
  return cron.schedule(CRON_EXPRESSION, () => {
    const execCtx: ExecutionCtx = {
      waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
      passThroughOnException: () => {},
    };
    const gtx = buildGatewayContext(env, execCtx);
    const cache = initCache(gtx.cacheL2Store, execCtx, memory);
    const event: GatewayScheduleEvent = { cron: CRON_EXPRESSION, scheduledTime: Date.now() };
    const cronCtx: GatewayScheduleContext = { event, env, ctx: execCtx, cache };

    // Stdout error logging, tagged per job — the Worker's boundary also flushes
    // Sentry; there is none here.
    const logError = async (e: Error, source: string) => {
      loggerFactory.createLogger({ source: `scheduled:${source}` }).error(e, { cron: event.cron });
    };

    runScheduledJobs(gtx, cronCtx, { logError });
  });
}
