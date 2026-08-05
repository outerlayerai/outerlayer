/**
 * Contract tests for custom_metrics_enabled entitlement
 *
 * Verifies that the `custom_metrics_enabled` boolean entitlement is correctly
 * configured per tier:
 *   - hobby:      false (custom metrics is a paid feature)
 *   - growth:     true
 *   - team:       true
 *   - enterprise: true
 *
 * Layer: unit (pure config values, no DB or network)
 */

import {
  BOOLEAN_ENTITLEMENTS,
  getBooleanEntitlement,
  TIER_IDS,
  type TierId,
} from '@repo/tier-config';
import { TIER_FIXTURES } from './helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('custom_metrics_enabled entitlement', () => {
  it('should have custom_metrics_enabled false for hobby tier', () => {
    expect(BOOLEAN_ENTITLEMENTS.custom_metrics_enabled.hobby).toBe(false);
    expect(getBooleanEntitlement('custom_metrics_enabled', 'hobby')).toBe(false);
  });

  it('should have custom_metrics_enabled true for growth tier', () => {
    expect(BOOLEAN_ENTITLEMENTS.custom_metrics_enabled.growth).toBe(true);
    expect(getBooleanEntitlement('custom_metrics_enabled', 'growth')).toBe(true);
  });

  it('should have custom_metrics_enabled true for team tier', () => {
    expect(BOOLEAN_ENTITLEMENTS.custom_metrics_enabled.team).toBe(true);
    expect(getBooleanEntitlement('custom_metrics_enabled', 'team')).toBe(true);
  });

  it('should have custom_metrics_enabled true for enterprise tier', () => {
    expect(BOOLEAN_ENTITLEMENTS.custom_metrics_enabled.enterprise).toBe(true);
    expect(getBooleanEntitlement('custom_metrics_enabled', 'enterprise')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-check against TIER_FIXTURES (guards against fixture drift)
  // -------------------------------------------------------------------------

  describe('fixture alignment', () => {
    const tierIds = TIER_IDS as readonly TierId[];

    for (const tier of tierIds) {
      it(`should match TIER_FIXTURES for ${tier} tier`, () => {
        expect(BOOLEAN_ENTITLEMENTS.custom_metrics_enabled[tier]).toBe(
          TIER_FIXTURES[tier].custom_metrics_enabled,
        );
      });
    }
  });
});
