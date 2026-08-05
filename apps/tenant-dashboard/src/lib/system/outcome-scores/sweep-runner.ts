import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { sweepOutcomeScores, type SweepCounts } from "./emit";
import { scoresInsertFn } from "./ch-insert";

/**
 * Service-layer entry for the cron sweep: owns the admin client (the sweep
 * spans every tenant; emitted rows carry the tenant/app ids their Postgres
 * sources already hold). Deployments without ClickHouse skip rather than
 * fail.
 */
export async function runOutcomeScoresSweep(input: {
  sinceHours: number;
}): Promise<{ skipped: true } | ({ skipped: false } & SweepCounts)> {
  const insertScores = scoresInsertFn();
  if (!insertScores) return { skipped: true as const };
  const counts = await sweepOutcomeScores(getAdminDataClient(), insertScores, input);
  return { skipped: false as const, ...counts };
}
