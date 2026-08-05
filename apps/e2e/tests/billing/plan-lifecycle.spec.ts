/**
 * Critical-path E2E: the billing PLAN LIFECYCLE — subscribe to Growth, upgrade
 * to Team, then cancel — against REAL Stripe test mode + the REAL payment
 * webhook.
 *
 * Best-practice note (why this doesn't drive Stripe's hosted Checkout/Portal):
 * Stripe owns those pages and changes them, so automating their DOM is
 * chronically flaky — Stripe's own guidance is to use the test API + webhooks.
 * So:
 *   - The state changes go through the real Stripe test API (create/cancel a
 *     subscription) and the dashboard's real `/api/webhooks/payment` handler,
 *     delivered locally by `stripe listen` (or Stripe's public endpoint on
 *     staging). This exercises signature verification + the price→tier mapping.
 *   - The Growth→Team UPGRADE is driven through our OWN first-party dialog
 *     (`upgradeSubscription`), not Stripe's page — so a real UI flow is covered
 *     without the brittle third-party DOM.
 *   - The one inherently-hosted step (first subscribe) is seeded via the API.
 *
 * Local prerequisites:
 *   - `stripe listen --forward-to localhost:3002/api/webhooks/payment` running,
 *     and the dashboard started with the matching `STRIPE_SECRET_WEBHOOK_KEY`.
 *   - The dashboard + this spec configured with the REAL test-mode Growth/Team
 *     flat price IDs (STRIPE_GROWTH_FLAT_PRICE_ID / STRIPE_TEAM_FLAT_PRICE_ID);
 *     `.env.local` ships placeholders.
 *   - A test secret key in STRIPE_TEST_SECRET_KEY / STRIPE_SECRET_KEY.
 *
 * Tagged @billing-live and excluded from chromium-staging via playwright.config
 * (it would churn real test subscriptions on staging's Stripe account every run).
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  getSupabaseAdmin,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  loginTestUser,
  uniqueToken,
  TIMEOUTS,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';
import {
  hasStripeTestKey,
  createTestStripeCustomer,
  createTestSubscription,
  cancelTestSubscription,
  deleteTestStripeCustomer,
} from '../utils/billing-stripe';
import { expectCustomRolesGate } from '../utils/entitlement-helpers';

const FIRST_COMPILE_GOTO_TIMEOUT = 90_000;
const GROWTH_PRICE = process.env.STRIPE_GROWTH_FLAT_PRICE_ID;
const WEBHOOK_TIMEOUT = 60_000;

async function waitForBillingLoaded(page: import('@playwright/test').Page) {
  await expect(page.locator('[class*="MuiSkeleton"]').first()).toBeHidden({
    timeout: TIMEOUTS.MEDIUM,
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('Billing — plan lifecycle (real Stripe test + webhook) @billing-live', () => {
  // Extra headroom over the original 180s: the entitlement-gate checks add a
  // cold first-compile of the roles route plus a few warm navigations on top of
  // the real-Stripe webhook round-trips.
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!(await waitForSupabase())) throw new Error('Supabase not ready');
    // Hard requirements, not graceful skips — a silently-skipped billing test is
    // worse than none. Both come from the test Stripe account / staging config.
    if (!hasStripeTestKey()) {
      throw new Error('STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET_KEY) must be a sk_test_* key.');
    }
    if (!GROWTH_PRICE) {
      throw new Error('STRIPE_GROWTH_FLAT_PRICE_ID must be the REAL test-mode Growth flat price id.');
    }
  });

  let user: TestUser | null = null;
  let org: TestOrganization | null = null;
  let customerId: string | null = null;
  let subId: string | null = null;

  test.afterEach(async ({ page }) => {
    await page.close();
    cancelTestSubscription(subId);
    deleteTestStripeCustomer(customerId);
    // The subscription.deleted webhook inserts a notification row that FK-blocks
    // tenant deletion, so clear it before the standard org cleanup.
    if (org) {
      await getSupabaseAdmin().from('notification').delete().eq('tenant_id', org.tenantId);
    }
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
    user = null;
    org = null;
    customerId = null;
    subId = null;
  });

  test('subscribe to Growth, upgrade to Team in-app, then cancel — reflected in the billing UI', async ({
    page,
  }) => {
    const r = await createTestOwnerWithOrg('e2e-billing-live');
    user = r.user;
    org = r.org;
    const admin = getSupabaseAdmin();
    const tenantId = org.tenantId;
    const url = `/orgs/${org.organizationName}/settings/billing`;
    const rolesUrl = `/orgs/${org.organizationName}/settings/roles`;

    // The billing row seeds a fake cus_* — replace it with a real test customer
    // (with a default card) so real subscriptions + the webhook can resolve it.
    const customer = createTestStripeCustomer(`e2e-billing-${uniqueToken()}@test.example.com`);
    customerId = customer.id;
    const { error: custErr } = await admin
      .from('billing')
      .update({ stripe_customer_id: customer.id })
      .eq('tenant_id', tenantId);
    if (custErr) throw new Error(`billing customer update failed: ${custErr.message}`);

    const tierId = async () =>
      (await admin.from('billing').select('tier_id').eq('tenant_id', tenantId).single()).data?.tier_id;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });

    // --- Start: hobby (no subscription) → setup view ---
    await page.goto(url, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await waitForBillingLoaded(page);
    await expect(page.getByText('Ready to upgrade?')).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });

    // --- 1. Subscribe to Growth via the Stripe test API → webhook flips tier ---
    const sub = createTestSubscription(customer.id, GROWTH_PRICE!);
    subId = sub.id;
    await expect
      .poll(tierId, { timeout: WEBHOOK_TIMEOUT, intervals: [1000, 2000, 3000, 5000] })
      .toBe('growth');

    await page.goto(url, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await waitForBillingLoaded(page);
    // Management view (only renders with an active subscription) showing Growth.
    await expect(page.getByText('Manage your Subscription')).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await expect(page.getByText('Growth').first()).toBeVisible();

    // Entitlement gate: Growth is a paid tier, but custom_roles is Team-only, so
    // the Custom Roles feature must still be LOCKED here. This is what makes the
    // next check an unlock by the UPGRADE, not merely by paying.
    await expectCustomRolesGate(page, rolesUrl, false);

    // --- 2. Upgrade Growth → Team through our OWN dialog (not Stripe's page) ---
    // At Growth, "Team" is the upgrade card; clicking it opens the confirm dialog
    // → upgradeSubscription (Stripe API) → customer.subscription.updated webhook.
    // (Re-navigate to billing: the gate check above left us on the roles page.)
    await page.goto(url, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await waitForBillingLoaded(page);
    await page.getByText('Team').first().click();
    await page.getByRole('button', { name: /upgrade to team/i }).click();
    await expect
      .poll(tierId, { timeout: WEBHOOK_TIMEOUT, intervals: [1000, 2000, 3000, 5000] })
      .toBe('team');

    await page.goto(url, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await waitForBillingLoaded(page);
    await expect(page.getByText('Manage your Subscription')).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    // At Team, the only upgrade card is Enterprise, so "Team" appears solely as
    // the current plan — no need to disambiguate from a card.
    await expect(page.getByText('Team').first()).toBeVisible();

    // Entitlement gate UNLOCKS after the upgrade: the same feature locked at
    // Growth is now available — the tier flip reached a real server-resolved
    // feature gate, not just the billing.tier_id column.
    await expectCustomRolesGate(page, rolesUrl, true);

    // --- 3. Cancel via the Stripe test API → subscription.deleted webhook → hobby ---
    cancelTestSubscription(sub.id);
    subId = null;
    await expect
      .poll(tierId, { timeout: WEBHOOK_TIMEOUT, intervals: [1000, 2000, 3000, 5000] })
      .toBe('hobby');

    await page.goto(url, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await waitForBillingLoaded(page);
    await expect(page.getByText('Ready to upgrade?')).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });

    // Entitlement gate RE-LOCKS after cancellation: back on hobby, the Team-only
    // feature is gated again.
    await expectCustomRolesGate(page, rolesUrl, false);
  });
});
