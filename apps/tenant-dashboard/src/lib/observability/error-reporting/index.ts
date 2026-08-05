import {
  resolveErrorReportingConfig,
  warnLegacyDsnOnce,
  NoOpAdapter,
  type ErrorReportingAdapter,
  type ErrorReportingConfig,
  type ErrorReportingEnv,
} from '@repo/error-reporting-core';

import { SentryNextjsAdapter } from './sentry-adapter';

/**
 * The dashboard's error-reporting seam.
 *
 * `getErrorReporter()` returns the {@link ErrorReportingAdapter} every module
 * should use instead of importing `@sentry/nextjs` directly. When error
 * reporting is enabled it returns the Sentry-backed adapter; when it is disabled
 * (`ERROR_REPORTING_ENABLED=false`, `ERROR_REPORTING_BACKEND=none`, or no DSN)
 * it returns the shared {@link NoOpAdapter}, so call sites never branch on
 * config themselves.
 *
 * The toggle is also what the Sentry init files and `next.config.mjs` consult
 * (via {@link getErrorReportingConfig}) to decide whether to call `Sentry.init`
 * / `withSentryConfig` at all.
 */

/**
 * Read the error-reporting env into the resolver.
 *
 * Each var is referenced as an explicit `process.env.<NAME>` literal so Next.js
 * statically inlines the `NEXT_PUBLIC_*` values into the client bundle. A
 * dynamic `process.env[name]` read would NOT be inlined and would resolve to
 * `undefined` in the browser.
 */
function readErrorReportingEnv(): ErrorReportingEnv {
  return {
    ERROR_REPORTING_ENABLED: process.env.ERROR_REPORTING_ENABLED,
    ERROR_REPORTING_BACKEND: process.env.ERROR_REPORTING_BACKEND,
    ERROR_REPORTING_DSN: process.env.ERROR_REPORTING_DSN,
    NEXT_PUBLIC_ERROR_REPORTING_DSN:
      process.env.NEXT_PUBLIC_ERROR_REPORTING_DSN,
    BETTERSTACK_ERRORS_DSN: process.env.BETTERSTACK_ERRORS_DSN,
    NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN:
      process.env.NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN,
  };
}

let cachedConfig: ErrorReportingConfig | undefined;

/**
 * The resolved error-reporting config for this runtime. Computed once and
 * cached; emits the one-time legacy-DSN deprecation warning on first read.
 */
export function getErrorReportingConfig(): ErrorReportingConfig {
  if (!cachedConfig) {
    cachedConfig = resolveErrorReportingConfig(readErrorReportingEnv());
    warnLegacyDsnOnce(cachedConfig);
  }
  return cachedConfig;
}

let cachedReporter: ErrorReportingAdapter | undefined;

/**
 * The error reporter every dashboard module should use. Returns the Sentry
 * adapter when reporting is enabled, otherwise the shared no-op.
 */
export function getErrorReporter(): ErrorReportingAdapter {
  if (!cachedReporter) {
    cachedReporter = getErrorReportingConfig().enabled
      ? new SentryNextjsAdapter()
      : new NoOpAdapter();
  }
  return cachedReporter;
}
