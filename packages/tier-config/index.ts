import tiers from './tiers.json';

export type TierId = keyof typeof tiers.tiers;
export const TIER_IDS = Object.keys(tiers.tiers) as readonly TierId[];
export const UNLIMITED = -1 as const;

export type NumericEntitlementKey = keyof typeof tiers.numericEntitlements;
export const NUMERIC_ENTITLEMENTS = tiers.numericEntitlements;

export type BooleanEntitlementKey = keyof typeof tiers.booleanEntitlements;
export const BOOLEAN_ENTITLEMENTS = tiers.booleanEntitlements;

/** Get a numeric entitlement value for a tier. */
export function getNumericLimit(key: NumericEntitlementKey, tier: TierId): number {
  return NUMERIC_ENTITLEMENTS[key][tier];
}

/** Get a boolean entitlement value for a tier. */
export function getBooleanEntitlement(key: BooleanEntitlementKey, tier: TierId): boolean {
  return BOOLEAN_ENTITLEMENTS[key][tier];
}
