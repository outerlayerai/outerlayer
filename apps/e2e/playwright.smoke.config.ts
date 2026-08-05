import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for staging smoke tests.
 * Runs against the live staging environment after deployment.
 *
 * Usage:
 *   STAGING_URL=https://stg.outerlayer.ai npx playwright test --config=playwright.smoke.config.ts
 */
export default defineConfig({
  testDir: './tests/smoke',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* No retries for smoke tests - they should pass consistently */
  retries: 0,

  /* Single worker for smoke tests to avoid overwhelming staging */
  workers: 1,

  /* Reporter to use */
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  /* Faster timeouts for smoke tests - staging should respond quickly */
  timeout: 30000,
  expect: { timeout: 10000 },

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for staging environment */
    baseURL: process.env.STAGING_URL || 'https://stg.outerlayer.ai',

    /* Collect trace on failure for debugging */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects - smoke tests only run on Chromium */
  projects: [
    {
      name: 'chromium-smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* No webServer - tests run against already-deployed staging */
  webServer: undefined,
});
