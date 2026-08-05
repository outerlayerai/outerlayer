/**
 * E2E for org settings — the nav and its tabbed sections actually load.
 *
 * Deliberately asserts no layout or CSS geometry (heading-above-card pixel
 * ordering, sidebar `height > 40`, mobile `bodyWidth <= 375`). Those assertions
 * test styling: they break on any restyle and catch no real bug (`height > 40`
 * passes for almost any layout). Per the repo's test bar — "what's the smallest
 * prod change that still passes?" — they pass for nearly anything.
 *
 * This asserts BEHAVIOR instead: the settings nav renders every section, and
 * clicking each tab routes to it AND loads that section's own content (not a
 * blank or errored page). That catches broken routing, a section that 404s, or
 * a section that fails to render — the failures that actually matter.
 */

import { test, expect } from '@playwright/test';
import {
  loginTestUser,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  TIMEOUTS,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';

test.describe.configure({ mode: 'serial' });

test.describe('Org Settings', () => {
  let testUser: TestUser | null = null;
  let testOrg: TestOrganization | null = null;

  test.beforeAll(async () => {
    const result = await createTestOwnerWithOrg('settings-layout');
    testUser = result.user;
    testOrg = result.org;
  });

  test.afterAll(async () => {
    await cleanupTestOwnerWithOrg(testUser?.id ?? null, testOrg?.tenantId ?? null);
    testUser = null;
    testOrg = null;
  });

  test.beforeEach(async ({ page }) => {
    await loginTestUser(page, testUser!, { expectedUrlPattern: /orgs/ });
  });

  test('renders the settings nav with every section', async ({ page }) => {
    await page.goto(`/orgs/${testOrg!.organizationName}/settings/general`);

    await expect(page.getByRole('link', { name: 'General' })).toBeVisible({
      timeout: TIMEOUTS.MEDIUM,
    });
    await expect(page.getByRole('link', { name: 'Billing' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Members' })).toBeVisible();
  });

  test('each tab routes to its section AND loads that section content', async ({ page }) => {
    const base = `/orgs/${testOrg!.organizationName}/settings`;
    await page.goto(`${base}/general`);

    // General — the OrganizationForm renders its "Company Name" field. (Asserting
    // a section-specific element, not the nav link, proves the content loaded.)
    await expect(page.getByRole('textbox', { name: /company name/i })).toBeVisible({
      timeout: TIMEOUTS.MEDIUM,
    });

    // Billing — routes AND loads the plan UI ("Ready to upgrade?" for a free/hobby owner).
    await page.getByRole('link', { name: 'Billing' }).click();
    await page.waitForURL('**/settings/billing', { timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByText('Ready to upgrade?')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    // Members — routes AND loads the members UI (the Invite control).
    await page.getByRole('link', { name: 'Members' }).click();
    await page.waitForURL('**/settings/members', { timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByRole('button', { name: /invite/i })).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Back to General — routes AND the form reloads (round-trip, not a one-way load).
    await page.getByRole('link', { name: 'General' }).click();
    await page.waitForURL('**/settings/general', { timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByRole('textbox', { name: /company name/i })).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  });
});
