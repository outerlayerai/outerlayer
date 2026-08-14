// These modules are imported by route.ts but not needed for getTierIdFromSubscription tests
vi.mock('../../../../config-global.server', () => ({
  BILLING_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_SECRET_WEBHOOK_KEY: 'whsec_test',
  STRIPE_GROWTH_FLAT_PRICE_ID: 'price_growth_flat',
  STRIPE_TEAM_FLAT_PRICE_ID: 'price_team_flat',
  STRIPE_GROWTH_USAGE_PRICE_ID: 'price_growth_usage',
  STRIPE_TEAM_USAGE_PRICE_ID: 'price_team_usage',
  STRIPE_GROWTH_STORAGE_PRICE_ID: 'price_growth_storage',
  STRIPE_TEAM_STORAGE_PRICE_ID: 'price_team_storage',
  STRIPE_STORAGE_METER_ID: 'mtr_test_storage',
}));
vi.mock('../../../../lib/observability/server-logger', () => ({
  serverLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));
// Webhook verification now routes through the BillingService seam. Mock the
// factory to return a service whose constructWebhookEvent delegates to a mutable
// mock the tests can swap.
let mockConstructEvent = vi.fn();
vi.mock('../../../../lib/external-services', () => ({
  createBillingService: vi.fn(() => ({
    constructWebhookEvent: (...args: unknown[]) => mockConstructEvent(...args),
  })),
}));
// resolveBillingConfig gates the handler — default enabled; a test flips it to
// exercise the billing-disabled short-circuit. vi.hoisted so the value exists
// when the hoisted vi.mock factory runs.
const { mockResolveBilling } = vi.hoisted(() => ({
  mockResolveBilling: vi.fn(() => ({ enabled: true })),
}));
vi.mock('../../../../lib/external-services/billing-config', () => ({
  resolveBillingConfig: mockResolveBilling,
}));

import type Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import * as supabaseAdminClientModule from '../../../../supabaseAdminClient';
import { serverLogger } from '../../../../lib/observability/server-logger';
import { NotificationTypes } from '../../../../utils/notifications';
import { getTierIdFromSubscription, POST } from './route';

// --- Helpers ---

function makeSub(priceIds: string[]): Stripe.Subscription {
  return {
    items: {
      data: priceIds.map((id) => ({ price: { id } })),
    },
  } as unknown as Stripe.Subscription;
}

/**
 * Build a fake Stripe event object for webhook testing.
 */
function makeStripeEvent(
  type: string,
  subscription: Partial<Stripe.Subscription>,
): Stripe.Event {
  return {
    id: `evt_test_${Date.now()}`,
    type,
    data: { object: subscription },
  } as unknown as Stripe.Event;
}

/**
 * Build a chainable Supabase mock with configurable return values.
 *
 * The handler uses multiple Supabase call patterns:
 *   - .from().select().eq().single()           (read billing row)
 *   - .from().update().eq().select().single()  (update + return row)
 *   - .from().update().eq()                    (update without return)
 *   - .from().insert()                         (insert notification)
 *
 * We build a self-referencing chainable object where every method returns
 * itself (except terminal methods like .single() and .insert()).
 */
function createChainableSupabaseMock(overrides?: {
  selectResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
}) {
  const selectResult = overrides?.selectResult ?? { data: { tenant_id: 'tenant-123' }, error: null };
  const updateResult = overrides?.updateResult ?? { data: { tenant_id: 'tenant-123' }, error: null };
  const insertResult = overrides?.insertResult ?? { data: null, error: null };

  const singleFn = vi.fn().mockResolvedValue(selectResult);
  const insertFn = vi.fn().mockResolvedValue(insertResult);

  // A self-referencing chain object: every chainable method returns itself,
  // terminal methods (.single(), .insert()) return promises.
  // Also thenable so `await chain.update().eq()` resolves to updateResult.
  const chain: Record<string, unknown> = {};
  const selectFn = vi.fn().mockReturnValue(chain);
  const updateFn = vi.fn().mockReturnValue(chain);
  const eqFn = vi.fn().mockReturnValue(chain);

  Object.assign(chain, {
    select: selectFn,
    update: updateFn,
    eq: eqFn,
    single: singleFn,
    insert: insertFn,
    // Make the chain itself thenable for `await .update().eq()`
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(updateResult).then(resolve, reject),
  });

  const fromFn = vi.fn().mockReturnValue(chain);

  return {
    fromFn,
    selectFn,
    updateFn,
    insertFn,
    eqFn,
    singleFn,
  };
}

/**
 * Sets up the shared mockConstructEvent to return the given event.
 */
function setupStripeMock(event: Stripe.Event) {
  mockConstructEvent = vi.fn().mockReturnValue(event);
}

/**
 * Sets up headers mock to return a fake signature.
 */
function setupHeadersMock() {
  const headersMock = headers as unknown as ReturnType<typeof vi.fn>;
  headersMock.mockResolvedValue({
    get: vi.fn().mockReturnValue('sig_test_123'),
  });
}

/**
 * Creates a NextRequest suitable for the POST handler.
 */
function makeRequest(body = '{}') {
  return new NextRequest('http://localhost/api/webhooks/payment', {
    method: 'POST',
    body,
  });
}

// --- Tests: getTierIdFromSubscription ---

describe('getTierIdFromSubscription', () => {
  it('returns growth when flat price matches growth', () => {
    const result = getTierIdFromSubscription(makeSub(['price_growth_flat', 'price_usage']));
    expect(result).toBe('growth');
  });

  it('returns team when flat price matches team', () => {
    const result = getTierIdFromSubscription(makeSub(['price_team_flat', 'price_usage']));
    expect(result).toBe('team');
  });

  it('returns hobby when no price IDs match any tier', () => {
    const result = getTierIdFromSubscription(makeSub(['price_unknown', 'price_usage']));
    expect(result).toBe('hobby');
  });

  it('returns hobby when subscription has no line items', () => {
    const result = getTierIdFromSubscription(makeSub([]));
    expect(result).toBe('hobby');
  });

  it('matches even if flat price is not the first line item', () => {
    const result = getTierIdFromSubscription(makeSub(['price_usage', 'price_team_flat']));
    expect(result).toBe('team');
  });
});

// --- Tests: POST webhook handler ---

describe('POST webhook handler', () => {
  beforeEach(() => {
    setupHeadersMock();
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
      from: vi.fn(),
    } as any);
  });

  describe('customer.subscription.created', () => {
    it('should update billing with the new subscription id and tier on success', async () => {
      const event = makeStripeEvent('customer.subscription.created', {
        id: 'sub_new',
        customer: 'cus_123',
        items: { data: [{ price: { id: 'price_growth_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, singleFn, updateFn } = createChainableSupabaseMock({
        updateResult: { data: { tenant_id: 'tenant-abc' }, error: null },
      });
      // For the update().eq().select().single() chain:
      singleFn.mockResolvedValue({ data: { tenant_id: 'tenant-abc' }, error: null });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The created path writes the live sub id + derived tier onto billing.
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: 'sub_new',
        tier_id: 'growth',
      });
    });

    it('should return 200 and skip setup when billing record is not found', async () => {
      const event = makeStripeEvent('customer.subscription.created', {
        id: 'sub_new',
        customer: 'cus_missing',
        items: { data: [{ price: { id: 'price_growth_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, singleFn } = createChainableSupabaseMock();
      singleFn.mockResolvedValue({
        data: null,
        error: { message: 'Row not found', code: 'PGRST116' },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(serverLogger.info).toHaveBeenCalledWith(
        'Billing record not found for created subscription — skipping setup',
        expect.objectContaining({ stripeCustomerId: 'cus_missing' }),
      );
    });
  });

  describe('customer.subscription.deleted', () => {
    it('should clear subscription, reset tier, and notify user', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_to_delete',
        customer: 'cus_456',
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, insertFn, updateFn } = createChainableSupabaseMock({
        selectResult: {
          data: { tenant_id: 'tenant-xyz', stripe_subscription_id: 'sub_to_delete' },
          error: null,
        },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // Cancellation clears the billing sub id and resets to the free tier.
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: null,
        tier_id: 'hobby',
      });
      // Verify the cancellation notification was inserted for this tenant.
      expect(insertFn).toHaveBeenCalledWith({
        tenant_id: 'tenant-xyz',
        message:
          'Your subscription was cancelled. Please subscribe again or contact support to keep using the app',
        type: NotificationTypes.Warning,
      });
    });

    it('should not notify or clear billing when delete event is for a stale (already-replaced) subscription', async () => {
      // Cancel-then-resub flow: user cancelled sub_old at period end, then subscribed
      // to sub_new. ~XX days later, Stripe fires `subscription.deleted` for sub_old.
      // The tenant's billing row already points at sub_new, so this delete event must
      // not wipe their active billing row or push a "cancelled" notification.
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_old',
        customer: 'cus_456',
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, insertFn, updateFn } = createChainableSupabaseMock({
        selectResult: {
          data: { tenant_id: 'tenant-xyz', stripe_subscription_id: 'sub_new' },
          error: null,
        },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(insertFn).not.toHaveBeenCalled();
      expect(updateFn).not.toHaveBeenCalled();
      expect(serverLogger.info).toHaveBeenCalledWith(
        'Deleted subscription is not the tenant\'s current subscription — skipping cleanup',
        expect.objectContaining({
          deletedSubscriptionId: 'sub_old',
          currentSubscriptionId: 'sub_new',
        }),
      );
    });

    it('should return 200 and skip cleanup when billing record is not found for deleted subscription', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_orphan',
        customer: 'cus_nonexistent',
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, singleFn, insertFn } = createChainableSupabaseMock();
      singleFn.mockResolvedValue({
        data: null,
        error: { message: 'Row not found', code: 'PGRST116' },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(insertFn).not.toHaveBeenCalled();
      expect(serverLogger.info).toHaveBeenCalledWith(
        'Billing record not found for deleted subscription — skipping cleanup',
        expect.objectContaining({ stripeCustomerId: 'cus_nonexistent' }),
      );
    });

    it('should throw when stripeCustomerId is missing from deleted subscription', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_no_customer',
        customer: undefined,
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn } = createChainableSupabaseMock();
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      await expect(POST(makeRequest())).rejects.toThrow(
        'Something went wrong on subscription delete'
      );
    });
  });

  describe('customer.subscription.updated', () => {
    it('should set billing sub id and tier for an active subscription', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_updated',
        customer: 'cus_789',
        status: 'active',
        items: { data: [{ price: { id: 'price_team_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, updateFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-789' }, error: null },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // Active sub → billing keeps the live sub id (the gateway's paying signal).
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: 'sub_updated',
        tier_id: 'team',
      });
    });

    // proves AC-059-11
    it('should clear billing.stripe_subscription_id for a non-paying status', async () => {
      // canceled / incomplete_expired / unpaid: Stripe still surfaces the sub id
      // via subscription.updated, but the user no longer deserves paid rate limits.
      // The billing column is the gateway's paying signal, so it MUST be nulled.
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_canceled',
        customer: 'cus_789',
        status: 'canceled',
        items: { data: [{ price: { id: 'price_team_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, updateFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-789' }, error: null },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: null,
        tier_id: 'team',
      });
    });

    // The billing.stripe_subscription_id column IS the gateway's "paying?"
    // signal: set to the real id only while the sub is entitlement-bearing,
    // else NULL. Parameterized so a mutant that writes
    // the id unconditionally (or nulls it unconditionally) dies on one row.
    it.each([
      { status: 'active' as const, paying: true },
      { status: 'trialing' as const, paying: true },
      { status: 'past_due' as const, paying: true },
      { status: 'canceled' as const, paying: false },
      { status: 'unpaid' as const, paying: false },
      { status: 'incomplete_expired' as const, paying: false },
    ])('writes billing.stripe_subscription_id=$paying-gated for status=$status', async ({ status, paying }) => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_param',
        customer: 'cus_param',
        status,
        items: { data: [{ price: { id: 'price_team_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, updateFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-param' }, error: null },
      });
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: paying ? 'sub_param' : null,
        tier_id: 'team',
      });
    });

    it('should default to hobby when updated subscription has unknown price', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_updated_unknown',
        customer: 'cus_789',
        status: 'active',
        items: { data: [{ price: { id: 'price_unknown_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, updateFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-789' }, error: null },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(updateFn).toHaveBeenCalledWith({
        stripe_subscription_id: 'sub_updated_unknown',
        tier_id: 'hobby',
      });
    });

    it('should skip and log when billing record is missing for updated subscription', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_orphan_update',
        customer: 'cus_no_billing',
        status: 'active',
        items: { data: [{ price: { id: 'price_team_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn } = createChainableSupabaseMock({
        selectResult: { data: null, error: { message: 'Row not found', code: 'PGRST116' } },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(serverLogger.info).toHaveBeenCalledWith(
        'Billing record not found for updated subscription — skipping',
        expect.objectContaining({ stripeCustomerId: 'cus_no_billing' }),
      );
    });
  });

  describe('error handling', () => {
    it('should return 400 when Stripe signature verification fails', async () => {
      mockConstructEvent = vi.fn().mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const { fromFn } = createChainableSupabaseMock();
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('Webhook Error');
    });

    it('should return 200 for unhandled event types', async () => {
      const event = makeStripeEvent('invoice.paid', {});
      setupStripeMock(event);

      const { fromFn } = createChainableSupabaseMock();
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(consoleSpy).toHaveBeenCalledWith('Unhandled event type invoice.paid');
      consoleSpy.mockRestore();
    });

    it('should return 200 even when Supabase update fails on subscription.deleted', async () => {
      // Documents current behavior: no error check on the billing update
      // in the deleted handler path. The update error is silently ignored
      // because the code doesn't check the return value.
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_db_fail',
        customer: 'cus_db_fail',
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      // updateResult contains an error, but the handler doesn't check it
      const { fromFn } = createChainableSupabaseMock({
        selectResult: {
          data: { tenant_id: 'tenant-db-fail', stripe_subscription_id: 'sub_db_fail' },
          error: null,
        },
        updateResult: {
          data: null,
          error: { message: 'Database connection lost', code: '08001' },
        },
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      // The handler currently does not check the Supabase .update() error,
      // so it returns 200 even if the update fails.
      const response = await POST(makeRequest());
      expect(response.status).toBe(200);
    });

    it('handles duplicate subscription.updated deliveries safely via naturally idempotent ops', async () => {
      // Stripe retries on 5xx and occasionally redelivers on success.
      // Rather than an event-id ledger, the handler relies on every op in
      // the subscription.updated path being naturally idempotent:
      //   - billing.update().eq('stripe_customer_id', ...) converges to
      //     the same row state on repeat (PostgREST treats UPDATE to
      //     identical values as a no-op at the row level)
      //   - no notification.insert in this path
      // Stripe's own guidance permits state-validation as an alternative
      // to ledger-style dedup when ops are idempotent. This test pins
      // both halves of that contract: the second call DOES re-run the
      // ops (no dedup), but with identical args, so user-visible state
      // is the same as a single delivery.
      // https://docs.stripe.com/webhooks#handle-duplicate-events
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_idem',
        customer: 'cus_idem',
        status: 'active',
        items: { data: [{ price: { id: 'price_growth_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, updateFn, insertFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-idem' }, error: null },
      });
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      // Two deliveries — Stripe's standard retry pattern.
      const r1 = await POST(makeRequest());
      const r2 = await POST(makeRequest());

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Both deliveries hit billing.update with IDENTICAL args. If a
      // future refactor varies the args across deliveries (e.g. computing
      // tier_id from wall-clock time), this fails — that's the bug class
      // this test guards.
      expect(updateFn).toHaveBeenCalledTimes(2);
      expect(updateFn).toHaveBeenNthCalledWith(1, {
        stripe_subscription_id: 'sub_idem',
        tier_id: 'growth',
      });
      expect(updateFn).toHaveBeenNthCalledWith(2, {
        stripe_subscription_id: 'sub_idem',
        tier_id: 'growth',
      });

      // subscription.updated has NO notification.insert. Pinning this
      // assertion guards against a future change that adds a non-idempotent
      // side effect here without also adding a dedup mechanism.
      expect(insertFn).not.toHaveBeenCalled();
    });

    it('handles subscription.deleted retry: stale-sub guard short-circuits after first processing', async () => {
      // A real Stripe retry for the SAME event_id. After the first POST
      // sets billing.stripe_subscription_id to NULL, the second POST sees
      // NULL !== 'sub_xyz' at the stale-sub guard (route.ts:76) and breaks
      // out of the switch — no second billing update, no duplicate
      // cancellation notification.
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_retry',
        customer: 'cus_retry',
        items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn, singleFn, insertFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-retry', stripe_subscription_id: 'sub_retry' }, error: null },
      });
      // Queue per-call responses — Vitest's mockResolvedValueOnce values are
      // consumed in order, so the first POST sees the live sub_id and the
      // second POST sees NULL (the state after first-delivery processing).
      singleFn.mockResolvedValueOnce({
        data: { tenant_id: 'tenant-retry', stripe_subscription_id: 'sub_retry' },
        error: null,
      });
      singleFn.mockResolvedValueOnce({
        data: { tenant_id: 'tenant-retry', stripe_subscription_id: null },
        error: null,
      });

      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const r1 = await POST(makeRequest());
      const r2 = await POST(makeRequest());

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // The cancellation notification.insert fired EXACTLY ONCE across both
      // deliveries. The second delivery hit the stale-sub guard and skipped
      // the side-effect block entirely.
      expect(insertFn).toHaveBeenCalledTimes(1);

      // The skip log fires on the second delivery — pinning this guards
      // against a refactor that drops the guard (or its log) silently.
      expect(serverLogger.info).toHaveBeenCalledWith(
        'Deleted subscription is not the tenant\'s current subscription — skipping cleanup',
        expect.objectContaining({
          stripeCustomerId: 'cus_retry',
          deletedSubscriptionId: 'sub_retry',
          currentSubscriptionId: null,
        }),
      );
    });

    it('should return 400 without invoking constructEvent when stripe-signature header is missing', async () => {
      // Header explicitly null — the fast-fail check must catch this before
      // we hand a null signature to Stripe's SDK, which would otherwise throw
      // a generic "No signatures found" with no indication of the real cause.
      const headersMock = headers as unknown as ReturnType<typeof vi.fn>;
      headersMock.mockResolvedValue({
        get: vi.fn().mockReturnValue(null),
      });

      // Reset constructEvent so we can assert it was NEVER called.
      mockConstructEvent = vi.fn();

      const { fromFn } = createChainableSupabaseMock();
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toBe('Webhook Error: missing stripe-signature header');
      // The handler must short-circuit BEFORE signature verification — otherwise
      // the error surface would depend on Stripe SDK internals.
      expect(mockConstructEvent).not.toHaveBeenCalled();
    });

    it('should pass raw body, signature, and webhook secret to constructEvent', async () => {
      // Pin the contract that constructEvent is invoked with the FULL payload —
      // not a parsed/re-serialized version (which would break HMAC) and with
      // the actual signature header + secret (not hardcoded test values that
      // happen to make Stripe's SDK accept them). Without this, a refactor
      // that JSON.parses the body before passing it through would silently
      // disable signature verification.
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_args_check',
        customer: 'cus_args_check',
        status: 'active',
        items: { data: [{ price: { id: 'price_growth_flat' } }] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });
      setupStripeMock(event);

      const { fromFn } = createChainableSupabaseMock({
        selectResult: { data: { tenant_id: 'tenant-args' }, error: null },
      });
      vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue({
        from: fromFn,
      } as any);

      const rawBody = '{"id":"evt_args_check","type":"customer.subscription.updated"}';
      await POST(makeRequest(rawBody));

      expect(mockConstructEvent).toHaveBeenCalledTimes(1);
      expect(mockConstructEvent).toHaveBeenCalledWith(
        rawBody,
        'sig_test_123',
        'whsec_test',
      );
    });

    it('short-circuits with 200 and never verifies when billing is disabled', async () => {
      // Self-hosting (BILLING_ENABLED=false): no Stripe, so any stray delivery
      // is acknowledged with 200 and signature verification is never attempted.
      mockResolveBilling.mockReturnValueOnce({ enabled: false });
      mockConstructEvent = vi.fn();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockConstructEvent).not.toHaveBeenCalled();
    });
  });
});
