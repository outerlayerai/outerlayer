/**
 * Unit tests for FeatureFlagService
 *
 * Tests feature flag evaluation with caching and Supabase integration.
 * Mirrors the evaluation logic from tenant-dashboard's flag-factory.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FeatureFlagService, createFeatureFlagService } from './feature-flag-service';
import type { GatewayCache, Env, FeatureFlagData, CachedFeatureFlag } from '../types';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a stub cache namespace for testing.
 * Returns a minimal implementation that satisfies the CacheNamespace interface.
 */
function createStubNamespace() {
  return {
    get: vi.fn().mockResolvedValue({ val: undefined }),
    set: vi.fn().mockResolvedValue({ val: undefined }),
    remove: vi.fn().mockResolvedValue({ val: undefined }),
    swr: vi.fn().mockResolvedValue({ val: undefined }),
  };
}

function createMockCache(cachedFlag?: CachedFeatureFlag): GatewayCache {
  return {
    userMeta: createStubNamespace(),
    pricingData: createStubNamespace(),
    featureFlags: {
      get: vi.fn().mockResolvedValue({ val: cachedFlag }),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue({ val: undefined }),
      swr: vi.fn().mockResolvedValue({ val: undefined }),
    },
  } as GatewayCache;
}

function createMockEnv(): Env {
  return {
    SUPABASE_API_BASE_URL: 'https://test.supabase.co',
    SUPABASE_SECRET_KEY: 'test-key',
  } as Env;
}

function createMockFlagData(overrides: Partial<FeatureFlagData> = {}): FeatureFlagData {
  return {
    id: 'flag-123',
    key: 'test_flag',
    is_enabled: true,
    strategy: 'global',
    rollout_percentage: 0,
    ...overrides,
  };
}

// Mock Supabase client
const mockSupabaseFrom = vi.fn();
vi.mock('../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: () => ({
    from: mockSupabaseFrom,
  }),
}));

// =============================================================================
// Tests
// =============================================================================

describe('FeatureFlagService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cache behavior', () => {
    it('should return cached value when flag is in cache', async () => {
      const flagData = createMockFlagData({ is_enabled: true, strategy: 'global' });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag');

      expect(result).toBe(true);
      expect(cache.featureFlags.get).toHaveBeenCalledWith('flag:test_flag');
      expect(mockSupabaseFrom).not.toHaveBeenCalled();
    });

    it('should fetch from Supabase when cache is empty', async () => {
      const cache = createMockCache(undefined);
      const flagData = createMockFlagData({ is_enabled: true });

      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'feature_flag') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: flagData, error: null }),
              }),
            }),
          };
        }
        if (table === 'feature_flag_override') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        return {};
      });

      const service = new FeatureFlagService(cache, createMockEnv());
      const result = await service.isEnabled('test_flag');

      expect(result).toBe(true);
      expect(mockSupabaseFrom).toHaveBeenCalledWith('feature_flag');
      // The freshly-fetched flag is written back to cache under its key,
      // with no tenant overrides applied.
      expect(cache.featureFlags.set).toHaveBeenCalledWith(
        'flag:test_flag',
        expect.objectContaining({ flag: flagData, overrides: {} }),
      );
    });

    it('should return false when flag does not exist in database', async () => {
      const cache = createMockCache(undefined);

      mockSupabaseFrom.mockImplementation(() => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: { message: 'Not found' } }),
          }),
        }),
      }));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new FeatureFlagService(cache, createMockEnv());
      const result = await service.isEnabled('nonexistent_flag');

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Feature flag \'nonexistent_flag\' not found'),
        expect.any(String)
      );
      consoleSpy.mockRestore();
    });
  });

  describe('global strategy', () => {
    it('should return true when flag is enabled globally', async () => {
      const flagData = createMockFlagData({ is_enabled: true, strategy: 'global' });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag');

      expect(result).toBe(true);
    });

    it('should return false when flag is disabled globally', async () => {
      const flagData = createMockFlagData({ is_enabled: false, strategy: 'global' });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag');

      expect(result).toBe(false);
    });
  });

  describe('percentage strategy', () => {
    it('should return true for tenant in rollout bucket', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'percentage',
        rollout_percentage: 100, // 100% rollout
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(true);
    });

    it('should return false for tenant outside rollout bucket', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'percentage',
        rollout_percentage: 0, // 0% rollout
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(false);
    });

    it('should return false when tenantId is not provided for percentage strategy', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'percentage',
        rollout_percentage: 100,
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag'); // No tenantId

      expect(result).toBe(false);
    });

    it('should return consistent results for same tenant (cohort stability)', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'percentage',
        rollout_percentage: 50,
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {},
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const tenantId = 'consistent-tenant-123';
      const result1 = await service.isEnabled('test_flag', tenantId);
      const result2 = await service.isEnabled('test_flag', tenantId);

      expect(result1).toBe(result2);
    });
  });

  describe('targeted strategy', () => {
    it('should return false for tenant without override', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'targeted',
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {}, // No overrides
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(false);
    });

    it('should return true for tenant with enabled override', async () => {
      const flagData = createMockFlagData({
        is_enabled: false, // Global disabled
        strategy: 'targeted',
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {
          'tenant-123': true, // Tenant override enabled
        },
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(true);
    });
  });

  describe('tenant overrides', () => {
    it('should return override value when tenant has override (overrides global)', async () => {
      const flagData = createMockFlagData({
        is_enabled: true, // Global enabled
        strategy: 'global',
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {
          'tenant-123': false, // Tenant override disabled
        },
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(false);
    });

    it('should return override value when tenant has override (overrides percentage)', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'percentage',
        rollout_percentage: 0, // 0% rollout would normally return false
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {
          'tenant-123': true, // Tenant override enabled
        },
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-123');

      expect(result).toBe(true);
    });

    it('should not apply override for different tenant', async () => {
      const flagData = createMockFlagData({
        is_enabled: true,
        strategy: 'global',
      });
      const cachedFlag: CachedFeatureFlag = {
        flag: flagData,
        overrides: {
          'tenant-123': false, // Override for different tenant
        },
        cachedAt: Date.now(),
      };
      const cache = createMockCache(cachedFlag);
      const service = new FeatureFlagService(cache, createMockEnv());

      const result = await service.isEnabled('test_flag', 'tenant-456');

      expect(result).toBe(true); // Uses global value, not override
    });
  });
});

describe('createFeatureFlagService', () => {
  it('should create a FeatureFlagService instance', () => {
    const cache = createMockCache();
    const env = createMockEnv();

    const service = createFeatureFlagService(cache, env);

    expect(typeof service.isEnabled).toBe('function');
  });
});
