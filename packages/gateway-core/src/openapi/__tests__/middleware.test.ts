/**
 * Auth middleware tests.
 *
 * Tests the authMiddleware function that authenticates a request and sets the
 * authenticated user context on the Hono request.
 *
 * The API-key path resolves through `gtx.auth.resolveApiKey`,
 * which the fake gateway context delegates to the real `verifyKey`. `verifyKey`
 * hashes the incoming key with `API_KEY_PEPPER` and
 * looks the digest up via the `verify_api_key` RPC (mocked here through the
 * shared Supabase MSW handler). The bearer (user-JWT) path is separate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, Next } from 'hono';
import { hashApiKey } from '@repo/api-key-service';
import { fakeBuildGatewayContext as buildGatewayContext } from '../../test-helpers/fake-gateway-context';
import {
  getGatewaySupabaseMswState,
  seedGatewaySupabaseMswState,
} from '../../test-helpers/msw-handlers';
import type { Env } from '../../types';
import type { ExecutionContext } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Cache is built inside authMiddleware via initCache. Tests stub it to
// return a miss by default; individual tests override userMetaGet/Set
// to assert cache behavior. The key-store RPC itself is driven through the
// shared Supabase MSW handler (seedGatewaySupabaseMswState), NOT a mock.
const userMetaGet = vi.fn().mockResolvedValue({ err: null, val: null });
const userMetaSet = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils', () => ({
  initCache: vi.fn(() => ({
    userMeta: { get: userMetaGet, set: userMetaSet },
  })),
}));
vi.mock('../../cache-store', () => ({ memory: {} }));

// Import after mocks
import { authMiddleware } from '../middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PEPPER = 'test-pepper';

/**
 * The flat jsonb payload `verify_api_key` returns on a match — the full
 * UserMeta the RPC assembles (no nested meta/identity). Seed a copy per test
 * via `seedGatewaySupabaseMswState({ verifyApiKeyResult: ... })`. Defaults to
 * the app-123 / tenant-456 caller most tests drive.
 */
function validUserMeta(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-123',
    tenantId: 'tenant-456',
    appName: 'Test App',
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    branchId: '',
    permissions: [] as string[],
    ...overrides,
  };
}

function createMockHonoContext(overrides?: {
  headers?: Record<string, string>;
  envOverrides?: Record<string, string | undefined>;
  method?: string;
  /**
   * Concrete URL pathname for the request, e.g. `/v1/apps`. This is what
   * `c.req.path` returns in production at the `app.use('/v1/*')` layer.
   * Defaults to `/v1/test`.
   */
  path?: string;
  /**
   * Chanfana's registered route pattern (e.g. `/v1/apps/:appId`). In real
   * Hono, at the `app.use('/v1/*')` layer this resolves to the WILDCARD
   * `/v1/*`, NOT the per-route pattern — chanfana only substitutes the
   * concrete pattern once Hono dispatches to a specific handler. Tests
   * default to `'/v1/*'` to reflect that reality; setting it to anything
   * else from the call site is a sign the test is asserting on the
   * post-dispatch value, not the middleware-layer value.
   */
  routePath?: string;
}): {
  c: Context<{ Bindings: any; Variables: any }>;
  next: Next;
  jsonSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
} {
  const headers = overrides?.headers ?? {};
  const jsonSpy = vi.fn((body: unknown, status?: number) => {
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  });
  const setSpy = vi.fn();
  const nextFn = vi.fn().mockResolvedValue(undefined);

  const env = {
    NODE_ENV: 'production',
    UNKEY_API_KEY: 'unkey-root-key',
    API_KEY_PEPPER: PEPPER,
    SUPABASE_API_BASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-service-role-key',
    ...overrides?.envOverrides,
  };
  // The gtx middleware runs before auth in production; simulate it here so
  // authMiddleware can read c.get('gtx').cacheL2Store for initCache and reach
  // the real verifyKey through gtx.auth.resolveApiKey.
  const gtx = buildGatewayContext(env as unknown as Env, {} as ExecutionContext);

  const c = {
    req: {
      header: vi.fn((name: string) => headers[name]),
      url: 'http://localhost/v1/test',
      method: overrides?.method ?? 'GET',
      path: overrides?.path ?? overrides?.routePath ?? '/v1/test',
      routePath: overrides?.routePath ?? '/v1/*',
    },
    env,
    get: vi.fn((k: string) => (k === 'gtx' ? gtx : undefined)),
    json: jsonSpy,
    set: setSpy,
  } as unknown as Context<{ Bindings: any; Variables: any }>;

  return { c, next: nextFn, jsonSpy, setSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cache returns a miss so tests exercise the key-store path unless
  // they override userMetaGet explicitly. (MSW state auto-resets in
  // unit-test-setup's beforeEach.)
  userMetaGet.mockResolvedValue({ err: null, val: null });
  userMetaSet.mockResolvedValue(undefined);
});

