/**
 * E2E tests for terms blocking flow
 *
 * Tests the scenario where existing users need to agree to terms.
 *
 * Non-Blocking Policy (002-terms-update-policy):
 * - Users with ANY existing agreement are NEVER blocked
 * - Only users with NO agreement are blocked (first-time users)
 * - This implements the "continued use = acceptance" legal policy
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  getSupabaseAdmin,
  createTestUser,
  cleanupTestUser,
  loginTestUser,
  retryDbQuery,
  TIMEOUTS,
  TestUser,
} from '../utils/test-helpers';

interface TermsAgreementRecord {
  user_id: string;
  terms_version: string;
}

// Run tests serially to avoid database conflicts
test.describe.configure({ mode: 'serial' });

test.describe('Terms Blocking Flow', () => {
  let testUser: TestUser | null = null;

  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  test.afterEach(async ({ page }) => {
    // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
    await page.close();
    if (testUser) {
      await cleanupTestUser(testUser.id);
      testUser = null;
    }
  });

  test('should allow access after agreeing to terms', async ({ page }) => {
    // Create user with profile but NO terms agreement
    testUser = await createTestUser('e2e-blocking');

    // Login
    await loginTestUser(page, testUser);

    // Navigate to terms agreement page (blocking flow)
    await page.goto('/auth/terms-agreement?blocking=true&return_to=/orgs');

    // Wait for checkbox to be interactive
    await expect(page.getByTestId('terms-agreement-checkbox')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Agree to terms
    await page.getByTestId('terms-agreement-checkbox').check();

    // Wait for button to be enabled (not in loading state)
    const agreeButton = page.getByTestId('agree-button');
    await expect(agreeButton).toBeEnabled({ timeout: TIMEOUTS.MEDIUM });
    await agreeButton.click();

    // Should redirect to /orgs
    await expect(page).toHaveURL(/orgs/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify terms record was created with retry for eventual consistency
    const supabaseAdmin = getSupabaseAdmin();
    const termsAgreement = await retryDbQuery<TermsAgreementRecord>(async () =>
      supabaseAdmin.from('terms_agreement').select('*').eq('user_id', testUser!.id).maybeSingle()
    );

    // Assert the record's contents, not just that it exists
    expect(termsAgreement?.user_id).toBe(testUser!.id);
    expect(termsAgreement?.terms_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('should not redirect existing user to pending flow', async ({ page }) => {
    // Create user with profile but NO terms agreement
    testUser = await createTestUser('e2e-pending');

    // Login and wait specifically for terms-agreement (user has no terms, so must be redirected)
    await loginTestUser(page, testUser, { expectedUrlPattern: /terms-agreement/ });

    // This tests the fix: users with profile but no membership should NOT
    // be treated as new users (pending flow is for profile creation)
    const currentUrl = page.url();

    // Explicit assertions - no conditionals
    expect(currentUrl).toContain('terms-agreement');
    expect(currentUrl).toContain('blocking=true');
    expect(currentUrl).not.toContain('pending=true');
  });

  /**
   * Regression test for infinite redirect loop bug.
   *
   * Bug: TermsGuard had isChecking in useCallback deps, causing infinite loop
   * when redirecting to /auth/terms-agreement.
   *
   * This test verifies:
   * 1. User without terms is redirected from /orgs to /auth/terms-agreement
   * 2. The redirect completes (page loads, not stuck on splash screen)
   * 3. No infinite redirect loop (page becomes interactive)
   */
  test('should redirect to terms-agreement without infinite loop', async ({ page }) => {
    // Create user with profile but NO terms agreement
    testUser = await createTestUser('e2e-redirect-loop');

    // Login
    await loginTestUser(page, testUser);

    // Navigate to /orgs - TermsGuard should redirect to terms-agreement
    await page.goto('/orgs');

    // Should redirect to terms-agreement with blocking=true
    // If there's an infinite loop, this will timeout
    await expect(page).toHaveURL(/auth\/terms-agreement.*blocking=true/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify the page actually loaded (not stuck on splash screen)
    // The checkbox being visible proves the page rendered completely
    await expect(page.getByTestId('terms-agreement-checkbox')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Verify the agree button is present and functional
    await expect(page.getByTestId('agree-button')).toBeVisible();
  });

  /**
   * Non-Blocking Policy Test (002-terms-update-policy):
   * Users with ANY existing agreement should NOT be blocked,
   * even if their terms version is outdated.
   */
  test('should NOT block user with old terms version (non-blocking policy)', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();

    // Create user with profile and OUTDATED terms agreement
    testUser = await createTestUser('e2e-old-version');

    // Add an outdated terms agreement (old version)
    const { error: termsError } = await supabaseAdmin.from('terms_agreement').insert({
      user_id: testUser.id,
      terms_version: '2020-01-01', // Old version - current is 2026-01-10
      agreed_at: new Date().toISOString(),
      consent_type: 'explicit',
      created_by: testUser.id,
    });
    if (termsError) throw new Error(`Terms agreement creation failed: ${termsError.message}`);

    // Login
    await loginTestUser(page, testUser);

    // Navigate to /orgs - TermsGuard should NOT redirect to terms-agreement
    await page.goto('/orgs');

    // Wait for the orgs page content to load as a positive signal
    // If the page renders successfully, we know we weren't redirected
    await expect(page.getByRole('heading', { level: 4 })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Assert the outcome: the user remains on /orgs
    const currentUrl = page.url();
    expect(currentUrl).toContain('/orgs');
    expect(currentUrl).not.toContain('terms-agreement');
  });

  /**
   * Blocking Policy Test:
   * Users with NO agreement should still be blocked.
   */
  test('should block user with NO terms agreement', async ({ page }) => {
    // Create user with profile but NO terms agreement
    testUser = await createTestUser('e2e-no-terms');

    // Login
    await loginTestUser(page, testUser);

    // Navigate to /orgs - TermsGuard should redirect to terms-agreement
    await page.goto('/orgs');

    // Should redirect to terms-agreement with blocking=true
    await expect(page).toHaveURL(/auth\/terms-agreement.*blocking=true/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify the blocking page loaded
    await expect(page.getByTestId('terms-agreement-checkbox')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
  });

  /**
   * Legacy test: Users can still manually agree to updated terms if they choose.
   * This tests the UI flow when a user explicitly navigates to the terms page.
   */
  test('should allow user to voluntarily re-agree to terms via direct navigation', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();

    // Create user with profile and existing terms agreement
    testUser = await createTestUser('e2e-voluntary');

    // Add an existing terms agreement
    const { error: termsError } = await supabaseAdmin.from('terms_agreement').insert({
      user_id: testUser.id,
      terms_version: '2020-01-01', // Old version
      agreed_at: new Date().toISOString(),
      consent_type: 'explicit',
      created_by: testUser.id,
    });
    if (termsError) throw new Error(`Terms agreement creation failed: ${termsError.message}`);

    // Login
    await loginTestUser(page, testUser);

    // Voluntarily navigate to terms page (not blocking flow)
    await page.goto('/auth/terms-agreement?blocking=true&return_to=/orgs');

    // Wait for form to be fully loaded
    await expect(page.getByTestId('terms-agreement-checkbox')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Check the terms checkbox
    await page.getByTestId('terms-agreement-checkbox').check();

    // Wait for the button to become enabled
    const agreeButton = page.getByTestId('agree-button');
    await expect(agreeButton).toBeEnabled({ timeout: TIMEOUTS.MEDIUM });

    // Click the agree button and wait for navigation
    await Promise.all([
      page.waitForURL(/orgs/, { timeout: TIMEOUTS.NAVIGATION }),
      agreeButton.click(),
    ]);

    // Verify we're on /orgs
    await expect(page.getByRole('heading', { level: 4 })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
  });
});
