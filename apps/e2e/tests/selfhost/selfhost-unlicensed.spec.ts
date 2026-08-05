/**
 * Self-host EE gating — UNLICENSED instance. @selfhost
 *
 * Runs ONLY under the `chromium-selfhost-unlicensed` project, whose dashboard
 * (port 3006) boots with OUTERLAYER_SELF_HOSTED=true and NO license key.
 * Requires E2E_SELFHOST=1 so the config starts that server.
 *
 * Proves the self-host entitlement rules (see ee/README.md):
 *   1. Core auth works on an unlicensed instance — the login flow itself is
 *      the first assertion (SSO login guards stayed in open code).
 *   2. EE surfaces fail CLOSED without a license: custom roles and the
 *      audit-log viewer are denied.
 *   3. Billing tiers are IGNORED on self-host: flipping billing.tier_id to
 *      'team' — which unlocks custom_roles on Cloud (see
 *      billing/entitlement-gating.spec.ts) — must NOT unlock it here. Only a
 *      license key can. This pins that self-host resolution actually bypasses
 *      the tier matrix rather than layering on top of it.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  getSupabaseAdmin,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  loginTestUser,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';
import { expectCustomRolesGate } from '../utils/entitlement-helpers';

const FIRST_COMPILE_TIMEOUT = 90_000;

test.describe('Self-host unlicensed — EE features fail closed @selfhost', () => {
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

  test('login works; EE surfaces are denied; billing tier cannot unlock them', async ({
    page,
  }) => {
    const r = await createTestOwnerWithOrg('e2e-selfhost-unlic');
    user = r.user;
    org = r.org;
    const admin = getSupabaseAdmin();
    const settingsBase = `/orgs/${org.organizationName}/settings`;

    // 1. Core auth works unlicensed.
    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });

    // 2a. Custom roles: denied.
    await expectCustomRolesGate(page, `${settingsBase}/roles`, false);

    // 2b. Audit-log viewer: tab hidden, direct navigation hits the
    // entitlement wall (the server action re-checks — the tab is not the gate).
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeHidden();
    await page.goto(`${settingsBase}/audit-log`, { timeout: FIRST_COMPILE_TIMEOUT });
    await expect(page.getByText('The audit log requires an Enterprise plan')).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });

    // 3. Billing tier is ignored on self-host: 'team' unlocks custom_roles on
    // Cloud, but here only a license may.
    const { error } = await admin
      .from('billing')
      .update({ tier_id: 'team' })
      .eq('tenant_id', org.tenantId);
    if (error) throw new Error(`set tier team: ${error.message}`);

    await expectCustomRolesGate(page, `${settingsBase}/roles`, false);
  });
});
