import type {
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import { ErrorResponse, ResponseMessages } from "@repo/gateway-core/responses";
import {
  Env,
  GatewayRequest,
  GatewayScheduleContext,
  GatewayScheduleEvent,
  withSupabaseKeyAliases,
} from "@repo/gateway-core/types";
import { initCache } from "@repo/gateway-core/utils";
import { memory } from "@repo/gateway-core/cache-store";
import { dispatchRequest } from "@repo/gateway-core/dispatch-request";
import { runScheduledJobs } from "@repo/gateway-core/jobs/run-scheduled-jobs";
import { topicsEnrichmentHandler } from "./jobs/topics-enrichment-handler";
import {
  findingsComputeHandler,
  FINDINGS_COMPUTE_CRON,
} from "./jobs/findings-compute-handler";
import {
  retentionSweepHandler,
  RETENTION_SWEEP_CRON,
} from "./jobs/retention-sweep-handler";
// Health routes (/health, /v1/health/ingestion, /v1/health/files) are handled
// by OpenAPI routes in openapi/routes/health.ts
// getPricing is now handled by OpenAPI route (openapi/routes/pricing.ts)
import * as Sentry from "@sentry/cloudflare";
import { initLogContext } from "@repo/gateway-core/context";
import { resolveSentryOptions } from "./services/error-reporting";
import { createLoggerService, createLoggerFromContext } from "./services/logger";

import {
  handleUsageMeterQueue,
  handleUsageMeterDlq,
  handleTopicsEnrichmentQueue,
  handlePrCommentQueue,
} from "./queues";
import { buildGatewayContext } from "./runtime/cloudflare-context";
import type {
  UsageMeterQueueMessage,
  TopicsEnrichmentQueueMessage,
  PrCommentQueueMessage,
} from "@repo/gateway-core/types/queue-messages";
import { setGatewayContextFactory, setRequiredEnvKeys } from "@repo/gateway-core/openapi";

/**
 * Error-report flush that can neither outlive nor fail the work it describes.
 *
 * `Sentry.flush()` with no argument waits indefinitely, so a stalled or
 * refusing endpoint holds the handler open until the runtime kills it —
 * discarding completed work. Unhandled, its rejection is booked against the
 * invocation that logged, so a telemetry outage reads as thousands of failures
 * on work that succeeded. Events are on stdout regardless, so both are traded
 * away for the guarantee that reporting stays reporting.
 */
const SENTRY_FLUSH_TIMEOUT_MS = 2_000;
const flushErrorReports = (): Promise<unknown> =>
  Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(() => false);

// Inject the Cloudflare composition root into the core Hono app's `/v1/*` gtx
// middleware. Core never imports a concrete `buildGatewayContext`; this is the
// Worker entrypoint wiring it in (the Node entry does the same with its own).
setGatewayContextFactory(buildGatewayContext);

// The hosted-only required env keys. `/health` checks a runtime-agnostic base
// (Supabase + ClickHouse + NODE_ENV) shared by both runtimes; every other key
// the full deploy needs is declared HERE so a misconfigured hosted deploy fails
// /health at deploy time instead of breaking at runtime (Stripe metering fails
// open; Fly/build/OAuth/GitHub break at first use). These are kept OUT of the
// shared agnostic base so the node self-host entry — which declares none of
// them — reports healthy without the hosted-only secrets it never has.
setRequiredEnvKeys([
  // Stripe billing (metering + storage cap)
  "STRIPE_SECRET_KEY",
  "STRIPE_SPAN_METER_KEY",
  "STRIPE_STORAGE_METER_KEY",
  "STRIPE_STORAGE_METER_ID",
  // Unkey (burst rate limiting only — key verification moved to the Postgres store)
  "UNKEY_API_KEY",
  // API-key store pepper (HMAC secret for verifying key digests). Optional in the
  // shared schema (the node self-host runtime never verifies key values), so the
  // hosted deploy asserts its presence here — a missing pepper 401s every key.
  "API_KEY_PEPPER",
  // Cloudflare (cache purge)
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_CACHE_DOMAIN",
  // App config
  "DASHBOARD_BASE_URL",
  // GitHub App
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  // Secrets (OAuth state, token encryption)
  "OAUTH_STATE_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  // Fly Machines (env provisioning + promote)
  "FLY_API_TOKEN",
]);

export const app = {
  async fetch(
    request: GatewayRequest,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Accept legacy-named Supabase key secrets until every deploy sets the new
    // names; downstream code reads only the new fields.
    withSupabaseKeyAliases(env);

    // Initialize request context
    request.context = {};

    // Initialize log context (tenantId, userId, requestId, environment)
    initLogContext(request, env);

    // Create logger for this request (with ExecutionContext for automatic flushing)
    const logger = createLoggerService(request, env, ctx);
    const startTime = Date.now();

    try {
      const path = new URL(request.url).pathname;
      // Composition root for this entrypoint. The core dispatcher threads the
      // injected adapters into the L2 cache; the Hono app reached via the
      // dispatcher has its own gtx middleware.
      const gtx = buildGatewayContext(env, ctx);
      const cache = initCache(gtx.cacheL2Store, ctx, memory);

      // The routing table lives in gateway-core so the node self-host entry
      // shares it verbatim (see dispatch-request.ts). This entrypoint owns only
      // the observability boundary: request logging + the Sentry-coupled catch.
      const response = await dispatchRequest({ request, env, ctx, cache, gtx });

      // Log request completion with timing
      logger.info("request completed", {
        method: request.method,
        path,
        status: response.status,
        durationMs: Date.now() - startTime,
      });

      // Flush logs in the background so they're sent before the Worker terminates
      ctx.waitUntil(logger.flush());

      return response;
    } catch (err) {
      const url = new URL(request.url);

      // Log error with context auto-injected
      logger.error(err as Error, {
        path: url.pathname,
        method: request.method,
        status: 500,
        durationMs: Date.now() - startTime,
        source: "gateway-fetch",
      });

      // Flush logs and Sentry in the background
      ctx.waitUntil(Promise.all([logger.flush(), flushErrorReports()]));

      return new ErrorResponse(ResponseMessages.GenericError, 500);
    }
  },
  async scheduled(
    event: GatewayScheduleEvent,
    env: Env,
    ctx: GatewayScheduleContext["ctx"]
  ) {
    withSupabaseKeyAliases(env);

    // Composition root for the scheduled/cron entry boundary. CF types the
    // scheduled ctx as just `{ waitUntil }`, but passes a full ExecutionContext
    // at runtime — the cast lets the shared factory build the adapter set.
    const gtx = buildGatewayContext(env, ctx as unknown as ExecutionContext);
    const cache = initCache(gtx.cacheL2Store, ctx, memory);
    const cron: GatewayScheduleContext = { event, env, ctx, cache };

    // Log scheduled-job failures through LoggerService so they reach BetterStack
    // (Logtail) in addition to Sentry. LoggerService.error fans out to
    // console + Logtail + Sentry in one call. We also flush both transports
    // before the Worker terminates — Logtail batches in memory and Sentry has
    // its own queue.
    //
    // The `source` field tags every entry as "scheduled:<job>" so BetterStack
    // queries can isolate cron failures from request-path failures, and
    // distinguish which of the three jobs failed. This Sentry-coupled logger is
    // the Worker's observability boundary — the shared runner injects it.
    const logScheduledError = async (e: Error, source: string) => {
      const errorLogger = createLoggerFromContext(env, {
        source: `scheduled:${source}`,
      });
      errorLogger.error(e, { cron: event.cron });
      await Promise.all([errorLogger.flush(), flushErrorReports()]);
    };

    // The daily retention sweep fires as its OWN cron event (second trigger in
    // wrangler.toml) and runs INSTEAD of the every-minute jobs — those fire on
    // their own "* * * * *" event in the same minute. Worker-only; no-op unless
    // RETENTION_SWEEP_ENABLED. Same sync-throw-safe fire-and-forget +
    // per-source error logging shape as the jobs below.
    if (event.cron === RETENTION_SWEEP_CRON) {
      ctx.waitUntil(
        Promise.resolve()
          .then(() => retentionSweepHandler(cron))
          .catch((e) => {
            ctx.waitUntil(logScheduledError(e as Error, "retention-sweep-handler"));
          })
      );
      return;
    }

    // Nightly agent-findings compute — its OWN cron event, same shape as the
    // retention sweep. Worker-only; rides the topics-enrichment gate
    // (TOPICS_ENRICHMENT_ENABLED + allowlist): findings and enrichment are one
    // insight layer, enabled for the same tenants.
    if (event.cron === FINDINGS_COMPUTE_CRON) {
      ctx.waitUntil(
        Promise.resolve()
          .then(() => findingsComputeHandler(cron))
          .catch((e) => {
            ctx.waitUntil(logScheduledError(e as Error, "findings-compute-handler"));
          })
      );
      return;
    }

    // The cron loop (which jobs, their order, the waitUntil + per-source error
    // shape) lives in gateway-core so the node self-host cron shares it verbatim.
    runScheduledJobs(gtx, cron, {
      logError: logScheduledError,
    });

    // Insights (trace-topics) enrichment — Worker-only; no-op unless
    // TOPICS_ENRICHMENT_ENABLED. Runs alongside the shared runner with the same
    // sync-throw-safe fire-and-forget + per-source error logging shape. (Not yet
    // in `runScheduledJobs`, so the node self-host cron does not run it.)
    ctx.waitUntil(
      Promise.resolve()
        .then(() => topicsEnrichmentHandler(cron))
        .catch((e) => {
          ctx.waitUntil(logScheduledError(e as Error, "topics-enrichment-handler"));
        })
    );
  },

  /**
   * Queue handler for Cloudflare Queues
   *
   * Routes messages to appropriate handler based on queue name.
   */
  async queue(
    batch: MessageBatch<
      UsageMeterQueueMessage | TopicsEnrichmentQueueMessage | PrCommentQueueMessage
    >,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    withSupabaseKeyAliases(env);

    const queueName = batch.queue;

    const logger = createLoggerFromContext(env, {
      source: `queue:${queueName}`,
    }, ctx);

    try {
      if (queueName.includes("usage-meter-dlq")) {
        // NB: matched BEFORE "usage-meter" — the dlq name contains it.
        await handleUsageMeterDlq(batch as MessageBatch<UsageMeterQueueMessage>, env, ctx);
      } else if (queueName.includes("usage-meter")) {
        await handleUsageMeterQueue(batch as MessageBatch<UsageMeterQueueMessage>, env, ctx);
      } else if (queueName.includes("topics-enrichment")) {
        await handleTopicsEnrichmentQueue(
          batch as MessageBatch<TopicsEnrichmentQueueMessage>,
          env,
          ctx
        );
      } else if (queueName.includes("pr-comment-refresh")) {
        await handlePrCommentQueue(
          batch as MessageBatch<PrCommentQueueMessage>,
          env,
          ctx
        );
      } else {
        logger.warn("[queue] Unknown queue", { queue: queueName });
      }

      logger.info("[queue] Batch processed", {
        queue: queueName,
        messageCount: batch.messages.length,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err : new Error("[queue] Error processing batch"), {
        queue: queueName,
        messageCount: batch.messages.length,
      });
      Sentry.captureException(err);
    }

    await logger.flush();
  },
};

// Save original fetch before Sentry.withSentry() mutates app.fetch in place
// with a Proxy that wraps responses in `withIsolationScope(async ...)`.
// WebSocket 101 upgrades must be returned synchronously on the CF runtime;
// the async wrapper breaks them (causes 500). We use this reference for WS requests.
const originalAppFetch = app.fetch.bind(app);

// Sentry wrapper for error tracking. The DSN (and whether reporting runs at all)
// is resolved from env by the shared error-reporting toggle — Better Stack,
// self-hosted Sentry / GlitchTip, or disabled. See services/error-reporting.
const sentryWrappedApp = Sentry.withSentry<Env>(resolveSentryOptions, app as any);

const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const agentRequest = request as GatewayRequest;
    const sentryRequest = request as Parameters<NonNullable<typeof sentryWrappedApp.fetch>>[0];
    // Bypass Sentry for WebSocket upgrades. Sentry.withSentry() mutates
    // app.fetch in place (handler.js:29), so we use the pre-mutation reference.
    // See: https://github.com/getsentry/sentry-javascript/issues/15975
    const upgradeHeader = agentRequest.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return originalAppFetch(agentRequest, env, ctx);
    }
    return sentryWrappedApp.fetch!(sentryRequest, env, ctx);
  },
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Bypass OTEL instrumentation for cron — the OTEL exporter flush hangs
    // indefinitely (15-min wall time) and adds CPU overhead for no value since
    // cron jobs already log structured data to Better Stack via Logtail.
    // Sentry wrapper alone is sufficient for error tracking.
    return sentryWrappedApp.scheduled!(event, env, ctx);
  },
  queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    // Bypass OTEL for queue — same hanging exporter issue as cron.
    // Queue handler has its own structured logging via Logtail.
    return sentryWrappedApp.queue!(batch, env, ctx);
  },
};

export default worker as unknown as ExportedHandler<Env>;
