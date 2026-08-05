/**
 * Synthetic-customer guard tests.
 *
 * Bug classes guarded:
 *  - a fixture id from EITHER seeding convention is recognised (a dropped
 *    prefix would let that family page the critical usage-meter DLQ alert again)
 *  - a REAL Stripe id is never mis-flagged — including the adversarial case of a
 *    live id whose random token happens to begin with the letters "test" but,
 *    like every real id, carries no second underscore. Over-matching here would
 *    silently STOP metering a paying customer, the exact failure this guard must
 *    not introduce.
 */

import { describe, it, expect } from 'vitest';
import {
  isSyntheticStripeCustomerId,
  SYNTHETIC_STRIPE_CUSTOMER_PREFIXES,
} from './synthetic-customer';

describe('isSyntheticStripeCustomerId', () => {
  it('flags both seeding conventions, including their exact seeded shapes', () => {
    const synthetic = [
      // apps/e2e/scripts/seed-staging-fixture.ts — cus_e2e_fixture_${tenantId}
      'cus_e2e_fixture_b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      // apps/e2e/tests/utils/test-helpers.ts — cus_test_${Date.now()}_${rand}
      'cus_test_1783968621000_a1b2c3d4',
      // apps/integration-tests span-limit fixtures — cus_test_hobby_/growth_
      'cus_test_hobby_9f8e7d6c',
      'cus_test_growth_1a2b3c4d',
    ];
    expect(synthetic.map(isSyntheticStripeCustomerId)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('does NOT flag real Stripe ids, including a live token that starts with "test"', () => {
    const real = [
      'cus_NffrFeUfNV2Hib', // canonical live-mode id
      'cus_Qz1AbcdefGhijk', // test-mode id (still no underscore)
      'cus_testAbc123Xyz', // random token BEGINS with "test" but has no 2nd "_"
      'cus_e2eFixtureNope', // begins with "e2e" but not the "cus_e2e_fixture_" marker
      '', // empty id must not match
    ];
    expect(real.map(isSyntheticStripeCustomerId)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('pins the exact prefix set (a silent add/drop changes who gets metered)', () => {
    expect(SYNTHETIC_STRIPE_CUSTOMER_PREFIXES).toEqual([
      'cus_test_',
      'cus_e2e_fixture_',
    ]);
  });
});
