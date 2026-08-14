/**
 * Scheduled entry point for the daily storage-hygiene cron: the
 * entitlement-driven retention sweep plus the unmatched-artifact blob
 * release. Fires on the daily cron trigger, alertHandler pattern:
 * resolve config, run each phase in isolation, log a summary per phase.
 * Composition happens here — the services themselves are pure
 * orchestration over injected seams.
 */

import { GatewayScheduleContext } from "@repo/gateway-core/types";
// Cross-tenant by construction: both phases span every tenant — the retention
// sweep resolves every tenant's retention entitlement, and the artifact blob
// sweep drains every tenant's unmatched rows — so there is no single
// "current tenant" to scope by (sanctioned use #3 in system-client.ts).
import { createSystemAdminClient } from "@repo/gateway-core/lib/system-client";
import { createLoggerFromContext } from "../services/logger";
import { createRetentionStore } from "@repo/gateway-core/stores/clickhouse/retention-store";
import { clickHouseWriteAuth } from "@repo/gateway-core/stores/clickhouse/write-identity";
import { sweepUnmatchedArtifactBlobs } from "@repo/gateway-core/jobs/artifact-blob-sweep";
import {
  resolveRetentionSweepConfig,
  runRetentionSweep,
  supportsBlobSweep,
} from "../services/retention-sweep-service";

/**
 * The daily trigger this job fires on. Must match an entry in
 * `apps/gateway/wrangler.toml` `[triggers] crons`; the Worker's `scheduled()`
 * routes this cron string to the sweep INSTEAD of the every-minute jobs
 * (which fire as their own event in the same minute).
 */
export const RETENTION_SWEEP_CRON = "0 3 * * *";

export const retentionSweepHandler = async ({
  env,
  event,
}: GatewayScheduleContext) => {
  const config = resolveRetentionSweepConfig(env);

  const logger = createLoggerFromContext(env, {
    source: "scheduled:retention-sweep",
  });

  try {
    // Phase 1 — entitlement-driven retention. Gated by
    // RETENTION_SWEEP_ENABLED: this is the machinery that mass-deletes by
    // tenant entitlement, armed deployment by deployment.
    if (config.enabled) {
      try {
        const store = createRetentionStore({
          url: env.CLICKHOUSE_HOST,
          ...clickHouseWriteAuth(env),
        });

        const result = await runRetentionSweep({
          store,
          supabase: createSystemAdminClient(env),
          // The wrangler R2 binding exposes list/delete; the node self-host blob
          // seam doesn't — rows still sweep there, objects are the hoster's own.
          blobs: supportsBlobSweep(env.TRACE_BLOBS) ? env.TRACE_BLOBS : null,
          logger,
          config,
          nowMs: event.scheduledTime,
        });

        logger.info("retention sweep completed", {
          cron: event.cron,
          swept: result.swept,
          skipped: result.skipped,
          invalidTenants: result.invalidTenants,
          blobsDeleted: result.blobsDeleted,
          blobsExamined: result.blobsExamined,
          blobScanTruncated: result.blobScanTruncated,
        });
      } catch (error) {
        // Swallow (no rethrow): the scheduled() orchestrator already wraps
        // every job in waitUntil(handler().catch(log)) — rethrowing
        // double-logs. Isolated per phase so a retention failure never skips
        // the artifact sweep below.
        logger.error(
          error instanceof Error ? error : new Error("Retention sweep failed"),
          { cron: event.cron },
        );
      }
    }

    // Phase 2 — unmatched-artifact blob release. Rides the same daily cron
    // but NOT the RETENTION_SWEEP_ENABLED flag: it only releases bytes whose
    // rows the reconciler already marked unmatched, cleanup every deployment
    // shape needs. A no-op run (nothing unmatched) logs nothing.
    try {
      const artifacts = await sweepUnmatchedArtifactBlobs(
        env,
        createSystemAdminClient(env),
      );
      if (artifacts.examined > 0) {
        logger.info("unmatched-artifact blob sweep completed", {
          cron: event.cron,
          ...artifacts,
        });
      }
    } catch (error) {
      logger.error(
        error instanceof Error
          ? error
          : new Error("Unmatched-artifact blob sweep failed"),
        { cron: event.cron },
      );
    }
  } finally {
    await logger.flush();
  }
};
