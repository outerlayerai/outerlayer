/**
 * Self-host EE gating — LICENSED instance. @selfhost
 *
 * Runs ONLY under the `chromium-selfhost-licensed` project, whose dashboard
 * (port 3007) boots with OUTERLAYER_SELF_HOSTED=true and the committed TEST
 * license fixture (fixtures/ee-license/test-license.json — offline-verified
 * Ed25519 token; no network licensing calls exist by design).
 * Requires E2E_SELFHOST=1 so the config starts that server.
 *
 * Proves the license — not the billing tier — unlocks EE:
 *   1. The tenant's billing row stays at the free tier throughout, yet custom
 *      roles are unlocked and a role can actually be created end-to-end.
 *   2. The audit-log viewer is unlocked and shows the trail of the EE
 *      mutation just performed (recording stayed open code; the license
 *      unlocks viewing — same trail semantics as the Cloud audit-log spec).
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  loginTestUser,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';
import { expectCustomRolesGate } from '../utils/entitlement-helpers';

const FIRST_COMPILE_TIMEOUT = 90_000;

test.describe('Self-host licensed — license unlocks EE without billing @selfhost', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    if (!(await waitForSupabase())) throw new Error('Supabase not ready');
  });

  let user: TestUser | null = null;
  let org: TestOrganization | null = null;

  test.afterEach(async ({ page }) => {
    await page.close();
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
    user = null;
    org = null;
  });

  test('custom role can be created and appears in the audit trail, on a free-tier billing row', async ({
    page,
  }) => {
    const r = await createTestOwnerWithOrg('e2e-selfhost-lic');
    user = r.user;
    org = r.org;
    const settingsBase = `/orgs/${org.organizationName}/settings`;
    const roleName = `e2e-selfhost-role-${Date.now()}`;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });

    // 1. Unlocked by license despite the billing row still being free tier.
    await expectCustomRolesGate(page, `${settingsBase}/roles`, true);

    // Create a role end-to-end: name + one permission + submit.
    await page.getByRole('button', { name: 'Create Role' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role Name').fill(roleName);
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByRole('button', { name: /^(Create|Save)/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(roleName) })).toBeVisible({
      timeout: 30_000,
    });

    // 2. Audit-log viewer unlocked; the EE mutation above is in the trail.
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
    await page.goto(`${settingsBase}/audit-log`, { timeout: FIRST_COMPILE_TIMEOUT });
    await expect(
      page.getByText('The audit log requires an Enterprise plan'),
    ).toBeHidden();
    const trailRow = page.getByRole('row', { name: /Custom Role Created/ });
    await expect(trailRow).toBeVisible({ timeout: FIRST_COMPILE_TIMEOUT });
    await expect(trailRow.getByText(user.email)).toBeVisible();
  });
});
