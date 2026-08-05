/**
 * E2E tests for billing setup and management flows.
 *
 * View-specific selectors prevent false-passes:
 *   Setup view:      "Ready to upgrade?" heading, "Free" label, plan cards
 *   Management view: "Manage your Subscription" heading, "View" manage link
 *
 * Stripe interactions are verified by intercepting the server action POST
 * (Next-Action header), not by checking Stripe URLs which depend on env keys.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  getSupabaseAdmin,
  createTestUser,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  cleanupTestUser,
  loginTestUser,
  TIMEOUTS,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';

test.describe.configure({ mode: 'serial' });

/** Wait for the billing section skeleton to disappear */
async function waitForBillingLoaded(page: import('@playwright/test').Page) {
  await expect(page.locator('[class*="MuiSkeleton"]').first()).toBeHidden({
    timeout: TIMEOUTS.MEDIUM,
  });
}

/**
 * Intercept Next.js server action POSTs so they never reach the server.
 * Returns a promise that resolves with the intercepted request once the
 * action fires. This prevents Stripe calls with fake customer IDs while
 * still verifying the UI triggers the correct action.
 */
function interceptServerAction(page: import('@playwright/test').Page) {
  let resolve: (req: import('@playwright/test').Request) => void;
  const promise = new Promise<import('@playwright/test').Request>(r => { resolve = r; });

  page.route('**/*', (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.headers()['next-action']) {
      resolve(req);
      // Empty body = invalid Flight payload. The client-side action stub
      // rejects with "An unexpected response was received from the server."
      // — deliberately exercising the transport-error path. The billing
      // callers MUST catch this (snackbar), never let it escape as an
      // unhandled rejection (see captureUnhandledRejections below).
      route.fulfill({ status: 200, body: '' });
    } else {
      route.continue();
    }
  });

  return promise;
}

/**
 * Record every unhandled promise rejection in the page so tests can assert
 * none escaped. Regression gate for production Sentry events: without a
 * handler, the stubbed server-action response above surfaces as an unhandled
 * "An unexpected response was received from the server." rejection on
 * /settings/billing every time this suite runs against staging.
 *
 * Must be called BEFORE page.goto so the listener is installed first.
 */
async function captureUnhandledRejections(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __unhandledRejections: string[] };
    w.__unhandledRejections = [];
    window.addEventListener('unhandledrejection', (e) => {
      w.__unhandledRejections.push(String(e.reason));
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __unhandledRejections: string[] }).__unhandledRejections,
    );
}

