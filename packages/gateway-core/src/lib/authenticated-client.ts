/**
 * Supabase client wrapping a user's Supabase JWT.
 *
 * For bearer-auth traffic (CLI / user sessions) — forwards the user's
 * own `authenticated`-role JWT so PostgREST runs queries under that
 * role and the dashboard's existing RLS policies fire (`authorize()`,
 * `app_authorize()`, `tenant_id()`).
 *
 * Companion to `createTenantScopedClient` (gateway-role, API-key path)
 * and the opposite of `createSupabaseAdminClient` (service-role,
 * bypass-RLS, very narrow allowlist). Which client a handler uses is
 * decided by `getScopedSupabase(c)` in `openapi/routes/_shared.ts` —
 * based on `c.var.user.authMode`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../db';
import type { Env } from '../types';

export function createAuthenticatedClient(
  env: Env,
  userJwt: string,
  requestTenantId?: string,
): SupabaseClient<Database> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${userJwt}`,
  };
  // Pin the DB's dual-source `tenant_id()` to the tenant this request resolved
  // to at auth (an explicit, membership-validated `X-Tenant-Id` winning over
  // the JWT claim). Without this header the resolver falls back to the token's
  // claim, so a request tenant that overrode the claim upstream would silently
  // not apply to the data-plane reads/writes. `tenant_id()` re-validates
  // `(auth.uid(), tenant)` membership, so this can never widen scope; when the
  // resolved tenant equals the claim it is a no-op.
  if (requestTenantId) headers['X-Tenant-Id'] = requestTenantId;
  return createClient<Database>(env.SUPABASE_API_BASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    // Cloudflare Workers / edge runtime: disable browser-oriented auth
    // machinery. supabase-js#926 — defaults start a setInterval for token
    // refresh that leaks per createClient call. We mint/forward our own
    // JWT so none of this is needed.
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers,
    },
  });
}
