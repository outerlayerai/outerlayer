import { z } from "zod";

import { TIER_IDS } from "@/config/entitlements";

const tierId = z.enum(TIER_IDS);

/** `createCheckoutSession` — the redirect target plus the tier being purchased. */
export const createCheckoutSessionInput = z.object({
  redirectTo: z.string().min(1),
  tierId,
});
export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionInput>;

/** `upgradeSubscription` — the tier to move the active subscription to. */
export const upgradeSubscriptionInput = z.object({
  tierId,
});
export type UpgradeSubscriptionInput = z.infer<typeof upgradeSubscriptionInput>;

/** `createPortalSession` — the URL Stripe returns the customer to on exit. */
export const createPortalSessionInput = z.object({
  redirectTo: z.string().min(1),
});
export type CreatePortalSessionInput = z.infer<typeof createPortalSessionInput>;

/** `getBillingPageState` takes no input — the tenant comes from the request context. */
export const getBillingPageStateInput = z.object({});
