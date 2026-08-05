# E2E Testing Quickstart Guide

## Overview

The E2E test suite is organized into three tiers to balance fast PR feedback with realistic staging validation.

| Tier | When It Runs | Target Environment | Time Budget |
|------|-------------|-------------------|-------------|
| **PR-Critical** | Every pull request | Local Supabase + dev server | < 10 min |
| **Staging Smoke** | After staging deployment | Live staging URL | < 5 min |
| **Full Suite** | Before prod deploy (required) or manual trigger | Staging | < 20 min |

## Running Tests Locally

### PR-Critical Tests (Default)

```bash
cd apps/e2e
npx playwright test --project=chromium-pr
```

### Full Test Suite

```bash
cd apps/e2e
npx playwright test --project=chromium-full
```

### Smoke Tests (Against Staging)

```bash
cd apps/e2e
STAGING_URL=<staging-dashboard-url> npx playwright test --config=playwright.smoke.config.ts
```

## Adding New Tests

### Step 1: Determine the Tier

| Choose This Tier | When Your Test... |
|-----------------|-------------------|
| **PR-Critical** | Tests core user flow (auth, registration), works with local Supabase |
| **Staging Smoke** | Requires external services (OAuth), validates deployment works |
| **Full Suite** | Admin features, destructive operations, comprehensive coverage |

### Step 2: Place Test in Correct Directory

```
apps/e2e/tests/
├── auth/                 # Full Suite only
├── registration/         # email + invitation = PR-Critical; oauth = Smoke
├── platform-admin/       # Full Suite only
└── smoke/                # Staging Smoke only
```

### Step 3: Follow Test Patterns

**PR-Critical Test Pattern:**
```typescript
// tests/auth/my-feature.spec.ts
import { test, expect } from '@playwright/test';
import { waitForSupabase, createTestUser, cleanupTestUser } from '../utils/test-helpers';

test.describe('My Feature', () => {
  test.beforeAll(async () => {
    await waitForSupabase(); // Ensures local Supabase is ready
  });

  test('should do something', async ({ page }) => {
    // Test against local environment
    await page.goto('/my-page');
    await expect(page.locator('h1')).toBeVisible();
  });
});
```

**Staging Smoke Test Pattern:**
```typescript
// tests/smoke/deployment-health.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Deployment Health', () => {
  test('should load homepage without errors', async ({ page }) => {
    // Smoke tests use baseURL from playwright.smoke.config.ts
    await page.goto('/');

    // Check for no console errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await expect(page.locator('body')).toBeVisible();
    expect(errors).toHaveLength(0);
  });
});
```

## Test Data Isolation

When tests create data, use unique prefixes to enable cleanup:

```typescript
import { uniqueId } from '../utils/test-helpers';

const testEmail = `e2e-smoke-${uniqueId()}@test.example.com`;

test.afterAll(async () => {
  await cleanupTestUser(createdUserId);
});
```

## CI/CD Integration

### Pull Request CI

- Runs: PR-Critical tests
- Trigger: Every push to a PR
- Timeout: 10 minutes for E2E job
- On failure: Artifacts (screenshots, traces) uploaded

### Staging Deployment CD

- Runs: Smoke tests after successful deployment
- Trigger: Merge to main → deploy-staging job completes
- Timeout: 5 minutes
- On failure: Job fails, prevents silent deployment failures

### Production Release (Full Suite - Required)

The full E2E suite runs automatically as a gate before production deployment:

1. Trigger production deploy via Actions → OuterLayer CD → "Run workflow"
2. Select environment: "production"
3. Full E2E suite runs on staging before production deploy proceeds
4. Production deploy is blocked if any E2E test fails

### Manual Full Suite (Optional)

To run the full E2E suite on staging without deploying to production:

1. Go to Actions → OuterLayer CD → "Run workflow"
2. Select environment: "staging"
3. Check "Run full E2E suite" option
4. Full suite runs after smoke tests complete

## Troubleshooting

### "Supabase not running" error

PR-Critical tests require local Supabase:

```bash
cd apps/tenant-dashboard
npx supabase start
```

### Tests timeout on CI

Check that tests are in the correct tier:
- PR-Critical tests must work with local Supabase
- Don't add slow tests to PR-Critical tier

### Smoke tests fail after deployment

1. Check if staging is actually accessible
2. Verify staging URL is correct in environment
3. Check for deployment errors in the deploy-staging job

## Test Naming Convention

Follow the pattern: `should [specific outcome] when [specific condition]`

```typescript
// ✅ Good
test('should redirect to terms agreement when user has not consented', ...)

// ❌ Bad
test('test auth flow', ...)
```
