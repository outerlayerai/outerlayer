/**
 * ErrorReportingAdapter — the runtime-specific error-reporting port.
 *
 * A pure interface + value types, no runtime dependencies. Lives in
 * `@repo/error-reporting-core` so it bundles into both the Workers gateway and
 * the Next.js dashboard.
 *
 * ## Why this port exists
 *
 * Call sites must not reach for the Sentry SDK directly
 * (`Sentry.captureException(...)`). Doing so hard-wires the transport to one
 * vendor's ingest endpoint and couples the whole codebase to it, which turns
 * "send errors to a self-hosted backend" or "turn error reporting off
 * entirely" into a scattered, error-prone change.
 *
 * `ErrorReportingAdapter` reifies that coupling into substitutable
 * implementations selected by config:
 *
 *  - A Sentry-backed adapter (per app: `@sentry/nextjs` in the dashboard,
 *    `@sentry/cloudflare` in the gateway). Its DSN can point at BetterStack, a
 *    self-hosted Sentry, or a Sentry-compatible backend like GlitchTip — same
 *    code, different config.
 *  - {@link NoOpAdapter} — every method is a no-op. Selected when reporting is
 *    disabled (`ERROR_REPORTING_ENABLED=false`, `ERROR_REPORTING_BACKEND=none`,
 *    or no DSN configured).
 *
 * ## The Liskov contract
 *
 * Both implementations are fully substitutable behind this interface. Swapping
 * a Sentry adapter for {@link NoOpAdapter} changes only *whether* an event is
 * shipped, never the caller's control flow:
 *
 *  1. **Fire-and-forget.** Every method returns `void` and MUST NOT throw —
 *     error reporting is best-effort telemetry on a failure path, and a throw
 *     here would mask the original error. Implementations swallow their own
 *     transport failures.
 *  2. **No ordering guarantee.** `setUser` / `setTag` / `setContext` enrich
 *     subsequent captures, but callers must not depend on delivery timing.
 *  3. **Null clears.** `setUser(null)` / `setContext(name, null)` clear scope
 *     state; both impls accept that without throwing.
 */

/**
 * Severity level for a reported event. Matches the Sentry severity vocabulary so
 * a Sentry-backed adapter can forward it unchanged.
 */
export type ErrorSeverityLevel =
  | "fatal"
  | "error"
  | "warning"
  | "log"
  | "info"
  | "debug";

/**
 * Structured context attached to a single capture. Mirrors the subset of the
 * Sentry capture-context shape the codebase actually uses at call sites:
 * `captureException(error, { tags, extra })` and
 * `captureMessage(message, { level, tags, extra })`.
 */
export interface ErrorReportContext {
  /** Severity for the event. Defaults to the backend's own default when unset. */
  level?: ErrorSeverityLevel;
  /** Indexed, low-cardinality labels (component, route, provider). */
  tags?: Record<string, string | number | boolean>;
  /** Arbitrary structured detail attached to the event, not indexed. */
  extra?: Record<string, unknown>;
}

/**
 * The reporting identity for the current scope. `id` is required; `email` is
 * optional (server-side enrichment sometimes only has the user id).
 */
export interface ErrorUser {
  id: string;
  email?: string;
}

/**
 * The runtime-specific error-reporting port.
 *
 * Every method is fire-and-forget (`void`, never throws — see the Liskov
 * contract above). Implementations route to their backend when enabled and to
 * nothing when disabled.
 */
export interface ErrorReportingAdapter {
  /** Report an exception (any thrown value), optionally with tags/extra. */
  captureException(error: unknown, context?: ErrorReportContext): void;
  /** Report a string message, optionally with tags/extra. */
  captureMessage(message: string, context?: ErrorReportContext): void;
  /** Set (or clear, with `null`) the user on the current scope. */
  setUser(user: ErrorUser | null): void;
  /** Set (or clear, with `null`) a named structured context on the scope. */
  setContext(name: string, data: Record<string, unknown> | null): void;
  /** Set a single indexed tag on the current scope. */
  setTag(key: string, value: string | number | boolean): void;
}

/**
 * The disabled implementation: every method is a no-op.
 *
 * Selected by the factory when error reporting is off. Runtime-agnostic (no SDK,
 * no Node built-ins), so it ships from this package and is shared by every app.
 */
export class NoOpAdapter implements ErrorReportingAdapter {
  captureException(_error: unknown, _context?: ErrorReportContext): void {}
  captureMessage(_message: string, _context?: ErrorReportContext): void {}
  setUser(_user: ErrorUser | null): void {}
  setContext(_name: string, _data: Record<string, unknown> | null): void {}
  setTag(_key: string, _value: string | number | boolean): void {}
}
