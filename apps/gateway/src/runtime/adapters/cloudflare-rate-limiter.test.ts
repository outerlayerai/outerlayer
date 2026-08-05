/**
 * Tests for the hosted `RateLimiter` adapter — the Unkey standalone-ratelimiter
 * logic, kept separate from gateway-core's `rate-limit.ts` (`checkRateLimit`).
 * It self-provisions (limit + duration inline) and FAILS OPEN on any error, a
 * missing root key, or a malformed response — data-plane availability beats
 * strict enforcement on a limiter blip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '@repo/gateway-core/types';
import { TEMPLATE_READ_RATE_LIMIT } from '@repo/gateway-core/rate-limits';

// --- Mock the Unkey SDK's standalone ratelimiter -------------------------
const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));
vi.mock('@unkey/api', () => ({
  Unkey: class MockUnkey {
    ratelimit = { limit: mockLimit };
    constructor(_opts: unknown) {}
  },
}));

import { CloudflareRateLimiter } from './cloudflare-rate-limiter';

const CONFIG = TEMPLATE_READ_RATE_LIMIT.free; // namespace template-request, 1000 / 30d
const withKey = new CloudflareRateLimiter({ UNKEY_API_KEY: 'unkey-root' } as Env);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CloudflareRateLimiter.check', () => {
  it('passes namespace/identifier/limit/duration/cost to the standalone limiter', async () => {
    mockLimit.mockResolvedValue({ data: { success: true, limit: 1000, remaining: 999, reset: 123 } });

    await withKey.check(CONFIG, 'tenant-1');

    expect(mockLimit).toHaveBeenCalledWith({
      namespace: 'template-request',
      identifier: 'tenant-1',
      limit: 1000,
      duration: CONFIG.durationMs,
      cost: 1,
    });
  });

  it('returns allowed=true with mapped fields when the limiter succeeds', async () => {
    mockLimit.mockResolvedValue({ data: { success: true, limit: 1000, remaining: 42, reset: 999 } });

    const out = await withKey.check(CONFIG, 'tenant-1');

    expect(out).toEqual({ allowed: true, limit: 1000, remaining: 42, reset: 999, failedOpen: false });
  });

  it('returns allowed=false when the limiter reports the limit exceeded', async () => {
    mockLimit.mockResolvedValue({ data: { success: false, limit: 1000, remaining: 0, reset: 555 } });

    const out = await withKey.check(CONFIG, 'tenant-1');

    expect(out.allowed).toBe(false);
    expect(out.failedOpen).toBe(false);
    expect(out.remaining).toBe(0);
  });

  it('FAILS OPEN (allowed, failedOpen) when the limiter throws', async () => {
    mockLimit.mockRejectedValue(new Error('unkey down'));

    const out = await withKey.check(CONFIG, 'tenant-1');

    expect(out.allowed).toBe(true);
    expect(out.failedOpen).toBe(true);
  });

  it('FAILS OPEN without calling the limiter when no root key is configured', async () => {
    const out = await new CloudflareRateLimiter({} as Env).check(CONFIG, 'tenant-1');

    expect(out.allowed).toBe(true);
    expect(out.failedOpen).toBe(true);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('FAILS OPEN on a malformed limiter response (no success boolean)', async () => {
    mockLimit.mockResolvedValue({ data: {} });

    const out = await withKey.check(CONFIG, 'tenant-1');

    expect(out.allowed).toBe(true);
    expect(out.failedOpen).toBe(true);
  });
});
