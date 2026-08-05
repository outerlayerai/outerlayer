import "server-only";

/**
 * BillingService — the billing settings page's read + the three Stripe
 * mutations (`public.billing`, supabase/schemas/30-billing.sql).
 *
 * `billing` carries SELECT-only RLS — every write to the row is
 * Stripe-webhook-driven on the admin path, never a user-scoped client — so
 * every read here runs through the caller's RLS-scoped `ctx.db`; a caller
 * without `billing.read` sees nothing rather than another tenant's row. The
 * three mutations talk to Stripe, not the `billing` table, through the
 * `createBillingService()` factory seam — real Stripe in production, a
 * no-op when self-hosted with billing disabled.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { createBillingService, getSpanLimit } from "@/lib/adapters";
import { createTenantReadClient } from "@/lib/analytics/client";
import { analyticsLogger } from "@/lib/analytics/logger";
import { STRIPE_SPAN_METER_ID, STRIPE_STORAGE_METER_ID } from "@/config-global.server";
import {
  TIER_STRIPE_PRICES,
  getCheckoutLineItems,
  getSubscriptionUpdateItems,
} from "@/config/stripe-prices";
import { UNLIMITED } from "@/config/entitlements";
import type { ServiceContext } from "@/lib/action-kit/service-context";

import type { BillingPageState, SpanUsage } from "./types";
import type {
  CreateCheckoutSessionInput,
  UpgradeSubscriptionInput,
  CreatePortalSessionInput,
} from "./schemas";

function db(ctx: ServiceContext): SupabaseClient {
  return ctx.db as SupabaseClient;
}

/** This month's span count for the near-limit banner. A null ClickHouse
 *  client (unconfigured self-host) reads as zero rather than erroring. */
