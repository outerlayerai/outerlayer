/**
 * E2E Tests: Platform Admin Delete Operations
 *
 * Tests the delete user and delete organization flows in the platform admin section.
 * These are destructive operations requiring confirmation dialogs.
 */

import { test, expect } from '@playwright/test';
import {
  waitForSupabase,
  createTestPlatformAdmin,
  cleanupTestPlatformAdmin,
  createTestUser,
  cleanupTestUser,
  createTestOrganization,
  cleanupTestOrganization,
  loginPlatformAdmin,
  getSupabaseAdmin,
  retryDbQuery,
  TIMEOUTS,
  TestUser,
  TestOrganization,
} from '../utils/test-helpers';

// Use serial mode since tests modify database state
test.describe.configure({ mode: 'serial' });

test.describe('Platform Admin - Delete User', () => {
  let platformAdmin: TestUser;
  let targetUser: TestUser | null = null;

  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
    // Create a platform admin dynamically (self-contained, works in all environments)
    platformAdmin = await createTestPlatformAdmin('e2e-delete-user');
  });

  test.afterAll(async () => {
    // Clean up the platform admin user
    await cleanupTestPlatformAdmin(platformAdmin?.id || null);
  });

  test.afterEach(async ({ page }) => {
    // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
    await page.close();
    // Clean up target user if not already deleted
    if (targetUser) {
      await cleanupTestUser(targetUser.id);
      targetUser = null;
    }
  });

  test('can delete a user via the platform admin UI', async ({ page }) => {
    // Create a user to delete
    targetUser = await createTestUser('e2e-delete-target');

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to platform admin users
    await page.goto('/platform-admin/users');
    await expect(page).toHaveURL(/platform-admin\/users/, { timeout: TIMEOUTS.NAVIGATION });

    // Wait for user list to load (use heading to be more specific)
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Find and click on the target user row
    const userRow = page.locator('tr').filter({ hasText: targetUser.email });
    await expect(userRow).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await userRow.click();

    // Should navigate to user detail page
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${targetUser.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Find and click the delete button (use first() in case of duplicate testids on page)
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-user-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Confirm button should be disabled until email is entered
    const confirmButton = page.getByTestId('delete-user-confirm-button');
    await expect(confirmButton).toBeDisabled();

    // Type the confirmation email
    const emailInput = page.getByTestId('delete-user-email-input-field');
    await emailInput.fill(targetUser.email);

    // Confirm button should now be enabled
    await expect(confirmButton).toBeEnabled();

    // Click delete
    await confirmButton.click();

    // Wait for modal to close (indicates server action completed)
    await expect(modal).toBeHidden({ timeout: TIMEOUTS.NAVIGATION });

    // Should redirect back to users list after successful deletion
    await expect(page).toHaveURL(/platform-admin\/users$/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify user was deleted from database
    const supabase = getSupabaseAdmin();
    const deletedUser = await retryDbQuery(
      async () => {
        const { data: users, error } = await supabase.auth.admin.listUsers();
        if (error) return { data: null, error };
        const user = users?.users.find((u) => u.id === targetUser!.id);
        return { data: user || null, error: null };
      },
      { shouldRetry: (data) => data !== null }
    );

    expect(deletedUser).toBeNull();
    targetUser = null; // Already deleted, no need to clean up
  });

  test('cancel button closes the modal without deleting', async ({ page }) => {
    // Create a user to NOT delete
    targetUser = await createTestUser('e2e-cancel-target');

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to user detail page directly
    await page.goto(`/platform-admin/users/${targetUser.id}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${targetUser.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Click delete button (use first() in case of duplicate testids on page)
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-user-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Click cancel
    const cancelButton = page.getByTestId('delete-user-cancel-button');
    await cancelButton.click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.SHORT });

    // User should still exist in database
    const supabase = getSupabaseAdmin();
    const { data: users } = await supabase.auth.admin.listUsers();
    const userStillExists = users?.users.find((u) => u.id === targetUser!.id);
    expect(userStillExists).toBeDefined();
  });

  test('wrong email keeps confirm button disabled', async ({ page }) => {
    // Create a user to test confirmation validation
    targetUser = await createTestUser('e2e-wrong-email');

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to user detail page
    await page.goto(`/platform-admin/users/${targetUser.id}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${targetUser.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Click delete button (use first() in case of duplicate testids on page)
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-user-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    const confirmButton = page.getByTestId('delete-user-confirm-button');
    const emailInput = page.getByTestId('delete-user-email-input-field');

    // Initially disabled
    await expect(confirmButton).toBeDisabled();

    // Type wrong email - button should stay disabled
    await emailInput.fill('wrong@email.com');
    await expect(confirmButton).toBeDisabled();

    // Type partial match - button should stay disabled
    await emailInput.clear();
    await emailInput.fill(targetUser.email.slice(0, -5));
    await expect(confirmButton).toBeDisabled();

    // Close modal
    await page.getByTestId('delete-user-cancel-button').click();
  });

  test('email matching is case-insensitive', async ({ page }) => {
    // Create a user to test case-insensitive matching
    targetUser = await createTestUser('e2e-case-test');

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to user detail page
    await page.goto(`/platform-admin/users/${targetUser.id}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${targetUser.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Wait for page to fully load
    await page.waitForLoadState('networkidle');

    // Click delete button (use first() in case of React strict mode double-render)
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-user-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    const confirmButton = page.getByTestId('delete-user-confirm-button');
    const emailInput = page.getByTestId('delete-user-email-input-field');

    // Type email in UPPERCASE - button should be enabled
    await emailInput.fill(targetUser.email.toUpperCase());
    await expect(confirmButton).toBeEnabled();

    // Clear and type in mixed case
    await emailInput.clear();
    const mixedCase = targetUser.email
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    await emailInput.fill(mixedCase);
    await expect(confirmButton).toBeEnabled();

    // Close modal
    await page.getByTestId('delete-user-cancel-button').click();
  });
});

test.describe('Platform Admin - Delete Organization', () => {
  let platformAdmin: TestUser;
  let orgOwner: TestUser | null = null;
  let testOrg: TestOrganization | null = null;

  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
    // Create a platform admin dynamically (self-contained, works in all environments)
    platformAdmin = await createTestPlatformAdmin('e2e-delete-org');
  });

  test.afterAll(async () => {
    // Clean up the platform admin user
    await cleanupTestPlatformAdmin(platformAdmin?.id || null);
  });

  test.beforeEach(async () => {
    // Create a user who will own the org
    orgOwner = await createTestUser('e2e-org-owner');
  });

  test.afterEach(async ({ page }) => {
    // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
    await page.close();
    // Clean up in reverse order
    if (testOrg) {
      await cleanupTestOrganization(testOrg.tenantId);
      testOrg = null;
    }
    if (orgOwner) {
      await cleanupTestUser(orgOwner.id);
      orgOwner = null;
    }
  });

  test('can delete an organization via the platform admin UI', async ({ page }) => {
    // Create an organization to delete
    testOrg = await createTestOrganization('e2e-delete', orgOwner!.id);

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to platform admin organizations
    await page.goto('/platform-admin/organizations');
    await expect(page).toHaveURL(/platform-admin\/organizations/, { timeout: TIMEOUTS.NAVIGATION });

    // Wait for org list to load (use heading to be more specific)
    await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    // Find and click on the target org row
    const orgRow = page.locator('tr').filter({ hasText: testOrg.organizationName });
    await expect(orgRow).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await orgRow.click();

    // Should navigate to org detail page
    await expect(page).toHaveURL(new RegExp(`/platform-admin/organizations/${testOrg.tenantId}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Scroll to danger zone and click delete button
    const deleteButton = page.getByTestId('delete-org-button');
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-org-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Confirm button should be disabled until org name is entered
    const confirmButton = page.getByTestId('delete-org-confirm-button');
    await expect(confirmButton).toBeDisabled();

    // Type the confirmation name
    const nameInput = page.getByTestId('delete-org-name-input-field');
    await nameInput.fill(testOrg.organizationName);

    // Confirm button should now be enabled
    await expect(confirmButton).toBeEnabled();

    // Click delete
    await confirmButton.click();

    // Should redirect back to organizations list after successful deletion
    await expect(page).toHaveURL(/platform-admin\/organizations$/, { timeout: TIMEOUTS.NAVIGATION });

    // Verify org was deleted from database
    const supabase = getSupabaseAdmin();
    const deletedOrg = await retryDbQuery(
      async () => {
        const { data, error } = await supabase
          .from('tenant')
          .select('tenant_id')
          .eq('tenant_id', testOrg!.tenantId)
          .maybeSingle();
        return { data, error };
      },
      { shouldRetry: (data) => data !== null }
    );

    expect(deletedOrg).toBeNull();
    testOrg = null; // Already deleted, no need to clean up
  });

  test('cancel button closes the modal without deleting organization', async ({ page }) => {
    // Create an organization to NOT delete
    testOrg = await createTestOrganization('e2e-cancel-org', orgOwner!.id);

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to org detail page directly
    await page.goto(`/platform-admin/organizations/${testOrg.tenantId}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/organizations/${testOrg.tenantId}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Scroll to and click delete button
    const deleteButton = page.getByTestId('delete-org-button');
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-org-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Click cancel
    const cancelButton = page.getByTestId('delete-org-cancel-button');
    await cancelButton.click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Org should still exist in database
    const supabase = getSupabaseAdmin();
    const { data: org } = await supabase
      .from('tenant')
      .select('tenant_id')
      .eq('tenant_id', testOrg.tenantId)
      .maybeSingle();

    expect(org).not.toBeNull();
  });

  test('wrong name keeps confirm button disabled', async ({ page }) => {
    // Create an organization to test confirmation validation
    testOrg = await createTestOrganization('e2e-wrong-name', orgOwner!.id);

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to org detail page
    await page.goto(`/platform-admin/organizations/${testOrg.tenantId}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/organizations/${testOrg.tenantId}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Scroll to and click delete button
    const deleteButton = page.getByTestId('delete-org-button');
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-org-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    const confirmButton = page.getByTestId('delete-org-confirm-button');
    const nameInput = page.getByTestId('delete-org-name-input-field');

    // Initially disabled
    await expect(confirmButton).toBeDisabled();

    // Type wrong name - button should stay disabled
    await nameInput.fill('Wrong Organization Name');
    await expect(confirmButton).toBeDisabled();

    // Type partial match - button should stay disabled
    await nameInput.clear();
    await nameInput.fill(testOrg.organizationName.slice(0, -5));
    await expect(confirmButton).toBeDisabled();

    // Close modal
    await page.getByTestId('delete-org-cancel-button').click();
  });

  test('name matching is case-insensitive', async ({ page }) => {
    // Create an organization to test case-insensitive matching
    testOrg = await createTestOrganization('e2e-case-org', orgOwner!.id);

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to org detail page
    await page.goto(`/platform-admin/organizations/${testOrg.tenantId}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/organizations/${testOrg.tenantId}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Scroll to and click delete button
    const deleteButton = page.getByTestId('delete-org-button');
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-org-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    const confirmButton = page.getByTestId('delete-org-confirm-button');
    const nameInput = page.getByTestId('delete-org-name-input-field');

    // Type name in UPPERCASE - button should be enabled
    await nameInput.fill(testOrg.organizationName.toUpperCase());
    await expect(confirmButton).toBeEnabled();

    // Clear and type in lowercase
    await nameInput.clear();
    await nameInput.fill(testOrg.organizationName.toLowerCase());
    await expect(confirmButton).toBeEnabled();

    // Close modal
    await page.getByTestId('delete-org-cancel-button').click();
  });
});

test.describe('Platform Admin - Delete User Edge Cases', () => {
  let platformAdmin: TestUser;
  let soleOwnerUser: TestUser | null = null;
  let soleOwnerOrg: TestOrganization | null = null;

  test.beforeAll(async () => {
    const isReady = await waitForSupabase();
    if (!isReady) throw new Error('Supabase not ready');
    // Create a platform admin dynamically (self-contained, works in all environments)
    platformAdmin = await createTestPlatformAdmin('e2e-delete-edge');
  });

  test.afterAll(async () => {
    // Clean up the platform admin user
    await cleanupTestPlatformAdmin(platformAdmin?.id || null);
  });

  test.afterEach(async ({ page }) => {
    // Close before deleting backend rows so SWR pollers can't 403 mid-teardown.
    await page.close();
    // Clean up in reverse order
    if (soleOwnerOrg) {
      await cleanupTestOrganization(soleOwnerOrg.tenantId);
      soleOwnerOrg = null;
    }
    if (soleOwnerUser) {
      await cleanupTestUser(soleOwnerUser.id);
      soleOwnerUser = null;
    }
  });

  test('sole owner user shows warning and requires acknowledgment checkbox', async ({ page }) => {
    // Create a user who is sole owner of an org
    soleOwnerUser = await createTestUser('e2e-sole-owner');
    soleOwnerOrg = await createTestOrganization('e2e-orphan-org', soleOwnerUser.id);

    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to user detail page
    await page.goto(`/platform-admin/users/${soleOwnerUser.id}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${soleOwnerUser.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Click delete button (use first() in case of duplicate testids on page)
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await deleteButton.click();

    // Modal should appear
    const modal = page.getByTestId('delete-user-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.SHORT });

    // Should show the "Orphaned Organizations" warning (scoped to modal)
    await expect(modal.getByText('Orphaned Organizations')).toBeVisible();

    // Should show the org name in the warning (scoped to modal to avoid duplicate on page)
    await expect(modal.getByText(soleOwnerOrg.organizationName)).toBeVisible();

    const confirmButton = page.getByTestId('delete-user-confirm-button');
    const emailInput = page.getByTestId('delete-user-email-input-field');
    const acknowledgeCheckbox = page.getByTestId('delete-user-acknowledge-checkbox');

    // Type correct email - button should STILL be disabled (checkbox not checked)
    await emailInput.fill(soleOwnerUser.email);
    await expect(confirmButton).toBeDisabled();

    // Check the acknowledgment checkbox - now button should be enabled
    await acknowledgeCheckbox.check();
    await expect(confirmButton).toBeEnabled();

    // Uncheck - button should be disabled again
    await acknowledgeCheckbox.uncheck();
    await expect(confirmButton).toBeDisabled();

    // Close modal
    await page.getByTestId('delete-user-cancel-button').click();
  });

  test('platform admin user has delete button disabled', async ({ page }) => {
    // Login as seeded platform admin
    await loginPlatformAdmin(page, platformAdmin);

    // Navigate to the platform admin's own user detail page
    await page.goto(`/platform-admin/users/${platformAdmin.id}`);
    await expect(page).toHaveURL(new RegExp(`/platform-admin/users/${platformAdmin.id}`), {
      timeout: TIMEOUTS.NAVIGATION,
    });

    // Delete button should be disabled for platform admins
    const deleteButton = page.getByTestId('delete-user-button').first();
    await expect(deleteButton).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await expect(deleteButton).toBeDisabled();

    // Should show helper text explaining why
    await expect(page.getByText('Revoke platform admin role first')).toBeVisible();
  });
});
