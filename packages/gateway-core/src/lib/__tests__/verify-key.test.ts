/**
 * Direct tests for the shared verifyKey helper.
 *
 * Covers the contract consumed by both the legacy handler
 * (policies/verify-api-key.ts) and the OpenAPI Hono middleware
 * (openapi/middleware.ts). Middleware tests assert the HTTP envelope;
 * this file asserts the result shape and branch behavior of the helper
 * itself.
 *
 * Post-cutover: verify hashes the incoming key with API_KEY_PEPPER and looks
 * the digest up via the `verify_api_key` RPC (mocked here through the shared
 * Supabase MSW handler). `resolveAppIdentity` is the self-host perimeter-trust
 * path that resolves the app identity directly from Supabase (no key-store).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hashApiKey } from '@repo/api-key-service';
import type { Env } from '../../types';
import {
  getGatewaySupabaseMswState,
  seedGatewaySupabaseMswState,
} from '../../test-helpers/msw-handlers';
import { verifyKey, buildUserMetaCacheKey, resolveAppIdentity } from '../verify-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PEPPER = 'test-pepper';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    UNKEY_API_KEY: 'unkey-root',
    API_KEY_PEPPER: PEPPER,
    SUPABASE_API_BASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'service-role',
    ...overrides,
  } as Env;
}

/**
 * The jsonb payload `verify_api_key` returns on a match — the full UserMeta the
 * RPC assembles from api_key/app/billing/git_branch. Seed a copy per test via
 * `seedGatewaySupabaseMswState({ verifyApiKeyResult: ... })`.
 */
function validUserMeta(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    tenantId: 'tenant-1',
    appName: 'App One',
    stripeCustomerId: 'cus_x',
    stripeSubscriptionId: 'sub_x',
    branchId: 'branch-1',
    permissions: ['trace.read', 'trace.write'],
    apiKeyId: 'key_abc',
    ...overrides,
  };
}

function seedVerifyResult(result: unknown) {
  seedGatewaySupabaseMswState({ verifyApiKeyResult: result });
}

function mockAppLookup(app: { id: string; tenant_id: string; name: string } | null) {
  seedGatewaySupabaseMswState({ apps: app ? [app] : [] });
}

function mockBranchLookup(branchId: string | null = 'branch-1') {
  seedGatewaySupabaseMswState({
    gitBranches: branchId ? [{ id: branchId, app_id: 'app-1' }] : [],
  });
}

