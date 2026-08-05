/**
 * Coverage for the animated error views and the account popover.
 *
 * The 403 and not-found views mount framer-motion variants from
 * `sections/error/motion.tsx`; the account popover carries its own hover/tap
 * variants. A malformed variant object (wrong shape, missing transition,
 * broken import) throws at mount rather than failing typecheck, and
 * snapshot or pixel assertions would not catch it. Asserting that the page
 * actually renders its content and that the popover actually opens and shows
 * data does.
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

test.describe('Error views and account popover (animate family inline)', () => {
  let testUser: TestUser | null = null;
  let testOrg: TestOrganization | null = null;

  test.beforeAll(async () => {
    const result = await createTestOwnerWithOrg('animate-inline');
    testUser = result.user;
    testOrg = result.org;
  });

  test.afterAll(async () => {
    await cleanupTestOwnerWithOrg(testUser?.id ?? null, testOrg?.tenantId ?? null);
    testUser = null;
    testOrg = null;
  });

  test('not-found view renders its content through its motion variants, no console errors', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginTestUser(page, testUser!, { expectedUrlPattern: /orgs/ });

    await page.goto('/this-route-does-not-exist-e2e-3190');

    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible({
      timeout: TIMEOUTS.MEDIUM,
    });
    await expect(page.getByRole('link', { name: /go home/i })).toBeVisible();
    // The icon tile is the third animated child — if the
    // variant object were malformed, framer-motion throws and it never mounts.
    // The tile is decorative (`aria-hidden`), so match its rendered <svg> via a
    // DOM locator rather than the `img` role.
    await expect(page.getByRole('main').locator('svg')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('account popover opens via its hover motion props and shows the signed-in user', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginTestUser(page, testUser!, { expectedUrlPattern: /orgs/ });
    await page.goto(`/orgs/${testOrg!.organizationName}/apps`);

    // The avatar/account button is the last action in the header banner (after
    // notifications + settings) — targeting by position avoids depending on the
    // avatar-initial letter, which is derived from the profile's display name.
    const avatarButton = page.getByRole('banner').getByRole('button').last();
    await avatarButton.hover();
    await avatarButton.click();

    await expect(page.getByText(testUser!.email)).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await expect(page.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
