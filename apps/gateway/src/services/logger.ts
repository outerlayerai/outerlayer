import { Logtail } from "@logtail/edge";
import * as Sentry from "./error-reporting/sentry";
import type { GatewayRequest, Env } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime";
import { getLogContext } from "@repo/gateway-core/context";
import type {
  ExtendedLogContext,
  ILoggerService,
  LogMetadata,
} from "@repo/gateway-core/services/logger-types";

// Re-export the contracts so CF-side call sites importing them from `./logger`
// keep working; core imports the same types from `./logger-types` directly.
export type { ExtendedLogContext, ILoggerService, LogMetadata };

/**
 * ONE Logtail per invocation, never a module singleton.
 *
 * The transport batches log lines and ships a batch with a single `fetch`.
 * That fetch is I/O owned by whichever invocation was running when the batch
 * happened to flush. Sharing one instance across invocations therefore lets a
 * batch that opened under invocation A get awaited under invocation B, and the
 * Workers runtime refuses the cross-context access ("Cannot perform I/O on
 * behalf of a different request"). The promise never settles, the runtime kills
 * the whole invocation ("Promise will never complete"), and for a queue
 * consumer that discards a finished batch and redelivers every message in it.
 *
 * A per-invocation instance costs one un-shared HTTP request; lines logged
 * within an invocation still batch together, which is where the batching was
 * ever worth anything.
 */
function createLogtail(env: Env): Logtail | null {
  if (!env.BETTERSTACK_LOGS_TOKEN || !env.BETTERSTACK_INGESTING_URL) return null;
  if (shippingSuppressedUntilMs > Date.now()) return null;
  return new Logtail(env.BETTERSTACK_LOGS_TOKEN, {
    endpoint: env.BETTERSTACK_INGESTING_URL,
    // This service owns the execution-context handling (see `ship`). Left on,
    // the transport treats a context-free log as a misconfiguration: it warns,
    // ships an EXTRA line about it, and force-flushes immediately — turning
    // every invocation into its own request to an endpoint we may already know
    // is refusing them.
    warnAboutMissingExecutionContext: false,
  });
}

/**
 * Circuit breaker for a log endpoint that is refusing traffic.
 *
 * Swallowing a failed ship keeps it from failing the request, but it does not
 * stop us ASKING. An endpoint that rejects on quota rejects every line, so the
 * gateway keeps paying a request per line to be told no, and each refusal is
 * recorded as an error against work that actually succeeded. After
 * a run of consecutive failures the transport is left unbuilt for a cooldown,
 * so logging degrades to stdout (which Cloudflare captures either way) and
 * recovers on its own once the window lapses.
 *
 * Module scope is safe here in a way a shared transport is not — these are
 * plain numbers, carrying no I/O, so no execution context can be captured and
 * leaked across invocations. It is also WEAK: the state is per-isolate, and
 * isolates churn, so every fresh isolate starts untripped and pays again. That
 * is why the threshold is one rather than a run. A quota rejection is a
 * standing condition, not a blip — the first refusal is already proof the next
 * request is wasted, so there is nothing to confirm by asking twice more.
 * Suppression is per-isolate at best; the durable fix for an environment that
 * cannot ship at all is to stop configuring an endpoint for it.
 */
const SHIP_FAILURES_BEFORE_SUPPRESS = 1;
const SHIP_SUPPRESS_MS = 60_000;
let consecutiveShipFailures = 0;
let shippingSuppressedUntilMs = 0;

function noteShipFailure(): void {
  consecutiveShipFailures += 1;
  if (consecutiveShipFailures >= SHIP_FAILURES_BEFORE_SUPPRESS) {
    shippingSuppressedUntilMs = Date.now() + SHIP_SUPPRESS_MS;
    consecutiveShipFailures = 0;
  }
}

function noteShipSuccess(): void {
  consecutiveShipFailures = 0;
}

/** @internal Test seam — resets breaker state between cases. */
export function resetLogShippingBreaker(): void {
  consecutiveShipFailures = 0;
  shippingSuppressedUntilMs = 0;
}

/**
 * Ceiling on how long a handler may wait for log shipping. Sized so a healthy
 * flush always wins the race and an unhealthy one cannot outlive the work it
 * describes; see {@link LoggerService.flush}.
 */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * LoggerService - Unified logging abstraction for Gateway
 *
 * Routes logs based on environment:
 * - Development: Console only
 * - Production/Staging: log.info/warn -> Logtail, log.error -> Sentry
 *
 * Supports both HTTP request context and queue message context.
 *
 * Constitution Compliance (Principle IX - Observability & Monitoring):
 * - Uses @logtail/edge for BetterStack integration
 * - Structured logging with context (tenantId, requestId, userId)
 * - Gracefully degrades to console in development
 */
export class LoggerService implements ILoggerService {
  private logtail: Logtail | null = null;
  private extendedContext: ExtendedLogContext;
  private isProduction: boolean;
  private ctx: ExecutionCtx | undefined;