async function getSpanCount(tenantId: string): Promise<number> {
  const clickhouse = createTenantReadClient({ tenantId });
  if (!clickhouse) {
    analyticsLogger.error(
      "billing-span-usage",
      new Error("ClickHouse client not configured — span count defaults to 0"),
    );
    return 0;
  }
  const result = await clickhouse.query({
    query:
      "SELECT COUNT(*) AS count FROM otel_traces WHERE TenantId = {tenantId:String} AND toYYYYMM(CreatedAt) = toYYYYMM(now())",
    query_params: { tenantId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ count: string }>();
  return rows[0] ? Number(rows[0].count) : 0;
}

/** The near-limit banner's data: current span count against the tenant's monthly limit. */
export async function loadSpanUsage(ctx: ServiceContext): Promise<SpanUsage> {
  const [currentCount, limit] = await Promise.all([
    getSpanCount(ctx.tenantId),
    getSpanLimit(ctx),
  ]);
  const unlimited = limit === UNLIMITED;
  const percentUsed = unlimited ? 0 : limit > 0 ? Math.round((currentCount / limit) * 1000) / 10 : 0;
  return { currentCount, limit, unlimited, percentUsed };
}

class BillingService {
  async getPageState(ctx: ServiceContext): Promise<BillingPageState> {
    const billing = createBillingService();

    // Hobby/free tenants have no billing row — maybeSingle returns null
    // without erroring.
    const { data: billingRow, error } = await db(ctx)
      .from("billing")
      .select("stripe_customer_id, stripe_subscription_id, tier_id")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!billingRow) {
      return { units: 0, storageGb: 0, isCancelling: false, tierId: null };
    }

    // Fetch the subscription once so its billing-cycle bounds (for the meter
    // query) and its cancel_at_period_end flag come from a single retrieve.
    let subscription: Stripe.Subscription | null = null;
    if (billingRow.stripe_subscription_id) {
      try {
        subscription = await billing.retrieveSubscription(billingRow.stripe_subscription_id);
      } catch (err) {
        analyticsLogger.error("billing-page-state", err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Billing-cycle bounds live on the subscription items (Stripe moved them
    // off the subscription object in the 2025-03-31 API). Every item on this
    // account's subscriptions shares one cycle (flat tier + usage meters are
    // created together, same anchor), so the first item's bounds are the
    // subscription's bounds. `items` rides along on a plain retrieve.
    // `items?.` (not bare `items.`) for the same reason as the isCancelling
    // truthiness check below: a test double that omits `items` must fall back,
    // not crash the page read.
    const firstItem = subscription?.items?.data[0];
    let periodStart: number;
    let periodEnd: number;
    if (firstItem?.current_period_start && firstItem.current_period_end) {
      periodStart = firstItem.current_period_start;
      periodEnd = firstItem.current_period_end;
    } else {
      const now = new Date();
      periodStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
      periodEnd = Math.floor(now.getTime() / 1000);
    }

    let units = 0;
    let storageGb = 0;
    if (billingRow.stripe_customer_id) {
      try {
        const [unitSummaries, storageSummaries] = await Promise.all([
          billing.listMeterEventSummaries(STRIPE_SPAN_METER_ID, {
            customer: billingRow.stripe_customer_id,
            start_time: periodStart,
            end_time: periodEnd,
          }),
          billing.listMeterEventSummaries(STRIPE_STORAGE_METER_ID, {
            customer: billingRow.stripe_customer_id,
            start_time: periodStart,
            end_time: periodEnd,
          }),
        ]);
        units = unitSummaries.data.reduce((acc, s) => acc + s.aggregated_value, 0);
        storageGb = storageSummaries.data.reduce((acc, s) => acc + s.aggregated_value, 0);
      } catch (err) {
        analyticsLogger.error("billing-page-state", err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Truthiness, not `!== null` — `retrieveSubscription` is Stripe-SDK-typed
    // to never resolve undefined, but a test double or a future SDK version
    // that doesn't hold that contract must not reach `subscription.status`.
    const isCancelling =
      !!subscription &&
      subscription.status !== "canceled" &&
      subscription.cancel_at_period_end === true;

    return {
      units,
      storageGb,
      isCancelling,
      tierId: billingRow.tier_id as BillingPageState["tierId"],
    };
  }

  /**
   * Starts a Stripe Checkout session for a new subscription.
   * `client_reference_id`/`metadata.tenantId` come from `ctx.tenantId` — the
   * request-tenant the action's permission check already authorized against,
   * never the JWT claim, so a multi-org owner's checkout always bills the
   * org they're looking at, never whichever org their session claim names.
   */
  async createCheckoutSession(
    ctx: ServiceContext,
    input: CreateCheckoutSessionInput,
  ): Promise<string> {
    const billing = createBillingService();

    const { data: billingRow, error } = await db(ctx)
      .from("billing")
      .select("stripe_customer_id")
      .eq("tenant_id", ctx.tenantId)
      .single();
    if (error || !billingRow) throw new Error(error?.message ?? "Something went wrong");
    if (!billingRow.stripe_customer_id) {
      throw new Error("Billing is not enabled for this organization");
    }

    const lineItems = getCheckoutLineItems(input.tierId);
    if (lineItems.length === 0) throw new Error("Invalid tier");

    const session = await billing.createCheckoutSession({
      client_reference_id: ctx.tenantId,
      customer: billingRow.stripe_customer_id,
      line_items: lineItems,
      mode: "subscription",
      success_url: `${input.redirectTo}/?success=true`,
      cancel_url: `${input.redirectTo}/?canceled=true`,
      metadata: { tenantId: ctx.tenantId, userId: ctx.actor.userId },
      customer_update: { address: "auto" },
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
    });
    if (!session?.url) throw new Error("Something went wrong");
    return session.url;
  }

  /** Swaps the active subscription's prices to a new tier. */
  async upgradeSubscription(
    ctx: ServiceContext,
    input: UpgradeSubscriptionInput,
  ): Promise<{ success: boolean }> {
    const billing = createBillingService();

    const { data: billingRow, error } = await db(ctx)
      .from("billing")
      .select("stripe_subscription_id")
      .eq("tenant_id", ctx.tenantId)
      .single();
    if (error || !billingRow?.stripe_subscription_id) {
      throw new Error("No active subscription found");
    }
    if (!TIER_STRIPE_PRICES[input.tierId]) throw new Error("Invalid tier");

    let subscription: Stripe.Subscription;
    try {
      subscription = await billing.retrieveSubscription(billingRow.stripe_subscription_id);
    } catch {
      throw new Error("Unable to retrieve subscription details. Please try again or contact support.");
    }

    if (subscription.status === "canceled") throw new Error("subscription_canceled");
    if (subscription.status !== "active" && subscription.status !== "trialing") {
      throw new Error("Subscription is not active. Please visit the billing portal.");
    }

    const updateItems = getSubscriptionUpdateItems(subscription, input.tierId);
    if (updateItems.length === 0) throw new Error("Could not determine subscription changes");

    const updateParams: Stripe.SubscriptionUpdateParams = {
      items: updateItems,
      proration_behavior: "create_prorations",
    };
    if (subscription.cancel_at_period_end) updateParams.cancel_at_period_end = false;

    try {
      await billing.updateSubscription(billingRow.stripe_subscription_id, updateParams);
    } catch {
      throw new Error("Failed to update subscription. Please try again or contact support.");
    }
    return { success: true };
  }

  /** Opens the Stripe billing portal for the tenant's customer. */
  async createPortalSession(ctx: ServiceContext, input: CreatePortalSessionInput): Promise<string> {
    const billing = createBillingService();

    const { data: billingRow, error } = await db(ctx)
      .from("billing")
      .select("stripe_customer_id")
      .eq("tenant_id", ctx.tenantId)
      .single();
    if (error || !billingRow) throw new Error(error?.message ?? "Something went wrong");
    if (!billingRow.stripe_customer_id) {
      throw new Error("Billing is not enabled for this organization");
    }

    const portalSession = await billing.createBillingPortalSession({
      customer: billingRow.stripe_customer_id,
      return_url: input.redirectTo,
    });
    if (!portalSession?.url) throw new Error("Something went wrong");
    return portalSession.url;
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const billingService = new BillingService();
