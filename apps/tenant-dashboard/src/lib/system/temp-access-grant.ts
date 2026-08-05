import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";
import type { Database } from "@/types/db";

/**
 * The active temporary-access grant for a caller against a tenant, under the
 * service-role client.
 *
 * `temp_access_grant` carries no RLS policy that could backstop a caller-
 * supplied `tenantId` — the row is looked up on the service-role client
 * (platform admins hold no ordinary tenant membership to scope a request-
 * tenant read against), so the ONLY thing standing between this query and
 * cross-tenant / cross-admin disclosure is the `created_by = userId` AND
 * `tenant_id = tenantId` predicate below. Both args are explicit and must
 * come from values the caller has already verified (the authenticated
 * user's id; a tenant id is never trusted merely because it was passed in —
 * a forged tenantId finds no matching row, since the row also has to
 * belong to that same admin).
 */
interface ActiveTempAccessGrant {
  id: string;
  expiresAt: string;
  companyName: string | null;
  organizationName: string;
}

export async function getActiveTempAccessGrant(params: {
  tenantId: string;
  userId: string;
}): Promise<ActiveTempAccessGrant | null> {
  const { tenantId, userId } = params;
  const db = createClient<Database>(`${SUPABASE_API.url}`, `${SUPABASE_SECRET_KEY}`, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: grant, error } = await db
    .from("temp_access_grant")
    .select(
      `
      id,
      expires_at,
      tenant:tenant!temp_access_grant_tenant_id_fkey(organization_name, company_name)
    `,
    )
    .eq("created_by", userId)
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (error || !grant) return null;

  const tenantData = grant.tenant as unknown;
  const tenant = (Array.isArray(tenantData) ? tenantData[0] : tenantData) as {
    organization_name: string;
    company_name: string | null;
  } | null;

  return {
    id: grant.id,
    expiresAt: grant.expires_at,
    companyName: tenant?.company_name ?? null,
    organizationName: tenant?.organization_name ?? "Unknown",
  };
}
