/**
 * The node self-host `RateLimiter` adapter: enforces nothing, always allows.
 */
import { describe, it, expect } from 'vitest';
import { NoopRateLimiter } from './noop-rate-limiter';
import { TEMPLATE_READ_RATE_LIMIT } from '../../rate-limits';

describe('NoopRateLimiter', () => {
  it('always allows with the config limit as budget, flagged failedOpen (no enforcement)', async () => {
    const config = TEMPLATE_READ_RATE_LIMIT.free;

    const out = await new NoopRateLimiter().check(config, 'tenant-1');

    expect(out).toEqual({
      allowed: true,
      limit: config.limit,
      remaining: config.limit,
      reset: 0,
      failedOpen: true,
    });
  });
});
