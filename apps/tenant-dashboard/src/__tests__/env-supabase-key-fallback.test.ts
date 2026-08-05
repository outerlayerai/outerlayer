// @vitest-environment node
/**
 * Real env-validation test for the Supabase API-key transitional fallback.
 *
 * env.ts prefers the new opaque-key names (`SUPABASE_SECRET_KEY`,
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and falls back to the legacy names
 * (`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) so a deploy
 * whose secrets have not been renamed yet keeps building. `.min(1)` still
 * requires at least one of each pair. This pins that contract against the REAL
 * `createEnv` schema, not a hand-rolled copy.
 *
 * Same three obstacles as the Stripe env test: the global `vi.mock('../env')`,
 * `skipValidation` under `NODE_ENV=test`, and refinements that read raw
 * `process.env` — defeated by unmocking, forcing `NODE_ENV=development`, and
 * rebuilding `process.env` under `vi.resetModules()`.
 *
 * Runs in the `node` environment: under jsdom, t3-env treats server-var access
 * as "from the client" and throws.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Bypass the global env mock from unit-test-setup.ts — we want the real schema.
vi.unmock('../env');

const ORIGINAL_ENV = process.env;

/** A fully-valid env for every required var, keyed to the NEW Supabase names. */
function validBaseEnv(): Record<string, string> {
  const secret32 = 'x'.repeat(32);
  return {
    NODE_ENV: 'development',
    // Supabase (new opaque-key names)
    SUPABASE_SECRET_KEY: 'sb_secret_new',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new',
    // Everything else required so only the Supabase pair is under test.
    UNKEY_API_KEY: 'unkey-key',
    API_KEY_PEPPER: 'test-pepper',
    CRON_SECRET: 'cron-secret',
    GITHUB_APP_ID: 'gh-app-id',
    GITHUB_APP_PRIVATE_KEY: 'gh-private-key',
    GITHUB_APP_WEBHOOK_SECRET: 'gh-webhook-secret',
    FROM_EMAIL: 'from@example.com',
    REPLY_TO_EMAIL: 'reply@example.com',
    RESEND_API_KEY: 'resend-key',
    RESEND_BROADCAST_AUDIENCE_ID: 'aud-id',
    DATABASE_URL: 'postgres://localhost:5432/test',
    TOKEN_ENCRYPTION_KEY: secret32,
    OAUTH_STATE_SECRET: secret32,
    FLY_API_TOKEN: 'fly-token',
    STRIPE_SECRET_KEY: 'sk-test',
    STRIPE_SECRET_WEBHOOK_KEY: 'whsec-test',
    STRIPE_GROWTH_FLAT_PRICE_ID: 'price-gf',
    STRIPE_TEAM_FLAT_PRICE_ID: 'price-tf',
    STRIPE_GROWTH_USAGE_PRICE_ID: 'price-gu',
    STRIPE_TEAM_USAGE_PRICE_ID: 'price-tu',
    STRIPE_GROWTH_STORAGE_PRICE_ID: 'price-gs',
    STRIPE_TEAM_STORAGE_PRICE_ID: 'price-ts',
    STRIPE_SPAN_METER_ID: 'meter-span',
    STRIPE_STORAGE_METER_ID: 'meter-storage',
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  };
}

/** Rebuild process.env from a clean, validation-enabled fixture + overrides. */
function setEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const next = validBaseEnv();
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  // Replace the whole object so no skip flag (SKIP_ENV_VALIDATION, VERCEL, …)
  // leaks in from the host/CI env.
  process.env = next as NodeJS.ProcessEnv;
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('env.ts — Supabase key legacy fallback', () => {
  it('prefers the new names when BOTH the new and legacy names are set', async () => {
    setEnv({
      SUPABASE_SECRET_KEY: 'sb_secret_new',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy_service_role',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'legacy_anon',
    });

    const { env } = await import('../env');

    expect(env.SUPABASE_SECRET_KEY).toBe('sb_secret_new');
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_new');
  });

  it('falls back to the legacy names when only the legacy names are set', async () => {
    setEnv({
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: 'legacy_service_role',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'legacy_anon',
    });

    const { env } = await import('../env');

    expect(env.SUPABASE_SECRET_KEY).toBe('legacy_service_role');
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('legacy_anon');
  });

  it('falls back to the legacy names when the new names are set to an empty placeholder', async () => {
    // A deploy that adds the new secret name but leaves it blank must still
    // resolve the populated legacy value — `||`, not `??`, guards this.
    setEnv({
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy_service_role',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'legacy_anon',
    });

    const { env } = await import('../env');

    expect(env.SUPABASE_SECRET_KEY).toBe('legacy_service_role');
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe('legacy_anon');
  });

  it('REJECTS when neither the new nor the legacy secret name is set', async () => {
    setEnv({
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });

    await expect(import('../env')).rejects.toThrow();
  });

  it('REJECTS when neither the new nor the legacy publishable name is set', async () => {
    setEnv({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    });

    await expect(import('../env')).rejects.toThrow();
  });
});
