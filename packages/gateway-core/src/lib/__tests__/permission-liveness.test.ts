/**
 * Guards against grantable-but-dead permissions: every entry of
 * `GATEWAY_PERMISSIONS` must be the `requiredPermission` of at least one
 * registered route, or be explicitly allowlisted below with a reason.
 *
 * A permission with no route behind it is still offered on API keys (the
 * key-creation UI, `full-access`/`read-only` presets) — it grants a scope
 * that does nothing, which is confusing at best and a false sense of
 * least-privilege at worst.
 */

import { describe, it, expect, vi } from 'vitest';

// Same mocks as permission-coverage.test.ts — openApiApp transitively
// imports Supabase, ClickHouse, and the analytics factory.
vi.mock('../../openapi/analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), insert: vi.fn() })),
}));

import { openApiApp } from '../../openapi/index';
import { GATEWAY_PERMISSIONS, getRoutePermission, type GatewayPermission } from '../permissions';

// Permissions that intentionally gate zero gateway routes. Every entry
// must carry a reason; an empty allowlist is the goal state.
const DORMANT_PERMISSION_ALLOWLIST: Partial<Record<GatewayPermission, string>> = {
  // Backs the RLS UPDATE policy on `environment`
  // (apps/tenant-dashboard/supabase/schemas/52-environment.sql) for the
  // bearer/dashboard path; no gateway route reads it, so it never
  // appears as a `requiredPermission`. Permanent — not tied to a future group.
  'environment.update': 'backs the environment RLS UPDATE policy; no gateway route by design',
  // Dormant until the sessions REST routes ship.
  'session.read': 'activated once GET /v1/sessions and GET /v1/sessions/{traceId} ship',
  'agents.sessions.team.read': 'activated once GET /v1/sessions ships and reads it from the actor-privacy policy',
};

describe('permission liveness', () => {
  const routes = (openApiApp as unknown as {
    routes: Array<{ method: string; path: string }>;
  }).routes;

  const livePermissions = new Set<GatewayPermission>();
  for (const { method, path } of routes) {
    if (method === 'ALL') continue;
    const permission = getRoutePermission(method, path);
    if (permission) livePermissions.add(permission);
  }

  // proves AC-052-10
  it.each(GATEWAY_PERMISSIONS)('%s gates a registered route or is allowlisted with a reason', (permission) => {
    const isLive = livePermissions.has(permission);
    const allowlistReason = DORMANT_PERMISSION_ALLOWLIST[permission];

    if (!isLive && !allowlistReason) {
      throw new Error(
        `'${permission}' gates no registered route and has no allowlist entry. ` +
          'Either wire it to a route, or add it to DORMANT_PERMISSION_ALLOWLIST with a reason.',
      );
    }
    expect(isLive || Boolean(allowlistReason)).toBe(true);
  });

  it('allowlists only permissions that are actually dormant', () => {
    const staleEntries = Object.keys(DORMANT_PERMISSION_ALLOWLIST).filter((permission) =>
      livePermissions.has(permission as GatewayPermission),
    );
    expect(staleEntries).toEqual([]);
  });
});
