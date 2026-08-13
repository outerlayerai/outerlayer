/**
 * Smoke test: every non-public, non-legacy /v1/* route registered in
 * `openApiApp` MUST have a permission registered in the route permission
 * registry.
 *
 * The type system already enforces that `registerAuthenticatedRoute()` cannot
 * be called without a `static requiredPermission` on the route class. This
 * test catches the *other* failure mode: someone uses raw
 * `openApiApp.get('/v1/new-route', ...)` (bypassing the helper) on a /v1/*
 * path and forgets to also call `setRoutePermission()`. In that case the
 * route would fall through the middleware unprotected.
 */

import { describe, it, expect, vi } from 'vitest';

// Same mocks as legacy-passthrough.test.ts — openApiApp transitively imports
// Supabase, ClickHouse, and the analytics factory.
vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), insert: vi.fn() })),
}));

import { openApiApp, UNAUTHENTICATED_V1_PATHS } from '../index';
import { getRoutePermission } from '../../lib/permissions';
import { isManagementApiPath } from '../../lib/management-auth';

const legacyKeys = new Set<string>();

describe('permission coverage', () => {
  const routes = (openApiApp as unknown as {
    routes: Array<{ method: string; path: string }>;
  }).routes;

  const protectedV1Routes = routes.filter((r) => {
    if (r.method === 'ALL') return false; // middleware registrations
    if (!r.path.startsWith('/v1/')) return false;
    if (UNAUTHENTICATED_V1_PATHS.has(r.path)) return false;
    if (legacyKeys.has(`${r.method} ${r.path}`)) return false;
    // Org-management routes (/v1/orgs/*) are protected by their own
    // `managementAuthGuard(requiredPermission)` — a management-API-key
    // (`olk_*`) permission check entirely separate from the `GatewayPermission`
    // registry this test polices (see `registerManagementRoute` in ../index.ts).
    if (isManagementApiPath(r.path)) return false;
    return true;
  });

  it('discovers a non-empty set of protected /v1/* routes', () => {
    // Sanity check — if this fires at 0 we're almost certainly filtering too
    // aggressively and the rest of the suite would silently pass.
    expect(protectedV1Routes.length).toBeGreaterThan(0);
  });

  it.each(protectedV1Routes)(
    '$method $path has a permission registered',
    ({ method, path }) => {
      expect(getRoutePermission(method, path)).not.toBeNull();
    },
  );
});
