/**
 * `EnvironmentService.createEnvironment`'s env-limit error is USER-FACING copy
 * rendered straight into a dashboard alert, so it must read as product copy:
 *
 *  - No trailing `(FR-...)` developer marker, which a requirement tag pasted
 *    into the message string leaks all the way to the end user.
 *  - The tier name is included when the entitlement check supplies it
 *    ("…limit (1) on the hobby tier — upgrade to add more.").
 *
 * This is a service-layer unit test: we stub the Supabase client and the
 * `checkEnvLimit` dependency so we can drive the env-limit branch deterministically
 * without an integration DB. It locks the contract that the message is
 * USER-FACING copy, not a developer marker.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EnvironmentService,
  type CheckEnvLimitFn,
  type EnvironmentServiceDeps,
} from './environment-service';

/**
 * Minimal Supabase stub — `createEnvironment`'s limit branch hits ONLY the
 * `countEnvironments` query before short-circuiting. Returning an empty data
 * array + null error is enough to satisfy that read; the limit-check stub
 * then drives the rejection path.
 */
function stubSupabase(): SupabaseClient {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockResolvedValue({ count: 5, data: [], error: null }),
    // `countEnvironments` calls `.select(...).eq(...)` and AWAITS the result —
    // the awaited value should be `{ count, error }`. `not` is unused but
    // safe to leave defined for any future caller.
    then: undefined as unknown,
  };
  // `await` on the builder fires `then` on the underlying PromiseLike — make
  // the builder itself thenable so the `await this.client(...).select(...).eq(...)`
  // path resolves to a quota-count envelope.
  // `countEnvironments` now chains TWO `.eq` filters (`app_id`, then
  // `is_ephemeral`) before awaiting, so each `.eq` must return a thenable that
  // is itself chainable.
  const countResult = Promise.resolve({ count: 5, data: [], error: null });
  const chain = {
    eq: vi.fn(() => chain),
    then: countResult.then.bind(countResult),
  };
  const thenable: SupabaseClient = {
    from: vi.fn(() => ({
      select: vi.fn(() => chain),
    })),
  } as unknown as SupabaseClient;
  void builder; // unused — kept for readers
  return thenable;
}

function makeService(checkEnvLimit: CheckEnvLimitFn): EnvironmentService {
  const deps: EnvironmentServiceDeps = {
    supabase: stubSupabase(),
    // The limit branch returns BEFORE any Fly call; a no-op client is enough.
    checkEnvLimit,
  };
  return new EnvironmentService(deps);
}

describe('EnvironmentService.createEnvironment — env_limit_exceeded error copy', () => {
  it('should return a USER-FACING message that does NOT leak the internal entitlement key', async () => {
    const service = makeService(async () => ({
      allowed: false,
      limit: 1,
      tierName: 'hobby',
    }));

    const result = await service.createEnvironment({
      tenantId: '11111111-1111-4111-8111-111111111111',
      appId: '22222222-2222-4222-8222-222222222222',
      name: 'staging',
      actorId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('env_limit_exceeded');
    // What matters here: no spec-tag leak, and the tier name lands
    // verbatim in the user-facing copy.
    expect(result.message).not.toMatch(/\(FR-\d+\)/);
    expect(result.message).toContain('on the hobby tier');
    expect(result.message).toContain('environment limit (1)');
    expect(result.message).toContain('upgrade to add more');
  });

  it('should omit the tier name segment when checkEnvLimit does not supply one', async () => {
    const service = makeService(async () => ({
      allowed: false,
      limit: 1,
      // tierName intentionally absent.
    }));

    const result = await service.createEnvironment({
      tenantId: '11111111-1111-4111-8111-111111111111',
      appId: '22222222-2222-4222-8222-222222222222',
      name: 'staging',
      actorId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Still no spec tag, and still no awkward "on the … tier" fragment.
    expect(result.message).not.toMatch(/\(FR-\d+\)/);
    expect(result.message).not.toContain(' on the  tier');
    expect(result.message).toContain('environment limit (1)');
    expect(result.message).toContain('upgrade to add more');
  });
});
