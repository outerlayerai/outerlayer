/**
 * Server-only environment variable exports.
 * These variables are only available on the server and MUST NOT be imported by client components.
 *
 * For client-safe variables (NEXT_PUBLIC_*), use config-global.ts instead.
 */
import { env } from './env';

// Supabase (server-only)
export const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;

// Unkey (burst rate limiting only — key verify/create live in the Postgres store)
export const UNKEY_API_KEY = env.UNKEY_API_KEY;
// API-key store pepper (HMAC secret for minting/hashing key digests).
export const API_KEY_PEPPER = env.API_KEY_PEPPER;

// OAuth state secret — must match the gateway's OAUTH_STATE_SECRET
// for signed state tokens minted by POST /v1/apps/:appId/git/connect
// to verify cleanly in the dashboard's OAuth callback handlers.
//
// Also the signing key for transcript image URLs
// (features/agent-sessions/blob-url.ts), which are minted and verified
// entirely inside the dashboard. Sharing one HMAC key across the two is safe
// because each signs a domain-prefixed message, so a token from one purpose
// can never verify as the other.
export const OAUTH_STATE_SECRET = env.OAUTH_STATE_SECRET;

// Stripe
// STRIPE_* are optional in the env schema when BILLING_ENABLED=false (self-hosting).
// Coerce undefined -> '' here so consumers keep a `string` type: these values are
// only read on the billing-enabled path (DefaultBillingService + checkout/portal/
// meter actions), where the env schema guarantees they're set.
export const STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_SECRET_WEBHOOK_KEY = env.STRIPE_SECRET_WEBHOOK_KEY ?? "";
export const STRIPE_GROWTH_FLAT_PRICE_ID = env.STRIPE_GROWTH_FLAT_PRICE_ID ?? "";
export const STRIPE_TEAM_FLAT_PRICE_ID = env.STRIPE_TEAM_FLAT_PRICE_ID ?? "";
export const STRIPE_GROWTH_USAGE_PRICE_ID = env.STRIPE_GROWTH_USAGE_PRICE_ID ?? "";
export const STRIPE_TEAM_USAGE_PRICE_ID = env.STRIPE_TEAM_USAGE_PRICE_ID ?? "";
export const STRIPE_GROWTH_STORAGE_PRICE_ID = env.STRIPE_GROWTH_STORAGE_PRICE_ID ?? "";
export const STRIPE_TEAM_STORAGE_PRICE_ID = env.STRIPE_TEAM_STORAGE_PRICE_ID ?? "";
export const STRIPE_SPAN_METER_ID = env.STRIPE_SPAN_METER_ID ?? "";
export const STRIPE_STORAGE_METER_ID = env.STRIPE_STORAGE_METER_ID ?? "";

// Cron
export const CRON_SECRET = env.CRON_SECRET;

// GitHub App (server-only secrets)
export const GITHUB_APP_ID = env.GITHUB_APP_ID;
export const GITHUB_APP_PRIVATE_KEY = env.GITHUB_APP_PRIVATE_KEY;
export const GITHUB_APP_WEBHOOK_SECRET = env.GITHUB_APP_WEBHOOK_SECRET;

// Email provider selection ('resend' hosted default | 'smtp' self-host)
export const EMAIL_PROVIDER = env.EMAIL_PROVIDER;

// Resend (email)
export const RESEND_API_KEY = env.RESEND_API_KEY;
export const FROM_EMAIL = env.FROM_EMAIL;
export const REPLY_TO_EMAIL = env.REPLY_TO_EMAIL;
export const RESEND_BROADCAST_AUDIENCE_ID = env.RESEND_BROADCAST_AUDIENCE_ID;

// SMTP (Nodemailer) — used when EMAIL_PROVIDER is 'smtp'
export const SMTP_HOST = env.SMTP_HOST;
export const SMTP_PORT = env.SMTP_PORT;
export const SMTP_USER = env.SMTP_USER;
export const SMTP_PASS = env.SMTP_PASS;
export const SMTP_SECURE = env.SMTP_SECURE;

// ClickHouse (analytics) — optional for local dev without analytics
export const CLICKHOUSE_HOST = env.CLICKHOUSE_HOST;
export const CLICKHOUSE_PASSWORD = env.CLICKHOUSE_PASSWORD;
// Row-policy read identity (optional — see lib/analytics/client.ts)
export const CLICKHOUSE_READ_USER = env.CLICKHOUSE_READ_USER;
export const CLICKHOUSE_READ_PASSWORD = env.CLICKHOUSE_READ_PASSWORD;
export const CLICKHOUSE_ALLOW_UNSCOPED_READS = env.CLICKHOUSE_ALLOW_UNSCOPED_READS;


// Email delivery gate
export const EMAIL_ENABLED = env.EMAIL_ENABLED;

// Recipient allowlist — empty means unrestricted (hosted production)
export const EMAIL_RECIPIENT_ALLOWLIST = env.EMAIL_RECIPIENT_ALLOWLIST;


// Billing gate (opt-out: hosted keeps Stripe; self-hosters disable)
export const BILLING_ENABLED = env.BILLING_ENABLED;

