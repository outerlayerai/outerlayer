import "server-only";

/**
 * The general-purpose admin boolean-entitlement gate: tenant-pinned by an
 * explicit argument, running under the service-role client this module owns.
 * Every product surface that only needs a single yes/no feature check (the
 * settings layout's SSO/roles/audit-log/AI-costs tab gates, the dashboards
 * custom-metrics gate) goes through this one function.
 *
 * Delegates to `EntitlementService.canAccess`, the one implementation of
 * override → tier → hobby-default resolution (plus the self-host branch) —
 * `lib/system` and the richer numeric-limit surface (`checkLimit`,
 * `getEffectiveEntitlements`, override CRUD) now share the same class, so
 * this gate can't drift from it.
 */

import { getAdminDataClient } from "./admin-client";
import { EntitlementService } from "./entitlement-service";
import type { BooleanEntitlementKey } from "@/config/entitlements";

export async function getEntitlement(
  tenantId: string,
  key: BooleanEntitlementKey,
): Promise<boolean> {
  return new EntitlementService({ db: getAdminDataClient() }).canAccess(tenantId, key);
}
