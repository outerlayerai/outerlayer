/**
 * Scheduled entry point for the entitlement-driven retention sweep.
 * Fires on the daily cron trigger, alertHandler pattern:
 * resolve config, bail silently when disabled, run the sweep, log a
 * summary. Composition happens here — the service itself is pure
 * orchestration over injected seams.
 */

import { GatewayScheduleContext } from "@repo/gateway-core/types";
// Cross-tenant by construction: the sweep resolves every tenant's retention
// entitlement and deletes each tenant's expired rows — there is no single
// "current tenant" to scope by (sanctioned use #3 in system-client.ts).
import { createSystemAdminClient } from "@repo/gateway-core/lib/system-client";
import { createLoggerFromContext } from "../services/logger";
import { createRetentionStore } from "@repo/gateway-core/stores/clickhouse/retention-store";
import { clickHouseWriteAuth } from "@repo/gateway-core/stores/clickhouse/write-identity";
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
  if (!config.enabled) return;

  const logger = createLoggerFromContext(env, {
    source: "scheduled:retention-sweep",
  });

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
    // Swallow (no rethrow): the scheduled() orchestrator already wraps every
    // job in waitUntil(handler().catch(log)) — rethrowing double-logs.
    logger.error(
      error instanceof Error ? error : new Error("Retention sweep failed"),
      { cron: event.cron },
    );
  } finally {
    await logger.flush();
  }
};