test.describe('Billing', () => {
  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  // ---------------------------------------------------------------------------
  // Setup View (hobby tier — no subscription)
  // ---------------------------------------------------------------------------
  test.describe('Setup View', () => {
    let testUser: TestUser | null = null;
    let testOrg: TestOrganization | null = null;

    test.afterEach(async ({ page }) => {
      // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
      await page.close();
      await cleanupTestOwnerWithOrg(testUser?.id ?? null, testOrg?.tenantId ?? null);
      testUser = null;
      testOrg = null;
    });

    test('renders plan cards, Free label, and span count for hobby owner', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-setup');
      testUser = result.user;
      testOrg = result.org;

      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      // Setup-specific heading (not present in management view)
      await expect(page.getByText('Ready to upgrade?')).toBeVisible();
      // Plan cards
      await expect(page.getByText('Growth').first()).toBeVisible();
      await expect(page.getByText('Enterprise').first()).toBeVisible();
      await expect(page.getByText('Team').first()).toBeVisible();
      // Free tier label
      await expect(page.getByText('Free')).toBeVisible();
      // Usage count label
      await expect(page.getByText('Units:')).toBeVisible();
    });

    test('Growth card click triggers Stripe checkout server action', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-checkout');
      testUser = result.user;
      testOrg = result.org;

      const getRejections = await captureUnhandledRejections(page);
      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      await expect(page.getByText('Ready to upgrade?')).toBeVisible();

      // Intercept the server action so it never reaches Stripe
      const actionFired = interceptServerAction(page);
      await page.getByText('Growth').first().click();
      const req = await actionFired;
      expect(req.method()).toBe('POST');

      // The stubbed (invalid) action response must be caught by the caller
      // and surfaced as a snackbar — never an unhandled rejection.
      await expect(page.getByText('Failed to start checkout')).toBeVisible();
      expect(await getRejections()).toEqual([]);
    });

    test('Team card click triggers Stripe checkout server action', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-team-checkout');
      testUser = result.user;
      testOrg = result.org;

      const getRejections = await captureUnhandledRejections(page);
      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      await expect(page.getByText('Ready to upgrade?')).toBeVisible();

      // Intercept the server action so it never reaches Stripe
      const actionFired = interceptServerAction(page);
      await page.getByText('Team', { exact: true }).first().click();
      const req = await actionFired;
      expect(req.method()).toBe('POST');

      // The stubbed (invalid) action response must be caught by the caller
      // and surfaced as a snackbar — never an unhandled rejection.
      await expect(page.getByText('Failed to start checkout')).toBeVisible();
      expect(await getRejections()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Management View (active subscription)
  // ---------------------------------------------------------------------------
  test.describe('Management View', () => {
    let testUser: TestUser | null = null;
    let testOrg: TestOrganization | null = null;

    test.afterEach(async ({ page }) => {
      // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
      await page.close();
      await cleanupTestOwnerWithOrg(testUser?.id ?? null, testOrg?.tenantId ?? null);
      testUser = null;
      testOrg = null;
    });

    test('renders tier name, span count, and manage link for growth owner', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-mgmt', {
        billingTierId: 'growth',
        billingSubscriptionId: `sub_test_${Date.now()}`,
      });
      testUser = result.user;
      testOrg = result.org;

      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      // Management-specific heading (not present in setup view)
      await expect(page.getByText('Manage your Subscription')).toBeVisible();
      // Tier display name (from TIERS config, not locale)
      await expect(page.getByText('Growth').first()).toBeVisible();
      // Usage count label
      await expect(page.getByText('Units:')).toBeVisible();
      // Manage link (permission-gated: only shows for billing.update holders)
      await expect(
        page.getByRole('button', { name: /manage your billing/i }),
      ).toBeVisible();
    });

    test('View link triggers Stripe portal server action', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-portal', {
        billingTierId: 'growth',
        billingSubscriptionId: `sub_test_${Date.now()}`,
      });
      testUser = result.user;
      testOrg = result.org;

      const getRejections = await captureUnhandledRejections(page);
      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      await expect(page.getByText('Manage your Subscription')).toBeVisible();

      // Intercept the server action so it never reaches Stripe
      const actionFired = interceptServerAction(page);
      await page.getByRole('button', { name: /manage your billing/i }).click();
      const req = await actionFired;
      expect(req.method()).toBe('POST');

      // The stubbed (invalid) action response must be caught by the caller
      // and surfaced as a snackbar — never an unhandled rejection.
      await expect(page.getByText('Failed to open billing portal')).toBeVisible();
      expect(await getRejections()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Access Control
  // ---------------------------------------------------------------------------
  test.describe('Access Control', () => {
    let ownerUser: TestUser | null = null;
    let memberUser: TestUser | null = null;
    let testOrg: TestOrganization | null = null;

    test.afterEach(async ({ page }) => {
      // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
      await page.close();
      const client = getSupabaseAdmin();
      if (memberUser) {
        await client.from('membership').delete().eq('user_id', memberUser.id);
        await cleanupTestUser(memberUser.id);
        memberUser = null;
      }
      await cleanupTestOwnerWithOrg(ownerUser?.id ?? null, testOrg?.tenantId ?? null);
      ownerUser = null;
      testOrg = null;
    });

    test('non-owner member is blocked from settings page', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-perm', {
        billingTierId: 'growth',
        billingSubscriptionId: `sub_test_perm_${Date.now()}`,
      });
      ownerUser = result.user;
      testOrg = result.org;

      const client = getSupabaseAdmin();
      memberUser = await createTestUser('e2e-billing-member');

      await client.from('terms_agreement').insert({
        user_id: memberUser.id,
        terms_version: '2026-01-10',
        agreed_at: new Date().toISOString(),
        consent_type: 'explicit',
        created_by: memberUser.id,
      });

      await client.from('membership').insert({
        tenant_id: testOrg.tenantId,
        user_id: memberUser.id,
        role: 'read',
        status: 'active',
        accepted_at: new Date().toISOString(),
        created_by: ownerUser.id,
      });

      await client.auth.admin.updateUserById(memberUser.id, {
        app_metadata: { tenant_id: testOrg.tenantId, role: 'read' },
      });

      await loginTestUser(page, memberUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings`);

      await expect(page.getByText(/No permission/i)).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    });
  });

  // ---------------------------------------------------------------------------
  // View Transitions (simulated post-checkout / cancellation)
  // ---------------------------------------------------------------------------
  test.describe('View Transitions', () => {
    let testUser: TestUser | null = null;
    let testOrg: TestOrganization | null = null;

    test.afterEach(async ({ page }) => {
      // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
      await page.close();
      await cleanupTestOwnerWithOrg(testUser?.id ?? null, testOrg?.tenantId ?? null);
      testUser = null;
      testOrg = null;
    });

    test('switches from setup to management view after subscription activation', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-switch');
      testUser = result.user;
      testOrg = result.org;

      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      // Confirm we start on the setup view
      await expect(page.getByText('Ready to upgrade?')).toBeVisible();
      await expect(page.getByText('Manage your Subscription')).toHaveCount(0);

      // Simulate webhook: add subscription
      const client = getSupabaseAdmin();
      await client
        .from('billing')
        .update({ stripe_subscription_id: `sub_test_switch_${Date.now()}`, tier_id: 'growth' })
        .eq('tenant_id', testOrg.tenantId);

      await page.reload();
      await waitForBillingLoaded(page);

      // Should now show management view
      await expect(page.getByText('Manage your Subscription')).toBeVisible();
      await expect(page.getByText('Ready to upgrade?')).toHaveCount(0);
    });

    test('reverts from management to setup view after cancellation', async ({ page }) => {
      const result = await createTestOwnerWithOrg('e2e-billing-revert', {
        billingTierId: 'growth',
        billingSubscriptionId: `sub_test_revert_${Date.now()}`,
      });
      testUser = result.user;
      testOrg = result.org;

      await loginTestUser(page, testUser, { expectedUrlPattern: /orgs/ });
      await page.goto(`/orgs/${testOrg.organizationName}/settings/billing`);
      await waitForBillingLoaded(page);

      // Confirm we start on the management view
      await expect(page.getByText('Manage your Subscription')).toBeVisible();
      await expect(page.getByText('Ready to upgrade?')).toHaveCount(0);

      // Simulate webhook: cancel subscription
      const client = getSupabaseAdmin();
      await client
        .from('billing')
        .update({ stripe_subscription_id: null, tier_id: 'hobby' })
        .eq('tenant_id', testOrg.tenantId);

      await page.reload();
      await waitForBillingLoaded(page);

      // Should revert to setup view
      await expect(page.getByText('Ready to upgrade?')).toBeVisible();
      await expect(page.getByText('Manage your Subscription')).toHaveCount(0);
    });
  });
});
