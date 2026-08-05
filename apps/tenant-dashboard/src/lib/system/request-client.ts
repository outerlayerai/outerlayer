import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_API } from "@/config-global";
import type { Database } from "@/types/db";

/**
 * Server-side Supabase client bound to the request's session cookies —
 * the `lib/system` construction of `createSupabaseServerClient` (root
 * `supabaseServerClient.ts`, a legacy-tree wrapper `legacyWorldImports` bans
 * from this tier). Same behavior, not a different client: `@supabase/ssr`'s
 * `createServerClient` is a sanctioned direct construction here, same as
 * `getAdminDataClient`'s use of the raw `@supabase/supabase-js` `createClient`.
 *
 * When `tenantId` is passed, it is attached as the `X-Tenant-Id` header on
 * every PostgREST/Realtime call the client makes. `public.tenant_id()`
 * validates that header against the actor's membership and scopes RLS to
 * it; a call with no `tenantId` sends no header, so the DB falls back to
 * the JWT claim.
 */
export async function getRequestDataClient(tenantId?: string) {
  const cookieStore = await cookies();

  return createServerClient<Database>(SUPABASE_API.url, SUPABASE_API.key, {
    ...(tenantId ? { global: { headers: { "X-Tenant-Id": tenantId } } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Writing cookies from a Server Component throws; the middleware
          // refreshes the session, so a dropped write here is safe to ignore.
        }
      },
    },
  });
}
