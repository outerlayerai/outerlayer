/**
 * Sentry-compatible error-reporting facade.
 *
 * A drop-in replacement for `import * as Sentry from "@sentry/nextjs"` at every
 * call site that only *reports* errors (capture/scope), so consumers depend on
 * this seam instead of the vendor SDK. Each function delegates to the active
 * {@link getErrorReporter} adapter — the real Sentry adapter when reporting is
 * enabled, or a no-op when it is disabled / self-hosted-off.
 *
 * The exported names deliberately mirror the `@sentry/nextjs` capture/scope API
 * so the only change a consumer makes is its import specifier:
 *   `import * as Sentry from "@sentry/nextjs"`
 *     → `import * as Sentry from "@/lib/observability/error-reporting/sentry"`
 *
 * This does NOT cover SDK lifecycle hooks (`init`, `getTraceData`,
 * `captureRouterTransitionStart`, `captureRequestError`) — those stay on the
 * real SDK in the init files.
 */
import type {
  ErrorReportContext,
  ErrorUser,
} from "@repo/error-reporting-core";

import { getErrorReporter } from "./index";

export function captureException(
  error: unknown,
  context?: ErrorReportContext
): void {
  getErrorReporter().captureException(error, context);
}

export function captureMessage(
  message: string,
  context?: ErrorReportContext
): void {
  getErrorReporter().captureMessage(message, context);
}

export function setUser(user: ErrorUser | null): void {
  getErrorReporter().setUser(user);
}

export function setContext(
  name: string,
  data: Record<string, unknown> | null
): void {
  getErrorReporter().setContext(name, data);
}

export function setTag(key: string, value: string | number | boolean): void {
  getErrorReporter().setTag(key, value);
}
