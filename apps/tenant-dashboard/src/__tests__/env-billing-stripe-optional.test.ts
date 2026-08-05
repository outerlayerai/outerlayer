// @vitest-environment node
/**
 * Real env-validation test for the BILLING_ENABLED ⇄ STRIPE_* refinement.
 *
 * env.ts makes every STRIPE_* var conditionally required: mandatory for the
 * hosted product, optional when a self-hoster sets BILLING_ENABLED=false
 * (`stripeVar()` / `billingDisabled()`). This pins that contract against the
 * REAL `createEnv` schema — not a hand-rolled copy of the predicate.
 *
 * Three things this test has to defeat to reach the real refinement:
 *   1. The global unit-test setup (`unit-test-setup.ts`) does
 *      `vi.mock('../env', …)` with static values, so env.ts never validates in
 *      unit tests. We `vi.unmock('../env')` so the real module runs here.
 *   2. `skipValidation` is force-enabled when `NODE_ENV === 'test'` (env.ts) —
 *      which Vitest sets. We rebuild `process.env` with `NODE_ENV='development'`
 *      and no skip flags so zod actually executes.
 *   3. The refinement reads `process.env.BILLING_ENABLED` directly (it runs in a
 *      zod refine before the validated `env` exists), so each case rewrites
 *      `process.env` and re-imports env.ts under `vi.resetModules()`.
 *
 * Runs in the `node` environment (top pragma): under jsdom, t3-env treats
 * server-var access as "from the client" and throws.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Bypass the global env mock from unit-test-setup.ts — we want the real schema.
vi.unmock('../env');

const ORIGINAL_ENV = process.env;

// The 10 conditionally-required Stripe vars guarded by the refinement.
const STRIPE_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_WEBHOOK_KEY',
  'STRIPE_GROWTH_FLAT_PRICE_ID',
  'STRIPE_TEAM_FLAT_PRICE_ID',
  'STRIPE_GROWTH_USAGE_PRICE_ID',
  'STRIPE_TEAM_USAGE_PRICE_ID',
  'STRIPE_GROWTH_STORAGE_PRICE_ID',
  'STRIPE_TEAM_STORAGE_PRICE_ID',
  'STRIPE_SPAN_METER_ID',
  'STRIPE_STORAGE_METER_ID',
] as const;

// A fully-valid value for every OTHER required var, so the only thing under test
// is the Stripe/billing refinement. Keep in sync with env.ts's required server
// + client schema (this test fails loudly if a new required var is added).
function validBaseEnv(): Record<string, string> {
  const secret32 = 'x'.repeat(32);
  return {
    // Force zod to actually run (defeat skipValidation).
    NODE_ENV: 'development',
    // Supabase / Unkey
    SUPABASE_SECRET_KEY: 'svc-role-key',
    UNKEY_API_KEY: 'unkey-key',
    // API-key store pepper (required)
    API_KEY_PEPPER: 'test-pepper',
    // Cron / GitHub App
    CRON_SECRET: 'cron-secret',
    GITHUB_APP_ID: 'gh-app-id',
    GITHUB_APP_PRIVATE_KEY: 'gh-private-key',
    GITHUB_APP_WEBHOOK_SECRET: 'gh-webhook-secret',
    // Email (provider defaults to 'resend' ⇒ Resend vars required)
    FROM_EMAIL: 'from@example.com',
    REPLY_TO_EMAIL: 'reply@example.com',
    RESEND_API_KEY: 'resend-key',
    RESEND_BROADCAST_AUDIENCE_ID: 'aud-id',
    // DB
    DATABASE_URL: 'postgres://localhost:5432/test',
    // Security (min 32)
    TOKEN_ENCRYPTION_KEY: secret32,
    OAUTH_STATE_SECRET: secret32,
    FLY_API_TOKEN: 'fly-token',
    // Client (NEXT_PUBLIC_*)
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    // All STRIPE_* present by default; individual cases override to undefined.
    ...Object.fromEntries(STRIPE_VARS.map((k) => [k, `${k.toLowerCase()}-value`])),
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
  // or stale Stripe value leaks in from the host/CI env.
  process.env = next as NodeJS.ProcessEnv;
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('env.ts — STRIPE_* are gated on BILLING_ENABLED', () => {
  it('validates with the STRIPE_* vars MISSING when BILLING_ENABLED=false (self-hosting)', async () => {
    setEnv({
      BILLING_ENABLED: 'false',
      ...Object.fromEntries(STRIPE_VARS.map((k) => [k, undefined])),
    });

    const { env } = await import('../env');

    // No throw, and the Stripe vars resolve undefined — a self-hoster runs with
    // zero Stripe config.
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_STORAGE_METER_ID).toBeUndefined();
    expect(env.BILLING_ENABLED).toBe('false');
  });

  it('REJECTS a missing STRIPE_SECRET_KEY when billing is enabled (hosted default)', async () => {
    // Same missing var as the case above — only BILLING_ENABLED differs. Proves
    // the refinement, not some unrelated requirement, is doing the gating.
    setEnv({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: undefined });

    await expect(import('../env')).rejects.toThrow();
  });

  it('REJECTS a missing STRIPE_SECRET_KEY when BILLING_ENABLED is unset (defaults on)', async () => {
    // Opt-out default: absence of the flag must behave like hosted, so dropping a
    // Stripe var still fails.
    setEnv({ BILLING_ENABLED: undefined, STRIPE_SECRET_KEY: undefined });

    await expect(import('../env')).rejects.toThrow();
  });

  it('validates and exposes the Stripe vars when billing is enabled and all are present', async () => {
    setEnv({ BILLING_ENABLED: 'true' });

    const { env } = await import('../env');

    expect(env.STRIPE_SECRET_KEY).toBe('stripe_secret_key-value');
    expect(env.BILLING_ENABLED).toBe('true');
  });
});
