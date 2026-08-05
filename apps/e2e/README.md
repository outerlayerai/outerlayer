# E2E Tests

End-to-end tests for the OuterLayer platform using [Playwright](https://playwright.dev/).

## Purpose

This package contains browser-based E2E tests that validate complete user flows across the OuterLayer platform. These tests run against real browsers and verify that the entire system works correctly from a user's perspective.

## Test Tiers

The E2E test suite is organized into three tiers to balance fast PR feedback with realistic staging validation:

| Tier | When It Runs | Target Environment | Time Budget |
|------|-------------|-------------------|-------------|
| **PR-Critical** | Every pull request | Local Supabase + dev server | < 10 min |
| **Staging Smoke** | After staging deployment | Live staging URL | < 5 min |
| **Full Suite** | Before prod deploy (required) or manual trigger | Staging | < 20 min |

## Setup

```bash
# Install dependencies
cd apps/e2e
yarn install

# Install Playwright browsers
npx playwright install
```

## Running Tests

```bash
# Run PR-Critical tests only (fast feedback)
yarn test:pr

# Run full test suite
yarn test:full

# Run smoke tests against staging
STAGING_URL=<staging-dashboard-url> yarn test:smoke

# Run all tests (headless)
yarn test

# Run tests with UI mode (interactive debugging)
yarn test:ui

# Run tests in headed mode (see the browser)
yarn test:headed

# Run tests in debug mode
yarn test:debug

# Run specific test file
yarn test tests/registration/email.spec.ts

# Run tests for specific browser
yarn test --project=chromium
```

## Test Structure

```
apps/e2e/
├── tests/
│   ├── auth/                      # Auth tests (Full Suite)
│   ├── registration/              # Registration tests
│   │   ├── email.spec.ts          # PR-Critical
│   │   ├── invitation.spec.ts     # PR-Critical
│   │   └── oauth.spec.ts          # Staging Smoke
│   ├── platform-admin/            # Admin tests (Full Suite)
│   ├── smoke/                     # Staging smoke tests
│   │   ├── health.spec.ts
│   │   ├── auth-page.spec.ts
│   │   └── navigation.spec.ts
│   └── utils/                     # Shared test utilities
├── playwright.config.ts           # Main configuration (PR + Full)
├── playwright.smoke.config.ts     # Smoke test configuration (Staging)
├── package.json
└── tsconfig.json
```

## Adding New Tests

### Step 1: Determine the Tier

| Choose This Tier | When Your Test... |
|-----------------|-------------------|
| **PR-Critical** | Tests core user flow (auth, registration), works with local Supabase |
| **Staging Smoke** | Requires external services (OAuth), validates deployment works |
| **Full Suite** | Admin features, destructive operations, comprehensive coverage |

### Step 2: Follow Test Patterns

**PR-Critical Test Pattern:**
```typescript
import { test, expect } from '@playwright/test';
import { waitForSupabase } from '../utils/test-helpers';

test.describe('My Feature', () => {
  test.beforeAll(async () => {
    await waitForSupabase(); // Ensures local Supabase is ready
  });

  test('should do something', async ({ page }) => {
    await page.goto('/my-page');
    await expect(page.locator('h1')).toBeVisible();
  });
});
```

**Staging Smoke Test Pattern:**
```typescript
import { test, expect } from '@playwright/test';

test.describe('Deployment Health', () => {
  test('should load without errors', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
  });
});
```

## CI/CD Integration

### Pull Request CI

- **Runs**: PR-Critical tests only (`registration/email.spec.ts`, `registration/invitation.spec.ts`)
- **Trigger**: Every push to a PR
- **Timeout**: 10 minutes for E2E job
- **On failure**: Artifacts (screenshots, traces) uploaded

### Staging Deployment CD

- **Runs**: Smoke tests after successful staging deployment
- **Trigger**: Merge to main → deploy-staging job completes
- **Timeout**: 5 minutes
- **On failure**: Job fails, artifacts uploaded

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_BASE_URL` | `http://localhost:3000` | Base URL for the app under test |
| `CI` | - | Set automatically in CI environments |

## Writing Tests

1. Create test files in `tests/<feature-name>/`
2. Use Playwright's test API
3. Follow the naming convention: `<flow-name>.spec.ts`
4. Use page objects for complex flows

Example:
```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test('should do something specific', async ({ page }) => {
    await page.goto('/path');
    await expect(page.locator('h1')).toHaveText('Expected Text');
  });
});
```

## Reports

After running tests, view the HTML report:
```bash
yarn report
```

## Best Practices

1. **Isolation**: Each test should be independent
2. **Selectors**: Use data-testid attributes when possible
3. **Waits**: Use Playwright's auto-waiting instead of explicit waits
4. **Assertions**: Be specific about what you're testing
5. **Cleanup**: Tests should clean up after themselves