function makeCache() {
  const get = vi.fn().mockResolvedValue({ err: null, val: null });
  const set = vi.fn().mockResolvedValue(undefined);
  return {
    cache: { userMeta: { get, set } } as any,
    get,
    set,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildUserMetaCacheKey
// ---------------------------------------------------------------------------

describe('buildUserMetaCacheKey', () => {
  it('should combine appId with a hashed auth header', async () => {
    const key = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_abc');
    expect(key).toMatch(/^app-1-[a-f0-9]{64}$/);
    expect(key).not.toContain('sk_outerlayer_abc');
  });

  it('should be route-independent so the same caller reuses one cache entry across routes', async () => {
    const a = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_abc');
    const b = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_abc');
    expect(a).toBe(b);
  });

  it('should produce different keys for different auth headers', async () => {
    const a = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_abc');
    const b = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_xyz');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Key-store (verify_api_key RPC) path
// ---------------------------------------------------------------------------

describe('verifyKey — key-store path', () => {
  it('strips the Bearer scheme prefix and looks up the peppered digest of the raw key', async () => {
    // Regression guard: the middleware forwards the raw `Authorization` header
    // value (`Bearer sk_outerlayer_...`). The digest must be computed over the
    // key ALONE — a leaked scheme prefix would never match a stored digest.
    seedVerifyResult(validUserMeta());

    await verifyKey({
      authHeader: 'Bearer sk_outerlayer_abcdef',
      appId: 'app-1',
      env: makeEnv(),
    });

    const expectedDigest = await hashApiKey('sk_outerlayer_abcdef', PEPPER);
    expect(getGatewaySupabaseMswState().lastVerifyApiKeyDigest).toBe(expectedDigest);
    expect(getGatewaySupabaseMswState().lastVerifyApiKeyDigest).not.toContain('Bearer');
  });

  it('should return ok with the exact UserMeta the RPC assembled on a match', async () => {
    seedVerifyResult(validUserMeta());

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exact shape — the RPC payload passes through Zod unchanged (no
    // gatewayUserId is resolved).
    expect(result.user).toEqual(validUserMeta());
    expect(result.user.apiKeyId).toBe('key_abc');
  });

  it('tolerates RETIRED permission values on stored keys — drops them, keeps the live ones', async () => {
    // A key minted before a permission was retired from GATEWAY_PERMISSIONS
    // still carries the dead value in its permissions array. Retiring a
    // permission must cost such a key exactly that one capability — nothing
    // else. A strict enum parse over the whole array would instead fail the
    // verify payload and 401 the key.
    seedVerifyResult(
      validUserMeta({ permissions: ['trace.write', 'template.read', 'score.write'] }),
    );

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_retired_permission',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Positional pin: dead value gone, live values intact and ordered.
    expect(result.user.permissions).toEqual(['trace.write', 'score.write']);
  });

  it('parses environmentId off the RPC payload so the resolver can use the meta path', async () => {
    seedVerifyResult(validUserMeta({ environmentId: 'env-prod-7' }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.environmentId).toBe('env-prod-7');
  });

  it('authorizes a legacy key whose payload carries no environmentId (undefined, not a 401)', async () => {
    seedVerifyResult(validUserMeta());

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_legacy',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.environmentId).toBeUndefined();
  });

  it('should return 502 when the verify_api_key RPC errors (store unreachable)', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyError: { message: 'connection refused', code: '08006' },
    });

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result).toEqual({
      ok: false,
      status: 502,
      message: 'Authentication service error',
      code: 'service_unavailable',
    });
  });

  it('should return 401 when no live key matches the digest (RPC returns null)', async () => {
    seedVerifyResult(null);

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_unknown',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      message: 'Not authorized',
      code: 'unauthorized',
    });
  });

  it('should return 401 when the RPC payload fails Zod validation (missing tenantId)', async () => {
    const { tenantId: _tenantId, ...withoutTenant } = validUserMeta();
    seedVerifyResult(withoutTenant);

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('drops an unknown permission string but keeps the key valid (retired-vocabulary tolerance)', async () => {
    // Retiring a permission from the vocabulary must cost a key exactly that
    // one capability, not fail its whole payload. Unknown VALUES are dropped;
    // structural garbage (non-array) still fails closed (pinned below).
    seedVerifyResult(validUserMeta({ permissions: ['trace.read', 'definitely.not_a_real_permission'] }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.permissions).toEqual(['trace.read']);
  });

  it('still fails closed when permissions is structurally malformed (not an array)', async () => {
    seedVerifyResult(validUserMeta({ permissions: 'trace.read' }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('should return 401 when the request appId does not match the verified key appId', async () => {
    seedVerifyResult(validUserMeta({ appId: 'app-from-key' }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-from-header',
      env: makeEnv(),
    });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  // -------------------------------------------------------------------------
  // Derive mode: appId === null (the `/v1/mcp` optional-header path — see
  // `openapi/middleware.ts`'s `headerOptional` rule). Keys are bound to
  // exactly one app, so with no header to cross-check, the resolved key's
  // own app becomes the authority instead of being compared to anything.
  // -------------------------------------------------------------------------

  it('derives the app id from the resolved key when appId is null (no header)', async () => {
    seedVerifyResult(validUserMeta({ appId: 'app-from-key' }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: null,
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.appId).toBe('app-from-key');
  });

  it('still rejects when a header IS present and it names a different app than the key', async () => {
    // Regression guard for the derive-mode addition: a caller CANNOT get the
    // permissive branch by simply picking an appId that happens to be wrong —
    // only appId === null (no header at all) skips the cross-check.
    seedVerifyResult(validUserMeta({ appId: 'app-from-key' }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-attacker-supplied',
      env: makeEnv(),
    });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('should tolerate null stripeSubscriptionId (post-cancel billing state) and normalize to ""', async () => {
    // Regression: billing.stripe_subscription_id is NULL after a cancel; the RPC
    // surfaces it as null. Schema accepts null/undefined and normalizes to ''.
    seedVerifyResult(validUserMeta({ stripeSubscriptionId: null }));

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.stripeSubscriptionId).toBe('');
  });

  it('should return 500 and swallow the exception when hashing throws (pepper misconfigured)', async () => {
    // A hosted deploy missing API_KEY_PEPPER: hashApiKey throws, the catch maps
    // it to 500 rather than a misleading 401.
    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv({ API_KEY_PEPPER: undefined } as Partial<Env>),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      message: 'Something went wrong',
      code: 'internal_error',
    });
    // The RPC is never reached when hashing fails first.
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('verifyKey — cache', () => {
  it('should short-circuit on cache hit and never hit the key-store', async () => {
    const { cache, get } = makeCache();
    get.mockResolvedValueOnce({
      err: null,
      val: {
        appId: 'app-1',
        tenantId: 'tenant-1',
        appName: 'Cached App',
        stripeCustomerId: '',
        stripeSubscriptionId: '',
        branchId: '',
        permissions: [],
      },
    });

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
      cache,
      cacheKey: await buildUserMetaCacheKey('app-1', 'sk_outerlayer_x'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.appName).toBe('Cached App');
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
  });

  it('should populate the cache on successful verification', async () => {
    const { cache, set } = makeCache();
    seedVerifyResult(validUserMeta());

    const cacheKey = await buildUserMetaCacheKey('app-1', 'sk_outerlayer_x');
    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
      cache,
      cacheKey,
    });

    expect(result.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toBe(cacheKey);
    expect(set.mock.calls[0]?.[1]).toEqual(validUserMeta());
  });

  it('should fall through to the key-store when the cache read returns an error', async () => {
    // Fail-open: a transient KV blip must not lock callers out.
    const { cache, get } = makeCache();
    get.mockResolvedValueOnce({ err: new Error('cache down'), val: null });
    seedVerifyResult(validUserMeta());

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
      cache,
      cacheKey: await buildUserMetaCacheKey('app-1', 'sk_outerlayer_x'),
    });

    expect(result.ok).toBe(true);
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(1);
  });

  it('should not populate the cache when verification fails', async () => {
    const { cache, set } = makeCache();
    seedVerifyResult(null);

    await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
      cache,
      cacheKey: await buildUserMetaCacheKey('app-1', 'sk_outerlayer_x'),
    });

    expect(set).not.toHaveBeenCalled();
  });

  it('should skip the cache entirely when cache/cacheKey are not provided', async () => {
    seedVerifyResult(validUserMeta());

    const result = await verifyKey({
      authHeader: 'sk_outerlayer_x',
      appId: 'app-1',
      env: makeEnv(),
    });

    expect(result.ok).toBe(true);
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveAppIdentity (self-host perimeter-trust path — no key-store)
// ---------------------------------------------------------------------------

describe('resolveAppIdentity', () => {
  it('should resolve the user from Supabase when the app exists and grant full-access permissions', async () => {
    mockAppLookup({ id: 'app-1', tenant_id: 'tenant-1', name: 'Self-host App' });
    mockBranchLookup('branch-1');

    const result = await resolveAppIdentity('app-1', makeEnv());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({
      appId: 'app-1',
      tenantId: 'tenant-1',
      appName: 'Self-host App',
      branchId: 'branch-1',
    });
    expect(result.user.permissions).toEqual(expect.arrayContaining(['trace.read', 'trace.write']));
    // Perimeter trust resolves identity from the app row — it never verifies a key.
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
  });

  it('should return 401 when the app is not found', async () => {
    mockAppLookup(null);

    const result = await resolveAppIdentity('missing-app', makeEnv());

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
  });
});
