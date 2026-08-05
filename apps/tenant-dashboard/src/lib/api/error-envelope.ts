/**
 * Canonical error envelope for the dashboard API.
 *
 * Shape (matches the gateway's /v1/* surface):
 *   { error: { code, message, ...extras } }
 *
 * Three entry points:
 *   - `structuredError(code, message, extras?)` — construct a body
 *   - `errorResponseBody(error)`                — normalise a thrown error
 *   - `toNextResponse(error)`                   — full NextResponse shortcut
 *
 * Design:
 *   - The code is type-narrowed against `DashboardErrorCode` so typos fail
 *     the build, not the request.
 *   - Unknown errors collapse to `internal_error` with a sanitized message.
 *     Real details go to the logger; the client gets a generic surface.
 *   - Validation errors attach `{ details }` in `extras` — field-level issues
 *     for form UIs, while keeping the top-level envelope stable.
 */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  AnalyticsError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  QueryTimeoutError,
  ServiceUnavailableError,
} from '@repo/observability-service';
import type { DashboardErrorCode } from './error-codes';

export interface StructuredErrorBody {
  error: { code: DashboardErrorCode; message: string } & Record<string, unknown>;
}

/** Constructs a canonical error body. Compile-time checks the code. */
export function structuredError(
  code: DashboardErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
): StructuredErrorBody {
  return { error: { ...extras, code, message } };
}

/**
 * Maps a Zod issue list into the `{ details }` extras so form UIs can
 * surface per-field messages without reading the top-level `message`.
 */
function zodIssuesToDetails(error: ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!details[path]) details[path] = issue.message;
  }
  return details;
}

interface NormalizedError {
  status: number;
  body: StructuredErrorBody;
}

export interface RemapOptions {
  /** Resource-specific code for `NotFoundError` throws in this route. */
  remapNotFound?: DashboardErrorCode;
  /**
   * Resource-specific code for `ValidationError` throws whose message contains
   * "already exists". The service layer uses this convention to signal
   * unique-constraint violations today; the wrapper converts those to 409
   * with the configured code.
   */
  remapConflict?: DashboardErrorCode;
  /**
   * Resource-specific code for `ValidationError` throws whose message contains
   * "Maximum of" / "reached". Matches the service's per-app and per-org cap
   * checks. Emitted as 429 rather than 400 because it's a limit-exceeded
   * condition, not an input-validation failure.
   */
  remapLimit?: DashboardErrorCode;
}

/**
 * Normalise any thrown value into `{status, body}`.
 *
 * Handled:
 *   - ZodError                         → 400 invalid_request_body + details
 *   - ValidationError w/ "already exists" + `remapConflict`
 *                                      → 409 with configured code
 *   - ValidationError w/ "Maximum of" + `remapLimit`
 *                                      → 429 with configured code
 *   - ValidationError (other)          → 400 invalid_field_value
 *   - NotFoundError                    → 404 (caller re-codes with resource prefix)
 *   - ForbiddenError                   → 403
 *   - QueryTimeoutError                → 504
 *   - ServiceUnavailableError          → 503
 *   - AnalyticsError                   → uses its .statusCode + .code
 *   - anything else                    → 500 internal_error (logged)
 *
 * Callers wanting resource-specific codes should set `remapNotFound` /
 * `remapConflict` / `remapLimit` on their route schema — keeps the service
 * layer unchanged while the route contract stays resource-specific.
 */
export function errorResponseBody(
  error: unknown,
  opts: RemapOptions = {},
): NormalizedError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: structuredError(
        'invalid_request_body',
        'Invalid request body',
        { details: zodIssuesToDetails(error) },
      ),
    };
  }

  if (error instanceof ValidationError) {
    const msg = error.message.toLowerCase();
    const extras = error.details ? { details: error.details } : {};

    if (opts.remapConflict && msg.includes('already exists')) {
      return {
        status: 409,
        body: structuredError(opts.remapConflict, error.message, extras),
      };
    }
    if (opts.remapLimit && (msg.includes('maximum of') || msg.includes('limit'))) {
      return {
        status: 429,
        body: structuredError(opts.remapLimit, error.message, extras),
      };
    }
    return {
      status: 400,
      body: structuredError('invalid_field_value', error.message, extras),
    };
  }

  if (error instanceof NotFoundError) {
    return {
      status: 404,
      body: structuredError(
        opts.remapNotFound ?? ('internal_error' as DashboardErrorCode),
        error.message,
      ),
    };
  }

  if (error instanceof ForbiddenError) {
    return { status: 403, body: structuredError('forbidden', error.message) };
  }

  if (error instanceof QueryTimeoutError) {
    return { status: 504, body: structuredError('service_unavailable', error.message) };
  }

  if (error instanceof ServiceUnavailableError) {
    return { status: 503, body: structuredError('service_unavailable', error.message) };
  }

  if (error instanceof AnalyticsError) {
    return {
      status: error.statusCode,
      body: structuredError(
        (error.code as DashboardErrorCode) ?? 'internal_error',
        error.message,
      ),
    };
  }

  return {
    status: 500,
    body: structuredError('internal_error', 'An unexpected error occurred'),
  };
}

/** Build a NextResponse from any thrown value. */
export function toNextResponse(
  error: unknown,
  opts: RemapOptions = {},
): NextResponse {
  const { status, body } = errorResponseBody(error, opts);
  return NextResponse.json(body, { status });
}
