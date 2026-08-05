import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { sweepChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import { computeScoreCoverage } from "./coverage";

/**
 * Service-layer entry for the platform-admin route: owns the admin client
 * (the coverage check spans every tenant) so the RLS-bypassing client is
 * never constructed in the route handler directly (data-access-boundary
 * gate). Deployments without ClickHouse skip rather than fail.
 */
export async function getScoreCoverage(input: { appId?: string; prNumber?: number } = {}) {
  const chQuery = sweepChQuery();
  if (!chQuery) return { skipped: true as const };
  const result = await computeScoreCoverage(getAdminDataClient(), chQuery, input);
  return { skipped: false as const, ...result };
}
