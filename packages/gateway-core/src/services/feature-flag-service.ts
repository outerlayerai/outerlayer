/**
 * Feature Flag Service for Gateway
 *
 * Provides cached feature flag evaluation for Cloudflare Workers.
 * Reuses the same evaluation logic as tenant-dashboard's flag-factory.ts.
 *
 * Uses createSystemAdminClient because feature flag evaluation is
 * intentionally cross-tenant: the service bulk-loads every tenant's
 * override for a given flag once per cache window, then evaluates per
 * request by tenantId against that cached set. There's no tenant filter
 * to drop — the query shape is the point. This isn't the admin-client
 * failure mode (tenant isolation leak via missing .eq); it's legitimate
 * platform-level config access, same shape as jobs/alert-handler.ts.
 *
 * @see apps/tenant-dashboard/src/flags/flag-factory.ts
 * @see packages/gateway-core/src/lib/system-client.ts
 */

import type { Env, GatewayCache, FeatureFlagData, CachedFeatureFlag } from '../types';
import { createSystemAdminClient } from '../lib/system-client';

/**
 * Interface for the feature flag service
 */
export interface IFeatureFlagService {
  /**
   * Evaluate a feature flag for a specific tenant
   *
   * @param flagKey - The feature flag key
   * @param tenantId - The tenant to evaluate for (optional)
   * @returns true if the flag is enabled for this tenant
   */
  isEnabled(flagKey: string, tenantId?: string): Promise<boolean>;
}

/**
 * Evaluate feature flag with support for targeting strategies.
 *
 * This logic mirrors tenant-dashboard's evaluateFlag function.
 * @see apps/tenant-dashboard/src/flags/flag-factory.ts
 *
 * Evaluation order:
 * 1. Check for tenant-specific override FIRST - overrides always win
 * 2. If no override, apply strategy + is_enabled:
 *    - global: return is_enabled
 *    - percentage: hash-based rollout (only if is_enabled)
 *    - targeted: return false (only overrides matter)
 */
function evaluateFlagData(
  flag: FeatureFlagData,
  overrides: Record<string, boolean>,
  tenantId: string | undefined
): boolean {
  // Check for tenant-specific override FIRST - overrides always take precedence
  if (tenantId && tenantId in overrides) {
    return overrides[tenantId] ?? false;
  }

  // No override found - apply strategy with global is_enabled
  // If flag is globally disabled, return false (except for targeted, handled above)
  if (!flag.is_enabled) {
    return false;
  }

  // Apply strategy
  switch (flag.strategy) {
    case 'global':
      // Global strategy: flag is enabled for everyone
      return true;

    case 'percentage':
      // Percentage rollout based on tenant_id hash
      // IMPORTANT: Hash is based ONLY on tenant_id (not rollout_percentage)
      // This ensures cohort stability: increasing 50% -> 60% keeps original 50% + adds 10% new
      if (tenantId) {
        const hash = Array.from(tenantId).reduce(
          (acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) & 0xffffffff,
          0
        );
        const tenantBucket = Math.abs(hash) % 100;
        return tenantBucket < (flag.rollout_percentage || 0);
      }
      return false;

    case 'targeted':
      // Targeted strategy: only tenants with overrides get the feature
      // Since we already checked overrides above and didn't find one, return false
      return false;

    default:
      return false;
  }
}

/**
 * FeatureFlagService fetches and caches feature flag data.
 * Uses Supabase for flag storage and GatewayCache for caching.
 */
export class FeatureFlagService implements IFeatureFlagService {
  constructor(
    private readonly cache: GatewayCache,
    private readonly env: Env
  ) {}

  async isEnabled(flagKey: string, tenantId?: string): Promise<boolean> {
    // Try to get from cache first
    const cacheKey = `flag:${flagKey}`;
    const cached = await this.cache.featureFlags.get(cacheKey);

    if (cached.val) {
      return evaluateFlagData(cached.val.flag, cached.val.overrides, tenantId);
    }

    // Fetch from Supabase
    const supabase = createSystemAdminClient(this.env);

    const { data: flagData, error: flagError } = await supabase
      .from('feature_flag')
      .select('id, key, is_enabled, strategy, rollout_percentage')
      .eq('key', flagKey)
      .single();

    if (flagError || !flagData) {
      // Flag doesn't exist - return false as default
      console.warn(`Feature flag '${flagKey}' not found:`, flagError?.message);
      return false;
    }

    // Fetch all overrides for this flag
    const { data: overrideData } = await supabase
      .from('feature_flag_override')
      .select('tenant_id, is_enabled')
      .eq('flag_id', flagData.id);

    // Build overrides map
    const overrides: Record<string, boolean> = {};
    if (overrideData) {
      for (const override of overrideData) {
        overrides[override.tenant_id] = override.is_enabled;
      }
    }

    // Cache the result
    const cachedFlag: CachedFeatureFlag = {
      flag: flagData as FeatureFlagData,
      overrides,
      cachedAt: Date.now(),
    };
    await this.cache.featureFlags.set(cacheKey, cachedFlag);

    return evaluateFlagData(cachedFlag.flag, cachedFlag.overrides, tenantId);
  }
}

/**
 * Create a FeatureFlagService with the given cache and env
 */
export function createFeatureFlagService(
  cache: GatewayCache,
  env: Env
): IFeatureFlagService {
  return new FeatureFlagService(cache, env);
}
