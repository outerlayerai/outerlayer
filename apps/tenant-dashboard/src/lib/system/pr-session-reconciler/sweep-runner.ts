import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  reconcileRecentSessions,
  resolveChangedLinkTargets,
  type ReconcileCounts,
  type ChangedPrTarget,
} from "./reconciler";
import { reconcileArtifacts, type ArtifactReconcileCounts } from "./artifact-reconcile";
import { sweepChQuery } from "./ch-query";

/**
 * Service-layer entry for the cron sweep: owns the admin client (system
 * path — the sweep spans every tenant, and the rows it writes are scoped by
 * the tenant/app ids ClickHouse rows already carry). Deployments without
 * ClickHouse configured skip rather than fail.
 *
 * `changed` is the set of PRs whose links this tick actually moved, already
 * resolved to `(tenantId, repository, prNumber)` — the cron route refreshes
 * exactly these, not every PR the sweep looked at.
 */
export async function runPrSessionSweep(input: {
  sinceHours: number;
}): Promise<
  | { skipped: true }
  | {
      skipped: false;
      counts: ReconcileCounts;
      artifactCounts: ArtifactReconcileCounts;
      changed: ChangedPrTarget[];
    }
> {
  const chQuery = sweepChQuery();
  if (!chQuery) return { skipped: true as const };
  const admin = getAdminDataClient();
  const { changed, ...counts } = await reconcileRecentSessions(admin, chQuery, input);
  // Artifact resolution rides the same tick: it reads the session links the
  // pass above just confirmed, so ordering matters — artifacts after
  // sessions, never the reverse.
  const artifacts = await reconcileArtifacts(admin);
  const combined = [...changed, ...artifacts.changed];
  const targets = await resolveChangedLinkTargets(admin, combined);
  return { skipped: false as const, counts, artifactCounts: artifacts.counts, changed: targets };
}
