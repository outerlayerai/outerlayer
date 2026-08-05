/**
 * E2E for app creation — the activation step that creates the container every
 * other journey needs. Covers the create-via-UI flow that every new user hits.
 *
 * Gateway-backed: createApp POSTs to the gateway (/v1/apps), which writes the
 * app row. Validated locally against a gateway pointed at the dashboard's
 * Supabase. The UI-created app cascades on tenant delete →
 * cleanupTestOwnerWithOrg. Per-run unique name.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  cleanupTestApp,
  getSupabaseAdmin,
  loginTestUser,
  TIMEOUTS,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';

const FIRST_COMPILE_GOTO_TIMEOUT = 90_000;

test.describe('Activation — create an app', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    const ready = await waitForSupabase();
    if (!ready) throw new Error('Supabase not ready');
  });

  let user: TestUser | null = null;
  let org: TestOrganization | null = null;

  test.afterEach(async ({ page }) => {
    await page.close();
    // The app was created via the UI (no seeded id) and app.tenant_id is NOT
    // cascade-on-tenant-delete — so delete the tenant's app(s) first, else the
    // FK blocks the org delete and tenant/app/user leak.
    if (org?.tenantId) {
      const { data: apps } = await getSupabaseAdmin()
        .from('app')
        .select('id')
        .eq('tenant_id', org.tenantId);
      for (const a of apps ?? []) await cleanupTestApp(a.id as string);
    }
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
    user = null;
    org = null;
  });

  test('creates an app from the apps list and it appears', async ({ page }) => {
    const r = await createTestOwnerWithOrg('e2e-app-create');
    user = r.user;
    org = r.org;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });
    await page.goto(`/orgs/${org.organizationName}/apps`, { timeout: FIRST_COMPILE_GOTO_TIMEOUT });

    // Open the create dialog. Empty org → "Create App" (or a "create your first"
    // empty-state button).
    await page
      .getByRole('button', { name: /create app|create your first|new app/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    // The URL slug is auto-generated and shown in a DISABLED "Identifier"
    // field (not editable). The editable "Display name" field is the friendly
    // label shown across the dashboard; leaving it blank falls back to the
    // identifier. Here we set one so the card renders it.
    const identifier = await dialog
      .getByRole('textbox', { name: 'Identifier', exact: true })
      .inputValue();
    expect(identifier, 'an identifier slug should be pre-generated').not.toBe('');
    const displayName = `E2E ${identifier}`;
    await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill(displayName);
    await dialog.getByRole('button', { name: /^save$/i }).click();

    // On success the dialog closes and the apps list refreshes → the new app
    // appears (createApp returned data, i.e. the gateway wrote the row). The
    // card is titled by the display name, not the slug.
    await expect(dialog).toHaveCount(0, { timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByText(displayName)).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  });
});
