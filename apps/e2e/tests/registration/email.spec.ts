/**
 * E2E tests for email registration flow
 *
 * Tests the complete email registration journey including:
 * - Form validation
 * - Terms agreement requirement
 * - Successful account creation
 */

import { test, expect } from '@playwright/test';
import type { User } from '@supabase/supabase-js';
import {
  waitForSupabase,
  getSupabaseAdmin,
  cleanupTestUser,
  retryDbQuery,
  uniqueId,
  TIMEOUTS,
} from '../utils/test-helpers';

interface ProfileRecord {
  email: string;
}

interface TermsAgreementRecord {
  terms_version: string;
  agreed_at: string;
}

test.describe('Email Registration', () => {
  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  test.describe('Form Validation', () => {
    test('should require terms agreement before submission', async ({ page }) => {
      await page.goto('/auth/register');

      // Wait for form to be ready
      await expect(page.locator('[name="email"]')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

      // Fill form without checking terms
      await page.fill('[name="email"]', 'test-no-terms@example.com');
      await page.fill('[name="password"]', 'E2eT3st!Secure#2026Pwd');
      await page.fill('[name="firstName"]', 'Test');
      await page.fill('[name="lastName"]', 'User');

      // Try to submit without agreeing to terms
      await page.getByRole('button', { name: 'Create account' }).click();

      // Should show validation error
      await expect(page.getByText(/must agree to the Terms/i)).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    });
  });

  test.describe('Error Handling', () => {
    test('should show error for duplicate email', async ({ page }) => {
      const supabaseAdmin = getSupabaseAdmin();
      const testEmail = `e2e-duplicate-${uniqueId()}@test.example.com`;
      let createdUserId: string | null = null;

      try {
        // Create existing user first
        const { data } = await supabaseAdmin.auth.admin.createUser({
          email: testEmail,
          password: 'E2eT3st!Secure#2026Pwd',
          email_confirm: true,
        });
        createdUserId = data.user?.id || null;

        // Try to register with same email
        await page.goto('/auth/register');
        await expect(page.locator('[name="email"]')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

        await page.fill('[name="email"]', testEmail);
        await page.fill('[name="password"]', 'E2eT3st!Secure#2026Pwd');
        await page.fill('[name="firstName"]', 'Test');
        await page.fill('[name="lastName"]', 'User');
        await page.getByTestId('terms-checkbox').check();
        await page.getByRole('button', { name: 'Create account' }).click();

        // Should show error message (generic for security - doesn't reveal email exists)
        const errorAlert = page.getByTestId('register-error-alert');
        await expect(errorAlert).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
        await expect(errorAlert).toContainText(/registration failed|try again|contact support/i);
      } finally {
        await cleanupTestUser(createdUserId);
      }
    });
  });

  test.describe('Successful Registration', () => {
    test('should create user, profile, and terms agreement record', async ({ page }) => {
      const supabaseAdmin = getSupabaseAdmin();
      const testEmail = `e2e-register-${uniqueId()}@test.example.com`;
      let createdUserId: string | null = null;

      try {
        await page.goto('/auth/register');
        await expect(page.locator('[name="email"]')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

        // Fill complete form
        await page.fill('[name="email"]', testEmail);
        await page.fill('[name="password"]', 'E2eT3st!Secure#2026Pwd');
        await page.fill('[name="firstName"]', 'Test');
        await page.fill('[name="lastName"]', 'User');
        await page.getByTestId('terms-checkbox').check();

        // Submit
        await page.getByRole('button', { name: 'Create account' }).click();

        // Wait for either redirect OR error alert
        // Use specific test ID to target the registration error alert (not other alerts like snackbars)
        const redirectPromise = page.waitForURL(/verify/, { timeout: TIMEOUTS.NAVIGATION });
        const errorAlert = page.getByTestId('register-error-alert');
        const anyAlert = page.locator('[role="alert"]');

        try {
          await Promise.race([
            redirectPromise,
            errorAlert.waitFor({ state: 'visible', timeout: TIMEOUTS.NAVIGATION }).then(async () => {
              const errorText = await errorAlert.textContent();
              throw new Error(`Registration failed with visible error: ${errorText}`);
            }),
          ]);
        } catch (error: unknown) {
          // If we caught an error from the alert, rethrow it
          if (error instanceof Error && error.message.includes('Registration failed with visible error')) {
            throw error;
          }
          // Otherwise, it's a timeout - gather diagnostic info
          const specificAlertVisible = await errorAlert.isVisible().catch(() => false);
          const specificAlertText = specificAlertVisible ? await errorAlert.textContent().catch(() => 'N/A') : 'N/A';

          // Check for ANY alert elements (snackbars, toasts, etc.)
          const allAlerts = await anyAlert.all();
          const alertDiagnostics: string[] = [];
          for (let i = 0; i < Math.min(allAlerts.length, 3); i++) {
            const alert = allAlerts[i]!;
            const text = await alert.textContent().catch(() => 'N/A');
            const classes = await alert.getAttribute('class').catch(() => 'N/A');
            alertDiagnostics.push(`Alert ${i + 1}: text="${text?.substring(0, 100)}", class="${classes?.substring(0, 100)}"`);
          }

          // Capture page state for debugging
          const currentUrl = page.url();
          const pageContent = await page.locator('body').textContent().catch(() => 'Could not get page content');

          throw new Error(
            `Registration did not redirect to /verify. Current URL: ${currentUrl}. ` +
            `Specific error alert visible: ${specificAlertVisible}, text: "${specificAlertText}". ` +
            `Total alert elements: ${allAlerts.length}. ` +
            `Alert diagnostics: [${alertDiagnostics.join('; ')}]. ` +
            `Page excerpt: ${pageContent?.substring(0, 300)}`
          );
        }

        // Should be on verify page now
        await expect(page).toHaveURL(/verify/);

        // Find created user with retry (eventual consistency)
        const createdUser = await retryDbQuery<User>(async () => {
          const { data: users } = await supabaseAdmin.auth.admin.listUsers();
          const user = users?.users.find((u) => u.email === testEmail);
          return { data: user || null, error: null };
        });

        expect(createdUser).toBeDefined();
        createdUserId = createdUser!.id;

        // Verify profile was created with retry
        const profile = await retryDbQuery<ProfileRecord>(async () =>
          supabaseAdmin.from('profile').select('*').eq('id', createdUserId!).maybeSingle()
        );
        expect(profile).not.toBeNull();
        expect(profile!.email).toBe(testEmail);

        // Verify terms agreement was recorded with retry
        const termsAgreement = await retryDbQuery<TermsAgreementRecord>(async () =>
          supabaseAdmin.from('terms_agreement').select('*').eq('user_id', createdUserId!).maybeSingle()
        );
        expect(termsAgreement).not.toBeNull();
        expect(termsAgreement!.terms_version).toBeDefined();
        expect(termsAgreement!.agreed_at).toBeDefined();
      } finally {
        await cleanupTestUser(createdUserId);
      }
    });
  });
});
