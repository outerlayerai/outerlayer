/**
 * CLI API Authentication Helper
 *
 * `createCliSupabaseClient` — OAuth path (Supabase JWT), used by the CLI routes
 * (dev-key, apps). API-key verification lives entirely in the gateway's
 * Postgres key-store; the dashboard does not verify keys here.
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_API } from '@/config-global';
import { Database } from '@/types/db';

/**
 * Extracts the Bearer token from the request and creates a Supabase client
 * authenticated as that user. Returns null if no valid token is present.
 *
 * `tenantId`, when passed, is attached as the `X-Tenant-Id` header — the CLI
 * counterpart to `createSupabaseServerClient(tenantId)`'s cookie-session
 * version. Callers build a first, header-less client to run
 * `resolveCliTenant`, then a second client WITH `tenantId` for every query
 * that follows.
 */
export function createCliSupabaseClient(request: Request, tenantId?: string) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);

  return createClient<Database>(
    SUPABASE_API.url,
    SUPABASE_API.key,
    {
      // Server runtime: disable browser auth machinery. supabase-js#926
      // leaks a setInterval per createClient call otherwise.
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
        },
      },
    }
  );
}
