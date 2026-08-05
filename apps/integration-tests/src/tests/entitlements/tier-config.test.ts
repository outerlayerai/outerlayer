/**
 * Contract tests for @repo/tier-config
 *
 * Verifies that the tier configuration values match the pricing page.
 * These tests guard against accidental changes to entitlement values
 * that would cause the runtime behavior to drift from published pricing.
 *
 * Layer: unit (pure config values, no DB or network)
 */

import {
  NUMERIC_ENTITLEMENTS,
  BOOLEAN_ENTITLEMENTS,
  TIER_IDS,
  type TierId,
  type NumericEntitlementKey,
  type BooleanEntitlementKey,
} from '@repo/tier-config';
import { TIER_FIXTURES } from './helpers';

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

describe('tier-config contract tests', () => {
  describe('tier definitions', () => {
    it('should define exactly 4 tiers: hobby, growth, team, enterprise', () => {
      expect(TIER_IDS).toHaveLength(4);
      expect(TIER_IDS).toContain('hobby');
      expect(TIER_IDS).toContain('growth');
      expect(TIER_IDS).toContain('team');
      expect(TIER_IDS).toContain('enterprise');
    });
  });

  // --------------------------------------------------------------------------
  // Numeric entitlements — verify each tier matches the pricing page
  // --------------------------------------------------------------------------

  describe('numeric entitlements', () => {
    const numericKeys = Object.keys(NUMERIC_ENTITLEMENTS) as NumericEntitlementKey[];
    const tierIds = TIER_IDS as readonly TierId[];

    for (const tier of tierIds) {
      describe(`${tier} tier`, () => {
        for (const key of numericKeys) {
          it(`should have ${key} = ${TIER_FIXTURES[tier][key]}`, () => {
            expect(NUMERIC_ENTITLEMENTS[key][tier]).toBe(TIER_FIXTURES[tier][key]);
          });
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // Boolean entitlements — verify each tier matches the pricing page
  // --------------------------------------------------------------------------

  describe('boolean entitlements', () => {
    const booleanKeys = Object.keys(BOOLEAN_ENTITLEMENTS) as BooleanEntitlementKey[];
    const tierIds = TIER_IDS as readonly TierId[];

    for (const tier of tierIds) {
      describe(`${tier} tier`, () => {
        for (const key of booleanKeys) {
          it(`should have ${key} = ${TIER_FIXTURES[tier][key]}`, () => {
            expect(BOOLEAN_ENTITLEMENTS[key][tier]).toBe(TIER_FIXTURES[tier][key]);
          });
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // Tier sort order — tiers must be ordered by plan level
  // --------------------------------------------------------------------------

  describe('tier ordering', () => {
    it('should have tiers in correct sort order', () => {
      const expectedOrder: TierId[] = ['hobby', 'growth', 'team', 'enterprise'];
      expect([...TIER_IDS]).toEqual(expectedOrder);
    });
  });
});
