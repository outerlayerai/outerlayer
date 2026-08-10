import { describe, it, expect } from 'vitest';
import { RATE_LIMITS } from './rate-limits';

describe('RATE_LIMITS.sessionDetail', () => {
  it('registers the tighter per-tier ceilings for session-detail reads', () => {
    expect(RATE_LIMITS.sessionDetail).toEqual({
      free: {
        namespace: 'session-detail',
        limit: 30,
        durationMs: 60_000,
        cost: 1,
      },
      paid: {
        namespace: 'session-detail',
        limit: 300,
        durationMs: 60_000,
        cost: 1,
      },
    });
  });
});
