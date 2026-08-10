import type { env as dashboardEnv } from 'tenant-dashboard/src/env';

/**
 * The route handlers construct the dashboard's OWN admin client
 * (`@/supabaseAdminClient`), which reads `env.NEXT_PUBLIC_SUPABASE_URL` /
 * `env.SUPABASE_SECRET_KEY` from the T3 `env` module. test-setup.ts mocks
 * that module with the CI Supabase (54331 + demo HS256 key); a worktree
 * instance lives elsewhere and mints its own keys. The route tests override the
 * `env` mock with this builder so the handler's admin client targets the SAME
 * instance the test's own admin client does — resolved from process.env, which
 * the runner exports from `supabase status`.
 *
 * Every non-Supabase field mirrors test-setup.ts verbatim so any module that
 * reads `env` at import time still boots.
 */
export function buildEnvMock() {
  return {
    SUPABASE_SECRET_KEY:
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
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
    TOKEN_ENCRYPTION_KEY: 'test-encryption-key-must-be-32-chars!',
    NODE_ENV: 'test',
    RESEND_API_KEY: undefined,
    FROM_EMAIL: undefined,
    RESEND_BROADCAST_AUDIENCE_ID: undefined,
    CLICKHOUSE_HOST: undefined,
    CLICKHOUSE_PASSWORD: undefined,
    FLY_API_TOKEN: 'test-fly-api-token',
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54331',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3002',
    NEXT_PUBLIC_POSTHOG_UI_HOST: undefined,
    NEXT_PUBLIC_POSTHOG_PROJECT_ID: undefined,
  } satisfies Partial<Record<keyof typeof dashboardEnv, unknown>>;
}
