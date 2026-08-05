/**
 * Staging-specific test utilities for E2E smoke tests
 *
 * Provides patterns for:
 * - Test data isolation with unique prefixes
 * - Cleanup utilities for staging environment
 * - Read-only assertion helpers
 *
 * NOTE: Current smoke tests (health.spec.ts, auth-page.spec.ts, navigation.spec.ts)
 * are intentionally READ-ONLY and don't create test data, so they don't import
 * these utilities. These helpers are provided for future smoke tests that may
 * need to create data (e.g., testing user registration on staging).
 *
 * Usage: Import when your smoke test creates data that needs cleanup.
 */

// ============================================================================
// Test Data Isolation
// ============================================================================

/**
 * Generates a unique test prefix for staging test data
 * Format: e2e-smoke-{timestamp}-{random}
 *
 * Use this prefix for any test data created on staging to enable cleanup
 */
export function generateTestPrefix(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `e2e-smoke-${timestamp}-${random}`;
}

/**
 * Generates a unique test email address for staging
 * Uses test.example.com domain which is reserved for testing (RFC 2606)
 */
export function generateTestEmail(prefix: string): string {
  return `${prefix}@test.example.com`;
}

/**
 * Generates a unique test organization name
 */
export function generateTestOrgName(prefix: string): string {
  return `${prefix}-org`;
}

// ============================================================================
// Staging Environment Detection
// ============================================================================

/**
 * Checks if we're running against the staging environment
 */
export function isStaging(): boolean {
  const baseUrl = process.env.STAGING_URL || process.env.E2E_BASE_URL || '';
  return (
    baseUrl.includes('stg.outerlayer.ai') ||
    baseUrl.includes('stg.agentmark.co') ||
    baseUrl.includes('staging')
  );
}

/**
 * Gets the staging base URL
 */
export function getStagingUrl(): string {
  return process.env.STAGING_URL || 'https://stg.outerlayer.ai';
}

// ============================================================================
// Cleanup Utilities
// ============================================================================

/**
 * Tracks test data created during a test run for cleanup
 */
export class TestDataTracker {
  private createdUsers: string[] = [];
  private createdOrgs: string[] = [];
  private createdEmails: string[] = [];

  /**
   * Records a user ID for cleanup
   */
  trackUser(userId: string): void {
    this.createdUsers.push(userId);
  }

  /**
   * Records an organization ID for cleanup
   */
  trackOrg(orgId: string): void {
    this.createdOrgs.push(orgId);
  }

  /**
   * Records an email for cleanup
   */
  trackEmail(email: string): void {
    this.createdEmails.push(email);
  }

  /**
   * Returns all tracked data (useful for manual cleanup or logging)
   */
  getTrackedData(): {
    users: string[];
    orgs: string[];
    emails: string[];
  } {
    return {
      users: [...this.createdUsers],
      orgs: [...this.createdOrgs],
      emails: [...this.createdEmails],
    };
  }

  /**
   * Clears all tracked data
   */
  clear(): void {
    this.createdUsers = [];
    this.createdOrgs = [];
    this.createdEmails = [];
  }

  /**
   * Returns true if any data was tracked
   */
  hasTrackedData(): boolean {
    return (
      this.createdUsers.length > 0 ||
      this.createdOrgs.length > 0 ||
      this.createdEmails.length > 0
    );
  }
}

// ============================================================================
// Smoke Test Assertions
// ============================================================================

/**
 * Standard checks for smoke tests that should be read-only
 * These assertions verify the page works without modifying data
 */
export const SmokeAssertions = {
  /**
   * Verifies a page loaded without errors
   */
  pageLoaded: async (
    page: import('@playwright/test').Page
  ): Promise<{ success: boolean; errors: string[] }> => {
    const errors: string[] = [];

    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    await page.waitForLoadState('networkidle');

    const criticalErrors = errors.filter(
      (err) =>
        !err.includes('ResizeObserver') && // Ignore ResizeObserver errors
        !err.includes('Non-Error') // Ignore non-error rejections
    );

    return {
      success: criticalErrors.length === 0,
      errors: criticalErrors,
    };
  },

  /**
   * Verifies basic HTML structure is present
   */
  hasValidStructure: async (
    page: import('@playwright/test').Page
  ): Promise<boolean> => {
    const html = page.locator('html');
    const body = page.locator('body');

    const htmlVisible = await html.isVisible().catch(() => false);
    const bodyVisible = await body.isVisible().catch(() => false);

    return htmlVisible && bodyVisible;
  },
};

// ============================================================================
// Test Isolation Patterns
// ============================================================================

/**
 * Creates a scoped test context for a smoke test run
 * Tracks all created data and provides cleanup
 */
export function createSmokeTestContext(): {
  prefix: string;
  tracker: TestDataTracker;
  cleanup: () => void;
} {
  const prefix = generateTestPrefix();
  const tracker = new TestDataTracker();

  return {
    prefix,
    tracker,
    cleanup: () => {
      // Log what was created for debugging
      if (tracker.hasTrackedData()) {
        const data = tracker.getTrackedData();
        console.log(`[Smoke Test Cleanup] Prefix: ${prefix}`);
        console.log(`  Users: ${data.users.length}`);
        console.log(`  Orgs: ${data.orgs.length}`);
        console.log(`  Emails: ${data.emails.length}`);
      }
      tracker.clear();
    },
  };
}
