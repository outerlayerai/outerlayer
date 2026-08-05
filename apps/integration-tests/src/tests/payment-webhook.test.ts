/**
 * Integration test: Stripe payment webhook → billing.tier_id, against a REAL
 * Supabase database with REAL Stripe signature verification.
 *
 * The dashboard's route.test.ts unit-tests this handler with `constructEvent`
 * and the entire Supabase chain MOCKED — so it proves the branch logic but NOT:
 *   - that a correctly-signed body actually clears Stripe's HMAC verification
 *     (`constructEvent` is the real SDK here), nor
 *   - that `.update({ tier_id }).eq("stripe_customer_id", X)` resolves the right
 *     tenant's row and persists the tier in Postgres (real DB here).
 * That real-signature + real-DB hop runs nowhere else automated (the full
 * @billing-live e2e is excluded from CD); this test closes it, running in the
 * `parallel` project that CI's integration shards execute on every PR.
 *
 * Two seams stay mocked, by necessity (not to dodge coverage):
 *   - next/headers — `headers()` needs a Next request scope that doesn't exist
 *     when POST is invoked directly; we inject the REAL signed header through it.
 *   - utils/unkey — Unkey is an external service with no local instance; the
 *     tier write is what's under test, not the identity sync.
 *
 * Stripe env values (secret + price ids) come from test-setup.ts's mock of
 * `tenant-dashboard/src/env`; we reuse the same literals to sign + to choose
 * the price that maps to each tier.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../lib/test-utils';

// next/headers is aliased to a stub in vitest.config (see the stub's comment for
// why an alias, not vi.mock); inject the signature through it. Unkey is an
// external service with no local instance — the tier write is what's under test.
import { __setHeader } from '../stubs/next-headers';

vi.mock('tenant-dashboard/src/utils/unkey', () => ({
  updateUnkeyIdentityMeta: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from 'tenant-dashboard/src/app/api/webhooks/payment/route';

// Must match test-setup.ts's mocked `tenant-dashboard/src/env`.
const WEBHOOK_SECRET = 'whsec_test_webhook_key';
const GROWTH_PRICE = 'price_test_growth_flat';
const TEAM_PRICE = 'price_test_team_flat';

// No apiVersion pin: this client only signs test payloads
// (generateTestHeaderString), which is version-independent.
const stripe = new Stripe('sk_test_stripe_secret_key');

// The handler is typed against tenant-dashboard's own `next` install; cast our
// (separate) NextRequest instance to the parameter type it expects. They're
// structurally identical — the handler only calls `.text()`.
type PostRequest = Parameters<typeof POST>[0];

function subscriptionEvent(
  type: string,
  opts: { customer: string; subId: string; priceId?: string; status?: string },
) {
  return {
    id: `evt_${opts.subId}`,
    object: 'event',
    type,
    data: {
      object: {
        id: opts.subId,
        object: 'subscription',
        customer: opts.customer,
        status: opts.status ?? 'active',
        items: { data: opts.priceId ? [{ price: { id: opts.priceId } }] : [] },
      },
    },
  };
}

/** Build a POST request whose body carries a REAL Stripe-signed header. */
function signedRequest(event: Record<string, unknown>): PostRequest {
  const body = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET });
  __setHeader('stripe-signature', header);
  return new NextRequest('http://localhost/api/webhooks/payment', {
    method: 'POST',
    body,
  }) as unknown as PostRequest;
}

describe('payment webhook → tier (real Supabase + real signature)', () => {
  const admin = createSupabaseAdminClient();
  let user: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  const customerId = `cus_webhook_${crypto.randomUUID()}`;

  beforeAll(async () => {
    user = await createAuthenticatedUser('owner');
    const { error } = await admin.from('billing').insert({
      tenant_id: user.tenantId,
      stripe_customer_id: customerId,
      tier_id: 'hobby',
      created_by: user.id,
    });
    if (error) throw new Error(`seed billing failed: ${error.message}`);
  });

  afterAll(async () => {
    await admin.from('notification').delete().eq('tenant_id', user.tenantId);
    await admin.from('billing').delete().eq('tenant_id', user.tenantId);
    await cleanupTestUsers();
  });

  const billingRow = async () =>
    (
      await admin
        .from('billing')
        .select('tier_id, stripe_subscription_id')
        .eq('tenant_id', user.tenantId)
        .single()
    ).data;

  // Ordered: the events mirror a real subscription lifecycle on one tenant.
  it('subscription.created with the growth flat price persists tier_id=growth', async () => {
    const res = await POST(
      signedRequest(
        subscriptionEvent('customer.subscription.created', {
          customer: customerId,
          subId: 'sub_growth',
          priceId: GROWTH_PRICE,
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await billingRow()).toEqual({ tier_id: 'growth', stripe_subscription_id: 'sub_growth' });
  });

  it('subscription.updated to the team flat price flips that customer to tier_id=team', async () => {
    const res = await POST(
      signedRequest(
        subscriptionEvent('customer.subscription.updated', {
          customer: customerId,
          subId: 'sub_team',
          priceId: TEAM_PRICE,
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await billingRow()).toEqual({ tier_id: 'team', stripe_subscription_id: 'sub_team' });
  });

  it('subscription.deleted of the current sub resets the tenant to hobby and clears the sub id', async () => {
    const res = await POST(
      signedRequest(
        subscriptionEvent('customer.subscription.deleted', {
          customer: customerId,
          subId: 'sub_team',
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await billingRow()).toEqual({ tier_id: 'hobby', stripe_subscription_id: null });
  });

  it('rejects a tampered signature with 400 and leaves the tier untouched', async () => {
    const body = JSON.stringify(
      subscriptionEvent('customer.subscription.updated', {
        customer: customerId,
        subId: 'sub_forged',
        priceId: TEAM_PRICE,
      }),
    );
    __setHeader('stripe-signature', 't=1,v1=deadbeef'); // not produced by WEBHOOK_SECRET
    const res = await POST(
      new NextRequest('http://localhost/api/webhooks/payment', {
        method: 'POST',
        body,
      }) as unknown as PostRequest,
    );
    expect(res.status).toBe(400);
    // The forged event must NOT have written a team tier — still hobby from above.
    expect((await billingRow())?.tier_id).toBe('hobby');
  });
});
