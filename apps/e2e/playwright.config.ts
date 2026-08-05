import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Playwright configuration for OuterLayer E2E tests.
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  /* Exclude quarantined flaky tests across every project. See tests/.quarantine/README.md */
  testIgnore: ['**/.quarantine/**'],

  /* Global setup - ensures Supabase is running */
  globalSetup: require.resolve('./global-setup'),

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use */
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for tenant-dashboard */
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3002',

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects for tiered testing strategy */
  projects: [
    // PR-Critical: Fast feedback on PRs - only core registration tests
    {
      name: 'chromium-pr',
      testMatch: ['**/registration/email.spec.ts', '**/registration/invitation.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    // Full Suite: Comprehensive coverage for pre-production validation (excludes smoke)
    {
      name: 'chromium-full',
      testMatch: ['**/*.spec.ts'],
      // selfhost specs need their own OUTERLAYER_SELF_HOSTED servers — they run
      // under the dedicated chromium-selfhost-* projects below.
      testIgnore: ['**/smoke/**', '**/.quarantine/**', '**/selfhost/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    // Staging Suite: Full tests + smoke tests for staging validation
    // Runs against deployed staging environment (no local webServer needed)
    {
      name: 'chromium-staging',
      testMatch: ['**/*.spec.ts'],
      testIgnore: ['**/selfhost/**'],
      // @local-stack specs drive the LOCAL gateway to dispatch to an in-process
      // localhost handler — the deployed staging gateway can't reach the CI
      // runner's localhost, so they can only run against a full local stack
      // (chromium-full). @billing-live specs create real Stripe test
      // subscriptions via the CLI + need the `stripe listen` webhook forwarder;
      // running them in CD would churn the test Stripe account every deploy.
      // Exclude both from the staging run.
      grepInvert: /@local-stack|@billing-live/,
      use: {
        ...devices['Desktop Chrome'],
        // Staging serves behind Vercel Authentication. global-setup does the
        // bypass handshake once and captures Vercel's origin-scoped
        // `_vercel_jwt` cookie into this storage state — the durable secret
        // itself never enters a browser context, so it can't ride
        // cross-origin requests or land in uploaded traces.
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? { storageState: path.resolve(__dirname, '.vercel-bypass-state.json') }
          : {}),
      },
    },
    // Self-host EE gating: each project drives its own
    // dashboard instance booted in self-host mode (see webServer array).
    // Requires E2E_SELFHOST=1 so those servers are started.
    {
      name: 'chromium-selfhost-unlicensed',
      testMatch: ['**/selfhost/selfhost-unlicensed.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3006' },
    },
    {
      name: 'chromium-selfhost-licensed',
      testMatch: ['**/selfhost/selfhost-licensed.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3007' },
    },
    // Legacy projects for backwards compatibility
    {
      name: 'chromium',
      testIgnore: ['**/selfhost/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testIgnore: ['**/selfhost/**'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testIgnore: ['**/selfhost/**'],
      use: { ...devices['Desktop Safari'] },
    },
  ],

  /* Run local dev servers before starting the tests. Skipped for remote URLs
   * and when E2E_EXTERNAL_SERVERS is set (the documented local flow pre-starts
   * the dashboard(s) manually — e.g. with the webpack compiler — and a flaky
   * reuse-probe here must not race them into EADDRINUSE). */
  webServer: (process.env.E2E_BASE_URL?.startsWith('https://') || process.env.E2E_EXTERNAL_SERVERS)
    ? undefined
    : [
        {
          command: 'yarn dev',
          cwd: require('path').resolve(__dirname, '../tenant-dashboard'),
          env: {
            ...process.env,
            SKIP_ENV_VALIDATION: 'true',
            PORT: process.env.E2E_PORT || '3002',
            // @local-stack specs run through the LOCAL gateway; without this the
            // dashboard falls back to the production gateway (config-global.ts).
            NEXT_PUBLIC_GATEWAY_URL:
              process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:9101',
          },
          url: process.env.E2E_BASE_URL || 'http://localhost:3002',
          reuseExistingServer: !process.env.CI,
          timeout: 120 * 1000,
        },
        // Self-host instances for the chromium-selfhost-* projects.
        // Opt-in via E2E_SELFHOST=1 — two extra dev servers are not
        // worth booting for runs that never touch tests/selfhost/**.
        ...(process.env.E2E_SELFHOST
          ? [
              {
                command: 'yarn dev',
                cwd: require('path').resolve(__dirname, '../tenant-dashboard'),
                env: {
                  ...process.env,
                  SKIP_ENV_VALIDATION: 'true',
                  PORT: '3006',
                  NEXT_DIST_DIR: '.next-selfhost-unlicensed',
                  OUTERLAYER_SELF_HOSTED: 'true',
                },
                url: 'http://localhost:3006',
                reuseExistingServer: !process.env.CI,
                timeout: 120 * 1000,
              },
              {
                command: 'yarn dev',
                cwd: require('path').resolve(__dirname, '../tenant-dashboard'),
                env: {
                  ...process.env,
                  SKIP_ENV_VALIDATION: 'true',
                  PORT: '3007',
                  NEXT_DIST_DIR: '.next-selfhost-licensed',
                  OUTERLAYER_SELF_HOSTED: 'true',
                  // Committed TEST keypair (fixtures/ee-license) — offline
                  // Ed25519 verification, unrelated to any production key.
                  OUTERLAYER_EE_PUBLIC_KEY: require('./fixtures/ee-license/test-license.json')
                    .publicKey,
                  OUTERLAYER_EE_LICENSE_KEY: require('./fixtures/ee-license/test-license.json')
                    .licenseKey,
                },
                url: 'http://localhost:3007',
                reuseExistingServer: !process.env.CI,
                timeout: 120 * 1000,
              },
            ]
          : []),
      ],
});
