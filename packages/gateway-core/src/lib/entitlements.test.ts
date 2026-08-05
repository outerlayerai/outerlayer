import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import { UNLIMITED } from '@repo/tier-config';
import {
  enforceEntitlement,
  enforceQuota,
  isSelfHostGateway,
  resolveBooleanEntitlement,
  resolveNumericLimit,
  buildEnvLimitCheck,
} from './entitlements';
import type { Env } from '../types';

// Every self-host assertion below leans on this: if any self-host path tries
// to build a billing client, the mock throws and the test fails loudly. The
// pre-existing no-user tests never reach the client, so they're unaffected.
vi.mock('./system-client', () => ({
  createSystemAdminClient: vi.fn(() => {
    throw new Error('createSystemAdminClient must not be called on the self-host path');
  }),
}));

/**
 * Focused unit coverage for the entitlement middlewares' defensive
 * "no authenticated user on context" branch — the path that exercises the
 * injected `gtx.logger` bridge (`buildLogger`) and `flushLogger` without
 * touching Supabase. Auth middleware should always populate `user`; if it
 * doesn't, the guard must fail closed with 401 and NOT call `next()`, and it
 * must emit the misconfiguration event through the injected logger so the gap
 * is observable rather than silent.
 */
function makeContext(opts: { user?: unknown; env?: Record<string, string | undefined> } = {}) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
  const createLogger = vi.fn(() => logger);
  const waitUntil = vi.fn();
  const json = vi.fn((body: unknown, status: number) => ({ body, status }));
  const store: Record<string, unknown> = {
    user: opts.user, // defaults to undefined — the misconfiguration under test
    gtx: { logger: { createLogger }, waitUntil },
  };
  const c = {
    get: (key: string) => store[key],
    env: opts.env ?? {},
    // Simulate @hono/node-server: the getter THROWS. The guards must background
    // their log flush via gtx.waitUntil and never read raw c.executionCtx.
    get executionCtx(): never {
      throw new Error('no execution context (Node runtime)');
    },
    json,
  } as unknown as Context;
  return { c, logger, createLogger, waitUntil, json };
}

describe('entitlement middlewares — no user on context', () => {
  it('enforceEntitlement fails closed to 401, logs the misconfig, and never calls next()', async () => {
    const { c, logger, createLogger, waitUntil, json } = makeContext();
    const next = vi.fn();

    const result = await enforceEntitlement('workers_enabled')(c, next);

    expect(createLogger).toHaveBeenCalledWith({
      tenantId: undefined,
      appId: undefined,
      source: 'gateway-entitlements',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'entitlement guard reached with no user on context',
      { event: 'entitlement_auth_misconfigured', key: 'workers_enabled' },
    );
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Not authorized' } },
      401,
    );
    expect(result).toEqual({
      body: { error: { code: 'unauthorized', message: 'Not authorized' } },
      status: 401,
    });
  });

  it('enforceQuota fails closed to 401 for the same missing-user misconfig', async () => {
    const { c, logger, json } = makeContext();
    const next = vi.fn();

    await enforceQuota({ key: 'max_api_keys', getCurrentCount: vi.fn() })(c, next);

    expect(logger.warn).toHaveBeenCalledWith(
      'quota guard reached with no user on context',
      { event: 'quota_auth_misconfigured', key: 'max_api_keys' },
    );
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      { error: { code: 'unauthorized', message: 'Not authorized' } },
      401,
    );
  });
});

// ---------------------------------------------------------------------------
// Self-host resolution.
//
// With OUTERLAYER_SELF_HOSTED='true', every gateway entitlement surface must
// resolve WITHOUT touching billing: the system-client mock above throws on
// contact, so any billing read fails these tests loudly. With the flag
// unset (or wrong-cased), the Cloud path must be entered — asserted via the
// same throwing mock surfacing as the resolver's infra-failure handling.
// ---------------------------------------------------------------------------

const SELF_HOST_ENV = { OUTERLAYER_SELF_HOSTED: 'true' } as unknown as Env;
const USER = { tenantId: 't-selfhost', appId: 'app-1' };

describe('self-host mode — helper', () => {
  it('isSelfHostGateway accepts only the exact string "true"', () => {
    expect(isSelfHostGateway({ OUTERLAYER_SELF_HOSTED: 'true' })).toBe(true);
    expect(isSelfHostGateway({ OUTERLAYER_SELF_HOSTED: 'TRUE' })).toBe(false);
    expect(isSelfHostGateway({ OUTERLAYER_SELF_HOSTED: '1' })).toBe(false);
    expect(isSelfHostGateway({ OUTERLAYER_SELF_HOSTED: undefined })).toBe(false);
  });
});

