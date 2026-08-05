import type Stripe from "stripe";
import { createSupabaseAdminClient } from "../../../../supabaseAdminClient";
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import {
  STRIPE_SECRET_WEBHOOK_KEY,
  BILLING_ENABLED,
} from "../../../../config-global.server";
import { resolveBillingConfig } from "../../../../lib/external-services/billing-config";
import { createBillingService } from "../../../../lib/external-services";
import { serverLogger } from "../../../../lib/observability/server-logger";
import { NotificationTypes } from "../../../../utils/notifications";
import type { TierId } from "../../../../config/entitlements";
import { getTierByFlatPriceId } from "../../../../config/stripe-prices";

/**
 * Determines the tier from a subscription by matching its flat-rate
 * Price ID against our known tier→price mapping. Falls back to 'hobby'.
 */
export function getTierIdFromSubscription(
  subscription: Stripe.Subscription,
): TierId {
  for (const item of subscription.items.data) {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    const tier = getTierByFlatPriceId(priceId);
    if (tier) return tier;
  }
  return 'hobby';
}

export async function POST(request: NextRequest) {
  // Billing disabled (self-hosting): no Stripe means no webhooks. Short-circuit
  // with a 200 so any stray delivery is acknowledged without touching Stripe.
  if (!resolveBillingConfig({ BILLING_ENABLED }).enabled) {
    return new Response("Billing disabled", { status: 200 });
  }

  const billing = createBillingService();
  const supabaseAdmin = createSupabaseAdminClient();
  const body = await request.text();
  const sig = (await headers()).get("stripe-signature");

  // Fast-fail on missing signature — surfaces a specific error instead of
  // letting Stripe's SDK throw an opaque "No signatures found matching the
  // expected signature" from constructEvent.
  if (!sig) {
    return new Response("Webhook Error: missing stripe-signature header", {
      status: 400,
    });
  }

  let event: Stripe.Event;
  try {
    event = billing.constructWebhookEvent(
      body,
      sig,
      STRIPE_SECRET_WEBHOOK_KEY
    );
  } catch (err) {
    return new Response(`Webhook Error: ${err}`, {
      status: 400,
    });
  }

  // No explicit event-id ledger: every operation in the switch below is
  // already idempotent. billing.update().eq("stripe_customer_id", ...)
  // converges to the same row state on retry, and the deleted-subscription
  // path is gated by the
  // "stale subscription" guard (billing.stripe_subscription_id !== id)
  // which short-circuits any retry that arrives after the first has
  // already cleared the row. See route.test.ts for the verification tests.
  // The remaining narrow race — two simultaneous deliveries hitting
  // separate Vercel function instances within ~50ms — is bounded to
  // duplicate notification.insert (no double-billing, no auth bypass).
  // Stripe's own guidance permits state-validation as an alternative to
  // an event-id ledger when operations are naturally idempotent:
  // https://docs.stripe.com/webhooks#handle-duplicate-events

  switch (event.type) {
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;
      if (!stripeCustomerId) {
        throw new Error("Something went wrong on subscription delete");
      }
      const { data: billingData, error: billingError } = await supabaseAdmin
        .from("billing")
        .select("tenant_id, stripe_subscription_id")
        .eq("stripe_customer_id", stripeCustomerId as string)
        .single();
      if (billingError || !billingData) {
        await serverLogger.info("Billing record not found for deleted subscription — skipping cleanup", {
          stripeCustomerId,
          subscriptionId: subscription.id,
          error: billingError,
        });
        break;
      }
      // Stripe fires `subscription.deleted` for an old subscription when its grace
      // period ends — including after the user has already resubscribed to a new plan.
      // Only clear the row + notify if the deleted sub is the one we're currently tracking.
      if (billingData.stripe_subscription_id !== subscription.id) {
        await serverLogger.info("Deleted subscription is not the tenant's current subscription — skipping cleanup", {
          stripeCustomerId,
          deletedSubscriptionId: subscription.id,
          currentSubscriptionId: billingData.stripe_subscription_id,
        });
        break;
      }
      await supabaseAdmin
        .from("billing")
        .update({
          stripe_subscription_id: null,
          tier_id: 'hobby',
        })
        .eq("stripe_subscription_id", subscription.id);
      await supabaseAdmin.from("notification").insert({
        tenant_id: billingData.tenant_id,
        message:
          "Your subscription was cancelled. Please subscribe again or contact support to keep using the app",
        type: NotificationTypes.Warning,
      });
      break;
    }
    case "customer.subscription.created": {
      const customerSubscription = event.data.object;
      const stripeSubscriptionId =
        customerSubscription.id as string;
      const customerId = customerSubscription.customer;
      const tierId = getTierIdFromSubscription(customerSubscription);

      const { data, error } = await supabaseAdmin
        .from("billing")
        .update({
          stripe_subscription_id: stripeSubscriptionId,
          tier_id: tierId,
        })
        .eq("stripe_customer_id", customerId as string)
        .select()
        .single();

      if (error || !data) {
        await serverLogger.info("Billing record not found for created subscription — skipping setup", {
          stripeCustomerId: customerId,
          stripeSubscriptionId,
          tierId,
          error,
        });
        break;
      }
      break;
    }
    case "customer.subscription.updated": {
      const updatedSubscription = event.data.object;
      const customerId = updatedSubscription.customer;
      const tierId = getTierIdFromSubscription(updatedSubscription);

      // A subscription is entitlement-bearing only in these statuses. The
      // gateway reads billing.stripe_subscription_id directly as the "is this
      // tenant paying?" signal, so a non-paying status (canceled, unpaid,
      // incomplete_expired) must clear the column — otherwise a lapsed sub keeps
      // reading as PAID. Without this, reactivation flows (cancel-at-period-end →
      // active, past_due → active, plan changes after a prior cancel) only fire
      // `updated` and leave a stale id — which is how tenants ended up billed-as-
      // paying while canceled.
      const PAYING_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
        'active',
        'trialing',
        'past_due',
      ];
      const isPaying = PAYING_STATUSES.includes(updatedSubscription.status);

      const { data, error } = await supabaseAdmin
        .from("billing")
        .update({
          stripe_subscription_id: isPaying ? updatedSubscription.id : null,
          tier_id: tierId,
        })
        .eq("stripe_customer_id", customerId as string)
        .select()
        .single();

      if (error || !data) {
        await serverLogger.info("Billing record not found for updated subscription — skipping", {
          stripeCustomerId: customerId,
          subscriptionId: updatedSubscription.id,
          error,
        });
        break;
      }

      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  return new Response("Success", {
    status: 200,
  });
}
