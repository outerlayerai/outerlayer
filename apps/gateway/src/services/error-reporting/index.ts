import {
  resolveErrorReportingConfig,
  warnLegacyDsnOnce,
} from "@repo/error-reporting-core";

import type { Env } from "@repo/gateway-core/types";

/**
 * The gateway's error-reporting toggle.
 *
 * Builds the `@sentry/cloudflare` `withSentry` options from the worker `env`,
 * gating the DSN through the shared {@link resolveErrorReportingConfig}. This is
 * the single decision point for the whole gateway:
 *
 *  - **enabled** (a DSN is set and not force-disabled) → the SDK initializes
 *    with that DSN. Point it at Better Stack, a self-hosted Sentry, or GlitchTip.
 *  - **disabled** (`ERROR_REPORTING_ENABLED=false`, `ERROR_REPORTING_BACKEND=none`,
 *    or no DSN) → `dsn` is `undefined`, so the SDK installs no client and every
 *    `captureException` / `flush` downstream becomes a no-op.
 *
 * The DSN resolves from the vendor-neutral `ERROR_REPORTING_DSN` first, falling
 * back to the legacy `BETTERSTACK_ERRORS_DSN` (with a one-time deprecation warn).
 *
 * `withSentry` invokes this per request; it is pure and cheap, and the legacy
 * warning is latched so it fires at most once per isolate.
 */
export function resolveSentryOptions(env: Env) {
  const config = resolveErrorReportingConfig(env);
  warnLegacyDsnOnce(config);

  return {
    dsn: config.enabled ? config.dsn : undefined,
    release: "unknown",
    // Adds request headers and IP for users, for more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
    // Disable OTel setup to avoid conflicts with Better Stack tracing
    skipOpenTelemetrySetup: true,
  };
}
