import { describe, it, expect, vi } from 'vitest';

vi.mock('../config-global.server', () => ({
  STRIPE_GROWTH_FLAT_PRICE_ID: 'price_growth_flat',
  STRIPE_TEAM_FLAT_PRICE_ID: 'price_team_flat',
  STRIPE_GROWTH_USAGE_PRICE_ID: 'price_growth_usage',
  STRIPE_TEAM_USAGE_PRICE_ID: 'price_team_usage',
  STRIPE_GROWTH_STORAGE_PRICE_ID: 'price_growth_storage',
  STRIPE_TEAM_STORAGE_PRICE_ID: 'price_team_storage',
}));

import {
  getCheckoutLineItems,
  getSubscriptionUpdateItems,
  getTierByFlatPriceId,
} from './stripe-prices';
import type Stripe from 'stripe';

describe('getCheckoutLineItems', () => {
  it('should return flat + all metered prices for growth', () => {
    const items = getCheckoutLineItems('growth');

    expect(items).toEqual([
      { price: 'price_growth_flat', quantity: 1 },
      { price: 'price_growth_usage' },
      { price: 'price_growth_storage' },
    ]);
  });

  it('should return flat + all metered prices for team', () => {
    const items = getCheckoutLineItems('team');

    expect(items).toEqual([
      { price: 'price_team_flat', quantity: 1 },
      { price: 'price_team_usage' },
      { price: 'price_team_storage' },
    ]);
  });

  it('should return empty array for hobby (no stripe prices)', () => {
    const items = getCheckoutLineItems('hobby');
    expect(items).toEqual([]);
  });
});

describe('getSubscriptionUpdateItems', () => {
  // Stripe returns each item's `price` either as an expanded object ({ id })
  // or as a bare price-id string, depending on the `expand` param. The code
  // normalizes both via `typeof price === 'string' ? price : price.id`, so we
  // exercise BOTH forms — a test that only ever uses one lets a mutant that
  // drops the branch survive undetected.
  function mockSubscription(
    items: { id: string; priceId: string }[],
    opts: { priceAsString?: boolean } = {},
  ): Stripe.Subscription {
    return {
      items: {
        data: items.map((i) => ({
          id: i.id,
          price: opts.priceAsString ? i.priceId : { id: i.priceId },
        })),
      },
    } as unknown as Stripe.Subscription;
  }

  const GROWTH_SUB = [
    { id: 'si_flat', priceId: 'price_growth_flat' },
    { id: 'si_usage', priceId: 'price_growth_usage' },
    { id: 'si_storage', priceId: 'price_growth_storage' },
  ];

  // Exact, order-sensitive plan: flat swap first, then existing-metered
  // removals in subscription order, then newly-added metered in tier order.
  // Exact `toEqual` (not `toContainEqual`) pins count + order + contents, so a
  // mutant that drops/duplicates an item or mis-routes a price is caught.
  const GROWTH_TO_TEAM = [
    { id: 'si_flat', price: 'price_team_flat' },
    { id: 'si_usage', deleted: true },
    { id: 'si_storage', deleted: true },
    { price: 'price_team_usage' },
    { price: 'price_team_storage' },
  ];

  it('swaps flat, removes old metered, and adds new metered (expanded price objects)', () => {
    expect(getSubscriptionUpdateItems(mockSubscription(GROWTH_SUB), 'team')).toEqual(GROWTH_TO_TEAM);
  });

  it('produces the identical plan when Stripe returns price as a bare id string', () => {
    // Pins the `typeof price === 'string'` branch: with string prices the code
    // must read item.price directly, not item.price.id (which would be undefined
    // and silently drop the flat swap + all metered handling).
    expect(
      getSubscriptionUpdateItems(mockSubscription(GROWTH_SUB, { priceAsString: true }), 'team'),
    ).toEqual(GROWTH_TO_TEAM);
  });

  it('adds a metered price missing from a pre-storage subscriber', () => {
    const sub = mockSubscription([
      { id: 'si_flat', priceId: 'price_growth_flat' },
      { id: 'si_usage', priceId: 'price_growth_usage' },
    ]);

    expect(getSubscriptionUpdateItems(sub, 'team')).toEqual([
      { id: 'si_flat', price: 'price_team_flat' },
      { id: 'si_usage', deleted: true },
      { price: 'price_team_usage' },
      { price: 'price_team_storage' },
    ]);
  });

  it('keeps metered items already on the target tier (no delete, no re-add)', () => {
    // Re-applying the same tier must NOT delete or duplicate the shared metered
    // items — pins the `if (!newMeteredSet.has(priceId))` keep branch. A mutant
    // that always deletes (or never keeps) changes this exact result.
    const sub = mockSubscription([
      { id: 'si_flat', priceId: 'price_team_flat' },
      { id: 'si_usage', priceId: 'price_team_usage' },
      { id: 'si_storage', priceId: 'price_team_storage' },
    ]);

    expect(getSubscriptionUpdateItems(sub, 'team')).toEqual([
      { id: 'si_flat', price: 'price_team_flat' },
    ]);
  });

  it('returns an empty array for a tier with no Stripe prices', () => {
    expect(getSubscriptionUpdateItems(mockSubscription([]), 'hobby')).toEqual([]);
  });
});

describe('getTierByFlatPriceId', () => {
  it('should return growth for growth flat price', () => {
    expect(getTierByFlatPriceId('price_growth_flat')).toBe('growth');
  });

  it('should return team for team flat price', () => {
    expect(getTierByFlatPriceId('price_team_flat')).toBe('team');
  });

  it('should return undefined for unknown price', () => {
    expect(getTierByFlatPriceId('price_unknown')).toBeUndefined();
  });
});
