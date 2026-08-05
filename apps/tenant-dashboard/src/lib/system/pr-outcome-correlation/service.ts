import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { tenantChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import { fetchPredictorScoreVerdictsByPr } from "./predictor-scores";

/**
 * Service-layer entry for the `agent_pr_outcome_by_score_*` widget metrics:
 * owns the admin client construction (see `pr-lifecycle-read.ts`'s
 * data-access-boundary comment — `tenantId`/`appId` MUST come from a
 * verified `TenantContext`) so the route handler never builds it directly.
 * Deployments without ClickHouse skip rather than fail, matching every
 * other agent-fleet metric's missing-capability posture.
 */
export async function getPredictorScoreVerdictsByPr(input: {
  tenantId: string;
  appId: string;
  scoreName: string;
}): Promise<Map<number, boolean> | null> {
  const chQuery = tenantChQuery({ tenantId: input.tenantId, appId: input.appId });
  if (!chQuery) return null;
  return fetchPredictorScoreVerdictsByPr(getAdminDataClient(), chQuery, input);
}
