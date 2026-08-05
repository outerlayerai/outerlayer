import "server-only";

import { getEntitlement } from "@/lib/system/get-entitlement";

/**
 * The dashboards domain's one admin-client site: the add-widget custom-metrics
 * gate. Delegates to the canonical boolean-entitlement gate
 * (`@/lib/system/get-entitlement`) rather than constructing its own
 * `EntitlementService` — this adapter is the confinement point that keeps
 * the RLS-bypassing client itself out of `features/dashboards/actions.ts`,
 * per the new→legacy bridge this directory exists for.
 */
export async function hasCustomMetricsEntitlement(tenantId: string): Promise<boolean> {
  return getEntitlement(tenantId, "custom_metrics_enabled");
}
