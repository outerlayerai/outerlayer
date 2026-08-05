/**
 * QA smoke test for the frozen `@repo/ui` seam.
 *
 * ~130+ call sites of licensed UI primitive families (hook-form, table,
 * label, custom-breadcrumbs, custom-popover, settings, empty-content, etc.)
 * live behind thin `src/theme/<family>` barrels aliased as
 * `@repo/ui/src/<family>`, with a lint rule banning new direct imports. The
 * barrels are import-path-only — no behavior/visual change — so the bug
 * class this guards against is a barrel that silently drops part of a
 * family's public surface (e.g. `export * from '...'` dropping a `default`
 * export) or a codemod that pointed a consumer at the wrong binding, both of
 * which manifest as a runtime crash or a missing/broken control, not a type
 * error (the barrel still typechecks).
 *
 * Exercises multiple frozen families in one flow: `empty-content` (the "No
 * Apps" placeholder), `custom-breadcrumbs` (org nav breadcrumb), `table` +
 * `label` (Members list with role/status chips), and `custom-popover` (the
 * account avatar menu).
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

test.describe('Frozen @repo/ui seam — cross-family smoke', () => {
  // App Router only compiles a route on first visit; give cold-compile room
  // beyond the default per-test timeout so this doesn't flake on a cold dev
  // server.
  test.setTimeout(90_000);

  let testUser: TestUser | null = null;
  let testOrg: TestOrganization | null = null;

  test.beforeAll(async () => {
    const result = await createTestOwnerWithOrg('frozen-seam-smoke');
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

  test('empty-content placeholder and breadcrumb render on a fresh org', async ({ page }) => {
    await page.goto(`/orgs/${testOrg!.organizationName}/apps`);

    // `empty-content` family barrel (default export preserved).
    await expect(page.getByText('No Apps')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // `custom-breadcrumbs` family barrel (default export preserved) — org
    // breadcrumb button in the header shows the org name.
    await expect(page.getByRole('button', { name: testOrg!.organizationName })).toBeVisible();
  });

  test('account avatar opens the custom-popover menu with user identity + actions', async ({ page }) => {
    await page.goto(`/orgs/${testOrg!.organizationName}/apps`);

    // `custom-popover` family barrel (default export + `usePopover`). The
    // account trigger is an icon button labelled `account` (via aria-label), not
    // the avatar initial — matching the letter is brittle when the display name
    // (and therefore the initial) changes.
    await page.getByRole('button', { name: 'account' }).click();

    await expect(page.getByText(testUser!.email)).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await expect(page.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
  });

  test('Members table renders role/status as label chips (table + label seam)', async ({ page }) => {
    await page.goto(`/orgs/${testOrg!.organizationName}/settings/members`);

    const row = page.getByRole('row', { name: new RegExp(testUser!.email) });
    await expect(row).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // `label` family barrel carries the preserved `default` export — if the
    // barrel had dropped it (the central trap for these barrels),
    // these chips would render as `undefined` or crash instead of text.
    await expect(row.getByText('owner', { exact: true })).toBeVisible();
    await expect(row.getByText('Accepted', { exact: true })).toBeVisible();
  });
});
