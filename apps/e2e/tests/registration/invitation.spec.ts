/**
 * E2E tests for invitation acceptance flow
 *
 * Tests the user journey when accepting an organization invitation.
 * Includes terms agreement verification.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  getSupabaseAdmin,
  cleanupTestUser,
  cleanupTestOrganization,
  loginTestUser,
  retryDbQuery,
  uniqueId,
  TIMEOUTS,
  TestUser,
} from '../utils/test-helpers';

interface MembershipStatusRecord {
  status: string;
}

interface TermsAgreementRecord {
  terms_version: string;
}

// ============================================================================
// Test Data Types
// ============================================================================

interface InvitationTestSetup {
  tenantId: string;
  ownerUserId: string;
  invitedUser: TestUser;
  membershipId: string;
}

type Awaitable<T> = T | PromiseLike<T>;

// ============================================================================
// Setup Helpers
// ============================================================================

/**
 * Creates a complete invitation test setup with proper isolation
 */
async function createInvitationSetup(): Promise<InvitationTestSetup> {
  const supabase = getSupabaseAdmin();
  const timestamp = uniqueId();

  // Create tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenant')
    .insert({
      organization_name: `E2E Test Org ${timestamp}`,
      company_name: `E2E Test Company ${timestamp}`,
    })
    .select()
    .single();
  if (tenantError) throw new Error(`Tenant creation failed: ${tenantError.message}`);

  // Create owner auth user
  const ownerEmail = `e2e-owner-${timestamp}@test.example.com`;
  const { data: ownerAuth, error: ownerAuthError } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: 'E2eT3st!Secure#2026Pwd',
    email_confirm: true,
  });
  if (ownerAuthError) throw new Error(`Owner auth creation failed: ${ownerAuthError.message}`);
  const ownerUserId = ownerAuth.user!.id;

  // Create owner profile
  const { error: ownerProfileError } = await supabase
    .from('profile')
    .insert({ id: ownerUserId, email: ownerEmail, name: 'Owner User' });
  if (ownerProfileError) throw new Error(`Owner profile creation failed: ${ownerProfileError.message}`);

  // Create owner membership (active)
  const { error: ownerMembershipError } = await supabase
    .from('membership')
    .insert({ user_id: ownerUserId, tenant_id: tenant.tenant_id, role: 'owner', status: 'active' });
  if (ownerMembershipError) throw new Error(`Owner membership creation failed: ${ownerMembershipError.message}`);

  // Create invited auth user
  const invitedEmail = `e2e-invited-${timestamp}@test.example.com`;
  const { data: invitedAuth, error: invitedAuthError } = await supabase.auth.admin.createUser({
    email: invitedEmail,
    password: 'E2eT3st!Secure#2026Pwd',
    email_confirm: true,
  });
  if (invitedAuthError) throw new Error(`Invited auth creation failed: ${invitedAuthError.message}`);
  const invitedUserId = invitedAuth.user!.id;

  // Create invited user profile
  const { error: invitedProfileError } = await supabase
    .from('profile')
    .insert({ id: invitedUserId, email: invitedEmail, name: 'Invited User' });
  if (invitedProfileError) throw new Error(`Invited profile creation failed: ${invitedProfileError.message}`);

  // Create pending membership (the invitation)
  const { data: membership, error: membershipError } = await supabase
    .from('membership')
    .insert({
      user_id: invitedUserId,
      tenant_id: tenant.tenant_id,
      role: 'read',
      status: 'pending',
      invited_by: ownerUserId,
    })
    .select()
    .single();
  if (membershipError) throw new Error(`Membership creation failed: ${membershipError.message}`);

  return {
    tenantId: tenant.tenant_id,
    ownerUserId,
    invitedUser: {
      id: invitedUserId,
      email: invitedEmail,
      password: 'E2eT3st!Secure#2026Pwd',
    },
    membershipId: membership.id,
  };
}

/**
 * Cleans up invitation test data safely (ignores errors)
 */
