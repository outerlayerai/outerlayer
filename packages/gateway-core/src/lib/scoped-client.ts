import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../db';
import type { Env } from '../types';
import { mintGatewayJwt } from './jwt';

export const scopedSupabaseClientFactory = {
  create(env: Env, jwt: string): SupabaseClient<Database> {
    return createClient<Database>(env.SUPABASE_API_BASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
    });
  },
};

/**
 * Create a Supabase client scoped to a specific tenant via a gateway JWT.
 *
 * The client uses the anon key (not service role) so PostgREST routes the
 * request through the dedicated `gateway` Postgres role (via the `role`
 * claim). Tenant isolation is enforced by RLS policies on that role keyed on
 * `tenant_id()`; API-level permission checks happen upstream in Hono
 * middleware before any DB call.
 */
export async function createTenantScopedClient(
  env: Env,
  tenantId: string,
  systemUserId: string,
  permissions: string[],
): Promise<SupabaseClient<Database>> {
  const jwt = await mintGatewayJwt(env.SUPABASE_JWT_SECRET, tenantId, systemUserId, permissions);

  // Cloudflare Workers / edge runtime: disable browser-oriented auth
  // machinery. supabase-js defaults start a setInterval for token refresh
  // (supabase/supabase-js#926) that leaks per createClient call — each
  // request to a scoped-client route leaves a live interval in the
  // isolate, silently hammering /auth/v1 every 10s until the isolate is
  // recycled. persistSession/detectSessionInUrl touch localStorage/window,
  // neither exist here. We mint our own JWT so none of this is needed.
  return scopedSupabaseClientFactory.create(env, jwt);
}