describe('self-host mode — out-of-context resolvers', () => {
  it('resolveBooleanEntitlement returns true for both gateway keys without a billing read', async () => {
    expect(await resolveBooleanEntitlement(SELF_HOST_ENV, 't1', 'workers_enabled')).toBe(true);
    expect(await resolveBooleanEntitlement(SELF_HOST_ENV, 't1', 'workers_enabled')).toBe(true);
  });

  it('keeps an EE key fail-closed: unlicensed self-host resolves it false', async () => {
    // No EE key exists in GatewayEntitlement today — this pins the seam so
    // the first one added stays OFF until gateway license resolution is
    // wired (see the `licensed: false` note in entitlements.ts).
    const eeKey = 'custom_roles' as Parameters<typeof resolveBooleanEntitlement>[2];
    expect(await resolveBooleanEntitlement(SELF_HOST_ENV, 't1', eeKey)).toBe(false);
  });

  it('resolveNumericLimit returns the UNLIMITED sentinel without a billing read', async () => {
    expect(await resolveNumericLimit(SELF_HOST_ENV, 't1', 'max_api_keys')).toBe(UNLIMITED);
    expect(await resolveNumericLimit(SELF_HOST_ENV, 't1', 'max_apps')).toBe(UNLIMITED);
    expect(await resolveNumericLimit(SELF_HOST_ENV, 't1', 'max_environments_per_app')).toBe(UNLIMITED);
  });

  it('buildEnvLimitCheck allows any count with the self-hosted tier label, no reads', async () => {
    const check = buildEnvLimitCheck(SELF_HOST_ENV);
    expect(await check({ tenantId: 't1', currentCount: 10_000 })).toEqual({
      allowed: true,
      limit: UNLIMITED,
      tierName: 'self-hosted',
    });
  });

  it('cloud path is entered when the flag is unset: the resolvers reach for the billing client', async () => {
    const cloudEnv = {} as unknown as Env;
    await expect(resolveBooleanEntitlement(cloudEnv, 't1', 'workers_enabled')).rejects.toThrow(
      'createSystemAdminClient must not be called on the self-host path',
    );
    await expect(resolveNumericLimit(cloudEnv, 't1', 'max_api_keys')).rejects.toThrow(
      'createSystemAdminClient must not be called on the self-host path',
    );
  });
});

describe('self-host mode — middlewares', () => {
  it('enforceEntitlement calls next() for both gateway keys with no billing read and no denial', async () => {
    for (const key of ['workers_enabled', 'persistent_worker_environments'] as const) {
      const { c, json } = makeContext({ user: USER, env: { OUTERLAYER_SELF_HOSTED: 'true' } });
      const next = vi.fn().mockResolvedValue(undefined);

      await enforceEntitlement(key)(c, next);

      expect(next).toHaveBeenCalledOnce();
      expect(json).not.toHaveBeenCalled();
    }
  });

  it('enforceQuota calls next() without fetching the count or reading billing', async () => {
    const { c, json } = makeContext({ user: USER, env: { OUTERLAYER_SELF_HOSTED: 'true' } });
    const next = vi.fn().mockResolvedValue(undefined);
    const getCurrentCount = vi.fn();

    await enforceQuota({ key: 'max_api_keys', getCurrentCount })(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getCurrentCount).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('an EE key still produces the standard 402 on unlicensed self-host (shared deny path)', async () => {
    const { c, json } = makeContext({ user: USER, env: { OUTERLAYER_SELF_HOSTED: 'true' } });
    const next = vi.fn();
    const eeKey = 'custom_roles' as Parameters<typeof enforceEntitlement>[0];

    await enforceEntitlement(eeKey)(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      {
        error: {
          code: 'entitlement_required',
          message: "Tenant tier does not include the 'custom_roles' feature",
          entitlement: 'custom_roles',
        },
      },
      402,
    );
  });

  it('a wrong-cased flag resolves as Cloud: the guard reaches for billing and 500s on the mock', async () => {
    const { c, json } = makeContext({ user: USER, env: { OUTERLAYER_SELF_HOSTED: 'TRUE' } });
    const next = vi.fn();

    await enforceEntitlement('workers_enabled')(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      { error: { code: 'internal_error', message: 'Entitlement resolution failed' } },
      500,
    );
  });
});
