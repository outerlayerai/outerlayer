// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// Betterstack Error Tracking (Sentry-compatible): https://$TOKEN@$HOST/1

import * as Sentry from "@sentry/nextjs";

import { getErrorReportingConfig } from "@/lib/observability/error-reporting";
import { registerVersionSkewRecovery, tagSentryEvent } from "@/utils/version-skew";

// Recover from deployment version skew (stale client JS after a deploy) by
// reloading once instead of dying with an unhandled rejection.
registerVersionSkewRecovery();

const errorReporting = getErrorReportingConfig();

if (errorReporting.enabled) {
  Sentry.init({
    dsn: errorReporting.dsn,

    // Add optional integrations for additional features
    integrations: [
      Sentry.replayIntegration(),
    ],

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,
    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Define how likely Replay events are sampled.
    // This sets the sample rate to be 10%. You may want this to be 100% while
    // in development and sample at a lower rate in production
    replaysSessionSampleRate: 0.1,

    // Define how likely Replay events are sampled when an error occurs.
    replaysOnErrorSampleRate: 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Tag version-skew warnings, React recoverable errors, and E2E traffic.
    // Extracted so the logic is unit-tested (see version-skew.test.ts)
    // instead of buried in SDK config.
    beforeSend: tagSentryEvent,

    // Enrich errors with user and organization context
    // This is set dynamically after authentication in auth-provider.tsx
    // via Sentry.setUser() when the user logs in or the session is initialized
  });
}

// PostHog Analytics is initialized in auth-provider.tsx after user authentication
// to ensure we only track users who have agreed to terms

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
