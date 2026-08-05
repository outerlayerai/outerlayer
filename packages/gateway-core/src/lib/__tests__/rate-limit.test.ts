/**
 * Tests for the per-route rate-limit guard (`enforceRateLimit`).
 *
 * The guard reads the tier from the injected billing seam, then delegates the
 * actual check to the injected `gtx.rateLimiter` seam (Unkey on hosted, no-op on
 * self-host — each covered by its own adapter test). Here we pin the guard's own
 * behavior: tier selection, the 429 envelope + headers on a breach, and the
 * no-tenant skip. The limiter's fail-open semantics live in the adapters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import { TEMPLATE_READ_RATE_LIMIT } from '../../rate-limits';
import { enforceRateLimit, type RateLimitOutcome } from '../rate-limit';

const envWithKey = { UNKEY_API_KEY: 'unkey-root' } as Env;

// The injected limiter seam. Each test sets what its check() returns.
const rlCheck = vi.fn();

function allowedOutcome(limit: number): RateLimitOutcome {
  return { allowed: true, limit, remaining: 5, reset: 0, failedOpen: false };
}

interface FakeContext {
  env: Env;
  get: (k: string) => unknown;
  json: ReturnType<typeof vi.fn>;
}

function makeCtx(
  user: Record<string, unknown> | undefined,
  opts: { enforcesSubscriptionTiers?: boolean } = {},
): FakeContext {
  // The guard reads billing.enforcesSubscriptionTiers (tier) + rateLimiter.check.
  const gtx = {
    billing: { enforcesSubscriptionTiers: opts.enforcesSubscriptionTiers ?? true },
    rateLimiter: { check: rlCheck },
  };
  return {
    env: envWithKey,
    get: (k: string) => (k === 'user' ? user : k === 'gtx' ? gtx : undefined),
    json: vi.fn((body: unknown, init: unknown) => ({ body, init })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rlCheck.mockResolvedValue(allowedOutcome(1000));
});

describe('enforceRateLimit', () => {
  const guard = enforceRateLimit(TEMPLATE_READ_RATE_LIMIT);

  it('calls next() and does not respond when under the limit', async () => {
    const c = makeCtx({ tenantId: 'tenant-1', stripeSubscriptionId: '' });
    const next = vi.fn();

    await guard(c as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c.json).not.toHaveBeenCalled();
  });

  it('checks the FREE config for a tenant with no subscription', async () => {
    const c = makeCtx({ tenantId: 'tenant-free', stripeSubscriptionId: '' });
    await guard(c as never, vi.fn() as never);
    expect(rlCheck).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }), 'tenant-free');
  });

  it('checks the PAID config for a tenant with an active subscription', async () => {
    const c = makeCtx({ tenantId: 'tenant-paid', stripeSubscriptionId: 'sub_123' });
    await guard(c as never, vi.fn() as never);
    expect(rlCheck).toHaveBeenCalledWith(expect.objectContaining({ limit: 100000 }), 'tenant-paid');
  });

  // Runtime billing signal (self-host vs hosted) via the injected gtx.billing
  // seam. Tier is `!enforcesSubscriptionTiers || stripeSubscriptionId ? 'paid' : 'free'`.
  it('checks the PAID config for a subscription-less tenant when the runtime does NOT enforce tiers (self-host)', async () => {
    // A mutation dropping the `!enforcesSubscriptionTiers` clause picks free
    // (limit 1000) and fails this.
    const c = makeCtx(
      { tenantId: 'tenant-selfhost', stripeSubscriptionId: '' },
      { enforcesSubscriptionTiers: false },
    );
    await guard(c as never, vi.fn() as never);
    expect(rlCheck).toHaveBeenCalledWith(expect.objectContaining({ limit: 100000 }), 'tenant-selfhost');
  });

  it('still checks the FREE config for a subscription-less tenant when the runtime enforces tiers (hosted)', async () => {
    const c = makeCtx(
      { tenantId: 'tenant-hosted-free', stripeSubscriptionId: '' },
      { enforcesSubscriptionTiers: true },
    );
    await guard(c as never, vi.fn() as never);
    expect(rlCheck).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }), 'tenant-hosted-free');
  });

  it('returns 429 with Retry-After + X-RateLimit-* headers on a real breach', async () => {
    const reset = Date.now() + 60_000;
    rlCheck.mockResolvedValue({ allowed: false, limit: 1000, remaining: 0, reset, failedOpen: false });
    const c = makeCtx({ tenantId: 'tenant-1', stripeSubscriptionId: '' });
    const next = vi.fn();

    await guard(c as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledTimes(1);
    const [body, init] = c.json.mock.calls[0]!;
    expect(body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
    expect((init as { status: number }).status).toBe(429);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['X-RateLimit-Limit']).toBe('1000');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('skips enforcement (calls next) when there is no authenticated tenant', async () => {
    const c = makeCtx(undefined);
    const next = vi.fn();

    await guard(c as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rlCheck).not.toHaveBeenCalled();
  });
});
