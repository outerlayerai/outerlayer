/* eslint-disable import/no-unused-modules */
import { flag } from "flags/next";
import { createSupabaseAdminClient } from "../supabaseAdminClient";
import { createSupabaseServerClient } from "../supabaseServerClient";

export type FlagConfig = {
  key: string;
  defaultValue?: boolean;
};

export type FlagData = {
  id: string;
  is_enabled: boolean;
  strategy: 'global' | 'percentage' | 'targeted';
  rollout_percentage: number;
};

/**
 * Compute a deterministic bucket (0-99) for a tenant ID.
 * Used for percentage-based rollouts — hash depends ONLY on tenantId
 * so that increasing the rollout percentage preserves existing cohort membership.
 *
 * @exported for integration testing
 */
export function computeTenantBucket(tenantId: string): number {
  const hash = Array.from(tenantId).reduce(
    (acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) & 0xffffffff,
    0
  );
  return Math.abs(hash) % 100;
}

/**
 * Evaluate feature flag with support for targeting strategies.
 * Updated 2026-01-02: Uses feature_flag_override table instead of JSONB arrays.
 *
 * Evaluation order:
 * 1. Check for tenant-specific override FIRST - overrides always win
 * 2. If no override, apply strategy + is_enabled:
 *    - global: return is_enabled
 *    - percentage: hash-based rollout (only if is_enabled)
 *    - targeted: return false (only overrides matter)
 *
 * @exported for integration testing
 */
export async function evaluateFlag(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  data: FlagData,
  tenantId: string | undefined
): Promise<boolean> {
  // Check for tenant-specific override FIRST - overrides always take precedence
  if (tenantId) {
    const { data: override } = await supabase
      .from('feature_flag_override')
      .select('is_enabled')
      .eq('flag_id', data.id)
      .eq('tenant_id', tenantId)
      .single();

    if (override) {
      return override.is_enabled;
    }
  }

  // No override found - apply strategy with global is_enabled
  // If flag is globally disabled, return false (except for targeted, handled above)
  if (!data.is_enabled) {
    return false;
  }

  // Apply strategy
  switch (data.strategy) {
    case 'global':
      // Global strategy: flag is enabled for everyone
      return true;

    case 'percentage':
      // Percentage rollout based on tenant_id hash
      // IMPORTANT: Hash is based ONLY on tenant_id (not rollout_percentage)
      // This ensures cohort stability: increasing 50% -> 60% keeps original 50% + adds 10% new
      if (tenantId) {
        return computeTenantBucket(tenantId) < (data.rollout_percentage || 0);
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

export function createFeatureFlag({ key, defaultValue = false }: FlagConfig) {
  const supabase = createSupabaseAdminClient();
  return flag({
    key,
    identify: async () => {
      const serverClient = await createSupabaseServerClient();
      const {
        data: { user },
      } = await serverClient.auth.getUser();

      // Get the user's current tenant_id from membership
      let tenantId: string | undefined;
      if (user?.id) {
        const { data: membership } = await serverClient
          .from("membership")
          .select("tenant_id")
          .eq("user_id", user.id)
          .eq("status", "active")
          .limit(1)
          .single();
        tenantId = membership?.tenant_id ?? undefined;
      }

      return { userId: user?.id, tenantId };
    },
    async decide({ entities }) {
      const { data } = await supabase
        .from("feature_flag")
        .select("id, is_enabled, strategy, rollout_percentage")
        .eq("key", key)
        .single();

      if (!data) {
        return defaultValue;
      }

      return evaluateFlag(supabase, data as FlagData, entities?.tenantId as string | undefined);
    },
    defaultValue,
  });
}
