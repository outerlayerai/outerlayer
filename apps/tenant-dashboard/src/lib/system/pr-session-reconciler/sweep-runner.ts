import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { reconcileRecentSessions, type ReconcileCounts } from "./reconciler";
import { sweepChQuery } from "./ch-query";

/**
 * Service-layer entry for the cron sweep: owns the admin client (system
 * path — the sweep spans every tenant, and the rows it writes are scoped by
 * the tenant/app ids ClickHouse rows already carry). Deployments without
 * ClickHouse configured skip rather than fail.
 */
export async function runPrSessionSweep(input: {
  sinceHours: number;
}): Promise<{ skipped: true } | { skipped: false; counts: ReconcileCounts }> {
  const chQuery = sweepChQuery();
  if (!chQuery) return { skipped: true as const };
  const counts = await reconcileRecentSessions(getAdminDataClient(), chQuery, input);
  return { skipped: false as const, counts };
}
