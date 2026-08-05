/**
 * The tenant's span-per-month entitlement limit, for the billing page's
 * near-limit banner. `EntitlementService.getLimit` reads
 * `billing`/`tenant_entitlement_override` under the request-tenant's own
 * RLS-scoped client, so a caller without `billing.read` still resolves a
 * limit — RLS just answers with the hobby default — and this always
 * returns a number rather than throwing.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { EntitlementService } from "@/lib/system/entitlement-service";
import type { ServiceContext } from "@/lib/action-kit/service-context";

export async function getSpanLimit(ctx: ServiceContext): Promise<number> {
  const entitlementService = new EntitlementService({ db: ctx.db as SupabaseClient });
  return entitlementService.getLimit(ctx.tenantId, "max_spans_per_month");
}
