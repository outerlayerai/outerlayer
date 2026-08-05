/**
 * Tests for `gatherOnboardingSignals` — the orchestrator that pairs the
 * ClickHouse trace count with the Supabase counts.
 *
 * Both dependencies are true function seams (`getCachedTraces`,
 * `countOnboardingSignals`), so `vi.mock` is correct and no Supabase client is
 * hand-rolled. We pin: the trace total is threaded through beside the counts,
 * both seams receive the verified context, and a rejected trace cache degrades
 * to `traceTotal: 0` without disturbing the counts.
 */

vi.mock('server-only', () => ({}));

const mockGetCachedTraces = vi.fn();
vi.mock('@/lib/analytics/cache', () => ({
  getCachedTraces: (...args: unknown[]) => mockGetCachedTraces(...args),
}));

const mockCountOnboardingSignals = vi.fn();
vi.mock('@/lib/system/onboarding-signals', () => ({
  countOnboardingSignals: (...args: unknown[]) => mockCountOnboardingSignals(...args),
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gatherOnboardingSignals } from './service';
import type { TenantContext } from '@/lib/analytics/tenant-context';

const ctx = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  appId: 'app-1',
  dataRetentionDays: -1,
} as unknown as TenantContext;

const COUNTS = {
  apiKeyCount: 3,
  memberCount: 4,
  gitProvider: 'github',
  gitInstallationId: 'inst-9',
  gitBranchCount: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCountOnboardingSignals.mockResolvedValue(COUNTS);
});

describe('gatherOnboardingSignals', () => {
  it('threads the trace total beside the counts and scopes both to the verified context', async () => {
    mockGetCachedTraces.mockResolvedValue({ total: 9 });

    const result = await gatherOnboardingSignals(ctx);

    expect(result).toEqual({ traceTotal: 9, ...COUNTS });
    // The trace signal comes from the cache wrapper with (ctx, 1, 0); the counts
    // seam receives the same verified context — neither takes a raw param.
    expect(mockGetCachedTraces).toHaveBeenCalledWith(ctx, 1, 0);
    expect(mockCountOnboardingSignals).toHaveBeenCalledWith(ctx);
  });

  it('falls back to traceTotal 0 when the trace cache rejects, counts untouched', async () => {
    mockGetCachedTraces.mockRejectedValue(new Error('clickhouse down'));

    const result = await gatherOnboardingSignals(ctx);

    expect(result).toEqual({ traceTotal: 0, ...COUNTS });
  });
});
