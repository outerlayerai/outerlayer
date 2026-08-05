/**
 * LogContext - Request-scoped context for logs and traces.
 *
 * A plain interface, not a validation schema: nothing validates a LogContext at
 * runtime, so building one out of a schema object would cost construction for a
 * type that is only ever inferred.
 */
export interface LogContext {
  /** Current tenant ID (no PII) */
  tenantId?: string;

  /** Current user ID (no PII - not email) */
  userId?: string;

  /** Current app ID (when in app context) */
  appId?: string;

  /** Whether running in production */
  isProduction: boolean;
}
