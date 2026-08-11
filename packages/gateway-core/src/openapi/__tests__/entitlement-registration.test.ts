/**
 * Route-registration invariants for quota-gated routes.
 *
 * `registerAuthenticatedRoute()` chains: permissionGuard → (optional)
 * entitlementGuard → (optional) quotaGuard → route handler. Invariants
 * that the unit tests for the middlewares themselves can't catch:
 *
 *   1. POST /v1/api-keys has `quotaGuard` installed AFTER
 *      `permissionGuard`. GET + DELETE stay open so downgraded tenants
 *      can still list + revoke; only the create path enforces
 *      `max_api_keys`.
 *
 * The test introspects `openApiApp.routes` — the same surface that
 * permission-coverage.test.ts uses — and matches handlers by name. The
 * named function expressions in `enforcePermission` (returns
 * `permissionGuard`), `enforceEntitlement` (returns `entitlementGuard`),
 * and `enforceQuota` (returns `quotaGuard`) are what make this matching
 * possible.
 */

import { describe, it, expect, vi } from 'vitest';

// openApiApp transitively pulls in Clickhouse and analytics —
// stub them. Same shape as permission-coverage.test.ts.
vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), insert: vi.fn() })),
}));

import { openApiApp } from '../index';

type RouteEntry = { method: string; path: string; handler: { name?: string } };

function handlersFor(method: string, path: string): RouteEntry[] {
  const routes = (openApiApp as unknown as { routes: RouteEntry[] }).routes;
  return routes.filter((r) => r.method === method && r.path === path);
}

function handlerNames(method: string, path: string): string[] {
  return handlersFor(method, path).map((r) => r.handler?.name ?? '');
}

describe('tier-gated route registration', () => {
  describe('api-keys quota gate', () => {
    it('POST /v1/api-keys installs quotaGuard AFTER permissionGuard', () => {
      const names = handlerNames('POST', '/v1/api-keys');
      const permIdx = names.indexOf('permissionGuard');
      const quotaIdx = names.indexOf('quotaGuard');

      expect(permIdx).toBeGreaterThanOrEqual(0);
      expect(quotaIdx).toBeGreaterThanOrEqual(0);
      expect(permIdx).toBeLessThan(quotaIdx);
    });

    it.each([
      ['GET', '/v1/api-keys'],
      ['DELETE', '/v1/api-keys/:apiKeyId'],
    ] as const)('%s %s stays open (no quotaGuard)', (method, path) => {
      const names = handlerNames(method, path);
      expect(names).not.toContain('quotaGuard');
      // Sanity check the permission gate is still there.
      expect(names).toContain('permissionGuard');
    });
  });

  describe('apps quota gate', () => {
    it('POST /v1/apps installs quotaGuard AFTER permissionGuard', () => {
      // The `max_apps` quota would silently leak if quotaGuard slipped
      // off this route — a paying-tier tenant could create unlimited
      // apps via the API even with the dashboard cap in place. Nothing
      // else checks that this route's guard order matches the api-keys
      // pattern.
      const names = handlerNames('POST', '/v1/apps');
      const permIdx = names.indexOf('permissionGuard');
      const quotaIdx = names.indexOf('quotaGuard');

      expect(permIdx).toBeGreaterThanOrEqual(0);
      expect(quotaIdx).toBeGreaterThanOrEqual(0);
      expect(permIdx).toBeLessThan(quotaIdx);
    });

    it.each([
      ['GET', '/v1/apps'],
      ['GET', '/v1/apps/:appId'],
      ['PATCH', '/v1/apps/:appId'],
      ['DELETE', '/v1/apps/:appId'],
    ] as const)('%s %s stays open (no quotaGuard)', (method, path) => {
      // Read / update / delete don't grow usage, so they don't gate.
      // A downgraded tenant must still be able to inspect and clean up
      // their existing apps.
      const names = handlerNames(method, path);
      expect(names).not.toContain('quotaGuard');
      expect(names).toContain('permissionGuard');
    });

    it('no apps route is entitlement-gated (only quota-gated)', () => {
      // Apps are foundational — there's no binary "apps_enabled"
      // entitlement, only the `max_apps` numeric quota. This test
      // ensures we don't accidentally add a binary tier-lock to an
      // apps route.
      for (const [method, path] of [
        ['GET', '/v1/apps'],
        ['POST', '/v1/apps'],
        ['GET', '/v1/apps/:appId'],
        ['PATCH', '/v1/apps/:appId'],
        ['DELETE', '/v1/apps/:appId'],
      ] as const) {
        const names = handlerNames(method, path);
        expect(names).not.toContain('entitlementGuard');
      }
    });
  });

  describe('topics entitlement gate', () => {
    it('GET /v1/topics installs entitlementGuard AFTER permissionGuard', () => {
      const names = handlerNames('GET', '/v1/topics');
      const permIdx = names.indexOf('permissionGuard');
      const entIdx = names.indexOf('entitlementGuard');

      expect(permIdx).toBeGreaterThanOrEqual(0);
      expect(entIdx).toBeGreaterThanOrEqual(0);
      expect(permIdx).toBeLessThan(entIdx);
    });

    it.each([
      ['GET', '/v1/metrics/models'],
      ['GET', '/v1/metrics/overview'],
    ] as const)('%s %s stays open (no entitlementGuard)', (method, path) => {
      const names = handlerNames(method, path);
      expect(names).not.toContain('entitlementGuard');
      expect(names).toContain('permissionGuard');
    });
  });

  describe('sessions routes', () => {
    it.each([
      ['GET', '/v1/sessions'],
      ['GET', '/v1/sessions/:traceId'],
    ] as const)('%s %s stays open (no entitlementGuard or quotaGuard)', (method, path) => {
      const names = handlerNames(method, path);
      expect(names).not.toContain('entitlementGuard');
      expect(names).not.toContain('quotaGuard');
      expect(names).toContain('permissionGuard');
    });
  });
});
