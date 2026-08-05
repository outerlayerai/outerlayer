import type { env as dashboardEnv } from 'tenant-dashboard/src/env';
// Integration Tests Setup
// This file runs before all tests to ensure proper environment configuration

// Ensure required environment variables are set
const requiredEnvVars = {
  'NEXT_PUBLIC_SUPABASE_URL': 'http://127.0.0.1:54331',
  'SUPABASE_SERVICE_ROLE_KEY': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  'NODE_ENV': 'test',
  // Database URL for pg client (used by streamDatasetIntoPg)
  'DATABASE_URL': 'postgresql://postgres:postgres@127.0.0.1:54332/postgres',
  // OAuth provider environment variables for integration tests
  'GOOGLE_CLIENT_ID': 'test-google-client-id',
  'GOOGLE_CLIENT_SECRET': 'test-google-client-secret',
  'GITHUB_CLIENT_ID': 'test-github-client-id',
  'GITHUB_CLIENT_SECRET': 'test-github-client-secret',
  'SUPABASE_AUTH_REDIRECT_URI': 'http://localhost:3002/auth/callback'
};

// Set environment variables if not already set
for (const [key, defaultValue] of Object.entries(requiredEnvVars)) {
  if (!process.env[key]) {
    process.env[key] = defaultValue;
  }
}

// Mock server-only to prevent "cannot be imported from Client Component" errors
vi.mock('server-only', () => ({}));

// Mock @repo/transactional to avoid ESM import issues with marked/react-email
vi.mock('@repo/transactional', () => ({
  ResetPasswordEmail: () => null,
  InviteUserEmail: () => null,
  ConfirmSignupEmail: () => null,
  BuildFailureEmail: () => null,
  RoleChangedEmail: () => null,
  RemovedFromOrgEmail: () => null,
  TempAccessNotificationEmail: () => null,
}));

// Mock T3 Env module to provide test values
// This prevents validation errors when tenant-dashboard code is imported.
// The Supabase connection fields fall back to `process.env` (with the usual
// global-stack defaults) rather than a bare literal: `lib/system/*` reads
// this module for its Vault RPC client, so a suite pointed at a non-default
// Supabase instance (e.g. a dedicated worktree's own local stack, via
// SUPABASE_SECRET_KEY / NEXT_PUBLIC_SUPABASE_URL overrides) needs its Vault
// calls to land on that same instance, not silently on the global one.
vi.mock('tenant-dashboard/src/env', () => ({
  env: {
    // Server - Required
    SUPABASE_SECRET_KEY:
      process.env.SUPABASE_SECRET_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    UNKEY_API_KEY: 'test-unkey-api-key',
    STRIPE_SECRET_KEY: 'sk_test_stripe_secret_key',
    STRIPE_SECRET_WEBHOOK_KEY: 'whsec_test_webhook_key',
    STRIPE_GROWTH_FLAT_PRICE_ID: 'price_test_growth_flat',
    STRIPE_TEAM_FLAT_PRICE_ID: 'price_test_team_flat',
    STRIPE_GROWTH_USAGE_PRICE_ID: 'price_test_growth_usage',
    STRIPE_TEAM_USAGE_PRICE_ID: 'price_test_team_usage',
    STRIPE_SPAN_METER_ID: 'meter_test_span',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
    GITHUB_APP_WEBHOOK_SECRET: 'test-webhook-secret',
    OAUTH_STATE_SECRET: 'test-oauth-state-secret-at-least-32-chars',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres',
    TOKEN_ENCRYPTION_KEY: 'test-encryption-key-must-be-32-chars!',
    NODE_ENV: 'test',
    // Server - Optional
    RESEND_API_KEY: undefined,
    FROM_EMAIL: undefined,
    RESEND_BROADCAST_AUDIENCE_ID: undefined,
    CLICKHOUSE_HOST: undefined,
    CLICKHOUSE_PASSWORD: undefined,
    // Fly machine cleanup tests stub global fetch, so this token is never
    // sent anywhere — but the service throws before fetching if it's unset.
    FLY_API_TOKEN: 'test-fly-api-token',
    // Client - Required
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3002',
    // Client - Optional
    NEXT_PUBLIC_POSTHOG_UI_HOST: undefined,
    NEXT_PUBLIC_POSTHOG_PROJECT_ID: undefined,
  } satisfies Partial<Record<keyof typeof dashboardEnv, unknown>>,
}));