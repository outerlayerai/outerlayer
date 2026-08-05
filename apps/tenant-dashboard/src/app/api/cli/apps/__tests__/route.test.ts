// @vitest-environment node
/**
 * Tests: GET /api/cli/apps
 *
 * The CLI "list my apps" endpoint. Auth is a Supabase JWT in the
 * `Authorization: Bearer` header (the CLI/OAuth path via
 * `createCliSupabaseClient`), NOT the cookie SSR path. The tenant is resolved
 * by `resolveCliTenant` (header → last-active preference → sole membership →
 * deny) — there is no `x-tenant-id` header on a bare `bearer()` request here,
 * so these tests exercise the sole-active-membership branch unless noted. The
 * contract this file pins:
 *
 *   1. No Bearer header           → 401, before any DB work
 *   2. Token resolves to no user  → 401
 *   3. User has no active membership → 403
 *   4. The list is tenant-scoped   → a caller NEVER sees another tenant's apps
 *      (the `.eq('tenant_id', tenantId)` filter)
 *   5. Rows map to the CLI contract shape
 *
 * Supabase is an HTTP boundary → MSW (per app testing rules). The Bearer token
 * is the access token of an MSW-seeded session, so `getUser()` resolves through
 * the same `/auth/v1/user` handler as cookie SSR; the `app`/`membership`/
 * `profile` queries resolve through the seeded tables.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// Match the route's `NextResponse.json(body, { status })` so we can read
// status + body without a full Next runtime.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

// serverLogger is an internal logging seam (not HTTP traffic); the catch path
// calls it. Mock so a stray failure never does real I/O.
vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: { error: vi.fn() },
}));

import { GET } from '../route';
import {
  seedSupabaseAuth,
  seedSupabaseMswState,
  seedMembershipMswState,
} from '@/test-helpers/msw-handlers';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';

const TENANT = 'tenant-mine';
const OTHER_TENANT = 'tenant-other';
const CLI_USER_ID = 'cli-user-1';

function cliUser() {
  return { ...mockUser, id: CLI_USER_ID, app_metadata: {} };
}

/** Seeds a single active, non-disabled membership — the sole-membership
 * precedence branch resolves it with no header and no preference. */
function seedSoleMembership(tenantId: string) {
  seedMembershipMswState({
    memberships: [
      { id: 'm-1', user_id: CLI_USER_ID, tenant_id: tenantId, role: 'owner', status: 'active' },
    ],
  });
}

function bearer(token: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/cli/apps', {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
}

// MSW state is reset globally before each test (unit-test-setup.ts).
beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cli/apps', () => {
  it('401s with no Authorization header, before any user lookup', async () => {
    const res = await GET(new Request('http://localhost/api/cli/apps'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing Authorization header' });
  });

  it('401s when the bearer token resolves to no user', async () => {
    // No session seeded for this token → /auth/v1/user returns 401 → getUser errors.
    const res = await GET(bearer('a-token-with-no-session'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
  });

  it('403s when the authenticated user has no active membership anywhere', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    // No membership seeded → resolveCliTenant's sole-membership branch finds
    // nothing to fall back to.

    const res = await GET(bearer(session.access_token));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'No tenant associated with user' });
  });

  it('403s when the caller\'s only membership is disabled', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedMembershipMswState({
      memberships: [
        { id: 'm-1', user_id: CLI_USER_ID, tenant_id: TENANT, role: 'disabled', status: 'active' },
      ],
    });

    const res = await GET(bearer(session.access_token));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'No tenant associated with user' });
  });

  it('400s with the multi-org error when the caller has more than one active membership and no header or preference', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedMembershipMswState({
      memberships: [
        { id: 'm-1', user_id: CLI_USER_ID, tenant_id: TENANT, role: 'owner', status: 'active' },
        { id: 'm-2', user_id: CLI_USER_ID, tenant_id: OTHER_TENANT, role: 'read', status: 'active' },
      ],
    });

    const res = await GET(bearer(session.access_token));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Multiple organizations found — switch to the one you want in the dashboard, then retry',
    });
  });

  it('403s and never falls back when the caller sends a non-member X-Tenant-Id', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedSoleMembership(TENANT);
    seedSupabaseMswState({
      apps: [{ id: 'app-mine-1', tenant_id: TENANT, name: 'Mine One' }],
    });

    const res = await GET(bearer(session.access_token, { 'x-tenant-id': OTHER_TENANT }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not an active member of the requested tenant' });
    expect(JSON.stringify(body)).not.toContain('app-mine-1');
  });

  it('scopes to the explicit X-Tenant-Id when the caller is an active member of it', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedMembershipMswState({
      memberships: [
        { id: 'm-1', user_id: CLI_USER_ID, tenant_id: TENANT, role: 'owner', status: 'active' },
        { id: 'm-2', user_id: CLI_USER_ID, tenant_id: OTHER_TENANT, role: 'read', status: 'active' },
      ],
    });
    seedSupabaseMswState({
      apps: [{ id: 'app-other-1', tenant_id: OTHER_TENANT, name: 'Other One' }],
    });

    const res = await GET(bearer(session.access_token, { 'x-tenant-id': OTHER_TENANT }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps.map((a: { id: string }) => a.id)).toEqual(['app-other-1']);
  });

  it("returns ONLY the caller tenant's apps — never another tenant's", async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedSoleMembership(TENANT);
    seedSupabaseMswState({
      apps: [
        { id: 'app-mine-1', tenant_id: TENANT, name: 'Mine One' },
        { id: 'app-other', tenant_id: OTHER_TENANT, name: 'Other Tenant' },
        { id: 'app-mine-2', tenant_id: TENANT, name: 'Mine Two' },
      ],
    });

    const res = await GET(bearer(session.access_token));

    expect(res.status).toBe(200);
    const body = await res.json();
    // The exact set the caller may see — pins the tenant filter. If the route
    // drops `.eq('tenant_id', tenantId)`, the MSW handler returns every app and
    // 'app-other' leaks in → this fails.
    expect(body.apps.map((a: { id: string }) => a.id).sort()).toEqual([
      'app-mine-1',
      'app-mine-2',
    ]);
    expect(
      body.apps.some((a: { tenant_id: string }) => a.tenant_id === OTHER_TENANT),
    ).toBe(false);
  });

  it('maps each app to the CLI contract shape', async () => {
    const session = seedSupabaseAuth({ user: cliUser() });
    seedSoleMembership(TENANT);
    seedSupabaseMswState({
      apps: [{ id: 'app-1', tenant_id: TENANT, name: 'My App' }],
    });

    const res = await GET(bearer(session.access_token));

    expect(res.status).toBe(200);
    const body = await res.json();
    // toEqual (not toMatchObject) so an extra/renamed field fails. created_at is
    // omitted: no value is seeded, so the route emits `undefined`, which toEqual
    // ignores — yet a mutation that sets it to any defined value still fails here.
    expect(body.apps).toEqual([
      {
        id: 'app-1',
        name: 'My App',
        tenant_id: TENANT,
        // No `tenant` embed seeded → the route's `?.organization_name || ''`
        // fallback resolves to ''. Pins that transform branch.
        tenant_name: '',
      },
    ]);
  });
});
