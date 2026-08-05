// Re-export all error types from shared package
export {
  AnalyticsError,
  QueryTimeoutError,
  ServiceUnavailableError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
} from '@repo/observability-service';
