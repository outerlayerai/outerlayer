"use client";

import { useCallback, useContext } from "react";
import { useLogger } from "@logtail/next/hooks";
import * as Sentry from "@/lib/observability/error-reporting/sentry";
import { useAuthContext } from "../auth/hooks";
import { AppContext } from "@/lib/app-shell/app-context/app-context";
import { isTransientNetworkFetchError } from "./shared/api-error";

/**
 * Additional metadata that can be passed to log methods
 */
type LogMetadata = Record<string, unknown>;

/**
 * Client-side logger context
 */
interface ClientLogContext {
  tenantId?: string;
  userId?: string;
  appId?: string;
}

/**
 * Build log payload with context
 */
function buildLogPayload(
  context: ClientLogContext,
  metadata?: LogMetadata
): Record<string, unknown> {
  return {
    ...(context.tenantId && { tenantId: context.tenantId }),
    ...(context.userId && { userId: context.userId }),
    ...(context.appId && { appId: context.appId }),
    ...metadata,
  };
}

/**
 * Client-side logger hook - For React client components
 *
 * Auto-injects user context (tenantId, userId, appId) from AuthContext and AppContext.
 * Routes logs based on environment:
 * - Development: Console only
 * - Production: log.info -> Logtail, log.error -> Sentry
 *
 * @example
 * function MyComponent() {
 *   const logger = useClientLogger();
 *
 *   const handleClick = () => {
 *     logger.info("Button clicked", { buttonId: "submit" });
 *   };
 *
 *   return <button onClick={handleClick}>Submit</button>;
 * }
 */
export function useClientLogger() {
  const logtail = useLogger();
  const { user } = useAuthContext();

  // AppContext may not be available in all routes, so we use optional context
  const appContext = useContext(AppContext);

  // Build context from auth and app state
  const context: ClientLogContext = {
    // activeTenant first: it re-derives from the URL on every render, while
    // tenant is a full-row fetch that only refreshes on auth events and would
    // still name the previous org right after a switch (a pure navigation).
    tenantId: user?.activeTenant?.tenant_id || user?.tenant?.tenant_id,
    userId: user?.id,
    appId: appContext?.app?.id,
  };

  const info = useCallback(
    (message: string, metadata?: LogMetadata) => {
      const logPayload = buildLogPayload(context, metadata);

      // Always log to console
      console.info("[INFO]", message, logPayload);

      // Send to Logtail in production
      if (process.env.NODE_ENV === "production") {
        logtail.info(message, logPayload);
      }
    },
    [logtail, context]
  );

  const error = useCallback(
    (err: Error, metadata?: LogMetadata) => {
      const logPayload = buildLogPayload(context, metadata);

      // Always log to console
      console.error("[ERROR]", err.message, logPayload);

      // Send to Sentry in production
      if (process.env.NODE_ENV === "production") {
        // 401/403/404 from the SWR fetchers are policy outcomes, not bugs:
        // the session expired (401), the user lost access (403), or the
        // page outlived the row / they navigated to a deleted resource
        // (404, e.g. E2E teardown race). Don't page on-call for these —
        // the snackbar already informs the user, and the noise drowns
        // out real errors. Requires the fetcher to attach `status` to
        // the thrown Error; otherwise this check is a no-op.
        const status = (err as Error & { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) return;

        // Transport-level fetch failures are the other non-bug class: the
        // request died without an HTTP response (connection drop, navigation
        // or page-teardown abort, offline blip). They self-heal on the next
        // SWR tick, and at a 5-10s poll cadence every laptop sleep, page
        // navigation, or E2E teardown would page on-call. Keep the trend
        // visible in Logtail at warn; keep Sentry for errors a human should
        // act on.
        if (isTransientNetworkFetchError(err)) {
          logtail.warn(err.message, logPayload);
          return;
        }

        if (context.tenantId || context.userId || context.appId) {
          Sentry.setContext("logContext", {
            tenantId: context.tenantId,
            userId: context.userId,
            appId: context.appId,
          });
        }

        // Deliberately no Sentry.setUser here: auth-provider sets
        // { id, email } once at login, and re-setting { id } alone strips
        // the email that beforeSend's is_e2e tagging keys on — that clobber
        // is how E2E harness noise paged as real-user production errors
        // (see utils/version-skew.ts tagSentryEvent).

        if (metadata) {
          Sentry.setContext("metadata", metadata);
        }

        Sentry.captureException(err);
      }
    },
    [logtail, context]
  );

  return {
    info,
    error,
  };
}
