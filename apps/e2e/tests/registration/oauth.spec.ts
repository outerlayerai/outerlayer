/**
 * E2E tests for OAuth registration flow
 *
 * Tests the OAuth registration journey by simulating what happens AFTER
 * the OAuth provider redirects back. We can't automate GitHub/Google login,
 * but we can test the callback behavior by creating auth users directly.
 */

import { test, expect } from '@playwright/test';
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
}

/**
 * Creates an auth user WITHOUT a profile (simulates OAuth callback state)
 * This is the state after OAuth provider redirects back but before profile creation
 */
async function createOAuthUser(email: string, provider: 'github' | 'google' = 'github'): Promise<string> {
  const client = getSupabaseAdmin();
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: 'E2eT3st!Secure#2026Pwd',
    email_confirm: true,
    user_metadata: {
      name: 'OAuth Test User',
      avatar_url: 'https://example.com/avatar.png',
    },
    app_metadata: {
      provider,
      providers: [provider],
    },
  });

  if (error) throw new Error(`Auth user creation failed: ${error.message}`);
  if (!data.user) throw new Error('No user returned');

  return data.user.id;
}

test.describe('OAuth Registration', () => {
  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  test.describe('New User (Pending Flow)', () => {
    let testUserId: string | null = null;
    let testUserEmail: string;

    test.afterEach(async ({ page }) => {
      // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
      await page.close();
      await cleanupTestUser(testUserId);
      testUserId = null;
    });

    test('should create profile and terms record after agreeing (pending flow)', async ({ page }) => {
      const supabaseAdmin = getSupabaseAdmin();

      // Simulate OAuth callback state: auth user exists but no profile
      testUserEmail = `e2e-oauth-new-${uniqueId()}@test.example.com`;
      testUserId = await createOAuthUser(testUserEmail);

      // Verify: auth user exists, profile does NOT exist
      const { data: profileBefore } = await supabaseAdmin
        .from('profile')
        .select('id')
        .eq('id', testUserId)
        .maybeSingle();
      expect(profileBefore).toBeNull();

      // Login (this simulates what happens after OAuth redirect)
      await page.goto('/auth/login');
      await expect(page.locator('[name="email"]')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

      await page.fill('[name="email"]', testUserEmail);
      await page.fill('[name="password"]', 'E2eT3st!Secure#2026Pwd');
      await page.getByRole('button', { name: 'Login', exact: true }).click();

      // Should land on /orgs or terms-agreement
      await page.waitForURL(/orgs|terms-agreement/, { timeout: TIMEOUTS.NAVIGATION });

      // Navigate to pending terms flow (simulates callback redirect for new OAuth user)
      await page.goto('/auth/terms-agreement?pending=true&return_to=/orgs');

      // Wait for checkbox to be visible before interacting
      await expect(page.getByTestId('terms-agreement-checkbox')).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

      // Agree to terms
      await page.getByTestId('terms-agreement-checkbox').check();

      // Wait for button to be enabled (not in loading state)
      const agreeButton = page.getByTestId('agree-button');
      await expect(agreeButton).toBeEnabled({ timeout: TIMEOUTS.MEDIUM });
      await agreeButton.click();

      // Should redirect to /orgs
      await expect(page).toHaveURL(/orgs/, { timeout: TIMEOUTS.NAVIGATION });

      // Verify profile was created with retry
      const profile = await retryDbQuery<ProfileRecord>(async () =>
        supabaseAdmin.from('profile').select('*').eq('id', testUserId!).maybeSingle()
      );
      expect(profile).not.toBeNull();
      expect(profile!.email).toBe(testUserEmail);

      // Verify terms agreement was recorded with retry
      const termsAgreement = await retryDbQuery<TermsAgreementRecord>(async () =>
        supabaseAdmin.from('terms_agreement').select('*').eq('user_id', testUserId!).maybeSingle()
      );
      expect(termsAgreement).not.toBeNull();
      expect(termsAgreement!.terms_version).toBeDefined();
    });
  });
});
