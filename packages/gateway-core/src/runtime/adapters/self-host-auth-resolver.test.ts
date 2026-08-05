import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import type { VerifyKeyResult } from '../../lib/verify-key';

// Mock the shared Supabase-resolution helper; this adapter's whole job is to
// forward to it (appId + env only), so that's exactly what we assert. Hoisted so
// the vi.mock factory (lifted to file top) can reference it.
const { resolveAppIdentity } = vi.hoisted(() => ({ resolveAppIdentity: vi.fn() }));
vi.mock('../../lib/verify-key', () => ({ resolveAppIdentity }));

import { SelfHostAuthResolver } from './self-host-auth-resolver';

/** Perimeter-trust posture: the operator authenticates callers, not the gateway. */
const env = { NODE_ENV: 'production' } as Env;

const SECRET = 'k4Jd8vQ2mN7pR1sT5wY9zB3cF6hL0xA8';

/** Secret-verifying posture. */
const secretEnv = { NODE_ENV: 'production', SELF_HOST_GATEWAY_SECRET: SECRET } as Env;

const RESOLVED = {
  ok: true,
  user: { appId: 'app-1', tenantId: 'tenant-1', appName: 'A', permissions: [] },
} as VerifyKeyResult;

describe('SelfHostAuthResolver — perimeter trust (no secret configured)', () => {
  beforeEach(() => resolveAppIdentity.mockReset());

  it('resolves identity from the app id + env, ignoring the API-key secret and cache', async () => {
    resolveAppIdentity.mockResolvedValue(RESOLVED);

    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: 'whatever-token-the-sdk-sends',
      appId: 'app-1',
      env,
      cacheKey: 'ignored',
    });

    // Delegates with EXACTLY (appId, env) — never the secret or cache.
    expect(resolveAppIdentity).toHaveBeenCalledWith('app-1', env);
    expect(resolveAppIdentity).toHaveBeenCalledTimes(1);
    // Returns the resolver's result verbatim.
    expect(result).toBe(RESOLVED);
  });

  it('propagates a resolution failure unchanged (bad app id → 401)', async () => {
    const failure: VerifyKeyResult = { ok: false, status: 401, message: 'Not authorized', code: 'unauthorized' };
    resolveAppIdentity.mockResolvedValue(failure);

    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: 'x',
      appId: 'missing',
      env,
    });

    expect(result).toEqual({ ok: false, status: 401, message: 'Not authorized', code: 'unauthorized' });
  });
});

describe('SelfHostAuthResolver — shared secret configured', () => {
  beforeEach(() => resolveAppIdentity.mockReset());

  it('resolves identity when the bearer token matches the secret', async () => {
    resolveAppIdentity.mockResolvedValue(RESOLVED);

    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: `Bearer ${SECRET}`,
      appId: 'app-1',
      env: secretEnv,
    });

    expect(result).toBe(RESOLVED);
    expect(resolveAppIdentity).toHaveBeenCalledWith('app-1', secretEnv);
  });

  it('accepts the raw secret without the Bearer prefix', async () => {
    resolveAppIdentity.mockResolvedValue(RESOLVED);

    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: SECRET,
      appId: 'app-1',
      env: secretEnv,
    });

    expect(result).toBe(RESOLVED);
  });

  // The property that matters: a wrong secret must not reach the app lookup at
  // all. If the identity resolution still ran, a mismatch would leak "this app
  // id exists" through response timing, and any bug in the ordering would hand
  // out the tenant.
  it.each([
    ['a wrong secret of the same length', 'X4Jd8vQ2mN7pR1sT5wY9zB3cF6hL0xA8'],
    ['a prefix of the secret', 'k4Jd8vQ2mN7pR1sT'],
    ['the secret plus a suffix', `${SECRET}extra`],
    ['an empty token', ''],
    ['a bare Bearer with no token', 'Bearer '],
  ])('401s on %s, without resolving the app', async (_label, presented) => {
    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: presented,
      appId: 'app-1',
      env: secretEnv,
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      message: 'Not authorized',
      code: 'unauthorized',
    });
    expect(resolveAppIdentity).not.toHaveBeenCalled();
  });

  // The boot gate validates the TRIMMED secret, so the resolver must too — a
  // .env with stray whitespace would otherwise boot fine and then reject the
  // value the operator believes they configured.
  it('matches the trimmed secret when the env value carries stray whitespace', async () => {
    resolveAppIdentity.mockResolvedValue(RESOLVED);

    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: `Bearer ${SECRET}`,
      appId: 'app-1',
      env: { NODE_ENV: 'production', SELF_HOST_GATEWAY_SECRET: `  ${SECRET}\n` } as Env,
    });

    expect(result).toBe(RESOLVED);
  });

  it('does not accept a valid app id as a substitute for the secret', async () => {
    const result = await new SelfHostAuthResolver().resolveApiKey({
      authHeader: 'Bearer app-1',
      appId: 'app-1',
      env: secretEnv,
    });

    expect(result.ok).toBe(false);
    expect(resolveAppIdentity).not.toHaveBeenCalled();
  });
});
