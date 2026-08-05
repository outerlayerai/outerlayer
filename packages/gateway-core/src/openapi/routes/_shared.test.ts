/**
 * Unit tests for openapi/routes/_shared.ts helpers.
 *
 * Focus on getScopedSupabase — specifically that it passes the right
 * named arguments to createTenantScopedClient. An argument-order typo
 * here (user.appId vs user.tenantId, or leaving out the gatewayUserId
 * fallback) would type-check cleanly and silently leak cross-tenant at
 * runtime via the JWT sub / app_metadata.tenant_id claim. Keep these
 * assertions even if they feel obvious.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from './_shared';

const createTenantScopedClient = vi.fn(() => Promise.resolve({ __scoped: true }));
vi.mock('../../supabase', () => ({
  createTenantScopedClient: (...args: unknown[]) =>
    createTenantScopedClient(...(args as [])),
}));

const createSystemAdminClient = vi.fn(() => ({ __admin: true }));
vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: (...args: unknown[]) =>
    createSystemAdminClient(...(args as [])),
}));

const createAuthenticatedClient = vi.fn(() => ({ __authenticated: true }));
vi.mock('../../lib/authenticated-client', () => ({
  createAuthenticatedClient: (...args: unknown[]) =>
    createAuthenticatedClient(...(args as [])),
}));

const resolveEnvironmentFromApiKey = vi.fn();
vi.mock('../../lib/environment-resolver', () => ({
  resolveEnvironmentFromApiKey: (...args: unknown[]) =>
    resolveEnvironmentFromApiKey(...(args as [])),
}));

import { getScopedSupabase, resolveEnvScope } from './_shared';

const FAKE_ENV = {
  SUPABASE_API_BASE_URL: 'http://x',
  SUPABASE_PUBLISHABLE_KEY: 'anon',
  SUPABASE_JWT_SECRET: 'jwt',
} as AppContext['env'];

function createFakeContext(
  user: Record<string, unknown>,
): AppContext {
  return {
    env: FAKE_ENV,
    get: vi.fn((key: string) => (key === 'user' ? user : undefined)),
  } as unknown as AppContext;
}

beforeEach(() => vi.clearAllMocks());

describe('getScopedSupabase', () => {
  it('passes tenantId + gatewayUserId + permissions + env to createTenantScopedClient', async () => {
    const c = createFakeContext({
      tenantId: 'tenant-42',
      gatewayUserId: 'gw-user-99',
      permissions: ['template.read', 'dataset.read'],
      appId: 'app-WRONG', // should NOT be passed — catches argument-order typo
    });

    await getScopedSupabase(c);

    expect(createTenantScopedClient).toHaveBeenCalledWith(
      FAKE_ENV,
      'tenant-42',
      'gw-user-99',
      ['template.read', 'dataset.read'],
    );
    // Explicit: appId must not appear in the scoped-client arguments.
    const call = createTenantScopedClient.mock.calls[0]!;
    expect(call).not.toContain('app-WRONG');
  });

  it('falls back to tenantId as sub when gatewayUserId is absent', async () => {
    const c = createFakeContext({
      tenantId: 'tenant-nogateway',
      // no gatewayUserId
      permissions: [],
    });

    await getScopedSupabase(c);

    expect(createTenantScopedClient).toHaveBeenCalledWith(
      FAKE_ENV,
      'tenant-nogateway',
      'tenant-nogateway', // fallback
      [],
    );
  });

  it('defaults permissions to [] when user has no permissions field', async () => {
    const c = createFakeContext({
      tenantId: 'tenant-x',
      gatewayUserId: 'gw-x',
    });

    await getScopedSupabase(c);

    const call = createTenantScopedClient.mock.calls[0]!;
    expect(call[3]).toEqual([]);
  });

  // ========================================================================
  // Auth-mode dispatch
  // ========================================================================
  //
  // Bearer auth means the user's own Supabase JWT goes to PostgREST,
  // which resolves the `authenticated` role and the dashboard's existing
  // RLS policies. createTenantScopedClient (gateway role) must NOT be
  // called on this path — using it would silently mask RLS with the
  // gateway-role policy surface.

  describe('auth-mode dispatch', () => {
    it('uses createAuthenticatedClient when authMode is bearer', async () => {
      const c = createFakeContext({
        tenantId: 'tenant-b',
        gatewayUserId: 'user-sub',
        permissions: [],
        authMode: 'bearer',
        userJwt: 'the-bearer-jwt',
      });

      const result = await getScopedSupabase(c);

      // The resolved tenant is forwarded so the bearer client pins the DB's
      // dual-source tenant resolver to it, not the JWT claim.
      expect(createAuthenticatedClient).toHaveBeenCalledWith(FAKE_ENV, 'the-bearer-jwt', 'tenant-b');
      expect(createTenantScopedClient).not.toHaveBeenCalled();
      expect(result).toEqual({ __authenticated: true });
    });

    it('uses createTenantScopedClient when authMode is apikey', async () => {
      const c = createFakeContext({
        tenantId: 'tenant-a',
        gatewayUserId: 'gw-sys',
        permissions: ['trace.read'],
        authMode: 'apikey',
      });

      await getScopedSupabase(c);

      expect(createTenantScopedClient).toHaveBeenCalledOnce();
      expect(createAuthenticatedClient).not.toHaveBeenCalled();
    });

    it('defaults to the api-key path when authMode is undefined (backward compat)', async () => {
      // Legacy handler paths / tests that construct a user without the
      // authMode field should still work — the absence of `bearer`
      // falls through to the gateway-role scoped client.
      const c = createFakeContext({
        tenantId: 'tenant-legacy',
        gatewayUserId: 'gw',
        permissions: [],
      });

      await getScopedSupabase(c);

      expect(createTenantScopedClient).toHaveBeenCalledOnce();
      expect(createAuthenticatedClient).not.toHaveBeenCalled();
    });

    it('throws when authMode is bearer but userJwt is missing (defensive)', async () => {
      const c = createFakeContext({
        tenantId: 'tenant-b',
        authMode: 'bearer',
        // userJwt intentionally omitted — defensive failure path
      });

      await expect(getScopedSupabase(c)).rejects.toThrow(/userJwt/);
      expect(createAuthenticatedClient).not.toHaveBeenCalled();
      expect(createTenantScopedClient).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// resolveEnvScope — env-bound API keys must NOT degrade to cross-env access
// when the env lookup throws. The previous code returned `undefined` on any
// resolution error, which silently broadened authorization for env-bound
// keys to all envs on a transient Supabase blip. Now it re-throws.
// ===========================================================================

describe('resolveEnvScope', () => {
  it('returns undefined when the caller has no apiKeyId (bearer / legacy auth)', async () => {
    const c = createFakeContext({ tenantId: 't1' /* no apiKeyId */ });

    const result = await resolveEnvScope(c);

    expect(result).toBeUndefined();
    expect(resolveEnvironmentFromApiKey).not.toHaveBeenCalled();
  });

  it('returns the resolved env scope when the api-key has an env binding', async () => {
    resolveEnvironmentFromApiKey.mockResolvedValueOnce({
      name: 'prod',
      isDefault: false,
    });
    const c = createFakeContext({
      tenantId: 't1',
      apiKeyId: 'key_abc',
    });

    const result = await resolveEnvScope(c);

    expect(result).toEqual({
      environment: { name: 'prod', isDefault: false },
    });
  });

  it('returns undefined when the api-key has no env binding (legacy unbound key)', async () => {
    resolveEnvironmentFromApiKey.mockResolvedValueOnce(null);
    const c = createFakeContext({
      tenantId: 't1',
      apiKeyId: 'key_legacy',
    });

    const result = await resolveEnvScope(c);
    expect(result).toBeUndefined();
  });

  it('FAILS CLOSED: re-throws when env resolution errors (does NOT silently broaden access)', async () => {
    // Regression: the previous implementation returned `undefined` here,
    // which made an env-bound key look like a no-binding key — every analytics
    // query would skip its env filter and serve traces from other envs to the
    // bound caller. A 500 is preferable to data leakage; callers retry.
    const dbBlip = new Error('connection terminated unexpectedly');
    resolveEnvironmentFromApiKey.mockRejectedValueOnce(dbBlip);
    const c = createFakeContext({
      tenantId: 't1',
      apiKeyId: 'key_envbound',
    });

    await expect(resolveEnvScope(c)).rejects.toBe(dbBlip);
  });
});
