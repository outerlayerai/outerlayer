import * as Sentry from '@sentry/nextjs';
import type {
  ErrorReportingAdapter,
  ErrorReportContext,
  ErrorUser,
} from '@repo/error-reporting-core';

/**
 * Sentry-backed {@link ErrorReportingAdapter} for the Next.js dashboard.
 *
 * The only place in the dashboard allowed to call `@sentry/nextjs` capture/scope
 * APIs directly. Every other module routes through `getErrorReporter()` so the
 * vendor (and the on/off + self-host toggle) is swappable from one seam.
 *
 * Fire-and-forget per the port contract: the Sentry SDK already swallows its own
 * transport failures and no-ops when `Sentry.init` was never called, so these
 * methods never throw.
 */
export class SentryNextjsAdapter implements ErrorReportingAdapter {
  captureException(error: unknown, context?: ErrorReportContext): void {
    Sentry.captureException(
      error,
      context
        ? { level: context.level, tags: context.tags, extra: context.extra }
        : undefined
    );
  }

  captureMessage(message: string, context?: ErrorReportContext): void {
    Sentry.captureMessage(
      message,
      context
        ? { level: context.level, tags: context.tags, extra: context.extra }
        : undefined
    );
  }

  setUser(user: ErrorUser | null): void {
    Sentry.setUser(user);
  }

  setContext(name: string, data: Record<string, unknown> | null): void {
    Sentry.setContext(name, data);
  }

  setTag(key: string, value: string | number | boolean): void {
    Sentry.setTag(key, value);
  }
}