  /**
   * Create LoggerService with explicit context
   *
   * @param env - Worker environment
   * @param context - Log context (tenantId, userId, requestId, etc.)
   * @param ctx - Optional ExecutionContext for HTTP request lifecycle
   */
  constructor(
    env: Env,
    context: ExtendedLogContext = {},
    ctx?: ExecutionCtx
  ) {
    this.extendedContext = context;
    this.isProduction = env.NODE_ENV === "production";
    this.ctx = ctx;

    if (this.isProduction) {
      this.logtail = createLogtail(env);
    }
  }

  /**
   * Hold the invocation open until a line ships, WITHOUT letting shipping
   * decide whether the work survives.
   *
   * The vendor's own `withExecutionContext` binding does the `waitUntil` half
   * and not the catch: a rejected ship (a quota 402 is the common one) becomes
   * an unhandled rejection the runtime attributes to the invocation, which is
   * how one exhausted log quota turns into thousands of recorded failures on
   * work that actually succeeded. Swallowing here keeps a telemetry outage
   * telemetry-shaped. The lines are already on stdout, which Cloudflare
   * captures regardless.
   */
  private ship(pending: unknown): void {
    // `Promise.resolve` rather than `pending.catch`: the vendor documents a
    // promise, and a version that returned anything else must still not throw
    // from a log call.
    const swallowed = Promise.resolve(pending).then(noteShipSuccess, noteShipFailure);
    this.ctx?.waitUntil(swallowed);
  }

  /**
   * Log informational message
   * - Development: Console
   * - Production: Console + Logtail
   */
  info(message: string, metadata?: LogMetadata): void {
    const logPayload = this.buildLogPayload(metadata);

    console.info(message, logPayload);

    if (this.logtail) {
      this.ship(this.logtail.info(message, logPayload));
    }
  }

  /**
   * Log warning message
   * - Development: Console
   * - Production: Console + Logtail
   */
  warn(message: string, metadata?: LogMetadata): void {
    const logPayload = this.buildLogPayload(metadata);

    console.warn(message, logPayload);

    if (this.logtail) {
      this.ship(this.logtail.warn(message, logPayload));
    }
  }

  /**
   * Log error
   * - Development: Console
   * - Production: Console + Logtail + Sentry
   */
  error(error: Error, metadata?: LogMetadata): void {
    const logPayload = this.buildLogPayload({
      errorName: error.name,
      errorMessage: error.message,
      ...metadata,
    });

    console.error(error.message, logPayload);

    if (this.logtail) {
      this.ship(this.logtail.error(error.message, logPayload));
    }

    // Send to Sentry in production
    if (this.isProduction) {
      Sentry.setContext("logContext", {
        tenantId: this.extendedContext.tenantId,
        userId: this.extendedContext.userId,
        appId: this.extendedContext.appId,
        requestId: this.extendedContext.requestId,
        source: this.extendedContext.source,
      });

      if (this.extendedContext.userId) {
        Sentry.setUser({ id: this.extendedContext.userId });
      }

      if (metadata) {
        Sentry.setContext("metadata", metadata);
      }

      Sentry.captureException(error);
    }
  }

  /**
   * Flush pending logs to BetterStack.
   * Call at end of request/queue handler.
   *
   * Bounded and error-swallowing BY DESIGN: telemetry must never decide
   * whether the work that produced it succeeds. The instance is per-invocation,
   * so this awaits only I/O this invocation owns — but a slow or rejecting
   * endpoint would still hold a finished handler open, and for a queue consumer
   * a killed invocation discards completed work and redelivers every message in
   * the batch. A dropped log line is always the cheaper loss, so the flush
   * races a timer and failures die here.
   */
  async flush(): Promise<void> {
    if (!this.logtail || !('flush' in this.logtail)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.logtail.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Shipping failed (quota rejection, transport error). The lines are
      // already on stdout, which Cloudflare captures regardless. Counted so a
      // persistently refusing endpoint trips the breaker from this path too.
      noteShipFailure();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Build log payload with auto-injected context
   */
  private buildLogPayload(metadata?: LogMetadata): Record<string, unknown> {
    return {
      ...(this.extendedContext.tenantId && { tenantId: this.extendedContext.tenantId }),
      ...(this.extendedContext.userId && { userId: this.extendedContext.userId }),
      ...(this.extendedContext.appId && { appId: this.extendedContext.appId }),
      ...(this.extendedContext.requestId && { requestId: this.extendedContext.requestId }),
      ...(this.extendedContext.source && { source: this.extendedContext.source }),
      ...metadata,
    };
  }
}

/** Create a LoggerService from an HTTP request. */
export function createLoggerService(
  request: GatewayRequest,
  env: Env,
  ctx: ExecutionCtx
): ILoggerService {
  const logContext = getLogContext(request);
  return new LoggerService(env, {
    tenantId: logContext?.tenantId,
    userId: logContext?.userId,
    requestId: logContext?.requestId,
    source: 'http',
  }, ctx);
}

/**
 * Factory function to create LoggerService from queue message context
 * (For queue handlers without HTTP request)
 */
export function createLoggerFromContext(
  env: Env,
  context: ExtendedLogContext,
  ctx?: ExecutionCtx
): ILoggerService {
  return new LoggerService(env, context, ctx);
}
