/**
 * BillingService — the billing page read + the three Stripe mutations. The
 * `billing` table read runs for real against MSW (no query-chain mocks);
 * Stripe itself is mocked at the `createBillingService()` seam so these
 * assert the service's own logic (line-item assembly, period selection,
 * partial-failure tolerance), not the Stripe SDK.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";
import type { ServiceContext } from "@/lib/action-kit/service-context";

const { createBillingServiceMock, getSpanLimitMock, createTenantReadClientMock } = vi.hoisted(() => ({
  createBillingServiceMock: vi.fn(),
  getSpanLimitMock: vi.fn(),
  createTenantReadClientMock: vi.fn(() => null as unknown),
}));
vi.mock("@/lib/adapters", () => ({
  createBillingService: createBillingServiceMock,
  getSpanLimit: getSpanLimitMock,
}));

vi.mock("@/lib/analytics/client", () => ({
  createTenantReadClient: createTenantReadClientMock,
}));

vi.mock("@/config-global.server", () => ({
  STRIPE_GROWTH_FLAT_PRICE_ID: "price_growth_flat",
  STRIPE_TEAM_FLAT_PRICE_ID: "price_team_flat",
  STRIPE_GROWTH_USAGE_PRICE_ID: "price_growth_usage",
  STRIPE_TEAM_USAGE_PRICE_ID: "price_team_usage",
  STRIPE_GROWTH_STORAGE_PRICE_ID: "price_growth_storage",
  STRIPE_TEAM_STORAGE_PRICE_ID: "price_team_storage",
  STRIPE_SPAN_METER_ID: "meter_1",
  STRIPE_STORAGE_METER_ID: "meter_2",
}));

import { billingService, loadSpanUsage } from "./service";

const TENANT_ID = "tenant-1";

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: TENANT_ID, actor: { userId: "user-1", role: "owner" } };
}

function stripeMock(overrides: Record<string, unknown> = {}) {
  const billing = {
    createCheckoutSession: vi.fn(),
    createBillingPortalSession: vi.fn(),
    listMeterEventSummaries: vi.fn(),
    retrieveSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    ...overrides,
  };
  createBillingServiceMock.mockReturnValue(billing);
  return billing;
}

beforeEach(() => {
  getSpanLimitMock.mockResolvedValue(-1);
  createTenantReadClientMock.mockReturnValue(null);
});

describe("BillingService.getPageState", () => {
  it("returns combined usage, cancelling status, and tierId on the happy path", async () => {
    seedSupabaseMswState({
      billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", tier_id: "growth" }],
    });
    const billing = stripeMock();
    billing.listMeterEventSummaries
      .mockResolvedValueOnce({ data: [{ aggregated_value: 100 }, { aggregated_value: 50 }] })
      .mockResolvedValueOnce({ data: [{ aggregated_value: 2.5 }] });
    billing.retrieveSubscription.mockResolvedValue({ status: "active", cancel_at_period_end: true });

    const result = await billingService.getPageState(ctx());

    expect(result).toMatchObject({ units: 150, storageGb: 2.5, isCancelling: true, tierId: "growth" });
  });

  it("tolerates a subscription-retrieve failure — isCancelling defaults false, usage still returned", async () => {
    seedSupabaseMswState({
      billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123", stripe_subscription_id: "sub_bad", tier_id: "team" }],
    });
    const billing = stripeMock();
    billing.listMeterEventSummaries
      .mockResolvedValueOnce({ data: [{ aggregated_value: 42 }] })
      .mockResolvedValueOnce({ data: [{ aggregated_value: 1 }] });
    billing.retrieveSubscription.mockRejectedValue(new Error("stripe down"));

    const result = await billingService.getPageState(ctx());

    expect(result).toMatchObject({ units: 42, storageGb: 1, isCancelling: false, tierId: "team" });
  });

  it("returns defaults without error when the tenant has no billing row (hobby/free)", async () => {
    seedSupabaseMswState({ billing: [] });
    const billing = stripeMock();

    const result = await billingService.getPageState(ctx());

    expect(result).toMatchObject({ units: 0, storageGb: 0, isCancelling: false, tierId: null });
    expect(billing.retrieveSubscription).not.toHaveBeenCalled();
    expect(billing.listMeterEventSummaries).not.toHaveBeenCalled();
  });

  it("queries meter summaries using the subscription's current billing period, not calendar month", async () => {
    seedSupabaseMswState({
      billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", tier_id: "growth" }],
    });
    const billing = stripeMock();
    const currentPeriodStart = 1_700_000_000;
    const currentPeriodEnd = 1_702_592_000;
    billing.retrieveSubscription.mockResolvedValue({
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
          },
        ],
      },
    });
    billing.listMeterEventSummaries
      .mockResolvedValueOnce({ data: [{ aggregated_value: 10 }] })
      .mockResolvedValueOnce({ data: [{ aggregated_value: 0.5 }] });

    await billingService.getPageState(ctx());

    expect(billing.listMeterEventSummaries).toHaveBeenCalledTimes(2);
    for (const call of billing.listMeterEventSummaries.mock.calls) {
      expect(call[1]).toMatchObject({ start_time: currentPeriodStart, end_time: currentPeriodEnd });
    }
  });

  it("falls back to the calendar-month window when the subscription item lacks full period bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T15:30:00Z"));
    try {
      seedSupabaseMswState({
        billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", tier_id: "growth" }],
      });
      const billing = stripeMock();
      // start without end: a half-specified period must not produce a
      // half-real query window — the fallback takes over entirely.
      billing.retrieveSubscription.mockResolvedValue({
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ current_period_start: 1_700_000_000 }] },
      });
      billing.listMeterEventSummaries
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] });

      await billingService.getPageState(ctx());

      expect(billing.listMeterEventSummaries).toHaveBeenCalledTimes(2);
      for (const call of billing.listMeterEventSummaries.mock.calls) {
        expect(call[1]).toMatchObject({
          start_time: Math.floor(Date.UTC(2026, 7, 1) / 1000),
          end_time: Math.floor(Date.parse("2026-08-04T15:30:00Z") / 1000),
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("loadSpanUsage", () => {
  it("defaults currentCount to 0 when ClickHouse is unconfigured, still returning the entitlement limit", async () => {
    getSpanLimitMock.mockResolvedValue(20000);

    const result = await loadSpanUsage(ctx());

    expect(result).toEqual({ currentCount: 0, limit: 20000, unlimited: false, percentUsed: 0 });
  });

  it("counts real spans through a configured ClickHouse client, scoped to the request tenant", async () => {
    getSpanLimitMock.mockResolvedValue(1000);
    const queryMock = vi.fn().mockResolvedValue({ json: async () => [{ count: "250" }] });
    createTenantReadClientMock.mockReturnValue({ query: queryMock });

    const result = await loadSpanUsage(ctx());

    expect(createTenantReadClientMock).toHaveBeenCalledWith({ tenantId: TENANT_ID });
    const [queryArgs] = queryMock.mock.calls[0]!;
    expect(queryArgs.query_params).toEqual({ tenantId: TENANT_ID });
    expect(result).toEqual({ currentCount: 250, limit: 1000, unlimited: false, percentUsed: 25 });
  });
});

describe("BillingService.createCheckoutSession", () => {
  beforeEach(() => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123" }] });
  });

  it("passes tenant + tier line items to Stripe and returns the url", async () => {
    const billing = stripeMock();
    billing.createCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/c/ok" });

    const url = await billingService.createCheckoutSession(ctx(), {
      redirectTo: "https://app.example.com",
      tierId: "growth",
    });

    expect(url).toBe("https://checkout.stripe.com/c/ok");
    expect(billing.createCheckoutSession).toHaveBeenCalledTimes(1);
    const params = billing.createCheckoutSession.mock.calls[0]![0];
    expect(params).toMatchObject({
      client_reference_id: TENANT_ID,
      customer: "cus_123",
      mode: "subscription",
      success_url: "https://app.example.com/?success=true",
      cancel_url: "https://app.example.com/?canceled=true",
      metadata: { tenantId: TENANT_ID, userId: "user-1" },
    });
    expect(params.line_items).toEqual([
      { price: "price_growth_flat", quantity: 1 },
      { price: "price_growth_usage" },
      { price: "price_growth_storage" },
    ]);
  });

  it("rejects an invalid tier before creating a session", async () => {
    const billing = stripeMock();

    await expect(
      billingService.createCheckoutSession(ctx(), { redirectTo: "https://app.example.com", tierId: "hobby" as never }),
    ).rejects.toThrow("Invalid tier");
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses when the org has no Stripe customer (billing disabled)", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_customer_id: null }] });
    const billing = stripeMock();

    await expect(
      billingService.createCheckoutSession(ctx(), { redirectTo: "https://app.example.com", tierId: "growth" }),
    ).rejects.toThrow("Billing is not enabled for this organization");
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("surfaces the lookup failure when no billing row matches the tenant", async () => {
    seedSupabaseMswState({ billing: [] });
    const billing = stripeMock();

    // The exact message is MSW/PostgREST transport text, not a literal this
    // service owns — the behavioral contract is that the lookup failure
    // rejects instead of proceeding to a Stripe call with no customer id.
    await expect(
      billingService.createCheckoutSession(ctx(), { redirectTo: "https://app.example.com", tierId: "growth" }),
    ).rejects.toThrow();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("BillingService.upgradeSubscription", () => {
  const activeGrowthSub = {
    id: "sub_123",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ id: "si_flat", price: { id: "price_growth_flat" } }] },
  };

  beforeEach(() => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_subscription_id: "sub_123" }] });
  });

  it("returns 'No active subscription found' when billing has no subscription id", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_subscription_id: null }] });
    const billing = stripeMock();

    await expect(billingService.upgradeSubscription(ctx(), { tierId: "team" })).rejects.toThrow(
      "No active subscription found",
    );
    expect(billing.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("rejects a tier with no Stripe price config", async () => {
    const billing = stripeMock();
    await expect(billingService.upgradeSubscription(ctx(), { tierId: "hobby" as never })).rejects.toThrow(
      "Invalid tier",
    );
    expect(billing.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("returns a support message when Stripe retrieve throws", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockRejectedValue(new Error("stripe 500"));

    await expect(billingService.upgradeSubscription(ctx(), { tierId: "team" })).rejects.toThrow(
      "Unable to retrieve subscription details. Please try again or contact support.",
    );
  });

  it("throws subscription_canceled for a canceled subscription", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockResolvedValue({ ...activeGrowthSub, status: "canceled" });

    await expect(billingService.upgradeSubscription(ctx(), { tierId: "team" })).rejects.toThrow(
      "subscription_canceled",
    );
    expect(billing.updateSubscription).not.toHaveBeenCalled();
  });

  it("refuses an inactive (e.g. past_due) subscription and points to the portal", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockResolvedValue({ ...activeGrowthSub, status: "past_due" });

    await expect(billingService.upgradeSubscription(ctx(), { tierId: "team" })).rejects.toThrow(
      "Subscription is not active. Please visit the billing portal.",
    );
    expect(billing.updateSubscription).not.toHaveBeenCalled();
  });

  it("updates the subscription with swapped items and create_prorations, returning success", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockResolvedValue(activeGrowthSub);
    billing.updateSubscription.mockResolvedValue({ id: "sub_123" });

    const result = await billingService.upgradeSubscription(ctx(), { tierId: "team" });

    expect(result).toEqual({ success: true });
    expect(billing.updateSubscription).toHaveBeenCalledTimes(1);
    const [subId, params] = billing.updateSubscription.mock.calls[0]!;
    expect(subId).toBe("sub_123");
    expect(params.proration_behavior).toBe("create_prorations");
    expect(params.items).toEqual(
      expect.arrayContaining([
        { id: "si_flat", price: "price_team_flat" },
        { price: "price_team_usage" },
        { price: "price_team_storage" },
      ]),
    );
    expect(params.cancel_at_period_end).toBeUndefined();
  });

  it("reactivates (cancel_at_period_end: false) when the sub was scheduled to cancel", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockResolvedValue({ ...activeGrowthSub, cancel_at_period_end: true });
    billing.updateSubscription.mockResolvedValue({ id: "sub_123" });

    await billingService.upgradeSubscription(ctx(), { tierId: "team" });

    const [, params] = billing.updateSubscription.mock.calls[0]!;
    expect(params.cancel_at_period_end).toBe(false);
  });

  it("returns a support message when Stripe update throws", async () => {
    const billing = stripeMock();
    billing.retrieveSubscription.mockResolvedValue(activeGrowthSub);
    billing.updateSubscription.mockRejectedValue(new Error("update failed"));

    await expect(billingService.upgradeSubscription(ctx(), { tierId: "team" })).rejects.toThrow(
      "Failed to update subscription. Please try again or contact support.",
    );
  });
});

describe("BillingService.createPortalSession", () => {
  it("passes the customer + return_url to Stripe", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_customer_id: "cus_123" }] });
    const billing = stripeMock();
    billing.createBillingPortalSession.mockResolvedValue({ url: "https://billing.stripe.com/p/ok" });

    const url = await billingService.createPortalSession(ctx(), { redirectTo: "https://app.example.com/back" });

    expect(url).toBe("https://billing.stripe.com/p/ok");
    expect(billing.createBillingPortalSession).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://app.example.com/back",
    });
  });

  it("refuses when the org has no Stripe customer (billing disabled)", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT_ID, stripe_customer_id: null }] });
    const billing = stripeMock();

    await expect(
      billingService.createPortalSession(ctx(), { redirectTo: "https://app.example.com" }),
    ).rejects.toThrow("Billing is not enabled for this organization");
    expect(billing.createBillingPortalSession).not.toHaveBeenCalled();
  });

  it("surfaces the lookup failure when no billing row matches the tenant", async () => {
    seedSupabaseMswState({ billing: [] });
    const billing = stripeMock();

    // The exact message is MSW/PostgREST transport text, not a literal this
    // service owns — the behavioral contract is that the lookup failure
    // rejects instead of proceeding to a Stripe call with no customer id.
    await expect(
      billingService.createPortalSession(ctx(), { redirectTo: "https://app.example.com" }),
    ).rejects.toThrow();
    expect(billing.createBillingPortalSession).not.toHaveBeenCalled();
  });
});
