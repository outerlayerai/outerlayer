import "server-only";

/**
 * The api-keys entitlement limit check, service-role — both the tier/override
 * read AND the existing-key count. `billing` and `tenant_entitlement_override`
 * require `billing.read` under RLS, and `api_key` SELECT requires
 * `api_key.read`; an actor holding only `api_key.insert` need not hold
 * either. A user-scoped count for such an actor would silently resolve to
 * zero (RLS hides every row), passing the limit check vacuously and letting a
 * tenant already at its cap mint one more key — the count runs service-role
 * for the same reason the limit read does.
 */

import { getAdminDataClient } from "./admin-client";
import { EntitlementService, buildDeniedInfo } from "./entitlement-service";
import type { EntitlementCheckResult } from "@/config/entitlements";

export async function checkApiKeyLimit(tenantId: string): Promise<EntitlementCheckResult> {
  const db = getAdminDataClient();

  const { count } = await db
    .from("api_key")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    // Machine-minted keys carry rows but must not count against max_api_keys.
    .eq("is_machine", false);

  return new EntitlementService({ db }).checkLimit(tenantId, "max_api_keys", count ?? 0);
}

export { buildDeniedInfo };
