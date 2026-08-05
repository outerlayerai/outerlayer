/**
 * Billing settings acceptance — tenant + permission scoping for the
 * checkout, upgrade, portal, and page-state actions.
 *
 * Drives the real `createCheckoutSession`/`upgradeSubscription`/
 * `createPortalSession`/`getBillingPageState` Server Actions through the
 * session-cookie fixture: real auth, real `authorize()` RPC against the real
 * local Postgres/RLS, real `billing` table reads. Only the Stripe SDK itself
 * is mocked, at the `createBillingService()` factory seam — the same seam
 * the unit suite (`features/billing/service.test.ts`) mocks, but here it
 * sits behind the real action → real permission-check → real service
 * pipeline instead of a hand-built `ServiceContext`.
 *
 * The forbidden cases never reach Stripe at all: `authorizedAction` checks
 * the permission before calling the handler, so a denial short-circuits
 * ahead of any `createBillingService()` call — no live-Stripe dependency.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import {
  createTenantWithOwner,
  createCrossTenantUser,
  createBillingRecord,
  cleanupTenantsAndUsers,
  type TenantUser,
} from './helpers';

const { createCheckoutSessionMock, createBillingPortalSessionMock, retrieveSubscriptionMock, createBillingServiceMock } =
  vi.hoisted(() => {
    const createCheckoutSessionMock = vi.fn();
    const createBillingPortalSessionMock = vi.fn();
    const retrieveSubscriptionMock = vi.fn();
    const billingDouble = {
      createCheckoutSession: createCheckoutSessionMock,
      createBillingPortalSession: createBillingPortalSessionMock,
      listMeterEventSummaries: vi.fn().mockResolvedValue({ object: 'list', data: [], has_more: false, url: '' }),
      retrieveSubscription: retrieveSubscriptionMock,
      updateSubscription: vi.fn(),
      createCustomer: vi.fn(),
      retrieveCustomer: vi.fn(),
      deleteCustomer: vi.fn(),
      constructWebhookEvent: vi.fn(),
    };
    return {
      createCheckoutSessionMock,
      createBillingPortalSessionMock,
      retrieveSubscriptionMock,
      createBillingServiceMock: vi.fn(() => billingDouble),
    };
  });

// Mocks the one sub-module `lib/adapters/billing.ts` re-exports from, not the
// whole `@/lib/adapters` barrel — `loadRequestServiceContext`/
// `checkRequestPermission` (also from that barrel) must stay real so the
// tenancy/permission wiring under test is real.
vi.mock('@/lib/adapters/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tenant-dashboard/src/lib/adapters/billing')>();
  return { ...actual, createBillingService: createBillingServiceMock };
});

import { createCheckoutSession, upgradeSubscription, createPortalSession, getBillingPageState } from '@/features/billing/actions';
import { ActionErrorCodes } from '@/lib/action-kit';

describe('billing settings acceptance — tenant + permission scoping', () => {
  const admin = createSupabaseAdminClient();

  let orgA: TenantUser; // owner of A only
  let orgB: TenantUser; // owner of B only
  let dualOwner: TenantUser; // owner of B (home/claim tenant) AND owner of A
  let ownerAReaderB: TenantUser; // owner of A (home/claim tenant), read-only in B
  let readerNoAccess: TenantUser; // owner of a third tenant, no membership anywhere else

  const ORG_A_SUBSCRIPTION_ID = 'sub_org_a';
  const ORG_B_SUBSCRIPTION_ID = 'sub_org_b';

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    readerNoAccess = await createTenantWithOwner();

    dualOwner = await createCrossTenantUser(
      [
        { tenantId: orgB.tenantId, role: 'owner' },
        { tenantId: orgA.tenantId, role: 'owner' },
      ],
      'dual-owner',
    );
    ownerAReaderB = await createCrossTenantUser(
      [
        { tenantId: orgA.tenantId, role: 'owner' },
        { tenantId: orgB.tenantId, role: 'read' },
      ],
      'owner-a-reader-b',
    );

    // A and B get DIFFERENT tiers, customer ids, and subscription ids so a
    // claim-tenant regression (resolving B's row instead of A's) produces a
    // visibly wrong value rather than an accidental match.
    await createBillingRecord(admin, orgA.tenantId, 'hobby', orgA.id, {
      stripeCustomerId: 'cus_org_a',
      stripeSubscriptionId: ORG_A_SUBSCRIPTION_ID,
    });
    await createBillingRecord(admin, orgB.tenantId, 'team', orgB.id, {
      stripeCustomerId: 'cus_org_b',
      stripeSubscriptionId: ORG_B_SUBSCRIPTION_ID,
    });
  }, 90000);

  afterEach(() => {
    resetRequestScope();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanupTenantsAndUsers(
      [orgA.tenantId, orgB.tenantId, readerNoAccess.tenantId],
      [orgA, orgB, readerNoAccess, dualOwner, ownerAReaderB],
    );
  });

  // proves BL-1
  it('checkout pins client_reference_id/metadata to the request tenant, never the signed-in claim', async () => {
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://stripe.test/checkout/sess_1' });

    // dualOwner's JWT claim names org B (their home/signup tenant); the
    // request is for org A, where they also hold a real owner membership.
    await actAsInOrg(dualOwner, orgA.tenantId);
    const result = await createCheckoutSession({
      redirectTo: 'https://app.test/orgs/org-a/settings/billing',
      tierId: 'growth',
    });

    expect(result).toEqual({ ok: true, data: 'https://stripe.test/checkout/sess_1' });
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    const [params] = createCheckoutSessionMock.mock.calls[0]!;
    expect(params).toEqual(
      expect.objectContaining({
        client_reference_id: orgA.tenantId,
        metadata: { tenantId: orgA.tenantId, userId: dualOwner.id },
      }),
    );
    // The claim's tenant (org B) never appears anywhere in the Stripe call.
    expect(params.client_reference_id).not.toBe(orgB.tenantId);
    expect(params.metadata.tenantId).not.toBe(orgB.tenantId);
  });

  it('getBillingPageState, resolved for the dual-membership actor under org A, returns A\'s tier, never B\'s', async () => {
    // org A's billing row carries a subscription id, so getPageState retrieves
    // it — give the double an explicit resolution rather than relying on
    // whatever the previous test left behind.
    retrieveSubscriptionMock.mockResolvedValue({ status: 'active', cancel_at_period_end: false });

    await actAsInOrg(dualOwner, orgA.tenantId);
    const result = await getBillingPageState({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tierId).toBe('hobby');
    expect(result.data.tierId).not.toBe('team'); // org B's (the claim tenant's) tier
  });

  it('createPortalSession, resolved for the dual-membership actor under org A, opens a portal for A\'s Stripe customer, never B\'s', async () => {
    createBillingPortalSessionMock.mockResolvedValue({ url: 'https://stripe.test/portal/sess_1' });

    await actAsInOrg(dualOwner, orgA.tenantId);
    const result = await createPortalSession({ redirectTo: 'https://app.test' });

    expect(result).toEqual({ ok: true, data: 'https://stripe.test/portal/sess_1' });
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_org_a' }),
    );
  });

  it('upgradeSubscription, resolved for the dual-membership actor under org A, looks up A\'s subscription, never B\'s', async () => {
    // The subscription lookup runs before any update-item assembly, so a
    // rejection here still proves which tenant's subscription id was used —
    // the assertion on `retrieveSubscriptionMock`'s call args is the point.
    retrieveSubscriptionMock.mockRejectedValue(new Error('stripe down'));

    await actAsInOrg(dualOwner, orgA.tenantId);
    const result = await upgradeSubscription({ tierId: 'team' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ActionErrorCodes.INTERNAL,
        message: 'Unable to retrieve subscription details. Please try again or contact support.',
      },
    });
    expect(retrieveSubscriptionMock).toHaveBeenCalledWith(ORG_A_SUBSCRIPTION_ID);
    expect(retrieveSubscriptionMock).not.toHaveBeenCalledWith(ORG_B_SUBSCRIPTION_ID);
  });

  // proves BL-2
  it('an owner-of-A/read-only-in-B actor is forbidden on all three mutations under org B', async () => {
    await actAsInOrg(ownerAReaderB, orgB.tenantId);

    const checkout = await createCheckoutSession({ redirectTo: 'https://app.test', tierId: 'growth' });
    const upgrade = await upgradeSubscription({ tierId: 'team' });
    const portal = await createPortalSession({ redirectTo: 'https://app.test' });

    expect(checkout).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: billing.insert' },
    });
    expect(upgrade).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: billing.update' },
    });
    expect(portal).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: billing.update' },
    });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  // proves BL-3
  it('getBillingPageState requires billing.read — denied for a non-member, granted for an owner', async () => {
    // A user with no membership in org A at all (fail-closed on the read too).
    await actAsInOrg(readerNoAccess, orgA.tenantId);
    const denied = await getBillingPageState({});
    expect(denied).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: billing.read' },
    });

    // org A's billing row carries a subscription id, so getPageState
    // retrieves it — an explicit stub, not ordering-dependent on an earlier
    // test's mock state (`clearAllMocks` in afterEach clears calls, not
    // implementations already set by a mockResolvedValue elsewhere).
    retrieveSubscriptionMock.mockResolvedValue({ status: 'active', cancel_at_period_end: false });

    // The owner of A holds billing.read (every role does per the seed) — a
    // denied read here would mean the gate this action adds is over-broad.
    await actAsInOrg(orgA, orgA.tenantId);
    const granted = await getBillingPageState({});
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.data.tierId).toBe('hobby');
  });

  // proves BL-4
  it('a non-member of B gets forbidden on every billing action under B, even with a valid membership elsewhere', async () => {
    // orgA's owner is not a member of org B at all — the spoof/fail-closed case.
    await actAsInOrg(orgA, orgB.tenantId);

    const checkout = await createCheckoutSession({ redirectTo: 'https://app.test', tierId: 'growth' });
    const upgrade = await upgradeSubscription({ tierId: 'team' });
    const portal = await createPortalSession({ redirectTo: 'https://app.test' });
    const pageState = await getBillingPageState({});

    for (const result of [checkout, upgrade, portal, pageState]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(ActionErrorCodes.FORBIDDEN);
    }
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
