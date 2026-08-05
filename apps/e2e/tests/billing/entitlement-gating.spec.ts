/**
 * Authorization coverage that RUNS IN CD. Unlike the @billing-live lifecycle
 * spec — which churns real Stripe test subscriptions and so is excluded from
 * chromium-staging — this proves the tier→feature-access GATE, which needs only
 * a tenant at a given tier, NOT Stripe. It seeds `billing.tier_id` directly via
 * the service role (the same admin the staging run already uses to seed
 * tenants), so it is deliberately UNTAGGED and runs under chromium-staging
 * against deployed staging as well as locally under chromium-full.
 *
 * It complements, rather than duplicates, the lifecycle spec: the lifecycle
 * spec proves Stripe→webhook→tier (local only); this proves tier→authorization
 * across every tier (locally AND in CD), which is the part worth guarding on
 * every deploy.
 *
 * Gate under test: `custom_roles` (the Custom Roles settings page). It is true
 * ONLY on Team — false on hobby AND growth — so the matrix below pins that a
 * free tenant, a paid-but-not-Team tenant, and a downgraded tenant are all
 * denied, while a Team tenant is allowed.
 */

import { test } from '@playwright/test';
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

test.describe('Entitlements — tier gates feature access (custom_roles)', () => {
  test.describe.configure({ timeout: 180_000 });

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

  test('custom_roles is denied on hobby + growth, granted on team, re-denied on downgrade', async ({
    page,
  }) => {
    const r = await createTestOwnerWithOrg('e2e-entitlement-gate');
    user = r.user;
    org = r.org;
    const admin = getSupabaseAdmin();
    const rolesUrl = `/orgs/${org.organizationName}/settings/roles`;
    const setTier = async (tier: 'hobby' | 'growth' | 'team') => {
      const { error } = await admin.from('billing').update({ tier_id: tier }).eq('tenant_id', org!.tenantId);
      if (error) throw new Error(`set tier ${tier}: ${error.message}`);
    };

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });

    // hobby (the default for a fresh tenant) → denied
    await expectCustomRolesGate(page, rolesUrl, false);

    // growth: a PAID tier, but custom_roles is Team-only → still denied. This is
    // what distinguishes the gate from "any paid plan unlocks it".
    await setTier('growth');
    await expectCustomRolesGate(page, rolesUrl, false);

    // team → granted
    await setTier('team');
    await expectCustomRolesGate(page, rolesUrl, true);

    // downgrade back to hobby → re-denied (the grant is not sticky)
    await setTier('hobby');
    await expectCustomRolesGate(page, rolesUrl, false);
  });
});
