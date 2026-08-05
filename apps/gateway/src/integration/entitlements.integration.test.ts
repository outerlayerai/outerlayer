/**
 * Tier entitlement enforcement tests for the gateway.
 *
 * The override → tier → hobby-default resolution semantics are pinned
 * in `@repo/entitlements/src/resolver.test.ts` — that's the one place
 * the rules live. This file covers what the gateway adds on top:
 *
 *   - Wrapper integration: env → createSystemAdminClient → shared
 *     resolver works end-to-end through MSW (two sanity tests).
 *   - Middleware envelope: `enforceEntitlement` / `enforceQuota` map
 *     the resolved value to the right HTTP response (200/402/401/500)
 *     with the right error body shape.
 *
 * Supabase is mocked at the HTTP layer via MSW (see
 * `test-helpers/msw-handlers/supabase.ts`) — same pattern as
 * verify-key.test.ts. State is seeded per-test through
 * `seedGatewaySupabaseMswState` and reset by the unit-test setup
 * between tests. The only seam that doesn't go through MSW is the
 * "createSystemAdminClient throws" path below — that exercises the
 * middleware's catch block, which by construction never reaches HTTP.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@repo/gateway-core/types';
import {
  seedGatewaySupabaseMswState,
} from '../test-helpers/msw-handlers';

// Sentry would otherwise be reachable through `LoggerService.error()` in
// production code paths. We stub it so tests don't emit real captures.
// (logger.test.ts uses the same pattern.)
vi.mock('@sentry/cloudflare', () => ({
  setContext: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
}));

// Single seam: make `createSystemAdminClient` throw on demand so we
// can exercise the middleware's catch block. Both `enforceEntitlement`
// and `enforceQuota` build their Supabase client through this helper,
// so this is the only mock we need to test the error paths.
//
// Also spy on every call so the auth-mode-independence contract tests
// can assert the middleware reaches for the admin client (and not a
// scoped one) regardless of `user.authMode`. A future refactor that
// dispatches on authMode to a tenant-scoped client would break the
// dashboard's bearer-auth path — these tests pin the invariant.
const adminClientShouldThrow = { value: false };
const adminClientCalls: Array<{ env: Env }> = [];

vi.mock('@repo/gateway-core/lib/system-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/gateway-core/lib/system-client')>();
  return {
    ...actual,
    createSystemAdminClient: (env: Env) => {
      adminClientCalls.push({ env });
      if (adminClientShouldThrow.value) {
        throw new Error('synthetic supabase outage');
      }
      return actual.createSystemAdminClient(env);
    },
  };
});

// Second seam: make `resolveNumericLimit` from `@repo/entitlements`
// reject on demand. enforceQuota runs the limit resolver and the count
// fetcher via Promise.allSettled and emits a different `source:` log
// field per rejection. Triggering each separately is the only way to
// exercise both branches without simulating supabase-js internals.
const limitResolverShouldThrow = { value: false };

vi.mock('@repo/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/entitlements')>();
  return {
    ...actual,
    resolveNumericLimit: async (
      ...args: Parameters<typeof actual.resolveNumericLimit>
    ) => {
      if (limitResolverShouldThrow.value) {
        throw new Error('synthetic limit-resolver failure');
      }
      return actual.resolveNumericLimit(...args);
    },
  };
});

import { LoggerService } from '../services/logger';
import { buildGatewayContext } from '../runtime/cloudflare-context';
import type { ExecutionContext } from '@cloudflare/workers-types';

import {
  resolveBooleanEntitlement,
  resolveNumericLimit,
  enforceEntitlement,
  enforceQuota,
  type GatewayEntitlement,
} from '@repo/gateway-core/lib/entitlements';

const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY: GatewayEntitlement = 'workers_enabled';

function makeEnv(): Env {
  return {
    NODE_ENV: 'production',
    SUPABASE_API_BASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'service-role',
  } as Env;
}

// Re-set the throw flags + call log before each test. The MSW unit-test
// setup already resets seeded state via `resetMswState`, but doesn't
// know about these per-file structures.
beforeEach(() => {
  adminClientShouldThrow.value = false;
  limitResolverShouldThrow.value = false;
  adminClientCalls.length = 0;
});

// ===========================================================================
// Wrapper integration — env → createSystemAdminClient → @repo/entitlements
//
// The resolution rules (override → tier → hobby default, type-coercion
// guards, etc.) are pinned in @repo/entitlements. These two tests just
// prove the gateway's env-based wrapper plugs into the shared resolver
// correctly through MSW.
// ===========================================================================

describe('resolveBooleanEntitlement (gateway wrapper)', () => {
  it('returns the entitled value through the env → shared-resolver chain', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });
    expect(await resolveBooleanEntitlement(makeEnv(), TENANT, KEY)).toBe(true);
  });

  it('honours an explicit override over the tier matrix', async () => {
    seedGatewaySupabaseMswState({
      entitlementOverrides: [
        { tenant_id: TENANT, entitlement_key: KEY, value: { v: false } },
      ],
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });
    expect(await resolveBooleanEntitlement(makeEnv(), TENANT, KEY)).toBe(false);
  });
});

// ===========================================================================
// enforceEntitlement middleware
// ===========================================================================

type AuthMode = 'apikey' | 'bearer';

interface FakeUser {
  tenantId: string;
  appId?: string;
  authMode?: AuthMode;
  userJwt?: string;
  gatewayUserId?: string;
  permissions?: readonly string[];
}

function fakeContext(user: FakeUser | null) {
  const captured: { body?: unknown; status?: number } = {};
  // Track `executionCtx.waitUntil` so tests can verify that
  // `flushLogger` actually schedules the Logtail drain. Without this,
  // the test coverage of "logs land in production" would be zero —
  // the entitlement system is the billing-funnel measurement
  // instrument and we can't ship it blind.
  const waitUntil = vi.fn();
  const env = makeEnv();
  // buildLogger now reads c.get('gtx').logger; gtx.logger is a WorkerLogger
  // bound to this executionCtx, so it still constructs a LoggerService that
  // schedules Logtail flush via waitUntil (spied on below).
  const gtx = buildGatewayContext(env, { waitUntil } as unknown as ExecutionContext);
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'gtx'
        ? gtx
        : k === 'user' && user
        ? {
            tenantId: user.tenantId,
            appId: user.appId,
            authMode: user.authMode ?? 'apikey',
            userJwt: user.userJwt,
            gatewayUserId: user.gatewayUserId,
            permissions: user.permissions ?? [],
          }
        : undefined,
    ),
    env,
    executionCtx: { waitUntil },
    json: vi.fn((body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status ?? 200;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
  };
  return { ctx, captured, waitUntil };
}

describe('enforceEntitlement', () => {
  it('calls next() and never responds when tenant is entitled', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });

    const { ctx } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    const result = await enforceEntitlement(KEY)(ctx as unknown as Context, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it('returns 402 entitlement_required when the tenant lacks the feature', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });

    const { ctx, captured, waitUntil } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    await enforceEntitlement(KEY)(ctx as unknown as Context, next);

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(402);
    const body = captured.body as {
      error: { code: string; entitlement: string; message: string };
    };
    expect(body.error.code).toBe('entitlement_required');
    expect(body.error.entitlement).toBe(KEY);
    expect(body.error.message).toContain('workers_enabled');
    // `entitlement_denied` is the billing-funnel event. The middleware
    // must schedule a Logtail flush via `executionCtx.waitUntil` or the
    // Worker terminates with the buffer still full and we lose the
    // signal. Without this assertion the observability is a fiction.
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('returns 401 when the user context is missing (auth chain misconfigured)', async () => {
    const { ctx, captured } = fakeContext(null);
    const next: Next = vi.fn(async () => undefined);
    await enforceEntitlement(KEY)(ctx as unknown as Context, next);

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(401);
  });

  it('fails closed to 402 when both Supabase reads return .error', async () => {
    // PostgREST returns errors in `.error` on the response object — they
    // don't throw. Override-error falls through to the tier lookup;
    // billing-error falls through to the hobby default. Both failing
    // means we resolve as hobby, which for workers_enabled is false → 402.
    // That's the "fail closed" behaviour the cron + dashboard also have.
    // The true throw path is exercised in the next test.
    seedGatewaySupabaseMswState({
      tableErrors: {
        tenant_entitlement_override: { message: 'transient pg error' },
        billing: { message: 'connection reset' },
      },
    });

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    await enforceEntitlement(KEY)(ctx as unknown as Context, next);

    expect(captured.status).toBe(402);
  });

  it('returns 500 internal_error when the admin client fails to construct', async () => {
    // Malformed env, JWT-secret missing, etc. — the middleware's
    // try/catch exists for this path. Must surface a real 500, not a
    // silent 402, so on-call wakes up rather than a paying customer
    // being miscategorised as "tier limit".
    adminClientShouldThrow.value = true;

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    await enforceEntitlement(KEY)(ctx as unknown as Context, next);

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(500);
    const body = captured.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
  });
});

// ===========================================================================
// resolveNumericLimit — quota counterpart to resolveBooleanEntitlement
// ===========================================================================

describe('resolveNumericLimit', () => {
  it('returns the numeric override when present', async () => {
    // Numeric overrides win over the tier matrix — same semantics as
    // the boolean resolver.
    seedGatewaySupabaseMswState({
      entitlementOverrides: [
        {
          tenant_id: TENANT,
          entitlement_key: 'max_api_keys',
          value: { v: 5 },
        },
      ],
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });
    expect(await resolveNumericLimit(makeEnv(), TENANT, 'max_api_keys')).toBe(5);
  });

  it('returns the tier-matrix value when no override exists', async () => {
    // Hobby max_api_keys = 25 (see packages/tier-config/tiers.json).
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });
    expect(await resolveNumericLimit(makeEnv(), TENANT, 'max_api_keys')).toBe(25);
  });

  it('returns -1 (UNLIMITED) for team tier', async () => {
    // Team max_api_keys = -1 in tiers.json.
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });
    expect(await resolveNumericLimit(makeEnv(), TENANT, 'max_api_keys')).toBe(-1);
  });

  it('defaults to hobby (25) when no billing row exists', async () => {
    expect(await resolveNumericLimit(makeEnv(), TENANT, 'max_api_keys')).toBe(25);
  });

  it('ignores boolean override values', async () => {
    // The dual-typed override schema permits booleans. Numeric keys must
    // ignore them — coercing `true` → 1 would silently shrink the quota.
    seedGatewaySupabaseMswState({
      entitlementOverrides: [
        {
          tenant_id: TENANT,
          entitlement_key: 'max_api_keys',
          value: { v: true },
        },
      ],
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });
    expect(await resolveNumericLimit(makeEnv(), TENANT, 'max_api_keys')).toBe(-1);
  });
});

// ===========================================================================
// enforceQuota middleware
// ===========================================================================

describe('enforceQuota', () => {
  it('calls next() when current count is below the limit', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });

    const { ctx } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    // Count fetcher now receives a scoped Supabase client (not env) —
    // RLS handles the tenant filter so the fetcher body never needs to
    // re-assert it. Tests only care that the right number comes out.
    const getCurrentCount = vi.fn(async () => 24);
    const next: Next = vi.fn(async () => undefined);

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it('returns 402 entitlement_required when at the limit', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const getCurrentCount = vi.fn(async () => 25);
    const next: Next = vi.fn(async () => undefined);

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(402);
    const body = captured.body as {
      error: { code: string; entitlement: string; limit: number; current: number };
    };
    expect(body.error.code).toBe('entitlement_required');
    expect(body.error.entitlement).toBe('max_api_keys');
    expect(body.error.limit).toBe(25);
    expect(body.error.current).toBe(25);
  });

  it('skips the count comparison when the tier is UNLIMITED', async () => {
    // Critical: `count >= -1` is always true. The middleware must
    // short-circuit on UNLIMITED before comparing, otherwise enterprise
    // tenants would see 402 every time.
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'team' }],
    });

    const { ctx } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    // Synthetic huge count — should still be allowed because limit is -1.
    const getCurrentCount = vi.fn(async () => 9_999_999);
    const next: Next = vi.fn(async () => undefined);

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 500 internal_error when the count fetcher throws', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const getCurrentCount = vi.fn(async () => {
      throw new Error('count query failed');
    });
    const next: Next = vi.fn(async () => undefined);

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(500);
    const body = captured.body as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 401 when user context is missing', async () => {
    const { ctx, captured } = fakeContext(null);
    const getCurrentCount = vi.fn(async () => 0);
    const next: Next = vi.fn(async () => undefined);

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(getCurrentCount).not.toHaveBeenCalled();
    expect(captured.status).toBe(401);
  });

  it('returns 500 with source=admin_client when supabase client construction throws', async () => {
    // enforceQuota constructs the admin client in its own try/catch so a
    // construction failure (malformed env, bad JWT secret, etc.) lands
    // in a different error-attribution branch than the limit/count
    // resolvers. On-call needs the `source:` field to tell them which
    // half of the gate broke — this test pins that the admin-client
    // branch logs `source: 'admin_client'` (and not the misleading
    // `limit_resolver` or `count_fetcher` labels that come later).
    adminClientShouldThrow.value = true;
    const errorSpy = vi.spyOn(LoggerService.prototype, 'error');

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    const getCurrentCount = vi.fn(async () => 0);
    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: 'quota_error',
        source: 'admin_client',
        key: 'max_api_keys',
      }),
    );
    // Count fetcher must NOT run if the supabase client never came up —
    // calling it without a client would crash in a different way.
    expect(getCurrentCount).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('wraps non-Error rejection reasons before passing to logger', async () => {
    // JS code (or transitive deps) sometimes throws strings instead of
    // Error objects. The middleware's `toError` helper has to wrap
    // those — otherwise Sentry sees `undefined` as the exception name
    // and the entry is useless. This test exercises the
    // `!(instanceof Error)` branch of the helper.
    const errorSpy = vi.spyOn(LoggerService.prototype, 'error');

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
     
    const getCurrentCount = vi.fn(async () => { throw 'string rejection'; });
    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(captured.status).toBe(500);
    // The first arg passed to logger.error should be a real Error
    // wrapping the original string reason.
    const firstCall = errorSpy.mock.calls[0];
    expect(firstCall?.[0]).toBeInstanceOf(Error);
    expect((firstCall?.[0] as Error).message).toBe('string rejection');
    errorSpy.mockRestore();
  });

  it('returns 500 with source=limit_resolver when the shared resolver rejects but count succeeds', async () => {
    // Promise.allSettled distinguishes which side of the pair failed.
    // Without this test, a resolver-side breakage (e.g. tier-config
    // dropped a key) would be misattributed as `count_fetcher` by
    // on-call and the wrong runbook would get pulled.
    limitResolverShouldThrow.value = true;
    const errorSpy = vi.spyOn(LoggerService.prototype, 'error');

    const { ctx, captured } = fakeContext({ tenantId: TENANT, appId: 'app-1' });
    const next: Next = vi.fn(async () => undefined);
    const getCurrentCount = vi.fn(async () => 5); // succeeds
    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
      ctx as unknown as Context,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(500);
    expect(getCurrentCount).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: 'quota_error',
        source: 'limit_resolver',
        key: 'max_api_keys',
      }),
    );
    errorSpy.mockRestore();
  });
});

// ===========================================================================
// flushLogger on a runtime without a real ExecutionContext
//
// Cloudflare populates `c.executionCtx` so logs flush via `waitUntil` without
// blocking the response. Other runtimes (queue handlers via a different path,
// @hono/node-server, the OSS CLI dev server) don't — and Hono's getter THROWS
// there rather than returning undefined. The guards therefore route through
// `gtx.waitUntil`, and the entrypoint's gtx middleware supplies a no-op
// `waitUntil` shim in that case. flushLogger must NOT throw and the response
// must still complete.
// ===========================================================================

describe('flushLogger on a runtime with only a no-op waitUntil shim', () => {
  it('does not throw and the deny path still returns 402', async () => {
    seedGatewaySupabaseMswState({
      billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
    });

    const captured: { body?: unknown; status?: number } = {};
    const env = makeEnv();
    // The shim the gtx middleware injects when c.executionCtx throws (Node):
    // a no-op waitUntil. gtx.waitUntil is wired to it, so flushLogger is safe.
    const shimExecCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const gtx = buildGatewayContext(env, shimExecCtx);
    const ctx = {
      get: vi.fn((k: string) =>
        k === 'gtx'
          ? gtx
          : {
              tenantId: TENANT,
              appId: 'app-1',
              authMode: 'apikey',
              permissions: [],
            },
      ),
      env,
      // No raw executionCtx — the guard must never read it (it would throw).
      get executionCtx(): never {
        throw new Error('no execution context (Node runtime)');
      },
      json: vi.fn((body: unknown, status?: number) => {
        captured.body = body;
        captured.status = status ?? 200;
        return new Response(JSON.stringify(body), { status: status ?? 200 });
      }),
    };
    const next: Next = vi.fn(async () => undefined);

    await expect(
      enforceEntitlement(KEY)(ctx as unknown as Context, next),
    ).resolves.toBeInstanceOf(Response);
    expect(captured.status).toBe(402);
  });
});

// ===========================================================================
// Auth-mode independence contract
//
// The dashboard reaches /v1/* via bearer JWT — the user's Supabase session
// token. The gateway also accepts api-key auth. Both modes MUST land at the
// same entitlement outcome for the same tenant, because the middleware uses
// the service-role admin client (which bypasses RLS) plus the explicit
// `.eq('tenant_id', tenantId)` filter in the shared resolver.
//
// If a future refactor reintroduces a tenant-scoped client here, the
// bearer-auth path will break: the authenticated-role RLS on `billing`
// requires `billing.read` permission which a regular user hitting a gated
// endpoint almost certainly doesn't have. The reads would return zero
// rows, the resolver would fall back to `hobby`, and paying customers
// would be miscategorised as `entitlement_required`.
//
// These tests pin the contract: gate behaviour is independent of
// `user.authMode`.
// ===========================================================================

describe('auth-mode independence', () => {
  it.each([
    ['apikey' as const, 'team' as const, 'allows'],
    ['bearer' as const, 'team' as const, 'allows'],
    ['apikey' as const, 'hobby' as const, 'denies'],
    ['bearer' as const, 'hobby' as const, 'denies'],
  ])(
    'enforceEntitlement %s on %s tier %s the request (same as the other auth mode)',
    async (authMode, tier, outcome) => {
      seedGatewaySupabaseMswState({
        billings: [{ tenant_id: TENANT, tier_id: tier }],
      });

      const { ctx, captured } = fakeContext({
        tenantId: TENANT,
        appId: 'app-1',
        authMode,
        ...(authMode === 'bearer'
          ? { userJwt: 'fake-bearer-jwt' }
          : { gatewayUserId: 'gw-user-1', permissions: ['app.insert'] }),
      });
      const next: Next = vi.fn(async () => undefined);
      await enforceEntitlement(KEY)(ctx as unknown as Context, next);

      // Hard contract: middleware MUST construct the admin client.
      // A future refactor that calls `getScopedSupabase` (which
      // dispatches on authMode and lands in an authenticated-role
      // client for bearer users) would silently break the dashboard
      // because the authenticated-role RLS on `billing` requires
      // `billing.read`. This assertion catches that even though MSW
      // can't simulate RLS.
      expect(adminClientCalls.length).toBeGreaterThanOrEqual(1);

      if (outcome === 'allows') {
        expect(next).toHaveBeenCalledOnce();
        expect(ctx.json).not.toHaveBeenCalled();
      } else {
        expect(next).not.toHaveBeenCalled();
        expect(captured.status).toBe(402);
        const body = captured.body as { error: { code: string } };
        expect(body.error.code).toBe('entitlement_required');
      }
    },
  );

  it.each([
    ['apikey' as const, 24, 'allows'],
    ['bearer' as const, 24, 'allows'],
    ['apikey' as const, 25, 'denies'],
    ['bearer' as const, 25, 'denies'],
  ])(
    'enforceQuota %s at count %s %s the request (same as the other auth mode)',
    async (authMode, currentCount, outcome) => {
      // hobby max_api_keys = 25. Count 24 → allowed, 25 → denied.
      seedGatewaySupabaseMswState({
        billings: [{ tenant_id: TENANT, tier_id: 'hobby' }],
      });

      const { ctx, captured } = fakeContext({
        tenantId: TENANT,
        appId: 'app-1',
        authMode,
        ...(authMode === 'bearer'
          ? { userJwt: 'fake-bearer-jwt' }
          : { gatewayUserId: 'gw-user-1', permissions: ['api_key.insert'] }),
      });
      const next: Next = vi.fn(async () => undefined);
      const getCurrentCount = vi.fn(async () => currentCount);

      await enforceQuota({ key: 'max_api_keys', getCurrentCount })(
        ctx as unknown as Context,
        next,
      );

      // Same hard contract as enforceEntitlement: admin client only.
      expect(adminClientCalls.length).toBeGreaterThanOrEqual(1);
      // The count fetcher MUST be called regardless of auth mode —
      // if a future refactor dispatches on authMode and skips the
      // count for bearer, this fails.
      expect(getCurrentCount).toHaveBeenCalledOnce();

      if (outcome === 'allows') {
        expect(next).toHaveBeenCalledOnce();
      } else {
        expect(next).not.toHaveBeenCalled();
        expect(captured.status).toBe(402);
      }
    },
  );
});
