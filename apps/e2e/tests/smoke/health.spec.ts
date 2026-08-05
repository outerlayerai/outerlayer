import { test, expect } from '@playwright/test';

/**
 * Health Check Smoke Tests
 *
 * Validates that the staging deployment is functional by checking:
 * - Homepage loads without errors
 * - No critical JavaScript errors in console
 */
test.describe('Deployment Health', () => {
  test('should load homepage without critical errors', async ({ page }) => {
    const errors: string[] = [];

    // Capture console errors
    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    // Navigate to homepage
    await page.goto('/');

    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Verify body is visible (page rendered)
    await expect(page.locator('body')).toBeVisible();

    // Check for critical errors (filter out non-critical warnings)
    const criticalErrors = errors.filter(
      (err) =>
        !err.includes('ResizeObserver') && // Ignore ResizeObserver errors
        !err.includes('Non-Error') // Ignore non-error rejections
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('should respond with valid HTML structure', async ({ page }) => {
    await page.goto('/');

    // Verify basic HTML structure exists
    const html = page.locator('html');
    await expect(html).toBeVisible();

    // Check that head and body exist
    const head = page.locator('head');
    const body = page.locator('body');

    await expect(head).toBeAttached();
    await expect(body).toBeVisible();
  });
});