describe('authMiddleware', () => {
  // -----------------------------------------------------------------------
  // Missing headers
  // -----------------------------------------------------------------------

  it('should return 401 when Authorization header is missing', async () => {
    const { c, next, jsonSpy } = createMockHonoContext({
      headers: { 'X-Outerlayer-App-Id': 'app-123' },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Missing auth header' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when X-Outerlayer-App-Id header is missing', async () => {
    const { c, next, jsonSpy } = createMockHonoContext({
      headers: { Authorization: 'sk_outerlayer_test123' },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Missing app id' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject X-Puzzlet-App-Id — the legacy header is not read', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456', appName: 'My App' }),
    });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Puzzlet-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Missing app id' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept X-Outerlayer-App-Id as an alternative app ID header', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456', appName: 'My App' }),
    });

    const { c, next, setSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(setSpy).toHaveBeenCalledWith('user', expect.objectContaining({
      tenantId: 'tenant-456',
    }));
  });

  // -----------------------------------------------------------------------
  // Key-store: no live key matches the digest (RPC returns null)
  //
  // Post-cutover this is a 401, NOT a 502. Only a genuine RPC/store error
  // (verifyApiKeyError below) is a 502 — a null result means "unknown /
  // revoked / expired key", which is the caller's fault.
  // -----------------------------------------------------------------------

  it('should return 401 when no live key matches the digest (RPC returns null)', async () => {
    seedGatewaySupabaseMswState({ verifyApiKeyResult: null });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Not authorized' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Key-store: RPC / store error → 502
  // -----------------------------------------------------------------------

  it('should return 502 when the verify_api_key RPC errors (store unreachable)', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyError: { message: 'connection refused', code: '08006' },
    });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'service_unavailable', message: 'Authentication service error' } },
      502,
    );
    expect(next).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Key-store: unknown permission VALUES are dropped, not fatal — retiring a
  // permission is a normal vocabulary event, and a key minted before the
  // retirement must lose only that one capability, not its whole payload.
  // -----------------------------------------------------------------------

  it('authenticates a key carrying a retired permission and drops only that value', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({
        permissions: ['trace.read', 'definitely.not_a_real_permission'],
      }),
    });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_invalid',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    // The dropped-value content pin lives in verify-key.test.ts (this mock
    // context doesn't expose vars); here the contract is: NOT a 401.
  });

  // -----------------------------------------------------------------------
  // Key-store: appId mismatch → 401
  // -----------------------------------------------------------------------

  it('should return 401 when the verified key appId does not match the header appId', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-DIFFERENT' }),
    });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Not authorized' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Wire-format: `Authorization: Bearer sk_...` (production SDK behavior)
  //
  // Regression guard: the SDK sends the API key with a
  // `Bearer ` scheme prefix. `extractBearerToken` only routes JWT-shaped
  // (three dot-separated segments) tokens through the bearer path, so a
  // `Bearer sk_...` value falls through to the API-key path, where
  // `verifyKey` strips the `Bearer ` prefix before hashing. The digest the
  // RPC receives must be over the raw key ALONE — a leaked scheme prefix
  // would never match a stored digest.
  // -----------------------------------------------------------------------

  it('routes "Bearer sk_..." to the API-key path and looks up the peppered digest of the raw key', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456', appName: 'SDK App' }),
    });

    const { c, next, setSpy } = createMockHonoContext({
      headers: {
        Authorization: 'Bearer sk_outerlayer_abcdef',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    // 1. The key-store RPC was actually reached — proves the API-key path was
    //    taken (a JWT-shaped bearer would have short-circuited above).
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(1);

    // 2. The RPC received the digest of the key ALONE, not the whole
    //    Authorization value. (If the strip regressed, the digest would be
    //    over `"Bearer sk_outerlayer_abcdef"` and never match a stored digest.)
    const expectedDigest = await hashApiKey('sk_outerlayer_abcdef', PEPPER);
    expect(getGatewaySupabaseMswState().lastVerifyApiKeyDigest).toBe(expectedDigest);
    expect(getGatewaySupabaseMswState().lastVerifyApiKeyDigest).not.toContain('Bearer');

    // 3. The user was set and middleware advanced — full end-to-end success.
    expect(next).toHaveBeenCalledOnce();
    expect(setSpy).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ authMode: 'apikey', tenantId: 'tenant-456' }),
    );
  });

  it('should call next and set user when the key verifies with a matching appId', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({
        appId: 'app-123',
        tenantId: 'tenant-456',
        appName: 'Test App',
        stripeCustomerId: 'cus_test',
        stripeSubscriptionId: 'sub_test',
      }),
    });

    const { c, next, setSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(setSpy).toHaveBeenCalledWith('user', expect.objectContaining({
      tenantId: 'tenant-456',
      appName: 'Test App',
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
    }));

    // The appId should be a VerifiedAppId (branded string)
    const userArg = setSpy.mock.calls[0]?.[1];
    expect(userArg.appId).toBe('app-123');
  });

  // -----------------------------------------------------------------------
  // UserMetaSchema validation failure
  // -----------------------------------------------------------------------

  it('should return 401 when the RPC payload fails Zod validation (missing tenantId)', async () => {
    const { tenantId: _tenantId, ...withoutTenant } = validUserMeta({ appId: 'app-123' });
    seedGatewaySupabaseMswState({ verifyApiKeyResult: withoutTenant });

    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Not authorized' } },
      401,
    );
    expect(next).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Hashing throws (API_KEY_PEPPER misconfigured) → 500
  //
  // A hosted deploy missing API_KEY_PEPPER: hashApiKey throws, the catch in
  // verifyKey maps it to 500 rather than a misleading 401. The RPC is never
  // reached because hashing fails first.
  // -----------------------------------------------------------------------

  it('should return 500 when hashing throws because API_KEY_PEPPER is misconfigured', async () => {
    const { c, next, jsonSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
      envOverrides: { API_KEY_PEPPER: undefined },
    });

    await authMiddleware(c, next);

    expect(jsonSpy).toHaveBeenCalledWith(
      { error: { code: 'internal_error', message: 'Something went wrong' } },
      500,
    );
    expect(next).not.toHaveBeenCalled();
    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Cache behavior
  // -----------------------------------------------------------------------

  it('should return cached userMeta without hitting the key-store on cache hit', async () => {
    userMetaGet.mockResolvedValueOnce({
      err: null,
      val: {
        appId: 'app-123',
        tenantId: 'tenant-cached',
        appName: 'Cached App',
        stripeCustomerId: '',
        stripeSubscriptionId: '',
        branchId: '',
        permissions: [],
      },
    });

    const { c, next, setSpy } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
    expect(next).toHaveBeenCalledOnce();
    expect(setSpy).toHaveBeenCalledWith('user', expect.objectContaining({
      tenantId: 'tenant-cached',
      appName: 'Cached App',
    }));
    expect(userMetaSet).not.toHaveBeenCalled();
  });

  it('should populate the cache on successful key-store verification', async () => {
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456' }),
    });

    const { c, next } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(userMetaSet).toHaveBeenCalledTimes(1);
    const [cacheKey, cachedUser] = userMetaSet.mock.calls[0] ?? [];
    // Cache key is route-independent, but should not expose raw auth material.
    expect(cacheKey).toMatch(/^app-123-[a-f0-9]{64}$/);
    expect(cacheKey).not.toContain('sk_outerlayer_test123');
    expect(cachedUser).toMatchObject({ tenantId: 'tenant-456' });
  });

  it('should fall through to the key-store when the cache lookup returns an error', async () => {
    // Cache is a latency optimization; the key-store is authoritative.
    // A transient KV blip must not lock legitimate callers out.
    userMetaGet.mockResolvedValueOnce({ err: new Error('cache down'), val: null });
    seedGatewaySupabaseMswState({
      verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456' }),
    });

    const { c, next } = createMockHonoContext({
      headers: {
        Authorization: 'sk_outerlayer_test123',
        'X-Outerlayer-App-Id': 'app-123',
      },
    });

    await authMiddleware(c, next);

    expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(1);
    expect(next).toHaveBeenCalledOnce();
  });

  // ========================================================================
  // Bearer auth dispatch
  // ========================================================================

  // verify-bearer is unit-tested in isolation (see src/lib/verify-bearer.test.ts).
  // At the middleware layer we care about ONE thing: does an `Authorization:
  // Bearer <token>` header route into `resolveBearerUser`, and does the
  // resulting user context carry `authMode: 'bearer'` + the forwarded JWT?
  // Everything else (signature validity, expiry, role checks) is verified
  // by resolveBearerUser's own tests. For JWT-shaped bearers the key-store
  // RPC must NOT be reached (requestLog.verifyApiKey === 0).

  describe('bearer auth dispatch', () => {
    it('routes Bearer-scheme headers into resolveBearerUser, not the key-store', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-bearer',
          tenantId: 'tenant-bearer',
          appName: 'Bearer App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-bearer',
        },
      });

      await freshAuth(c as any, next);

      expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'user.jwt.here', appId: 'app-bearer' }),
      );
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({
          appId: 'app-bearer',
          tenantId: 'tenant-bearer',
          authMode: 'bearer',
          userJwt: 'the-user-jwt',
        }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('forwards the X-Tenant-Id header to resolveBearerUser as requestTenantId', async () => {
      // The dashboard sends the URL-org tenant as X-Tenant-Id on bearer
      // dispatch; the middleware must hand it to resolveBearerUser so the
      // membership-validated header can override the session claim.
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-bearer',
          tenantId: 'tenant-from-header',
          appName: 'Bearer App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-bearer',
          'X-Tenant-Id': 'tenant-from-header',
        },
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'user.jwt.here',
          appId: 'app-bearer',
          requestTenantId: 'tenant-from-header',
        }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('passes requestTenantId undefined when no X-Tenant-Id header is present', async () => {
      // No header ⇒ the middleware must not invent a tenant; resolveBearerUser
      // then keeps the claim behavior. Pins that absence stays absence.
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-bearer',
          tenantId: 'tenant-bearer',
          appName: 'Bearer App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-bearer',
        },
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ requestTenantId: undefined }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('propagates resolveBearerUser failure (401/500) to the HTTP response', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        message: 'Not authorized',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      // A JWT-shaped (three-segment) token so `extractBearerToken` routes it
      // to resolveBearerUser — whose failure must surface unchanged and NOT
      // fall through to the key-store.
      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer expired.invalid.jwt',
          'X-Outerlayer-App-Id': 'app-bearer',
        },
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'expired.invalid.jwt', appId: 'app-bearer' }),
      );
      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
      );
      expect(next).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
      expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('falls through to the key-store when the scheme is not Bearer (e.g. raw API key)', async () => {
      // Legacy API keys use the key itself as the header value with no
      // scheme prefix. Must NOT be routed through the bearer path.
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-123', tenantId: 'tenant-456', appName: 'API-key App' }),
      });

      const { c, next, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'sk_outerlayer_raw_key_no_scheme',
          'X-Outerlayer-App-Id': 'app-123',
        },
      });

      await authMiddleware(c as any, next);

      expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(1);
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({
          tenantId: 'tenant-456',
          authMode: 'apikey',
        }),
      );
      // No userJwt on the api-key path — downstream helpers know it's
      // absent when authMode === 'apikey'.
      const userArg = setSpy.mock.calls[0]?.[1] as { userJwt?: string };
      expect(userArg.userJwt).toBeUndefined();
    });

    // ========================================================================
    // Regression: JWT-shaped bearers must never fall through to the key-store
    // path.
    //
    // JWT-shaped bearers must route through `resolveBearerUser` BEFORE the
    // key-store path. `resolveBearerUser` is the ONLY path that checks
    // `app.tenant_id === jwt.app_metadata.tenant_id` and honors the caller's
    // actual role; both checks are what keep a JWT's granted permissions tied
    // to its own tenant and role rather than to the app id it names. Bearer
    // extraction is unconditional, and the ordering below locks it in
    // permanently.
    // ========================================================================

    it('routes a real JWT-shaped bearer through resolveBearerUser, never the key-store (regression)', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-bearer',
          tenantId: 'tenant-bearer',
          appName: 'Bearer App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'X-Outerlayer-App-Id': 'app-bearer',
        },
      });

      await freshAuth(c as any, next);

      // The bearer path ran — proving JWTs are tenant-validated by
      // `resolveBearerUser`. If this regressed, the key-store RPC would fire
      // and `mockResolveBearer` would never run.
      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'header.payload.signature',
          appId: 'app-bearer',
        }),
      );
      expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({
          authMode: 'bearer',
          tenantId: 'tenant-bearer',
          userJwt: 'the-user-jwt',
        }),
      );

      vi.doUnmock('../../lib/verify-bearer');
    });

    it('does not enable the app-scoped tenant fallback on a plain REST route', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-bearer',
          tenantId: 'tenant-bearer',
          appName: 'Bearer App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-bearer',
        },
        path: '/v1/traces',
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ appScopedTenantFallback: false }),
      );
      expect(next).toHaveBeenCalledOnce();
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('propagates resolveBearerUser tenant-mismatch failure, never reaching the key-store (regression)', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        message: 'Not authorized',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'X-Outerlayer-App-Id': 'foreign-tenant-app-id',
        },
      });

      await freshAuth(c as any, next);

      // The 401 surfaces and the key-store is never hit — the JWT is rejected
      // by `resolveBearerUser`'s tenant cross-check, not silently escalated.
      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
      );
      expect(getGatewaySupabaseMswState().requestLog.verifyApiKey).toBe(0);
      expect(next).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();

      vi.doUnmock('../../lib/verify-bearer');
    });
  });

  // -----------------------------------------------------------------------
  // Tenant-scoped route bypass
  //
  // POST /v1/apps and GET /v1/apps operate at the tenant level — there
  // may be no app yet (first-create from an empty dashboard) or the
  // list spans every app in the tenant. The X-Outerlayer-App-Id header
  // is OPTIONAL on these routes, and the bearer path skips the app row
  // lookup (passing `appId: null` to resolveBearerUser).
  //
  // Without this: dashboard's create-app modal sent a sentinel UUID,
  // gateway tried to resolve it to a real app row, got nothing, 401'd.
  // -----------------------------------------------------------------------

  describe('tenant-scoped routes (POST /v1/apps, GET /v1/apps)', () => {
    it.each([
      ['POST', '/v1/apps'],
      ['GET', '/v1/apps'],
    ] as const)(
      '%s %s does NOT require X-Outerlayer-App-Id when called via bearer auth',
      async (method, path) => {
        const mockResolveBearer = vi.fn().mockResolvedValue({
          ok: true,
          user: {
            // All-zero UUID sentinel — VerifiedAppId brand rejects empty
            // strings, so an all-zero UUID is the right "no scope" marker.
            // Handler reads tenantId, never appId.
            appId: '00000000-0000-0000-0000-000000000000',
            tenantId: 'tenant-bearer',
            appName: '',
            stripeCustomerId: '',
            stripeSubscriptionId: '',
            branchId: '',
            gatewayUserId: 'user-sub',
            permissions: [],
          },
          userJwt: 'the-user-jwt',
        });
        vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
          const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
          return { ...actual, resolveBearerUser: mockResolveBearer };
        });
        vi.resetModules();
        const { authMiddleware: freshAuth } = await import('../middleware');

        const { c, next, jsonSpy } = createMockHonoContext({
          headers: { Authorization: 'Bearer user.jwt.here' },
          // NO X-Outerlayer-App-Id header. This is the first-create flow.
          method,
          // The realistic shape at the `app.use('/v1/*')` layer:
          // `c.req.path` is the concrete URL pathname, `c.req.routePath`
          // is the wildcard. If isTenantScopedRoute() ever regresses to
          // reading routePath again, this test will fail because the
          // allowlist won't match.
          path,
          routePath: '/v1/*',
        });

        await freshAuth(c as any, next);

        expect(jsonSpy).not.toHaveBeenCalled();
        expect(mockResolveBearer).toHaveBeenCalledWith(
          expect.objectContaining({ appId: null }),
        );
        expect(next).toHaveBeenCalledOnce();
        vi.doUnmock('../../lib/verify-bearer');
      },
    );

    it('non-tenant-scoped routes still 401 on missing app-id header', async () => {
      // Regression guard: the tenant-scoped allowlist must not bleed
      // into other routes. POST /v1/apps/:appId/something arbitrary
      // should still require the header.
      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer some.jwt.here' },
        method: 'GET',
        path: '/v1/traces',
        routePath: '/v1/*',
      });

      await authMiddleware(c as any, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Missing app id' } },
        401,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('POST /v1/apps/ (with trailing slash) is still tenant-scoped', async () => {
      // Hono normalizes trailing slashes at routing time, but
      // `c.req.path` returns the raw pathname. The allowlist normalizes
      // by stripping the trailing slash. Without that normalization,
      // a curl that includes a stray slash would 401.
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: '00000000-0000-0000-0000-000000000000',
          tenantId: 'tenant-bearer',
          appName: '',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer user.jwt.here' },
        method: 'POST',
        path: '/v1/apps/',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(jsonSpy).not.toHaveBeenCalled();
      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ appId: null }),
      );
      expect(next).toHaveBeenCalledOnce();
      vi.doUnmock('../../lib/verify-bearer');
    });
  });

  // ========================================================================
  // /v1/mcp: optional X-Outerlayer-App-Id for API-key auth (group 8)
  //
  // A key is bound to exactly one app, so with no header the resolver
  // derives the app from the resolved key row itself instead of
  // cross-checking it against a header. Bearer-JWT auth on /v1/mcp is
  // unaffected — JWTs are tenant-scoped, not app-bound, so the header
  // stays required there.
  // ========================================================================

  describe('/v1/mcp (optional X-Outerlayer-App-Id for API-key auth)', () => {
    it('derives the app from the resolved key when the header is absent', async () => {
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-from-key', tenantId: 'tenant-from-key' }),
      });

      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: { Authorization: 'sk_outerlayer_mcp_key' },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith('user', expect.objectContaining({
        appId: 'app-from-key',
        tenantId: 'tenant-from-key',
        authMode: 'apikey',
      }));
    });

    // proves AC-052-11
    it('rejects a header naming a different app than the resolved key, never scoping to it', async () => {
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-real', tenantId: 'tenant-real' }),
      });

      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'sk_outerlayer_mcp_key',
          'X-Outerlayer-App-Id': 'app-forged',
        },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
        { 'WWW-Authenticate': 'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"' },
      );
      expect(next).not.toHaveBeenCalled();
      // Auth was rejected before c.set('user', ...) ever ran — a forged
      // header can't influence scope because there is no resolved identity
      // to influence.
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('the WWW-Authenticate resource_metadata URL is https behind a TLS-terminating proxy that sends X-Forwarded-Proto: https', async () => {
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-real', tenantId: 'tenant-real' }),
      });

      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'sk_outerlayer_mcp_key',
          'X-Outerlayer-App-Id': 'app-forged',
          'X-Forwarded-Proto': 'https',
        },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
        { 'WWW-Authenticate': 'Bearer resource_metadata="https://localhost/.well-known/oauth-protected-resource"' },
      );
      expect(next).not.toHaveBeenCalled();
      // Auth was rejected before c.set('user', ...) ever ran — a forged
      // header can't influence scope because there is no resolved identity
      // for it to influence.
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('still honors a matching header, resolving to the same app it names', async () => {
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-match', tenantId: 'tenant-match' }),
      });

      const { c, next, jsonSpy, setSpy } = createMockHonoContext({
        headers: {
          Authorization: 'sk_outerlayer_mcp_key',
          'X-Outerlayer-App-Id': 'app-match',
        },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith('user', expect.objectContaining({
        appId: 'app-match',
        authMode: 'apikey',
      }));
    });

    it('populates the cache keyed on the resolved app id, not a null, when derived', async () => {
      seedGatewaySupabaseMswState({
        verifyApiKeyResult: validUserMeta({ appId: 'app-derived', tenantId: 'tenant-derived' }),
      });

      const { c, next } = createMockHonoContext({
        headers: { Authorization: 'sk_outerlayer_mcp_key' },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(next).toHaveBeenCalledOnce();
      expect(userMetaSet).toHaveBeenCalledTimes(1);
      const [cacheKey, cachedUser] = userMetaSet.mock.calls[0] ?? [];
      expect(cacheKey).toMatch(/^app-derived-[a-f0-9]{64}$/);
      expect(cachedUser).toMatchObject({ appId: 'app-derived', tenantId: 'tenant-derived' });
    });

    it('leaves the bearer-JWT header requirement on /v1/mcp unchanged (still 401 without it)', async () => {
      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer header.payload.signature' },
        // No X-Outerlayer-App-Id — a bearer JWT still requires it on
        // /v1/mcp; only API-key auth gets the relaxation.
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c as any, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Missing app id' } },
        401,
        { 'WWW-Authenticate': 'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"' },
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('does not relax the header requirement for other routes (regression guard)', async () => {
      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'sk_outerlayer_other_route' },
        method: 'GET',
        path: '/v1/traces',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Missing app id' } },
        401,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('does not enable the app-scoped tenant fallback on /v1/mcp bearer auth', async () => {
      // Bearer auth on /v1/mcp still requires the X-Outerlayer-App-Id
      // header (JWTs are tenant-scoped, not app-bound); with it present,
      // resolveBearerUser must be called with the fallback OFF — only the
      // per-app mount enables it.
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-mcp-header',
          tenantId: 'tenant-mcp-header',
          appName: 'MCP App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-mcp-header',
        },
        method: 'POST',
        path: '/v1/mcp',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ appScopedTenantFallback: false }),
      );
      expect(next).toHaveBeenCalledOnce();
      vi.doUnmock('../../lib/verify-bearer');
    });
  });

  // ========================================================================
  // POST /v1/apps/:appId/mcp — per-app MCP mount for OAuth-connected
  // clients (group 13). Bearer-only; the app id comes from the path.
  // ========================================================================
  describe('/v1/apps/:appId/mcp (per-app MCP mount)', () => {
    it('resolves the app id from the path, not a header, and allows connector tokens', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-from-path',
          tenantId: 'tenant-from-path',
          appName: 'Path App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, setSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer user.jwt.here' },
        method: 'POST',
        path: '/v1/apps/app-from-path/mcp',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'user.jwt.here',
          appId: 'app-from-path',
          allowConnectorToken: true,
        }),
      );
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({ appId: 'app-from-path', authMode: 'bearer' }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('ignores an X-Outerlayer-App-Id header — the path segment is authoritative', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-from-path',
          tenantId: 'tenant-from-path',
          appName: 'Path App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next } = createMockHonoContext({
        headers: {
          Authorization: 'Bearer user.jwt.here',
          'X-Outerlayer-App-Id': 'app-header-lies',
        },
        method: 'POST',
        path: '/v1/apps/app-from-path/mcp',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-from-path' }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('rejects an API key on the per-app mount (bearer-only) with the RFC 9728 challenge', async () => {
      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'sk_outerlayer_some_key' },
        method: 'POST',
        path: '/v1/apps/app-from-path/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        {
          error: {
            code: 'unauthorized',
            message: 'This endpoint requires a user or OAuth bearer token; API keys use /v1/mcp.',
          },
        },
        401,
        {
          'WWW-Authenticate':
            'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/v1/apps/app-from-path/mcp"',
        },
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('401s with the RFC 9728 challenge when the auth header is missing entirely', async () => {
      const { c, next, jsonSpy } = createMockHonoContext({
        method: 'POST',
        path: '/v1/apps/app-from-path/mcp',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Missing auth header' } },
        401,
        {
          'WWW-Authenticate':
            'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/v1/apps/app-from-path/mcp"',
        },
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('propagates resolveBearerUser rejection (e.g. app outside the caller\'s tenant)', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        message: 'Not authorized',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer user.jwt.here' },
        method: 'POST',
        path: '/v1/apps/some-other-app/mcp',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Not authorized' } },
        401,
        {
          'WWW-Authenticate':
            'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/v1/apps/some-other-app/mcp"',
        },
      );
      expect(next).not.toHaveBeenCalled();
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('enables the app-scoped tenant fallback so a bearer-only connector token resolves', async () => {
      const mockResolveBearer = vi.fn().mockResolvedValue({
        ok: true,
        user: {
          appId: 'app-from-path',
          tenantId: 'tenant-from-path',
          appName: 'Path App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          gatewayUserId: 'user-sub',
          permissions: [],
        },
        userJwt: 'the-user-jwt',
      });
      vi.doMock('../../lib/verify-bearer', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../lib/verify-bearer')>();
        return { ...actual, resolveBearerUser: mockResolveBearer };
      });
      vi.resetModules();
      const { authMiddleware: freshAuth } = await import('../middleware');

      const { c, next, setSpy } = createMockHonoContext({
        headers: { Authorization: 'Bearer user.jwt.here' },
        method: 'POST',
        path: '/v1/apps/app-from-path/mcp',
        routePath: '/v1/*',
      });

      await freshAuth(c as any, next);

      expect(mockResolveBearer).toHaveBeenCalledWith(
        expect.objectContaining({ appId: 'app-from-path', appScopedTenantFallback: true }),
      );
      expect(next).toHaveBeenCalledOnce();
      expect(setSpy).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({ tenantId: 'tenant-from-path', authMode: 'bearer' }),
      );
      vi.doUnmock('../../lib/verify-bearer');
    });

    it('does not treat /v1/apps/:appId (no /mcp suffix) as the per-app MCP mount', async () => {
      // Regression guard: the plain apps CRUD surface must keep requiring
      // the header exactly as before — the /mcp-suffix regex must not
      // over-match.
      const { c, next, jsonSpy } = createMockHonoContext({
        headers: { Authorization: 'sk_outerlayer_some_key' },
        method: 'GET',
        path: '/v1/apps/app-from-path',
        routePath: '/v1/*',
      });

      await authMiddleware(c, next);

      expect(jsonSpy).toHaveBeenCalledWith(
        { error: { code: 'unauthorized', message: 'Missing app id' } },
        401,
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});
