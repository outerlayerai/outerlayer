/**
 * Supabase admin client — **service role, bypasses RLS**.
 *
 * This client bypasses RLS. The import name is chosen so that at every
 * call site, `import ... from '@/lib/admin-client'` signals "this code
 * operates outside the designed auth chain."
 *
 * The designed chain is:
 *
 *   API key → Unkey → { tenantId, userId, permissions }
 *     → mintGatewayJwt() → short-lived JWT with role:'gateway',
 *       app_metadata.tenant_id, gateway_permissions
 *     → createTenantScopedClient() uses that JWT
 *     → PostgREST switches into the `gateway` Postgres role
 *     → RLS enforces tenant isolation at the DB layer
 *
 * The scoped chain fails safe — drop a filter in handler code, the DB
 * still rejects cross-tenant reads.
 *
 * The admin client bypasses all of that. Tenant isolation then depends
 * entirely on hand-written `.eq('app_id', ...)` filters. Drop a filter,
 * leak a tenant.
 *
 * Use `createTenantScopedClient` (in `./scoped-client.ts`) for anything
 * tenant-scoped. The admin client is only for paths that genuinely have
 * no API-key user context (inbound webhooks authenticated by shared
 * secret, async jobs) and must resolve a tenant from some other signal.
 * Those call sites are explicitly allowlisted in
 * `apps/gateway/eslint.config.mjs`; adding new ones requires editing
 * that allowlist in the PR where the new call site lands.
 *
 * Eventually (see PR roadmap in the eslint config) this factory becomes
 * private — only a `createSystemClient` / `resolveTenantAndScope` helper
 * imports it — and the public module is deleted.
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../db';
import type { Env } from '../types';

export function createSupabaseAdminClient(environment: Env) {
  return createClient<Database>(
    environment.SUPABASE_API_BASE_URL!,
    environment.SUPABASE_SECRET_KEY!,
    {
      // Cloudflare Workers / edge runtime: disable browser-oriented auth
      // machinery. See scoped-client.ts for rationale — supabase-js#926
      // leaks a setInterval per createClient call otherwise.
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
