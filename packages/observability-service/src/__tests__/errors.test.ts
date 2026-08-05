/**
 * Analytics Error Tests
 * Feature: 007-analytics-architecture-evaluation
 *
 * Tests for error classes and mapping functions.
 */

import {
  AnalyticsError,
  QueryTimeoutError,
  ServiceUnavailableError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
} from '../errors';

describe('Error Classes', () => {
  describe('AnalyticsError', () => {
    it('should create error with message and code', () => {
      const error = new AnalyticsError('test error', 'test_code');
      expect(error.message).toBe('test error');
      expect(error.code).toBe('test_code');
      expect(error.name).toBe('AnalyticsError');
      expect(error).toBeInstanceOf(Error);
    });

    it('should include stack trace', () => {
      const error = new AnalyticsError('test', 'test');
      expect(typeof error.stack).toBe('string');
      expect(error.stack).toContain('test');
    });

    it('should have default status code 500', () => {
      const error = new AnalyticsError('test', 'test');
      expect(error.statusCode).toBe(500);
    });

    it('should accept custom status code', () => {
      const error = new AnalyticsError('test', 'test', 418);
      expect(error.statusCode).toBe(418);
    });
  });

  describe('QueryTimeoutError', () => {
    it('should have default message', () => {
      const error = new QueryTimeoutError();
      expect(error.message).toBe('Query exceeded timeout limit');
      expect(error.name).toBe('QueryTimeoutError');
      expect(error.code).toBe('query_timeout');
      expect(error.statusCode).toBe(504);
    });

    it('should accept custom message', () => {
      const error = new QueryTimeoutError('Custom timeout');
      expect(error.message).toBe('Custom timeout');
    });
  });

  describe('ServiceUnavailableError', () => {
    it('should have default message', () => {
      const error = new ServiceUnavailableError();
      expect(error.message).toBe('Analytics service is temporarily unavailable');
      expect(error.name).toBe('ServiceUnavailableError');
      expect(error.code).toBe('service_unavailable');
      expect(error.statusCode).toBe(503);
    });
  });

  describe('ValidationError', () => {
    it('should require message parameter', () => {
      const error = new ValidationError('Invalid limit');
      expect(error.message).toBe('Invalid limit');
      expect(error.name).toBe('ValidationError');
      expect(error.code).toBe('validation_error');
      expect(error.statusCode).toBe(400);
    });

    it('should accept field and details', () => {
      const error = new ValidationError('Invalid limit', 'limit', { limit: 'Must be positive' });
      expect(error.field).toBe('limit');
      expect(error.details).toEqual({ limit: 'Must be positive' });
    });
  });

  describe('NotFoundError', () => {
    it('should have default message', () => {
      const error = new NotFoundError();
      expect(error.message).toBe('Resource not found');
      expect(error.name).toBe('NotFoundError');
      expect(error.code).toBe('not_found');
      expect(error.statusCode).toBe(404);
    });

    it('should accept resource type and id', () => {
      const error = new NotFoundError('Trace not found', 'trace', '123');
      expect(error.resourceType).toBe('trace');
      expect(error.resourceId).toBe('123');
    });
  });

  describe('ForbiddenError', () => {
    it('should have default message', () => {
      const error = new ForbiddenError();
      expect(error.message).toBe('Access denied');
      expect(error.name).toBe('ForbiddenError');
      expect(error.code).toBe('forbidden');
      expect(error.statusCode).toBe(403);
    });
  });
});

describe('mapClickHouseError', () => {
  it('should map timeout errors', () => {
    const chError = new Error('TIMEOUT');
    const mapped = mapClickHouseError(chError);
    expect(mapped).toBeInstanceOf(QueryTimeoutError);
  });

  it('should map connection errors', () => {
    const chError = { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' };
    const mapped = mapClickHouseError(chError);
    expect(mapped).toBeInstanceOf(ServiceUnavailableError);
  });

  it('should preserve AnalyticsError subclasses', () => {
    const validationError = new ValidationError('test');
    const mapped = mapClickHouseError(validationError);
    expect(mapped).toBe(validationError);
  });

  it('should wrap unknown errors', () => {
    const unknownError = new Error('Something unexpected');
    const mapped = mapClickHouseError(unknownError);
    expect(mapped).toBeInstanceOf(AnalyticsError);
    expect(mapped.message).toBe('An unexpected error occurred');
    expect(mapped.code).toBe('internal_error');
  });
});

describe('toErrorResponse (canonical nested envelope)', () => {
  it('should format ValidationError', () => {
    const error = new ValidationError('Invalid input');
    const response = toErrorResponse(error);

    expect(response).toEqual({
      error: {
        code: 'validation_error',
        message: 'Invalid input',
      },
    });
  });

  it('should format QueryTimeoutError', () => {
    const error = new QueryTimeoutError();
    const response = toErrorResponse(error);

    expect(response).toEqual({
      error: {
        code: 'query_timeout',
        message: 'Query exceeded timeout limit',
      },
    });
  });

  it('should format NotFoundError', () => {
    const error = new NotFoundError('Trace not found');
    const response = toErrorResponse(error);

    expect(response).toEqual({
      error: {
        code: 'not_found',
        message: 'Trace not found',
      },
    });
  });

  it('should format ForbiddenError', () => {
    const error = new ForbiddenError();
    const response = toErrorResponse(error);

    expect(response).toEqual({
      error: {
        code: 'forbidden',
        message: 'Access denied',
      },
    });
  });

  it('should format unknown errors generically', () => {
    const error = new Error('Database crashed');
    const response = toErrorResponse(error);

    expect(response).toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
      },
    });
  });

  it('should nest details under error for ValidationError with details', () => {
    const error = new ValidationError('Validation failed', 'limit', { limit: 'Must be positive' });
    const response = toErrorResponse(error);

    // `details` rides alongside `code` / `message` inside `error` (not as a
    // top-level sibling), matching `structuredError()`'s extras contract.
    expect(response.error.details).toEqual({ limit: 'Must be positive' });
    expect(response.error.code).toBe('validation_error');
    expect(response.error.message).toBe('Validation failed');
  });

  it('should never emit a top-level sibling `code` / `message` / `details`', () => {
    // Guards against regressions that would re-introduce the legacy flat shape
    // while leaving the nested one in place (a partial migration would silently
    // double-encode and break both tolerant and strict readers).
    const error = new ValidationError('x', 'f', { f: 'bad' });
    const response = toErrorResponse(error);
    expect('code' in response).toBe(false);
    expect('message' in response).toBe(false);
    expect('details' in response).toBe(false);
  });
});

describe('getErrorStatusCode', () => {
  it('should return 400 for ValidationError', () => {
    expect(getErrorStatusCode(new ValidationError('test'))).toBe(400);
  });

  it('should return 403 for ForbiddenError', () => {
    expect(getErrorStatusCode(new ForbiddenError())).toBe(403);
  });

  it('should return 404 for NotFoundError', () => {
    expect(getErrorStatusCode(new NotFoundError())).toBe(404);
  });

  it('should return 504 for QueryTimeoutError', () => {
    expect(getErrorStatusCode(new QueryTimeoutError())).toBe(504);
  });

  it('should return 503 for ServiceUnavailableError', () => {
    expect(getErrorStatusCode(new ServiceUnavailableError())).toBe(503);
  });

  it('should return 500 for unknown errors', () => {
    expect(getErrorStatusCode(new Error())).toBe(500);
  });

  it('should return custom status code for AnalyticsError', () => {
    expect(getErrorStatusCode(new AnalyticsError('test', 'test', 418))).toBe(418);
  });
});
