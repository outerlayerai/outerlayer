/**
 * Tests: updateSession (session middleware behavior).
 *
 * Pins the API-vs-page split for unauthenticated requests:
 * - /api/* must get a JSON 401 (fetch callers can't handle redirects —
 *   they follow them silently and choke on the login page HTML)
 * - page routes keep the login redirect
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import { updateSession } from '../middleware';
import {
  seedSupabaseAuth,
  seedMembershipMswState,
} from '../../../test-helpers/msw-handlers';

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:4000${path}`);
}

const SESSION_COOKIE = 'sb-localhost-auth-token';

function makeUser(id: string): User {
  return {
    id,
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  } as User;
}

/** An authed request under `path` for `userId`, carrying the seeded session. */
function makeAuthedRequest(path: string, userId: string, headers?: Record<string, string>): NextRequest {
  const session = seedSupabaseAuth({ user: makeUser(userId) });
  const request = new NextRequest(`http://localhost:4000${path}`, { headers });
  request.cookies.set(SESSION_COOKIE, JSON.stringify(session));
  return request;
}

/** The tenant header the middleware forwarded onto the request, if any. */
function forwardedTenant(response: Response): string | null {
  return response.headers.get('x-middleware-request-x-tenant-id');
}

describe('updateSession (unauthenticated)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  });

  it('returns JSON 401 for API routes instead of a login redirect', async () => {
    const response = await updateSession(makeRequest('/api/platform-admin/score-coverage'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'Not authenticated',
      code: 'UNAUTHORIZED',
    });
  });

  it('redirects page routes to the login page', async () => {
    const response = await updateSession(makeRequest('/platform-admin/users'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/auth/login');
  });

  it('does not redirect /auth pages', async () => {
    const response = await updateSession(makeRequest('/auth/login'));

    expect(response.status).toBe(200);
  });
});

describe('updateSession (URL-tenant derivation)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'user-1', tenant_id: 'tenant-A', role: 'admin', status: 'active' },
      ],
      tenants: [{ tenant_id: 'tenant-A', organization_name: 'org-a' }],
    });
  });

  it('forwards the tenant of a page org the user is an active member of', async () => {
    const response = await updateSession(
      makeAuthedRequest('/orgs/org-a/apps/x/env/dev/settings', 'user-1'),
    );

    expect(forwardedTenant(response)).toBe('tenant-A');
  });

  it('derives the same tenant for a canonical /api/orgs path', async () => {
    const response = await updateSession(
      makeAuthedRequest('/api/orgs/org-a/apps/123/dashboards', 'user-1'),
    );

    expect(forwardedTenant(response)).toBe('tenant-A');
  });

  it('strips an inbound x-tenant-id and replaces it with the server-derived one', async () => {
    const response = await updateSession(
      makeAuthedRequest('/orgs/org-a/apps/x', 'user-1', { 'x-tenant-id': 'spoofed-tenant' }),
    );

    // The forged inbound value is never honored — the URL org wins.
    expect(forwardedTenant(response)).toBe('tenant-A');
  });

  it('sets no tenant header for an org the user is not an active member of', async () => {
    const response = await updateSession(
      makeAuthedRequest('/orgs/org-nope/apps/x', 'user-1'),
    );

    expect(forwardedTenant(response)).toBeNull();
  });

  it('strips an inbound x-tenant-id on a path that carries no org', async () => {
    const response = await updateSession(
      makeAuthedRequest('/settings', 'user-1', { 'x-tenant-id': 'spoofed-tenant' }),
    );

    // No org in the path ⇒ no derived header, and the forged one is dropped
    // rather than forwarded to a downstream reader.
    expect(forwardedTenant(response)).toBeNull();
  });

  it('does not forward an inbound member-tenant header on a non-member org path', async () => {
    // user-1 is an active member of tenant-A (org-a). They hit /orgs/org-nope —
    // an org they do NOT belong to — while injecting x-tenant-id: tenant-A (a
    // tenant they DO belong to). The strip runs before resolution and org-nope
    // resolves to nothing, so the forged header never reaches a handler; the
    // marker proves the forwarded header set is real, not absent.
    const response = await updateSession(
      makeAuthedRequest('/orgs/org-nope/apps/x', 'user-1', {
        'x-tenant-id': 'tenant-A',
        'x-test-marker': 'present',
      }),
    );

    expect(response.headers.get('x-middleware-request-x-test-marker')).toBe('present');
    expect(forwardedTenant(response)).toBeNull();
  });
});

describe('updateSession (strip-only api prefixes)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  });

  it('strips an inbound x-tenant-id on a self-authenticated prefix without running auth', async () => {
    const request = new NextRequest('http://localhost:4000/api/webhooks/github', {
      headers: { 'x-tenant-id': 'spoofed-tenant', 'x-test-marker': 'present' },
    });

    const response = await updateSession(request);

    // Passed through (no 401 — self-authenticated routes must not hit getUser),
    // the forwarded header set is real (marker present), and the forged tenant
    // header did not survive.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-test-marker')).toBe('present');
    expect(forwardedTenant(response)).toBeNull();
  });

  it.each([
    '/api/cron/worker-reaper',
    '/api/internal/worker-events',
    '/api/health',
    '/api/analytics/health',
    '/api/analytics',
  ])('drops the inbound header on strip-only path %s', async (path) => {
    const request = new NextRequest(`http://localhost:4000${path}`, {
      headers: { 'x-tenant-id': 'spoofed-tenant' },
    });

    const response = await updateSession(request);

    expect(forwardedTenant(response)).toBeNull();
  });

  // A prefix that merely starts with the same letters as "cli" must not be
  // swept into the exception.
  it.each(['/api/client-portal/widgets', '/api/clientele'])(
    'still strips the inbound header on a near-miss prefix %s (not a CLI substring match)',
    async (path) => {
      const request = new NextRequest(`http://localhost:4000${path}`, {
        headers: { 'x-tenant-id': 'spoofed-tenant' },
      });

      const response = await updateSession(request);

      expect(forwardedTenant(response)).toBeNull();
    },
  );
});

describe('updateSession (CLI api path — the one header-strip exception)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  });

  it.each(['/api/cli/apps', '/api/cli/dev-key', '/api/cli/dev-key/abc-123/refresh'])(
    'passes an inbound x-tenant-id header through unmodified on %s',
    async (path) => {
      const request = new NextRequest(`http://localhost:4000${path}`, {
        headers: { 'x-tenant-id': 'caller-supplied-tenant' },
      });

      const response = await updateSession(request);

      // The middleware neither strips nor re-derives the header on CLI
      // paths; the route's own resolver handles it.
      expect(response.headers.get('x-middleware-request-x-tenant-id')).toBe(
        'caller-supplied-tenant',
      );
    },
  );

  // A CLI request with no session cookie is not 401'd here — auth is the
  // route's job (createCliSupabaseClient + getUser() against the Bearer
  // token).
  it('does not run cookie-session auth for an unauthenticated CLI request', async () => {
    const request = new NextRequest('http://localhost:4000/api/cli/apps');

    const response = await updateSession(request);

    expect(response.status).toBe(200);
  });

  it('forwards other headers unchanged alongside the tenant header', async () => {
    const request = new NextRequest('http://localhost:4000/api/cli/apps', {
      headers: { 'x-tenant-id': 'tenant-x', 'x-test-marker': 'present' },
    });

    const response = await updateSession(request);

    expect(response.headers.get('x-middleware-request-x-test-marker')).toBe('present');
  });
});
