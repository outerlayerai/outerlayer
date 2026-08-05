/**
 * Per-tier Stripe price configuration (server-only).
 *
 * Single source of truth for all Stripe prices per tier.
 * Both createCheckoutSession and upgradeSubscription derive
 * their line items from this config — adding a new price only
 * requires updating TierStripePrices and the config object.
 */

import type { TierId } from './entitlements';
import {
  STRIPE_GROWTH_FLAT_PRICE_ID,
  STRIPE_TEAM_FLAT_PRICE_ID,
  STRIPE_GROWTH_USAGE_PRICE_ID,
  STRIPE_TEAM_USAGE_PRICE_ID,
  STRIPE_GROWTH_STORAGE_PRICE_ID,
  STRIPE_TEAM_STORAGE_PRICE_ID,
} from '../config-global.server';
import type Stripe from 'stripe';

interface TierStripePrices {
  flatPriceId: string;
  /** Metered prices — usage, storage, etc. Adding a new metered dimension = add here. */
  meteredPriceIds: string[];
}

export const TIER_STRIPE_PRICES: Partial<Record<TierId, TierStripePrices>> = {
  growth: {
    flatPriceId: STRIPE_GROWTH_FLAT_PRICE_ID,
    meteredPriceIds: [STRIPE_GROWTH_USAGE_PRICE_ID, STRIPE_GROWTH_STORAGE_PRICE_ID],
  },
  team: {
    flatPriceId: STRIPE_TEAM_FLAT_PRICE_ID,
    meteredPriceIds: [STRIPE_TEAM_USAGE_PRICE_ID, STRIPE_TEAM_STORAGE_PRICE_ID],
  },
};

/**
 * Reverse-lookup: given a flat-rate Price ID from a subscription line item,
 * return the tier it belongs to. Returns undefined if no match.
 */
export function getTierByFlatPriceId(priceId: string): TierId | undefined {
  for (const [tier, prices] of Object.entries(TIER_STRIPE_PRICES)) {
    if (prices?.flatPriceId === priceId) return tier as TierId;
  }
  return undefined;
}

/**
 * Build Stripe checkout line items for a tier.
 * Used by createCheckoutSession.
 */
export function getCheckoutLineItems(tierId: TierId): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const prices = TIER_STRIPE_PRICES[tierId];
  if (!prices) return [];

  return [
    { price: prices.flatPriceId, quantity: 1 },
    ...prices.meteredPriceIds.map((priceId) => ({ price: priceId })),
  ];
}

/**
 * Collect all metered price IDs across all tiers.
 * Used by upgradeSubscription to identify which subscription items are metered.
 */
function getAllMeteredPriceIds(): Set<string> {
  const ids = new Set<string>();
  for (const prices of Object.values(TIER_STRIPE_PRICES)) {
    if (prices) {
      for (const id of prices.meteredPriceIds) ids.add(id);
    }
  }
  return ids;
}

/**
 * Build Stripe subscription update items for a tier change.
 * Matches existing subscription items to the new tier's prices:
 * - Swaps the flat price item
 * - Removes metered items not in the new tier
 * - Adds metered items missing from the current subscription
 *
 * Used by upgradeSubscription.
 */
export function getSubscriptionUpdateItems(
  subscription: Stripe.Subscription,
  tierId: TierId,
): Stripe.SubscriptionUpdateParams.Item[] {
  const newPrices = TIER_STRIPE_PRICES[tierId];
  if (!newPrices) return [];

  const allMeteredPriceIds = getAllMeteredPriceIds();
  const items: Stripe.SubscriptionUpdateParams.Item[] = [];

  // Find and swap the flat price item
  const flatItem = subscription.items.data.find((item) => {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    return getTierByFlatPriceId(priceId) !== undefined;
  });

  if (flatItem) {
    items.push({ id: flatItem.id, price: newPrices.flatPriceId });
  }

  // Handle metered items: remove old ones not in new tier, add missing new ones
  const newMeteredSet = new Set(newPrices.meteredPriceIds);
  const existingMeteredItems = subscription.items.data.filter((item) => {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    return allMeteredPriceIds.has(priceId);
  });

  // Remove metered items not in the new tier
  for (const item of existingMeteredItems) {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    if (!newMeteredSet.has(priceId)) {
      items.push({ id: item.id, deleted: true });
    }
    // If the price is already in the new tier, keep it (no action needed)
    newMeteredSet.delete(priceId);
  }

  // Add metered items that are new (not on existing subscription)
  for (const priceId of newMeteredSet) {
    items.push({ price: priceId });
  }

  return items;
}
