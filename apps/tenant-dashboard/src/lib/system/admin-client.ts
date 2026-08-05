import "server-only";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";

/**
 * The single sanctioned constructor of the service-role (RLS-bypassing) admin
 * client for new-world code that needs to hand it to a whole service class
 * rather than run one named query — e.g. constructing an EE service that
 * mixes RLS-scoped and admin-authority reads/writes in its own methods
 * (`CustomRoleService`'s membership counting and audit writes). Callers still
 * own scoping every use of the client to the tenant they resolved; this only
 * confines *construction* to one reviewable place, mirroring the inline
 * construction `listTenantMembers`/`resolveMemberDisplayNames` already use.
 */
export function getAdminDataClient() {
  return createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
