/**
 * Analytics Middleware Helpers Tests
 *
 * Tests for the shared utility functions used by analytics API routes.
 *
 * NOTE: Authentication is tested separately in:
 * - with-auth.test.ts (withAnalyticsAuth wrapper)
 * - tenant-context.test.ts (verifyAppAccess function)
 */

import { parseSearchParams, createCacheHeaders } from '../middleware';

describe('Analytics Middleware Helpers', () => {
  describe('parseSearchParams', () => {
    it('should parse all query parameters', () => {
      const request = new Request('http://localhost/api?foo=bar&baz=qux&num=123');
      const params = parseSearchParams(request);

      expect(params).toEqual({
        foo: 'bar',
        baz: 'qux',
        num: '123',
      });
    });

    it('should handle empty query string', () => {
      const request = new Request('http://localhost/api');
      const params = parseSearchParams(request);

      expect(params).toEqual({});
    });

    it('should handle URL-encoded values', () => {
      const request = new Request('http://localhost/api?query=hello%20world');
      const params = parseSearchParams(request);

      expect(params.query).toBe('hello world');
    });

    it('should handle multiple values for same key (last value wins)', () => {
      const request = new Request('http://localhost/api?key=first&key=second');
      const params = parseSearchParams(request);

      // URL.searchParams.forEach iterates, so last value wins
      expect(params.key).toBe('second');
    });

    it('should handle special characters in values', () => {
      const request = new Request('http://localhost/api?date=2024-01-01T00%3A00%3A00Z');
      const params = parseSearchParams(request);

      expect(params.date).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('createCacheHeaders', () => {
    it('should create cache control headers with default values', () => {
      const headers = createCacheHeaders();

      expect(headers).toEqual({
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      });
    });

    it('should create cache control headers with custom values', () => {
      const headers = createCacheHeaders(120, 600);

      expect(headers).toEqual({
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      });
    });

    it('should handle zero values', () => {
      const headers = createCacheHeaders(0, 0);

      expect(headers).toEqual({
        'Cache-Control': 'public, s-maxage=0, stale-while-revalidate=0',
      });
    });

    it('should handle large values for long-lived caches', () => {
      const headers = createCacheHeaders(3600, 86400); // 1 hour, 1 day

      expect(headers).toEqual({
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      });
    });
  });
});
