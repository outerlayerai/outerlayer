/**
 * Entitlement-denial info: pure tier/pricing lookups, framework-free (no
 * React, no Supabase, no `server-only`) so this is the one shared home for
 * both a server action's denial response and a client component's inline
 * upgrade prompt — `create-app-modal.tsx` already relies on `buildDeniedInfo`
 * being callable from a client component; this module is where that's true by
 * construction rather than by accident of `EntitlementService` not (yet)
 * being marked `server-only`.
 *
 * `EntitlementService` (the DB-backed service, `src/lib/system/`)
 * re-exports both functions for its existing callers — this module is the
 * implementation, not a duplicate.
 */

import {
  ENTITLEMENTS,
  TIERS,
  TIER_IDS,
  UNLIMITED,
  type TierId,
  type EntitlementKey,
  type EntitlementCheckResult,
  type EntitlementDeniedInfo,
} from "@/config/entitlements";

/**
 * Returns the lowest tier that grants a feature.
 * For boolean: first tier (by sortOrder) where value is `true`.
 * For numeric: first tier with a higher limit than the previous tier (or first non-zero).
 * For categorical: returns 'hobby' (always available at some level).
 */
export function getRequiredTierForFeature(key: EntitlementKey): TierId {
  const def = ENTITLEMENTS[key];
  const sortedTiers = [...TIER_IDS].sort(
    (a, b) => TIERS[a].sortOrder - TIERS[b].sortOrder,
  );
  const lowestTier = sortedTiers[0] ?? ("hobby" as TierId);
  const highestTier = sortedTiers[sortedTiers.length - 1] ?? lowestTier;

  if (def.type === "boolean") {
    for (const tier of sortedTiers) {
      if (def[tier] === true) return tier;
    }
    return highestTier;
  }

  if (def.type === "numeric") {
    const lowestTierValue = def[lowestTier] as number;
    for (const tier of sortedTiers.slice(1)) {
      const val = def[tier] as number;
      if (val === UNLIMITED || val > lowestTierValue) return tier;
    }
    return lowestTier;
  }

  // categorical — always available
  return lowestTier;
}

export function buildDeniedInfo(
  key: EntitlementKey,
  checkResult?: EntitlementCheckResult,
): EntitlementDeniedInfo {
  const def = ENTITLEMENTS[key];
  const requiredTier = getRequiredTierForFeature(key);
  const tierConfig = TIERS[requiredTier];

  return {
    featureKey: key,
    featureDisplayName: def.displayName,
    requiredTier,
    requiredTierDisplayName: tierConfig.displayName,
    isSelfServe: tierConfig.isSelfServe,
    pricing: tierConfig.pricing,
    upgradeUrl: tierConfig.isSelfServe ? "/settings/billing" : "/contact",
    currentLimit: checkResult ? checkResult.limit : null,
    requiredTierLimit: def.type === "numeric" ? (def[requiredTier] as number) : null,
  };
}