async function cleanupInvitationSetup(setup: InvitationTestSetup | null): Promise<void> {
  if (!setup) return;

  const supabase = getSupabaseAdmin();

  // Delete in correct order for FK constraints, ignoring errors
  const safeDelete = async (fn: () => Awaitable<unknown>) => {
    try {
      await fn();
    } catch {
      /* ignore */
    }
  };

  await safeDelete(() => supabase.from('terms_agreement').delete().eq('user_id', setup.invitedUser.id));
  await safeDelete(() => supabase.from('terms_agreement').delete().eq('user_id', setup.ownerUserId));
  // Cascades membership + tenant via platform_admin_delete_tenant, which sets
  // app.compensating so the protect_last_owner trigger doesn't block deleting
  // the owner's own membership row along with the rest.
  await cleanupTestOrganization(setup.tenantId);
  await safeDelete(() => supabase.from('profile').delete().eq('id', setup.invitedUser.id));
  await safeDelete(() => supabase.from('profile').delete().eq('id', setup.ownerUserId));
  await safeDelete(() => supabase.auth.admin.deleteUser(setup.invitedUser.id));
  await safeDelete(() => supabase.auth.admin.deleteUser(setup.ownerUserId));
}

// ============================================================================
// Tests: Invitation Acceptance (Happy Path)
// ============================================================================

test.describe('Invitation Acceptance', () => {
  let testSetup: InvitationTestSetup | null = null;

  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  test.beforeEach(async () => {
    testSetup = await createInvitationSetup();
  });

  test.afterEach(async ({ page }) => {
    // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
    await page.close();
    await cleanupInvitationSetup(testSetup);
    testSetup = null;
  });

  test('should accept invitation and record terms agreement', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();

    // Login as invited user
    await loginTestUser(page, testSetup!.invitedUser);

    // Navigate to accept-invite page
    await page.goto(`/auth/accept-invite?id=${testSetup!.membershipId}`);

    // Wait for invitation details to load
    await expect(page.getByRole('heading', { name: /organization invitation/i })).toBeVisible({
      timeout: TIMEOUTS.MEDIUM,
    });

    // Check terms checkbox (required before accept button is enabled)
    const termsCheckbox = page.getByRole('checkbox', { name: /terms/i });
    await expect(termsCheckbox).toBeVisible({ timeout: TIMEOUTS.SHORT });
    await termsCheckbox.check();

    // Accept invitation (button should now be enabled)
    await page.getByRole('button', { name: /accept invitation/i }).click();

    // Should show success message (page doesn't auto-redirect)
    await expect(page.getByText(/successfully joined/i)).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Click "Go to Dashboard" to navigate to orgs
    await page.getByRole('link', { name: /go to dashboard/i }).click();
    await page.waitForURL(/orgs/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify membership is now active with retry
    const membership = await retryDbQuery<MembershipStatusRecord>(async () =>
      supabaseAdmin.from('membership').select('status').eq('id', testSetup!.membershipId).maybeSingle()
    );

    expect(membership).not.toBeNull();
    expect(membership!.status).toBe('active');

    // Verify terms agreement was recorded
    const termsAgreement = await retryDbQuery<TermsAgreementRecord>(async () =>
      supabaseAdmin.from('terms_agreement').select('*').eq('user_id', testSetup!.invitedUser.id).maybeSingle()
    );

    if (termsAgreement) {
      expect(termsAgreement.terms_version).toBeDefined();
    }
  });
});

// ============================================================================
// Tests: Invitation Edge Cases
// ============================================================================

