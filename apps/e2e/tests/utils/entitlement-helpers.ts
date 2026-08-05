import { expect, type Page } from '@playwright/test';

const FIRST_COMPILE_GOTO_TIMEOUT = 90_000;

/**
 * Assert the Team-gated Custom Roles feature's gate in the running app.
 *
 * The roles settings page (`/orgs/<org>/settings/roles`) resolves `custom_roles`
 * server-side from the tenant's LIVE tier (EntitlementService → billing.tier_id,
 * no cache), so this checks a REAL authorization gate, not just the tier column.
 * `custom_roles` is true ONLY on Team (false on hobby AND growth). The settings
 * layout always renders the page body (it only toggles a nav tab on the
 * entitlement), so a direct nav lands on the locked/unlocked page at any tier.
 *
 * Shared by the @billing-live lifecycle spec (drives the tier via real Stripe)
 * and the CD-runnable entitlement-gating spec (seeds the tier directly), so both
 * assert the gate the same way.
 */
export async function expectCustomRolesGate(
  page: Page,
  rolesUrl: string,
  unlocked: boolean,
): Promise<void> {
  await page.goto(rolesUrl, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });
  const createRole = page.getByRole('button', { name: 'Create Role' });
  const upgradeNotice = page.getByText(/Custom Roles is available on the Team plan/i);
  if (unlocked) {
    // The create-role control only renders when the entitlement is granted.
    await expect(createRole).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await expect(upgradeNotice).toBeHidden();
  } else {
    await expect(upgradeNotice).toBeVisible({ timeout: FIRST_COMPILE_GOTO_TIMEOUT });
    await expect(createRole).toBeHidden();
  }
}
