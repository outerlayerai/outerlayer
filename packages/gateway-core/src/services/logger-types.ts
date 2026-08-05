/**
 * Logger *contracts* — the runtime-neutral half of the logging seam.
 *
 * Split out from `logger.ts` (which imports `@logtail/edge` and is the Worker's
 * `LoggerService` impl) so that core — `runtime/gateway-context.ts`'s
 * `LoggerFactory`, `lib/entitlements.ts`, the Node adapter — can depend on the
 * logger's shape without pulling the BetterStack/edge vendor into its import
 * graph. `logger.ts` re-exports these for the CF-side call sites that already
 * import them from `./logger`.
 */

/** Additional metadata that can be passed to log methods. */
export type LogMetadata = Record<string, unknown>;

/**
 * Extended log context that supports both HTTP and queue contexts.
 *
 * - Structured logging with context (tenantId, requestId, userId)
 * - appId added for queue message context
 */
export interface ExtendedLogContext {
  tenantId?: string;
  userId?: string;
  appId?: string;
  requestId?: string;
  /** Additional context like queue name */
  source?: string;
}

/** Interface for LoggerService — enables testing with mocks. */
export interface ILoggerService {
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(error: Error, metadata?: LogMetadata): void;
  /** Flush pending logs (call at end of request/queue handler) */
  flush(): Promise<void>;
}
