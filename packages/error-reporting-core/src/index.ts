/**
 * @repo/error-reporting-core
 *
 * The dual-runtime / Workers-safe error-reporting port. Holds:
 *  - the {@link ErrorReportingAdapter} interface and its value types;
 *  - the runtime-agnostic {@link NoOpAdapter} (the disabled implementation);
 *  - {@link resolveErrorReportingConfig} — the self-host / no-op toggle that
 *    reads the vendor-neutral `ERROR_REPORTING_*` env vars (with a legacy
 *    `*BETTERSTACK_ERRORS_DSN` fallback) and decides enabled / backend / DSN.
 *
 * Everything here is pure and runtime-agnostic — no Sentry SDK, no Node
 * built-ins, no `process` access — so it bundles into both the Cloudflare
 * Workers gateway and the Next.js dashboard. The Sentry-backed adapter bindings
 * (which import `@sentry/nextjs` / `@sentry/cloudflare`) live in each app.
 */

export { NoOpAdapter } from "./adapter";
export type {
  ErrorReportingAdapter,
  ErrorReportContext,
  ErrorSeverityLevel,
  ErrorUser,
} from "./adapter";

export {
  resolveErrorReportingConfig,
  warnLegacyDsnOnce,
  resetLegacyWarningLatch,
} from "./config";
export type {
  ErrorReportingConfig,
  ErrorReportingEnv,
  ErrorReportingBackend,
} from "./config";
