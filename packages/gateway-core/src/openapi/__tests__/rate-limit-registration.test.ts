/**
 * Rate-limit guard registration tests.
 *
 * Proves the WIRING that unit tests can't: `registerAuthenticatedRoute`
 * installs `enforceRateLimit` (which returns a handler named `rateLimitGuard`)
 *   - ONLY on routes that declare `static rateLimit` (the ClickHouse-backed
 *     observability reads), so limits aren't lumped across every endpoint, and
 *   - AFTER `permissionGuard`, so a wrong-scope caller sees 403 before the
 *     limiter ever counts the request.
 *
 * Introspects `openApiApp.routes` and matches handlers by name — the same
 * surface entitlement-registration.test.ts / permission-coverage.test.ts use.
 */

import { describe, it, expect, vi } from 'vitest';

// openApiApp transitively pulls in Clickhouse and analytics — stub them.
vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), insert: vi.fn() })),
}));

import { openApiApp } from '../index';

type RouteEntry = { method: string; path: string; handler: { name?: string } };

function handlerNames(method: string, path: string): string[] {
  const routes = (openApiApp as unknown as { routes: RouteEntry[] }).routes;
  return routes
    .filter((r) => r.method === method && r.path === path)
    .map((r) => r.handler?.name ?? '');
}

describe('rate-limit guard registration', () => {
  describe('rate-limited routes install rateLimitGuard AFTER permissionGuard', () => {
    it.each([
      // observability-read bucket: ClickHouse-backed list/detail/search.
      ['GET', '/v1/spans'],
      ['POST', '/v1/spans/search'],
      ['GET', '/v1/scores'],
      ['POST', '/v1/scores/search'],
      ['GET', '/v1/topics'],
      ['GET', '/v1/metrics/models'],
      ['GET', '/v1/metrics/overview'],
    ] as const)('%s %s', (method, path) => {
      const names = handlerNames(method, path);
      const permIdx = names.indexOf('permissionGuard');
      const rlIdx = names.indexOf('rateLimitGuard');

      expect(permIdx).toBeGreaterThanOrEqual(0);
      expect(rlIdx).toBeGreaterThanOrEqual(0);
      // Permission first (RBAC), then rate limit — so a wrong-scope caller
      // gets 403 and the limiter never counts the request.
      expect(permIdx).toBeLessThan(rlIdx);
    });
  });

  describe('routes without a declared limit are NOT rate-limited (no lumping)', () => {
    it.each([
      // Ingestion stays unthrottled here — span-limit/storage-cap guards own
      // that path instead.
      ['POST', '/v1/scores'],
      ['POST', '/v1/agents/sync'],
    ] as const)('%s %s has no rateLimitGuard', (method, path) => {
      const names = handlerNames(method, path);
      // Sanity: the route is actually registered (permission guard present).
      expect(names).toContain('permissionGuard');
      expect(names).not.toContain('rateLimitGuard');
    });
  });
});
