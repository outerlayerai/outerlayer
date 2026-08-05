/**
 * E2E for API-key creation (+ delete) — the activation step that lets a user
 * send ANY data (traces / runs) to the gateway. You can't integrate without a
 * key, and this journey had no E2E.
 *
 * Unkey-backed: createApiKey mints a key via Unkey + writes the `api_key` row
 * (Supabase). Validated locally with the dashboard's Unkey creds; runs on
 * staging where Unkey is configured. Success = the key is minted and REVEALED in
 * the "API Key" dialog, which only opens after createApiKey returns a key — a
 * prefix-agnostic signal (so it doesn't break if the Unkey key prefix differs
 * between local and staging).
 *
 * Cleanup: `api_key.app_id` cascades on app delete → cleanupTestApp removes the
 * row. The minted Unkey key itself is left orphaned (a no-op: with no api_key
 * row, the gateway rejects it) — an acceptable trade vs. a flaky UI-delete dance
 * in an auto-merged spec. Per-run unique key name → parallel-safe.
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

test.describe('Activation — create an API key', () => {
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

  test('creates an API key — Unkey mints it and the dashboard reveals it', async ({ page }) => {
    const r = await createTestOwnerWithOrg('e2e-apikey');
    user = r.user;
    org = r.org;
    app = await createTestApp(org.tenantId, 'e2e-apikey', { createdBy: user.id });
    await createTestGitConnection(org.tenantId, app.id, { createdBy: user.id });

    const keyName = `e2ekey${uniqueToken().replace(/-/g, '')}`;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });
    await page.goto(`/orgs/${org.organizationName}/apps/${app.name}/env/dev/settings/api-keys`, {
      timeout: FIRST_COMPILE_GOTO_TIMEOUT,
    });

    // Create: trigger → form dialog (Name + Role defaults to "sdk") → "Create".
    await page.getByRole('button', { name: 'Create API Key' }).click();
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await form.getByRole('textbox', { name: 'Name' }).fill(keyName);
    await form.getByRole('button', { name: /^create$/i }).click();

    // Success == the "API Key" reveal dialog opens, which happens only after
    // createApiKey returns a freshly-minted key. A failed create (or broken
    // Unkey call) surfaces an inline error instead — this dialog never appears.
    // Prefix-agnostic on purpose (the Unkey key prefix can differ by env).
    await expect(page.getByRole('dialog').getByText('API Key')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  });

  test('a kind-scoped key is listed and revocable (env pin NULL must stay visible)', async ({ page }) => {
    // Regression: a kind-scoped key has environment_id
    // NULL, so the per-env list hid it — it could never be viewed or revoked
    // after the one-time reveal. This proves it shows on the env view (with its
    // kind chip) and can be deleted.
    const r = await createTestOwnerWithOrg('e2e-kindkey');
    user = r.user;
    org = r.org;
    app = await createTestApp(org.tenantId, 'e2e-kindkey', { createdBy: user.id });
    await createTestGitConnection(org.tenantId, app.id, { createdBy: user.id });

    const keyName = `e2ekind${uniqueToken().replace(/-/g, '')}`;

    await loginTestUser(page, user, { expectedUrlPattern: /orgs/ });
    await page.goto(`/orgs/${org.organizationName}/apps/${app.name}/env/dev/settings/api-keys`, {
      timeout: FIRST_COMPILE_GOTO_TIMEOUT,
    });

    await page.getByRole('button', { name: 'Create API Key' }).click();
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await form.getByRole('textbox', { name: 'Name' }).fill(keyName);
    // Switch from the pinned default to kind scope; "Preview" is pre-selected.
    await form.getByText('Environment kinds').click();
    await expect(form.getByRole('button', { name: 'Preview' })).toBeVisible();
    await form.getByRole('button', { name: /^create$/i }).click();

    // Reveal dialog opens on success — the <code> element is unique to it
    // (it holds the plaintext key). The create form has no <code>, so this
    // does NOT false-positive when creation fails and the form stays open.
    await expect(page.getByRole('dialog').locator('code')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
    await page.keyboard.press('Escape');

    // THE FIX: the kind-scoped key appears in the list (with its Preview chip),
    // even though it has no env pin and 'dev' is the selected env.
    const row = page.getByRole('listitem').filter({ hasText: keyName });
    await expect(row).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(row.getByText('Preview')).toBeVisible();

    // And it is revocable: delete → confirm → row gone.
    await row.getByRole('button').last().click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /delete/i }).click();
    await expect(page.getByText(keyName)).toBeHidden({ timeout: TIMEOUTS.NAVIGATION });
  });
});
