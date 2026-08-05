/**
 * Unit tests for the gateway feature-flag gate helper.
 *
 * The property these tests pin: `isFeatureEnabled` is
 * FAIL-CLOSED. A cache/Supabase failure must degrade to "feature disabled"
 * (so the caller 404s) rather than throw into a 500, and must never expose a
 * gated feature on error. We mock the cache + service seams so the test
 * exercises only the wrapper's success/throw handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }));

// initCache / memory are infra wiring the wrapper stands up; stub them so the
// helper runs without Cloudflare cache bindings.
vi.mock('../utils', () => ({ initCache: vi.fn(() => ({})) }));
vi.mock('../cache-store', () => ({ memory: {} }));
vi.mock('../services', () => ({
  createFeatureFlagService: vi.fn(() => ({ isEnabled: mockIsEnabled })),
}));

import { isFeatureEnabled, ENV_ROLLBACK_FLAG } from './feature-flags';

const env = {} as Parameters<typeof isFeatureEnabled>[0];
const ctx = {} as Parameters<typeof isFeatureEnabled>[1];
// L2 store is injected now; initCache is stubbed above so the value is inert.
const l2Store = {} as Parameters<typeof isFeatureEnabled>[2];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isFeatureEnabled', () => {
  it('returns the service result and forwards (key, tenantId) when evaluation succeeds', async () => {
    mockIsEnabled.mockResolvedValue(true);

    await expect(isFeatureEnabled(env, ctx, l2Store, 'some_flag', 'tenant-1')).resolves.toBe(
      true,
    );
    expect(mockIsEnabled).toHaveBeenCalledWith('some_flag', 'tenant-1');
  });

  it('passes a disabled flag result through as false', async () => {
    mockIsEnabled.mockResolvedValue(false);

    await expect(
      isFeatureEnabled(env, ctx, l2Store, 'some_flag', 'tenant-1'),
    ).resolves.toBe(false);
  });

  it('fails closed (resolves false, does not throw) when the service rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIsEnabled.mockRejectedValue(new Error('cache/Supabase unreachable'));

    // Must resolve false — NOT reject — so the caller 404s instead of 500ing,
    // and a flaky dependency never exposes the gated feature.
    await expect(
      isFeatureEnabled(env, ctx, l2Store, 'some_flag', 'tenant-1'),
    ).resolves.toBe(false);
    // The swallowed error is logged for observability (not silently dropped).
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('exposes the env-rollback flag key the dashboard mirrors', () => {
    expect(ENV_ROLLBACK_FLAG).toBe('enable_env_rollback');
  });
});
