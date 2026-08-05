import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stripe is constructed inside DefaultStripeService/DefaultBillingService. Mock
// the SDK so the real delegation can be asserted without a network client.
let mockCheckoutCreate = vi.fn();
let mockPortalCreate = vi.fn();
let mockMeterList = vi.fn();
let mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = { sessions: { create: (...a: unknown[]) => mockCheckoutCreate(...a) } };
    billingPortal = { sessions: { create: (...a: unknown[]) => mockPortalCreate(...a) } };
    billing = { meters: { listEventSummaries: (...a: unknown[]) => mockMeterList(...a) } };
    webhooks = { constructEvent: (...a: unknown[]) => mockConstructEvent(...a) };
    customers = {};
    subscriptions = {};
  },
}));

// createBillingService reads BILLING_ENABLED from config-global.server. Expose it
// as a getter over a hoisted, mutable value so both factory branches are testable.
const cfg = vi.hoisted(() => ({ billingEnabled: 'true', stripeSecretKey: 'sk_test_123' }));
vi.mock('../../config-global.server', () => ({
  get BILLING_ENABLED() {
    return cfg.billingEnabled;
  },
  // Getter so a test can drive the empty-key (misconfigured hosted) case.
  get STRIPE_SECRET_KEY() {
    return cfg.stripeSecretKey;
  },
}));

import {
  DefaultBillingService,
  MockBillingService,
  createBillingService,
} from '.';

beforeEach(() => {
  cfg.billingEnabled = 'true';
  cfg.stripeSecretKey = 'sk_test_123';
  mockCheckoutCreate = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout' });
  mockPortalCreate = vi.fn().mockResolvedValue({ id: 'bps_1', url: 'https://portal' });
  mockMeterList = vi.fn().mockResolvedValue({ object: 'list', data: [], has_more: false, url: '' });
  mockConstructEvent = vi.fn().mockReturnValue({ id: 'evt_1', type: 'x' });
});

describe('DefaultBillingService — delegates to the Stripe SDK', () => {
  it('createCheckoutSession forwards params and returns the session', async () => {
    const svc = new DefaultBillingService();
    const params = { mode: 'subscription' } as never;
    const res = await svc.createCheckoutSession(params);
    expect(mockCheckoutCreate).toHaveBeenCalledWith(params);
    expect(res).toEqual({ id: 'cs_1', url: 'https://checkout' });
  });

  it('createBillingPortalSession forwards params', async () => {
    const svc = new DefaultBillingService();
    const params = { customer: 'cus_1', return_url: 'https://back' } as never;
    await svc.createBillingPortalSession(params);
    expect(mockPortalCreate).toHaveBeenCalledWith(params);
  });

  it('listMeterEventSummaries forwards meterId + params', async () => {
    const svc = new DefaultBillingService();
    const params = { customer: 'cus_1', start_time: 1, end_time: 2 } as never;
    await svc.listMeterEventSummaries('mtr_1', params);
    expect(mockMeterList).toHaveBeenCalledWith('mtr_1', params);
  });

  it('constructWebhookEvent forwards payload/signature/secret', () => {
    const svc = new DefaultBillingService();
    const evt = svc.constructWebhookEvent('body', 'sig', 'whsec');
    expect(mockConstructEvent).toHaveBeenCalledWith('body', 'sig', 'whsec');
    expect(evt).toEqual({ id: 'evt_1', type: 'x' });
  });

  it('throws a clear error when STRIPE_SECRET_KEY is empty (misconfigured hosted deploy)', () => {
    // config-global coerces the now-optional STRIPE_SECRET_KEY to "" when unset.
    // The real service is only built on the billing-enabled path, so an empty key
    // is a misconfig — construction must fail fast with an actionable message
    // rather than defer to `new Stripe("")` failing deep in the SDK at call time.
    cfg.stripeSecretKey = '';
    expect(() => new DefaultBillingService()).toThrow(/STRIPE_SECRET_KEY is required/);
  });
});

describe('MockBillingService — no-op for self-hosting', () => {
  const svc = new MockBillingService();

  it('throws a clear billing-disabled error for Stripe-required operations', async () => {
    await expect(svc.createCustomer()).rejects.toThrow(/Billing is disabled/);
    await expect(svc.retrieveCustomer()).rejects.toThrow(/Billing is disabled/);
    await expect(svc.retrieveSubscription()).rejects.toThrow(/Billing is disabled/);
    await expect(svc.updateSubscription()).rejects.toThrow(/Billing is disabled/);
    await expect(svc.createCheckoutSession()).rejects.toThrow(/Billing is disabled/);
    await expect(svc.createBillingPortalSession()).rejects.toThrow(/Billing is disabled/);
    expect(() => svc.constructWebhookEvent()).toThrow(/Billing is disabled/);
  });

  it('deleteCustomer is a no-op (rollback path when nothing was created)', async () => {
    await expect(svc.deleteCustomer()).resolves.toBeUndefined();
  });

  it('listMeterEventSummaries returns an empty list so usage panels render zero', async () => {
    const res = await svc.listMeterEventSummaries();
    expect(res.data).toEqual([]);
    expect(res.object).toBe('list');
  });
});

describe('createBillingService — factory selects backend by BILLING_ENABLED', () => {
  it('returns the real Stripe-backed service when billing is enabled', () => {
    cfg.billingEnabled = 'true';
    expect(createBillingService()).toBeInstanceOf(DefaultBillingService);
  });

  it('returns the no-op service when billing is disabled', () => {
    cfg.billingEnabled = 'false';
    expect(createBillingService()).toBeInstanceOf(MockBillingService);
  });
});
