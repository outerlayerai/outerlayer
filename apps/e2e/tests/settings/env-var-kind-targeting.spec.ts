/**
 * E2E for env-var KIND targeting — the Vercel-style "Applies to"
 * picker. A variable can target an environment kind (Development / Preview /
 * Production / All Environments) instead of a single env, so a fresh preview
 * env inherits the right credentials. This journey had no E2E.
 *
 * Success = after adding a Preview-targeted var, its row shows in the app-wide
 * manager with a "Preview" target chip (the picker wrote a kind-targeted row,
 * not an env-pinned one). Cleanup: `env_var` cascades on app delete.
 * Per-run unique key → parallel-safe.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  createTestApp,
  cleanupTestApp,
  createTestGitConnection,
  loginTestUser,
  uniqueToken,
  TIMEOUTS,
  type TestUser,
  type TestOrganization,
  type TestApp,
} from '../utils/test-helpers';

const FIRST_COMPILE_GOTO_TIMEOUT = 90_000;

test.describe('Env vars — kind targeting', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    const ready = await waitForSupabase();
    if (!ready) throw new Error('Supabase not ready');
  });

  let user: TestUser | null = null;
  let org: TestOrganization | null = null;
  let app: TestApp | null = null;

  test.afterEach(async ({ page }) => {
    await page.close();
    await cleanupTestApp(app?.id ?? null);
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
    user = null;
    org = null;
    app = null;
  });

  test('adds a Preview-targeted variable and shows its kind chip', async ({ page }) => {
    const r = await createTestOwnerWithOrg('e2e-envvar');
    user = r.user;
    org = r.org;
    app = await createTestApp(org.tenantId, 'e2e-envvar', { createdBy: user.id });
    await createTestGitConnection(org.tenantId, app.id, { createdBy: user.id });

    const varKey = `E2E_PREVIEW_${uniqueToken().replace(/-/g, '').toUpperCase()}`;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });
    await page.goto(`/orgs/${org.organizationName}/apps/${app.name}/env/dev/settings/env-vars`, {
      timeout: FIRST_COMPILE_GOTO_TIMEOUT,
    });

    // Open the add dialog (page-level "Add" trigger).
    await page.getByRole('button', { name: /^add$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

    await dialog.getByRole('textbox', { name: 'Key' }).fill(varKey);
    await dialog.getByRole('textbox', { name: 'Value' }).fill('preview-secret');

    // Target the Preview kind. Clicking a kind clears the default "All
    // Environments", so the saved row is preview-targeted (target_kind), not
    // env-pinned.
    await dialog.getByText('Preview', { exact: true }).click();
    await dialog.getByRole('button', { name: /^add$/i }).click();

    // The new row appears in the app-wide list with a "Preview" target chip.
    const row = page.getByRole('listitem').filter({ hasText: varKey });
    await expect(row).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(row.getByText('Preview', { exact: true })).toBeVisible();
  });
});
