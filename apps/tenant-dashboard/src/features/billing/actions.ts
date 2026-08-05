"use server";

import { authorizedAction } from "@/lib/action-kit";

import { billingService } from "./service";
import {
  createCheckoutSessionInput,
  upgradeSubscriptionInput,
  createPortalSessionInput,
  getBillingPageStateInput,
} from "./schemas";

/**
 * Starts a Stripe Checkout session for a new subscription. Gated
 * `billing.insert` (creates the subscription relationship) — owner-only per
 * seed. The permission check runs against the request-resolved tenant, so a
 * multi-org owner acting on org B always transacts against B, never whatever
 * tenant their JWT claim happens to name.
 */
export const createCheckoutSession = authorizedAction({
  input: createCheckoutSessionInput,
  permission: "billing.insert",
  handler: (ctx, input) => billingService.createCheckoutSession(ctx, input),
});

/** Swaps the active subscription's tier. Gated `billing.update`. */
export const upgradeSubscription = authorizedAction({
  input: upgradeSubscriptionInput,
  permission: "billing.update",
  handler: (ctx, input) => billingService.upgradeSubscription(ctx, input),
});

/**
 * The billing settings page's read: tier, Stripe meter usage, and the
 * span-usage banner data. Gated `billing.read` — every seeded role holds it,
 * so a custom role that omits it is the only actor this denies.
 */
export const getBillingPageState = authorizedAction({
  input: getBillingPageStateInput,
  permission: "billing.read",
  handler: (ctx) => billingService.getPageState(ctx),
});

/** Opens the Stripe billing portal. Gated `billing.update`. */
export const createPortalSession = authorizedAction({
  input: createPortalSessionInput,
  permission: "billing.update",
  handler: (ctx, input) => billingService.createPortalSession(ctx, input),
});
