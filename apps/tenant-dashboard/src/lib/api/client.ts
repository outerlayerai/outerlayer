/**
 * Typed error shape for the dashboard's own API routes.
 *
 * The `withApi` routes (`src/lib/api/route-manifest.ts`) are consumed either
 * from React Server Components (RSCs, as direct function calls) or via
 * hand-built `apiFetch` requests (e.g. widget-data); everything else goes
 * through server actions or RSC reads. `ApiError` normalizes the canonical
 * error envelope for those `apiFetch` callers.
 *
 * Error handling: callers that want to branch on the error code should
 * check `err instanceof ApiError && err.code === 'entitlement_required'`.
 * Callers that only need a message for a toast should use `err.message`.
 */

import type { DashboardErrorCode } from './error-codes';

// ----------------------------------------------------------------------------
// ApiError — typed error shape surfaced from the envelope
// ----------------------------------------------------------------------------

/**
 * Error subclass that preserves the canonical envelope's `code`, HTTP
 * `status`, and any server-supplied `extras` (e.g. `retry_after_seconds`
 * on 429, `validation` on 400). `message` inherits from `Error` and is
 * safe to render directly in a toast.
 *
 * Design intent: code-aware branching without threading status through
 * hook return values.
 *
 *   try { ... } catch (err) {
 *     if (err instanceof ApiError && err.code === 'entitlement_required') {
 *       router.push('/billing');
 *       return;
 *     }
 *     enqueueSnackbar(err instanceof Error ? err.message : 'Failed', { variant: 'error' });
 *   }
 */
export class ApiError extends Error {
  readonly code: DashboardErrorCode | 'network_error' | 'malformed_response';
  readonly status: number;
  readonly extras: Record<string, unknown>;

  constructor(
    code: DashboardErrorCode | 'network_error' | 'malformed_response',
    message: string,
    status: number,
    extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extras = extras;
  }

  /**
   * Construct an ApiError from `openapi-fetch`'s `{error, response}` pair.
   *
   * openapi-fetch invariants:
   *  - On success: `{data, error: undefined, response}`
   *  - On HTTP non-2xx: `{data: undefined, error: <parsed body>, response}`
   *  - On network failure (fetch throws): the promise rejects; it does
   *    NOT return `{error: undefined, response: undefined}`. So callers
   *    won't normally hand us both-undefined — but we defend against it.
   *
   * Runtime-tolerates two envelope shapes in case the server regresses:
   *  - New: `{error: {code, message, ...extras}}` (what withApi emits)
   *  - Old: `{error: "flat string"}` (legacy unmigrated routes)
   */
  static from(error: unknown, response: Response | undefined, fallback = 'Request failed'): ApiError {
    if (!response) {
      return new ApiError('network_error', 'Network request failed', 0);
    }

    const status = response.status;
    const body = (error as { error?: unknown })?.error;

    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      const { code, message, ...extras } = body as {
        code: DashboardErrorCode;
        message: string;
        [k: string]: unknown;
      };
      return new ApiError(code, message, status, extras);
    }

    if (typeof body === 'string' && body.length > 0) {
      return new ApiError('malformed_response', body, status);
    }

    return new ApiError('malformed_response', fallback, status);
  }
}