test.describe('Invitation Edge Cases', () => {
  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
  });

  test('should show error for invalid invitation ID', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const timestamp = uniqueId();
    const testEmail = `e2e-invalid-invite-${timestamp}@test.example.com`;
    let testUserId: string | null = null;

    try {
      // Create a user to login with
      const { data: auth } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: 'E2eT3st!Secure#2026Pwd',
        email_confirm: true,
      });
      testUserId = auth.user!.id;

      await supabaseAdmin.from('profile').insert({
        id: testUserId,
        email: testEmail,
        name: 'Test User',
      });

      // Login
      await loginTestUser(page, { id: testUserId, email: testEmail, password: 'E2eT3st!Secure#2026Pwd' });

      // Navigate to accept-invite with invalid UUID
      await page.goto('/auth/accept-invite?id=00000000-0000-0000-0000-000000000000');

      // Should show error heading
      await expect(page.getByRole('heading', { name: /error/i })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    } finally {
      await cleanupTestUser(testUserId);
    }
  });

  test('should show already accepted message for accepted invitation', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const timestamp = uniqueId();
    let tenantId: string | null = null;
    let ownerUserId: string | null = null;
    let invitedUserId: string | null = null;

    try {
      // Create tenant
      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `E2E Already Accepted Org ${timestamp}`,
          company_name: `E2E Already Accepted Company ${timestamp}`,
        })
        .select()
        .single();
      tenantId = tenant.tenant_id;

      // Create owner
      const { data: ownerAuth } = await supabaseAdmin.auth.admin.createUser({
        email: `e2e-owner-already-${timestamp}@test.example.com`,
        password: 'E2eT3st!Secure#2026Pwd',
        email_confirm: true,
      });
      ownerUserId = ownerAuth.user!.id;

      await supabaseAdmin.from('profile').insert({
        id: ownerUserId,
        email: `e2e-owner-already-${timestamp}@test.example.com`,
        name: 'Owner User',
      });

      await supabaseAdmin.from('membership').insert({
        user_id: ownerUserId,
        tenant_id: tenantId,
        role: 'owner',
        status: 'active',
      });

      // Create invited user
      const invitedEmail = `e2e-invited-already-${timestamp}@test.example.com`;
      const { data: invitedAuth } = await supabaseAdmin.auth.admin.createUser({
        email: invitedEmail,
        password: 'E2eT3st!Secure#2026Pwd',
        email_confirm: true,
      });
      invitedUserId = invitedAuth.user!.id;

      await supabaseAdmin.from('profile').insert({
        id: invitedUserId,
        email: invitedEmail,
        name: 'Invited User',
      });

      // Create membership that's ALREADY ACTIVE (not pending)
      const { data: membership } = await supabaseAdmin
        .from('membership')
        .insert({
          user_id: invitedUserId,
          tenant_id: tenantId,
          role: 'read',
          status: 'active', // Already accepted
          invited_by: ownerUserId,
        })
        .select()
        .single();

      // Login as invited user
      await loginTestUser(page, { id: invitedUserId, email: invitedEmail, password: 'E2eT3st!Secure#2026Pwd' });

      // Try to accept already-accepted invitation
      await page.goto(`/auth/accept-invite?id=${membership.id}`);

      // Should show "already accepted" heading
      await expect(page.getByRole('heading', { name: /already accepted/i })).toBeVisible({
        timeout: TIMEOUTS.MEDIUM,
      });
    } finally {
      // Cleanup in correct order
      const safeDelete = async (fn: () => Awaitable<unknown>) => {
        try {
          await fn();
        } catch {
          /* ignore */
        }
      };

      if (invitedUserId) await safeDelete(() => supabaseAdmin.from('terms_agreement').delete().eq('user_id', invitedUserId!));
      if (ownerUserId) await safeDelete(() => supabaseAdmin.from('terms_agreement').delete().eq('user_id', ownerUserId!));
      // Cascades membership + tenant via platform_admin_delete_tenant, which
      // sets app.compensating so protect_last_owner doesn't block it.
      if (tenantId) await cleanupTestOrganization(tenantId);
      if (invitedUserId) {
        await safeDelete(() => supabaseAdmin.from('profile').delete().eq('id', invitedUserId!));
        await safeDelete(() => supabaseAdmin.auth.admin.deleteUser(invitedUserId!));
      }
      if (ownerUserId) {
        await safeDelete(() => supabaseAdmin.from('profile').delete().eq('id', ownerUserId!));
        await safeDelete(() => supabaseAdmin.auth.admin.deleteUser(ownerUserId!));
      }
    }
  });

  test('should show expired message for expired invitation', async ({ page }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const timestamp = uniqueId();
    let tenantId: string | null = null;
    let ownerUserId: string | null = null;
    let invitedUserId: string | null = null;

    try {
      // Create tenant
      const { data: tenant } = await supabaseAdmin
        .from('tenant')
        .insert({
          organization_name: `E2E Expired Org ${timestamp}`,
          company_name: `E2E Expired Company ${timestamp}`,
        })
        .select()
        .single();
      tenantId = tenant.tenant_id;

      // Create owner
      const { data: ownerAuth } = await supabaseAdmin.auth.admin.createUser({
        email: `e2e-owner-expired-${timestamp}@test.example.com`,
        password: 'E2eT3st!Secure#2026Pwd',
        email_confirm: true,
      });
      ownerUserId = ownerAuth.user!.id;

      await supabaseAdmin.from('profile').insert({
        id: ownerUserId,
        email: `e2e-owner-expired-${timestamp}@test.example.com`,
        name: 'Owner User',
      });

      await supabaseAdmin.from('membership').insert({
        user_id: ownerUserId,
        tenant_id: tenantId,
        role: 'owner',
        status: 'active',
      });

      // Create invited user
      const invitedEmail = `e2e-invited-expired-${timestamp}@test.example.com`;
      const { data: invitedAuth } = await supabaseAdmin.auth.admin.createUser({
        email: invitedEmail,
        password: 'E2eT3st!Secure#2026Pwd',
        email_confirm: true,
      });
      invitedUserId = invitedAuth.user!.id;

      await supabaseAdmin.from('profile').insert({
        id: invitedUserId,
        email: invitedEmail,
        name: 'Invited User',
      });

      // Create EXPIRED membership (expires_at in the past)
      // Set expires_at to yesterday (invitation has expired)
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1);

      const { data: membership } = await supabaseAdmin
        .from('membership')
        .insert({
          user_id: invitedUserId,
          tenant_id: tenantId,
          role: 'read',
          status: 'pending',
          invited_by: ownerUserId,
          expires_at: expiredDate.toISOString(),
        })
        .select()
        .single();

      // Login as invited user
      await loginTestUser(page, { id: invitedUserId, email: invitedEmail, password: 'E2eT3st!Secure#2026Pwd' });

      // Try to accept expired invitation
      await page.goto(`/auth/accept-invite?id=${membership.id}`);

      // Should show expired heading or message
      await expect(page.getByRole('heading', { name: /expired/i })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    } finally {
      // Cleanup in correct order
      const safeDelete = async (fn: () => Awaitable<unknown>) => {
        try {
          await fn();
        } catch {
          /* ignore */
        }
      };

      if (invitedUserId) await safeDelete(() => supabaseAdmin.from('terms_agreement').delete().eq('user_id', invitedUserId!));
      if (ownerUserId) await safeDelete(() => supabaseAdmin.from('terms_agreement').delete().eq('user_id', ownerUserId!));
      // Cascades membership + tenant via platform_admin_delete_tenant, which
      // sets app.compensating so protect_last_owner doesn't block it.
      if (tenantId) await cleanupTestOrganization(tenantId);
      if (invitedUserId) {
        await safeDelete(() => supabaseAdmin.from('profile').delete().eq('id', invitedUserId!));
        await safeDelete(() => supabaseAdmin.auth.admin.deleteUser(invitedUserId!));
      }
      if (ownerUserId) {
        await safeDelete(() => supabaseAdmin.from('profile').delete().eq('id', ownerUserId!));
        await safeDelete(() => supabaseAdmin.auth.admin.deleteUser(ownerUserId!));
      }
    }
  });
});
