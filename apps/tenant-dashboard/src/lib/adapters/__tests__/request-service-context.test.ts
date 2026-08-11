/**
 * Tests: the request-bound wiring behind the action-kit seams.
 *
 * loadRequestServiceContext builds a header-scoped client, resolves the tenant
 * from the URL (claim fallback), and reads the actor's role table-driven from
 * membership — not the JWT. checkRequestPermission answers via the DB
 * authorize / app_authorize RPCs. Boundary: MSW over the Supabase HTTP traffic;
 * the middleware-derived header controlled through next/headers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { getSupabaseTestCookieStore } from '../../../test-helpers/supabase-session';

vi.mock('server-only', () => ({}));

const headersGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import {
  loadRequestServiceContext,
  loadPreTenantActor,
  loadPreTenantActorSession,
  loadPreTenantDb,
  checkRequestPermission,
} from '../request-service-context';
import {
  seedSupabaseAuth,
  seedMembershipMswState,
  seedPermissionsMswState,
} from '../../../test-helpers/msw-handlers';
import type { Actor } from '@/lib/action-kit/service-context';

const CLAIM_TENANT = 'tenant-claim';
const URL_TENANT = 'tenant-url';
const ACTOR: Actor = { userId: 'user-1', role: 'unused' };

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: CLAIM_TENANT },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

describe('loadRequestServiceContext', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
  });

  it('resolves the URL tenant with the table-driven membership role, ignoring the claim', async () => {
    headersGet.mockReturnValue(URL_TENANT);
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'user-1', tenant_id: URL_TENANT, role: 'admin', status: 'active' },
      ],
      tenants: [{ tenant_id: URL_TENANT, organization_name: 'org-a' }],
    });

    const ctx = await loadRequestServiceContext();

    expect(ctx.tenantId).toBe(URL_TENANT);
    expect(ctx.actor).toEqual({ userId: 'user-1', role: 'admin' });
    expect(typeof ctx.db.from).toBe('function');
  });

  it('throws when no header is present, even though the claim names a tenant the caller has an active membership in', async () => {
    headersGet.mockReturnValue(null);
    seedMembershipMswState({
      memberships: [
        { id: 'm1', user_id: 'user-1', tenant_id: CLAIM_TENANT, role: 'read', status: 'active' },
      ],
      tenants: [{ tenant_id: CLAIM_TENANT, organization_name: 'org-claim' }],
    });

    await expect(loadRequestServiceContext()).rejects.toThrow('No tenant for request');
  });

  it('throws when the request is unauthenticated', async () => {
    // Overwrite the default authed session with an unauthenticated one.
    const cookieStore = getSupabaseTestCookieStore();
    cookieStore.delete('sb-localhost-auth-token');
    headersGet.mockReturnValue(URL_TENANT);

    await expect(loadRequestServiceContext()).rejects.toThrow('Not authenticated');
  });
});

describe('loadPreTenantActor', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
  });

  it('resolves the authenticated user with exactly the pre-tenant actor shape — no db, no tenantId', async () => {
    const actor = await loadPreTenantActor();

    expect(actor && Object.keys(actor).sort()).toEqual(['email', 'raw', 'userId']);
    expect(actor).toEqual({ userId: 'user-1', email: 'test@example.com', raw: mockUser });
  });

  it('returns null, not a thrown error, when the request is unauthenticated', async () => {
    const cookieStore = getSupabaseTestCookieStore();
    cookieStore.delete('sb-localhost-auth-token');

    await expect(loadPreTenantActor()).resolves.toBeNull();
  });
});

describe('loadPreTenantActorSession', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
  });

  it('resolves the authenticated actor plus the raw session access token', async () => {
    const result = await loadPreTenantActorSession();

    expect(result).not.toBeNull();
    expect(result!.actor).toEqual({ userId: 'user-1', email: 'test@example.com', raw: expect.objectContaining({ id: 'user-1' }) });
    expect(typeof result!.accessToken).toBe('string');
    expect(result!.accessToken.length).toBeGreaterThan(0);
  });

  it('returns null, not a thrown error, when the request is unauthenticated', async () => {
    const cookieStore = getSupabaseTestCookieStore();
    cookieStore.delete('sb-localhost-auth-token');

    await expect(loadPreTenantActorSession()).resolves.toBeNull();
  });
});

describe('loadPreTenantDb', () => {
  beforeEach(() => {
    headersGet.mockReset();
    seedSupabaseAuth({ user: mockUser });
  });

  it('resolves a usable Supabase client for an authenticated caller', async () => {
    const db = await loadPreTenantDb();

    expect(db).not.toBeNull();
    expect(typeof db!.rpc).toBe('function');
  });

  it('returns null, not a thrown error, when the request is unauthenticated', async () => {
    const cookieStore = getSupabaseTestCookieStore();
    cookieStore.delete('sb-localhost-auth-token');

    await expect(loadPreTenantDb()).resolves.toBeNull();
  });
});

describe('checkRequestPermission', () => {
  beforeEach(() => {
    headersGet.mockReset();
    headersGet.mockReturnValue(URL_TENANT);
    seedSupabaseAuth({ user: mockUser });
  });

  it('grants an org permission the authorize RPC allows', async () => {
    seedPermissionsMswState({ allowedPermissions: ['app.read'] });
    await expect(checkRequestPermission(ACTOR, 'app.read')).resolves.toBe(true);
  });

  it('denies an org permission the authorize RPC rejects', async () => {
    seedPermissionsMswState({ allowedPermissions: [] });
    await expect(checkRequestPermission(ACTOR, 'app.delete')).resolves.toBe(false);
  });

  it('grants an app permission the app_authorize RPC allows for that app', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-1': ['app_policy.update'] } });
    await expect(checkRequestPermission(ACTOR, 'app_policy.update', 'app-1')).resolves.toBe(true);
  });

  it('denies an app permission granted only for a different app', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-other': ['app_policy.update'] } });
    await expect(checkRequestPermission(ACTOR, 'app_policy.update', 'app-1')).resolves.toBe(false);
  });
});
