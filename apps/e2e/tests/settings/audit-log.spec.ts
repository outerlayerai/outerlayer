/**
 * Audit log — the Enterprise-gated tenant trail.
 *
 * Proves the full product story in one pass:
 *   1. Recording is ALWAYS on: a role change made while the org is still on
 *      the free tier is recorded.
 *   2. Viewing is Enterprise-gated: on hobby the settings tab is hidden and
 *      direct navigation shows the upgrade notice.
 *   3. Upgrading reveals history: after flipping `billing.tier_id` to
 *      enterprise, the PRE-upgrade change is visible in the trail with
 *      actor, target, and before/after detail.
 *   4. Export works: the CSV download carries the trail with UTC timestamps
 *      and none of the chain internals.
 *
 * Tier is seeded directly via the service role (same staging-safe pattern as
 * billing/entitlement-gating.spec.ts), so this spec is deliberately UNTAGGED
 * and runs under chromium-full and chromium-staging.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
  waitForSupabase,
  getSupabaseAdmin,
  createTestOwnerWithOrg,
  cleanupTestOwnerWithOrg,
  type TestUser,
  type TestOrganization,
} from '../utils/test-helpers';

const FIRST_COMPILE_TIMEOUT = 90_000;

test.describe('Audit log — Enterprise-gated tenant trail', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    if (!(await waitForSupabase())) throw new Error('Supabase not ready');
  });

  let user: TestUser | null = null;
  let org: TestOrganization | null = null;
  let memberId: string | null = null;

  test.afterEach(async ({ page }) => {
    await page.close();
    const admin = getSupabaseAdmin();
    if (memberId) {
      await admin.from('profile').delete().eq('id', memberId);
      await admin.auth.admin.deleteUser(memberId).catch(() => {
        // membership rows cascade with the tenant; auth cleanup is best-effort
      });
      memberId = null;
    }
    await cleanupTestOwnerWithOrg(user?.id ?? null, org?.tenantId ?? null);
    user = null;
    org = null;
  });

  test('records while free, reveals history on upgrade, and exports CSV', async ({ page }) => {
    const r = await createTestOwnerWithOrg('e2e-audit-log');
    user = r.user;
    org = r.org;
    const admin = getSupabaseAdmin();

    // A second (read-role) member: the target of the audited role change.
    const memberEmail = `member-${Date.now()}@e2e-audit-log.test`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: memberEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    if (createError || !created?.user) {
      throw new Error(`member createUser failed: ${createError?.message}`);
    }
    memberId = created.user.id;
    const { error: profileError } = await admin
      .from('profile')
      .insert({ id: memberId, name: 'Audit Member', email: memberEmail });
    if (profileError) throw new Error(`member profile failed: ${profileError.message}`);
    const { error: membershipError } = await admin.from('membership').insert({
      user_id: memberId,
      tenant_id: org.tenantId,
      role: 'read',
      status: 'active',
      accepted_at: new Date().toISOString(),
    });
    if (membershipError) throw new Error(`member membership failed: ${membershipError.message}`);

    // Inline login instead of `loginTestUser`: the shared helper caps the
    // post-login navigation at 20s, but the App Router only commits the URL
    // once the /orgs destination route compiles (~25s cold under the webpack
    // dev server; a middleware redirect blocks pre-warming it
    // unauthenticated). Same steps, first-compile-sized wait.
    await page.goto('/auth/login');
    await page.fill('[name="email"]', user.email);
    await page.fill('[name="password"]', user.password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL(/orgs/, { timeout: FIRST_COMPILE_TIMEOUT });
    const settingsBase = `/orgs/${org.organizationName}/settings`;

    // ── 1. Recording is on while the org is still hobby: real role change ──
    await page.goto(`${settingsBase}/members`, { timeout: FIRST_COMPILE_TIMEOUT });
    const memberRow = page.getByRole('row', { name: new RegExp(memberEmail) });
    await expect(memberRow).toBeVisible({ timeout: FIRST_COMPILE_TIMEOUT });
    await memberRow.getByRole('button').click();
    await page.getByRole('menuitem', { name: 'Update Role' }).click();
    await page.locator('[role="dialog"] [role="combobox"]').click();
    await page.getByRole('option', { name: 'Write' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(memberRow.getByText('write')).toBeVisible({ timeout: 30_000 });

    // ── 2. hobby → viewing is gated ──
    // The settings nav never offers the tab on a non-Enterprise plan...
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeHidden();
    // ...and navigating straight to the URL hits the entitlement wall
    // (the server action re-checks — hiding the tab is not the gate).
    await page.goto(`${settingsBase}/audit-log`, { timeout: FIRST_COMPILE_TIMEOUT });
    await expect(page.getByText('The audit log requires an Enterprise plan')).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });

    // ── 3. enterprise → tab appears and the PRE-upgrade change is visible ──
    const { error: tierError } = await admin
      .from('billing')
      .update({ tier_id: 'enterprise' })
      .eq('tenant_id', org.tenantId);
    if (tierError) throw new Error(`set tier enterprise: ${tierError.message}`);

    await page.goto(`${settingsBase}/audit-log`, { timeout: FIRST_COMPILE_TIMEOUT });
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible({
      timeout: FIRST_COMPILE_TIMEOUT,
    });
    const trailRow = page.getByRole('row', { name: /Member Role Changed/ });
    await expect(trailRow).toBeVisible({ timeout: FIRST_COMPILE_TIMEOUT });
    // Actor and target are both attributed on the row.
    await expect(trailRow.getByText(user.email)).toBeVisible();
    await expect(trailRow.getByText(memberEmail)).toBeVisible();

    // Detail dialog: summary plus the before/after diff of the change.
    await trailRow.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByText('Action Summary')).toBeVisible();
    await expect(page.getByText('Before State')).toBeVisible();
    await expect(page.getByText('After State')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('"read"')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('"write"')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Action Summary')).toBeHidden();

    // ── 4. CSV export: real download, trail content, no chain internals ──
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);

    const csvPath = await download.path();
    const csv = await fs.readFile(csvPath, 'utf8');
    const [header] = csv.split('\r\n');
    expect(header).toBe(
      'timestamp_utc,action,actor_email,actor_label,actor_type,actor_id,target_type,target,' +
        'target_id,ip_address,user_agent,request_id,details,before_state,after_state',
    );
    expect(csv).toContain('member_role_changed');
    expect(csv).toContain(user.email);
    expect(csv).toContain(memberEmail);
    // Chain internals never leave the database.
    expect(csv).not.toContain('row_hash');
    expect(csv).not.toContain('prev_hash');
  });
});
