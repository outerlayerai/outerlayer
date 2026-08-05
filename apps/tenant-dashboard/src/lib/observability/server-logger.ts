import "server-only";

import { Logger } from "@logtail/next";
import * as Sentry from "@/lib/observability/error-reporting/sentry";
import { getLogContext } from "../../utils/context";
import type { LogContext } from "../../types/context";

/**
 * Additional metadata that can be passed to log methods
 */
type LogMetadata = Record<string, unknown>;

/**
 * Build log payload with auto-injected context 
 */
function buildLogPayload(
  message: string,
  context?: LogContext,
  metadata?: LogMetadata
): Record<string, unknown> {

  return {
    message,
    ...(context?.tenantId && { tenantId: context.tenantId }),
    ...(context?.userId && { userId: context.userId }),
    ...(context?.appId && { appId: context.appId }),
    ...metadata,
  };
}

/**
 * Server-side Logger - For server actions, API routes, and server components
 *
 * Auto-injects user context (tenantId, userId, appId) from Supabase session.
 * Routes logs based on environment:
 * - Development: Console only
 * - Production: log.info -> Logtail, log.error -> Sentry
 *
 * @example
 * // Basic usage (auto-fetches context)
 * await serverLogger.info("User action completed", { action: "create" });
 *
 * // With app context
 * await serverLogger.withAppId(appId).info("App-specific action");
 */
class ServerLogger {
  private appId?: string;

  constructor(appId?: string) {
    this.appId = appId;
  }

  /**
   * Create a logger instance with app context
   */
  withAppId(appId: string): ServerLogger {
    return new ServerLogger(appId);
  }

  /**
   * Log informational message with auto-injected context
   */
  async info(message: string, metadata?: LogMetadata): Promise<void> {
    const context = await getLogContext(this.appId);
    const logPayload = buildLogPayload(message, context, metadata);

    // Always log to console
    console.info("[INFO]", message, logPayload);

    // Send to Logtail in production
    if (process.env.NODE_ENV === "production") {
      const logtail = new Logger();
      logtail.info(message, logPayload);
      await logtail.flush();
    }
  }

  /**
   * Log error with auto-injected context
   */
  async error(error: Error, metadata?: LogMetadata): Promise<void> {
    const context = await getLogContext(this.appId);
    const logPayload = buildLogPayload(error.message, context, metadata);

    // Always log to console
    console.error("[ERROR]", error.message, logPayload);

    // Send to Sentry in production
    if (process.env.NODE_ENV === "production") {
      if (context) {
        Sentry.setContext("logContext", {
          tenantId: context.tenantId,
          userId: context.userId,
          appId: context.appId,
        });

        if (context.userId) {
          Sentry.setUser({ id: context.userId });
        }
      }

      if (metadata) {
        Sentry.setContext("metadata", metadata);
      }

      Sentry.captureException(error);
    }
  }
}

/**
 * Server-side logger instance
 * Use for server actions, API routes, and server components
 */
export const serverLogger = new ServerLogger();
