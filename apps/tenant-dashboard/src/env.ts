import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';
import { parseEnvBoolean } from '@repo/adapter-config';

// Billing is opt-out: enabled unless BILLING_ENABLED is explicitly falsy. When
// disabled (self-hosting), the STRIPE_* vars are not required. Read raw
// process.env here because this predicate runs inside zod refinements during
// env construction (the validated `env` isn't available yet).
const billingDisabled = () => parseEnvBoolean(process.env.BILLING_ENABLED) === false;

/** A STRIPE_* var: required when billing is enabled, optional when disabled. */
const stripeVar = (name: string) =>
  z
    .string()
    .optional()
    .refine(
      (val) => billingDisabled() || (!!val && val.length > 0),
      `${name} is required when billing is enabled (set BILLING_ENABLED=false to disable)`,
    );

export const env = createEnv({
  /**
   * Server-side environment variables schema.
   * These are only available on the server.
   */
  server: {
    // Supabase secret (service-role) key. Legacy names accepted as a fallback
    // in `runtimeEnv` while deployment environments migrate to sb_* keys, so
    // `.min(1)` still enforces that at least one of the pair is set.
    SUPABASE_SECRET_KEY: z.string().min(1),

    // Unkey (invite-throttle rate limiting only — key verify/create/revoke
    // live in the Postgres key-store)
    UNKEY_API_KEY: z.string().min(1),

    // API-key store pepper: HMAC secret for minting/hashing key digests.
    // Required — the dashboard mints keys (settings UI, dev keys, managed
    // deployments) and must hash them with the same pepper the gateway
    // verifies against.
    API_KEY_PEPPER: z.string().min(1),

    // Stripe
    // Stripe — required for the hosted product; optional when BILLING_ENABLED=false
    // (self-hosting). See stripeVar() above.
    STRIPE_SECRET_KEY: stripeVar('STRIPE_SECRET_KEY'),
    STRIPE_SECRET_WEBHOOK_KEY: stripeVar('STRIPE_SECRET_WEBHOOK_KEY'),
    STRIPE_GROWTH_FLAT_PRICE_ID: stripeVar('STRIPE_GROWTH_FLAT_PRICE_ID'),
    STRIPE_TEAM_FLAT_PRICE_ID: stripeVar('STRIPE_TEAM_FLAT_PRICE_ID'),
    STRIPE_GROWTH_USAGE_PRICE_ID: stripeVar('STRIPE_GROWTH_USAGE_PRICE_ID'),
    STRIPE_TEAM_USAGE_PRICE_ID: stripeVar('STRIPE_TEAM_USAGE_PRICE_ID'),
    STRIPE_GROWTH_STORAGE_PRICE_ID: stripeVar('STRIPE_GROWTH_STORAGE_PRICE_ID'),
    STRIPE_TEAM_STORAGE_PRICE_ID: stripeVar('STRIPE_TEAM_STORAGE_PRICE_ID'),
    STRIPE_SPAN_METER_ID: stripeVar('STRIPE_SPAN_METER_ID'),
    STRIPE_STORAGE_METER_ID: stripeVar('STRIPE_STORAGE_METER_ID'),

    // Cron
    CRON_SECRET: z.string().min(1),
    // BetterStack Uptime API token for DORA incident collection. Optional —
    // unset in local/preview, set per-environment in staging/production.
    // Exposed via the validated `env` for a single typed source alongside the
    // other server config (raw `process.env` reads work too).
    BETTERSTACK_API_TOKEN: z.string().optional(),
    // Which deployment environment THIS dashboard is. Drives all DORA
    // metrics reads/collection — each deployment only pulls the data for
    // the environment it cares about. The staging Vercel project sets
    // 'staging'; production relies on the default below.
    //
    // NOTE: the `.default('production')` here does NOT apply on Vercel —
    // `skipValidation` is force-enabled by `!!process.env.VERCEL`, which makes
    // t3-env pass `runtimeEnv` through raw and never run zod (so zod defaults
    // are dead). The real default therefore lives in `runtimeEnv` below
    // (`process.env.DORA_ENVIRONMENT || 'production'`). Without it, prod —
    // which never sets the var — resolved `undefined` at runtime, and the
    // collector env-filter (`incident.env !== this.env`) silently dropped
    // EVERY production incident → CFR/MTTR stuck at 0. The zod default is kept
    // for the non-skip (local validation) path + type narrowing.
    DORA_ENVIRONMENT: z.enum(['production', 'staging']).default('production'),

    // GitHub App
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),

    // Email provider selection. 'resend' is the hosted/managed default;
    // 'smtp' routes transactional email through a self-hosted SMTP server
    // (Nodemailer) so an OSS self-hoster needs no Resend account. Audience
    // enrollment stays Resend-only — see SmtpEmailService.
    EMAIL_PROVIDER: z.enum(['resend', 'smtp']).default('resend'),

    // Resend (email) — required only when EMAIL_PROVIDER is 'resend'.
    // Self-hosters on SMTP can leave these unset.
    RESEND_API_KEY: z.string().optional().refine(
      (val) => process.env.EMAIL_PROVIDER === 'smtp' || (!!val && val.length > 0),
      'RESEND_API_KEY is required when EMAIL_PROVIDER is "resend"',
    ),
    FROM_EMAIL: z.string().min(1),
    // Real inbox that customer replies land in. FROM_EMAIL's subdomain
    // (updates.*) is send-only and bounces replies. Always supplied by
    // runtimeEnv (defaults to hello@outerlayer.ai), so required, not optional.
    REPLY_TO_EMAIL: z.string().min(1),
    // Resend broadcast audience — only meaningful for the Resend provider
    // (SMTP has no audience concept), so likewise conditional.
    RESEND_BROADCAST_AUDIENCE_ID: z.string().optional().refine(
      (val) => process.env.EMAIL_PROVIDER === 'smtp' || (!!val && val.length > 0),
      'RESEND_BROADCAST_AUDIENCE_ID is required when EMAIL_PROVIDER is "resend"',
    ),

    // SMTP (Nodemailer) — required only when EMAIL_PROVIDER is 'smtp'.
    // SMTP_USER/PASS are optional (open relays / IP-allowlisted senders need
    // no auth). SMTP_SECURE='true' forces TLS-on-connect (port 465); omit it
    // for STARTTLS (port 587), which Nodemailer negotiates automatically.
    SMTP_HOST: z.string().optional().refine(
      (val) => process.env.EMAIL_PROVIDER !== 'smtp' || (!!val && val.length > 0),
      'SMTP_HOST is required when EMAIL_PROVIDER is "smtp"',
    ),
    SMTP_PORT: z.coerce.number().optional().refine(
      (val) => process.env.EMAIL_PROVIDER !== 'smtp' || (val !== undefined && val > 0),
      'SMTP_PORT is required when EMAIL_PROVIDER is "smtp"',
    ),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: z.string().optional(),

    // Database
    DATABASE_URL: z.string().min(1),

    // ClickHouse (analytics) — optional for local dev without analytics
    CLICKHOUSE_HOST: z.string().optional(),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    // Row-policy read identity. Required in production whenever ClickHouse is
    // configured: without it tenant-scoped reads authenticate as the writer,
    // which no row policy covers, so isolation falls back to app-layer WHERE
    // clauses alone. Enforced at the call site in lib/analytics/client.ts, not
    // here — env validation is skipped on every Vercel deployment (see
    // skipValidation below), which is exactly where it would need to run.
    CLICKHOUSE_READ_USER: z.string().optional(),
    CLICKHOUSE_READ_PASSWORD: z.string().optional(),
    // Escape hatch for self-hosters who accept app-layer-only isolation and
    // have not provisioned the read user. Opt-in, so the default is closed.
    CLICKHOUSE_ALLOW_UNSCOPED_READS: z.string().optional(),

    // Security
    TOKEN_ENCRYPTION_KEY: z.string().min(32),

    /**
     * HMAC key for verifying OAuth state tokens minted by the gateway's
     * `POST /v1/apps/:appId/git/connect`. Must match the gateway's
     * `OAUTH_STATE_SECRET` exactly — drift would silently break the
     * headless onboarding flow (every signed callback would 400).
     * Mirror in `apps/gateway/src/types.ts::EnvSchema.OAUTH_STATE_SECRET`.
     *
     * Also signs the dashboard's expiring transcript image URLs
     * (`features/agent-sessions/blob-url.ts`), which are minted and verified
     * here only — that use needs no gateway coordination, and each purpose
     * signs a domain-prefixed message so their tokens can't cross over.
     */
    OAUTH_STATE_SECRET: z.string().min(32),

    // Email delivery gate (fail-closed: must be explicitly "true" to send real emails)
    EMAIL_ENABLED: z.string().optional().default('false'),

    // Comma-separated recipient allowlist: whole addresses ("me@corp.com") or
    // domain suffixes written with the leading @ ("@corp.com"). Unset means
    // unrestricted, which is the hosted-production posture — a non-empty value
    // is for environments that send real mail to a bounded set of humans
    // (staging dogfooding), where anything else is a mistake worth dropping.
    EMAIL_RECIPIENT_ALLOWLIST: z.string().optional(),

    // Billing gate (opt-out: hosted keeps Stripe; self-hosters set "false" to
    // disable Stripe customer provisioning + wire MockBillingService). Defaults
    // to "true" so the hosted default is unchanged.
    BILLING_ENABLED: z.string().optional().default('true'),

    // Fly Machines API token. Optional: cloud workers and git file removal
    // each degrade to "unavailable" when it is unset rather than failing
    // startup.
    FLY_API_TOKEN: z.string().optional(),

    // Node environment
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  },

  /**
   * Client-side environment variables schema.
   * These are exposed to the browser (prefixed with NEXT_PUBLIC_).
   */
  client: {
    // Supabase publishable (anon) key. Legacy names accepted as a fallback in
    // `runtimeEnv` while deployment environments migrate to sb_* keys, so
    // `.min(1)` still enforces that at least one of the pair is set.
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),

    // App URL
    NEXT_PUBLIC_APP_URL: z.string().url(),

    // Email domain a platform admin's address must end with. The platform-admin
    // surface is the internal operator tool; a self-hoster needs to name their
    // own organization here.
    //
    // Public because the same value gates the server checks AND short-circuits
    // the client-side nav affordance before it queries platform_user_role —
    // one var beats two that must be kept in sync, and an email domain is not a
    // secret (every admin's address reveals it).
    //
    // Comma-separated for more than one domain, which is what makes a domain
    // migration survivable: run the old and new domain together for the cutover,
    // then drop the old one — no code change, no window where every existing
    // admin is locked out.
    //
    // EVERY entry must start with '@' so none can be satisfied by a lookalike
    // registration: `notouterlayer.ai` ends with `outerlayer.ai`, but not with
    // `@outerlayer.ai`.
    NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN: z
      .string()
      .refine(
        (value) =>
          value
            .split(',')
            .map((domain) => domain.trim())
            .filter((domain) => domain.length > 0)
            .every((domain) => domain.startsWith('@')),
        'every domain in NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN must start with "@"',
      )
      .default('@outerlayer.ai'),

    // PostHog (analytics) — optional for local dev without product analytics
    NEXT_PUBLIC_POSTHOG_UI_HOST: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_PROJECT_ID: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),

    // Gateway URL for CLI trace forwarding — defaults to the production gateway.
    // The default lives in `runtimeEnv` too: the zod `.default()` here is dead on
    // Vercel (forced skipValidation), so the real fallback must be in runtimeEnv
    // or GATEWAY_URL resolves `undefined` in prod. See DORA_ENVIRONMENT above and
    // env-default-invariant.test.ts. Consumers read the validated value, not a
    // hardcoded fallback in config-global.
    NEXT_PUBLIC_GATEWAY_URL: z.string().url().default('https://api.agentmark.co'),

    // API URL for CLI trace forwarding — defaults to the production API. Same
    // runtimeEnv-fallback requirement as NEXT_PUBLIC_GATEWAY_URL above.
    NEXT_PUBLIC_API_URL: z.string().url().default('https://api.agentmark.co'),
  },

  /**
   * Runtime environment variables.
   * Maps env vars to their runtime values.
   */
  runtimeEnv: {
    // Server
    // `||` (not `??`): emptyStringAsUndefined only rewrites the *validated*
    // value, so an empty new-name placeholder must still fall through to a
    // populated legacy name.
    SUPABASE_SECRET_KEY:
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    UNKEY_API_KEY: process.env.UNKEY_API_KEY,
    API_KEY_PEPPER: process.env.API_KEY_PEPPER,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_SECRET_WEBHOOK_KEY: process.env.STRIPE_SECRET_WEBHOOK_KEY,
    STRIPE_GROWTH_FLAT_PRICE_ID: process.env.STRIPE_GROWTH_FLAT_PRICE_ID,
    STRIPE_TEAM_FLAT_PRICE_ID: process.env.STRIPE_TEAM_FLAT_PRICE_ID,
    STRIPE_GROWTH_USAGE_PRICE_ID: process.env.STRIPE_GROWTH_USAGE_PRICE_ID,
    STRIPE_TEAM_USAGE_PRICE_ID: process.env.STRIPE_TEAM_USAGE_PRICE_ID,
    STRIPE_GROWTH_STORAGE_PRICE_ID: process.env.STRIPE_GROWTH_STORAGE_PRICE_ID,
    STRIPE_TEAM_STORAGE_PRICE_ID: process.env.STRIPE_TEAM_STORAGE_PRICE_ID,
    STRIPE_SPAN_METER_ID: process.env.STRIPE_SPAN_METER_ID,
    STRIPE_STORAGE_METER_ID: process.env.STRIPE_STORAGE_METER_ID,
    CRON_SECRET: process.env.CRON_SECRET,
    BETTERSTACK_API_TOKEN: process.env.BETTERSTACK_API_TOKEN,
    // `|| 'production'` is the REAL default (the zod `.default` above is dead
    // under Vercel's forced skipValidation). Staging sets DORA_ENVIRONMENT
    // explicitly; prod leaves it unset and must resolve to 'production' here.
    DORA_ENVIRONMENT: process.env.DORA_ENVIRONMENT || 'production',
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
    // `|| 'resend'` is the REAL default (the zod default is dead under Vercel's
    // forced skipValidation — see DORA_ENVIRONMENT / EMAIL_ENABLED).
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER || 'resend',
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    FROM_EMAIL: process.env.FROM_EMAIL,
    // `|| 'hello@outerlayer.ai'` is the REAL default (any zod default would be
    // dead under Vercel's forced skipValidation). Override per-env if needed.
    REPLY_TO_EMAIL: process.env.REPLY_TO_EMAIL || 'hello@outerlayer.ai',
    RESEND_BROADCAST_AUDIENCE_ID: process.env.RESEND_BROADCAST_AUDIENCE_ID,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_SECURE: process.env.SMTP_SECURE,
    DATABASE_URL: process.env.DATABASE_URL,
    CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST,
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
    CLICKHOUSE_READ_USER: process.env.CLICKHOUSE_READ_USER,
    CLICKHOUSE_READ_PASSWORD: process.env.CLICKHOUSE_READ_PASSWORD,
    CLICKHOUSE_ALLOW_UNSCOPED_READS: process.env.CLICKHOUSE_ALLOW_UNSCOPED_READS,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
    // `|| <default>`: the schema `.default()` for these is dead on Vercel
    // (skipValidation bypasses zod), so the real default must live here or the
    // var resolves `undefined` at runtime when unset. Enforced for every
    // defaulted var by env-default-invariant.test.ts. See DORA_ENVIRONMENT.
    EMAIL_ENABLED: process.env.EMAIL_ENABLED || 'false',
    EMAIL_RECIPIENT_ALLOWLIST: process.env.EMAIL_RECIPIENT_ALLOWLIST,
    BILLING_ENABLED: process.env.BILLING_ENABLED || 'true',
    FLY_API_TOKEN: process.env.FLY_API_TOKEN,
    NODE_ENV: process.env.NODE_ENV || 'development',

    // Client
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    // `|| '@outerlayer.ai'` is the REAL default (any zod default would be dead
    // under Vercel's forced skipValidation). Self-hosters set their own domain.
    NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN:
      process.env.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN || '@outerlayer.ai',
    NEXT_PUBLIC_POSTHOG_UI_HOST: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST,
    NEXT_PUBLIC_POSTHOG_PROJECT_ID: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    // `|| <default>`: the schema `.default()` for these is dead on Vercel
    // (skipValidation bypasses zod), so the real default must live here or the
    // var resolves `undefined` at runtime when unset — silently sending the
    // dashboard's traffic nowhere instead of to the production gateway.
    // Enforced by env-default-invariant.test.ts. See DORA_ENVIRONMENT.
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL || 'https://api.agentmark.co',
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://api.agentmark.co',
  },

  /**
   * Treat empty strings as undefined.
   */
  emptyStringAsUndefined: true,

  /**
   * Skip validation in specific environments.
   *
   * IMPORTANT: We use NEXT_PUBLIC_SKIP_ENV_VALIDATION because regular env vars
   * are not available in client-side code at runtime. In Next.js, non-NEXT_PUBLIC
   * vars like 'CI' are replaced at build time and become undefined in browser code.
   *
   * Skip conditions:
   * - NEXT_PUBLIC_SKIP_ENV_VALIDATION=true - explicit skip (used by E2E tests in CI)
   * - SKIP_ENV_VALIDATION=true - server-side explicit skip
   * - Jest tests (NODE_ENV=test) - tests mock the env module
   * - Vercel preview deployments (VERCEL_ENV=preview) - PRs don't have all env vars
   * - Any Vercel deployment (VERCEL=1) - all Vercel builds (production uses explicit env vars)
   *
   * Validation DOES run for:
   * - Local development (helps developers catch config issues)
   */
  skipValidation:
    !!process.env.NEXT_PUBLIC_SKIP_ENV_VALIDATION ||
    !!process.env.SKIP_ENV_VALIDATION ||
    process.env.NODE_ENV === 'test' ||
    process.env.VERCEL_ENV === 'preview' ||
    !!process.env.VERCEL,
});
