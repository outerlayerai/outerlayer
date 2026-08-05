import { test, expect } from '@playwright/test';

/**
 * Navigation Smoke Tests
 *
 * Validates that basic navigation works:
 * - Pages load without errors
 * - Navigation between pages works
 * - Common routes are accessible
 */
test.describe('Basic Navigation', () => {
  test('should navigate from homepage to login page', async ({ page }) => {
    // Start at homepage
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to login
    await page.goto('/auth/login');
    await page.waitForLoadState('networkidle');

    // Verify we're on the login page (URL should contain auth/login)
    expect(page.url()).toContain('/auth/login');

    // Page should be visible
    await expect(page.locator('body')).toBeVisible();
  });

  test('should handle 404 pages gracefully', async ({ page }) => {
    // Navigate to a non-existent page
    const response = await page.goto('/this-page-does-not-exist-12345');

    // Should either show a 404 page or redirect
    // We're checking that the app doesn't crash
    await expect(page.locator('body')).toBeVisible();

    // The response should exist (page loaded)
    expect(response).not.toBeNull();
  });

  test('should load public pages without authentication', async ({ page }) => {
    const publicRoutes = ['/', '/auth/login'];

    for (const route of publicRoutes) {
      const response = await page.goto(route);
      await page.waitForLoadState('networkidle');

      // Each route should load successfully
      expect(response?.ok() || response?.status() === 304).toBeTruthy();

      // Page should be visible
      await expect(page.locator('body')).toBeVisible();
    }
  });
});
