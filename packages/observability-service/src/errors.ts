/**
 * Analytics Error Classes
 * Feature: 007-analytics-architecture-evaluation
 *
 * Custom error classes for the analytics service layer.
 * These enable proper error handling and categorization in API routes.
 */

/**
 * Base class for analytics-related errors.
 */
export class AnalyticsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

/**
 * Thrown when a query exceeds the configured timeout.
 */
export class QueryTimeoutError extends AnalyticsError {
  constructor(message: string = 'Query exceeded timeout limit') {
    super(message, 'query_timeout', 504);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Thrown when ClickHouse is unavailable or connection fails.
 */
export class ServiceUnavailableError extends AnalyticsError {
  constructor(message: string = 'Analytics service is temporarily unavailable') {
    super(message, 'service_unavailable', 503);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Thrown when input validation fails.
 */
export class ValidationError extends AnalyticsError {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, string>
  ) {
    super(message, 'validation_error', 400);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when a requested resource is not found.
 */
export class NotFoundError extends AnalyticsError {
  constructor(
    message: string = 'Resource not found',
    public readonly resourceType?: string,
    public readonly resourceId?: string
  ) {
    super(message, 'not_found', 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when access to a resource is forbidden.
 */
export class ForbiddenError extends AnalyticsError {
  constructor(message: string = 'Access denied') {
    super(message, 'forbidden', 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * Maps ClickHouse errors to appropriate analytics errors.
 *
 * @param error - The original error from ClickHouse
 * @returns An appropriate AnalyticsError subclass
 */
export function mapClickHouseError(error: unknown): AnalyticsError {
  if (error instanceof AnalyticsError) {
    return error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: string })?.code;

  // Connection errors
  if (
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'ENOTFOUND' ||
    errorMessage.includes('connect ECONNREFUSED')
  ) {
    return new ServiceUnavailableError('Unable to connect to analytics database');
  }

  // Timeout errors
  if (
    errorCode === 'ETIMEDOUT' ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('TIMEOUT')
  ) {
    return new QueryTimeoutError('Query execution timed out');
  }

  // Memory limit errors
  if (errorMessage.includes('Memory limit')) {
    return new QueryTimeoutError('Query exceeded memory limit');
  }

  // Default to generic error
  return new AnalyticsError(
    'An unexpected error occurred',
    'internal_error',
    500
  );
}

/**
 * Canonical gateway error envelope.
 *
 * Matches the shape emitted by `structuredError()` in
 * `apps/gateway/src/openapi/routes/_shared.ts`:
 *
 *   { error: { code, message, ...extras } }
 *
 * Readers consume `body.error.message` for display and `body.error.code`
 * for programmatic branching; `details` (present only on ValidationError)
 * carries field-level issues as `extras`.
 */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  } & Record<string, unknown>;
}

/**
 * Creates an error response object suitable for JSON serialization.
 *
 * @param error - The error to serialize
 * @returns A canonical nested error envelope
 */
export function toErrorResponse(error: unknown): ErrorResponseBody {
  if (error instanceof AnalyticsError) {
    const envelope: ErrorResponseBody = {
      error: {
        code: error.code,
        message: error.message,
      },
    };

    if (error instanceof ValidationError && error.details) {
      envelope.error.details = error.details;
    }

    return envelope;
  }

  // Don't expose internal error details
  return {
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
    },
  };
}

/**
 * Gets the HTTP status code for an error.
 *
 * @param error - The error to check
 * @returns The appropriate HTTP status code
 */
export function getErrorStatusCode(error: unknown): number {
  if (error instanceof AnalyticsError) {
    return error.statusCode;
  }
  return 500;
}
