/**
 * Analytics API Middleware Helpers
 *
 * Shared utilities for analytics API routes.
 *
 * NOTE: Authentication is handled by withAnalyticsAuth wrapper (with-auth.ts).
 * These are just utility functions for parsing requests and creating headers.
 */

/**
 * Parses search params from a request URL.
 *
 * @param request - The incoming request
 * @returns Parsed search params as a plain object
 */
export function parseSearchParams(request: Request): Record<string, string | undefined> {
  const { searchParams } = new URL(request.url);
  const params: Record<string, string | undefined> = {};

  searchParams.forEach((value, key) => {
    params[key] = value;
  });

  return params;
}

/**
 * Creates standard cache control headers for analytics responses.
 *
 * @param maxAge - Maximum age in seconds
 * @param staleWhileRevalidate - Stale-while-revalidate time in seconds
 * @returns Headers object with Cache-Control
 */
export function createCacheHeaders(
  maxAge: number = 60,
  staleWhileRevalidate: number = 300
): HeadersInit {
  return {
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  };
}
