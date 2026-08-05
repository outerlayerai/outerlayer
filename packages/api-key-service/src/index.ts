/**
 * @repo/api-key-service
 *
 * Shared API-key lifecycle primitives for the Postgres key-store. Used by both
 * the cloud gateway (Cloudflare Worker, RLS-scoped or service-role client) and
 * the tenant dashboard (Next.js, user-JWT or admin client).
 *
 * **Scope contract**: every function takes its Supabase clients as parameters —
 * this package has no runtime deps and no implicit clients. Callers wire DI in
 * their own composition root. This is the single source of truth for minting
 * (`mintApiKey`) and hashing (`hashApiKey`) keys, so the gateway and dashboard
 * can never drift on the crypto or the row/secret write ordering.
 */

export {
  generateApiKey,
  hashApiKey,
  DEFAULT_KEY_PREFIX,
  type GeneratedApiKey,
} from './crypto';

export {
  mintApiKey,
  type MintApiKeyParams,
  type MintApiKeyResult,
} from './mint-key';
