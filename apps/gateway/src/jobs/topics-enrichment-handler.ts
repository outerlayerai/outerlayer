/**
 * Scheduled entry point for Trace Topics enrichment.
 *
 * Every-minute cron, alertHandler pattern: resolve config, bail silently
 * when disabled or idle (a no-op log line per minute is BetterStack noise,
 * not signal), run the batch, log a summary only when work happened.
 */

import { GatewayScheduleContext } from "@repo/gateway-core/types";
import { createLoggerFromContext } from "../services/logger";
import { createTopicsStore } from "../stores/clickhouse/topics-store";
import { clickHouseWriteAuth } from "@repo/gateway-core/stores/clickhouse/write-identity";
import { enqueueTopicsBackfillBatch } from "../queues/topics-enrichment-queue";
import {
  TICK_DEADLINES_MS,
  TopicsEnrichmentService,
  createTopicsModelClients,
  resolveTopicsConfig,
} from "../services/topics-enrichment-service";

/**
 * Backfill candidates enqueued per tick and per job. Deliberately ABOVE the
 * consumers' per-minute drain rate: the consumer autoscaler only adds
 * invocations when it sees a backlog, and an enqueue sized to exactly match
 * the drain keeps the queue near-empty — the fleet then never scales past
 * one or two invocations and a 20k-row re-drain crawls for days (measured).
 * Overlap duplicates are safe by design: a completed candidate's re-enqueue
 * is a presence-check no-op at the consumer, and the scans stop
 * re-discovering a trace the moment its rows land.
 */
const BACKFILL_ENQUEUE_PER_TICK = 250;

export const topicsEnrichmentHandler = async ({
  env,
  event,
}: GatewayScheduleContext) => {
  const config = resolveTopicsConfig(env);
  if (!config.enabled) return;

  const logger = createLoggerFromContext(env, {
    source: "scheduled:topics-enrichment",
  });

  try {
    const store = createTopicsStore({
      url: env.CLICKHOUSE_HOST,
      ...clickHouseWriteAuth(env),
    });
    const { structured, embedding, mode } = createTopicsModelClients(env);
    const service = new TopicsEnrichmentService(
      store,
      { structured, embedding },
      config,
    );

    // Absolute deadlines let an idle pass donate its slack to the next one
    // (see TICK_DEADLINES_MS) while the final deadline keeps the whole tick
    // inside the cron interval.
    const tickStartedAt = Date.now();
    const result = await service.run(undefined, tickStartedAt + TICK_DEADLINES_MS.live);
    if (result.scanned > 0) {
      logger.info("topics enrichment tick", {
        cron: event.cron,
        mode,
        scanned: result.scanned,
        enriched: result.enriched,
        failed: result.failed,
      });
    }

    // Backfill lanes. With the queue bound, the tick only DISCOVERS work:
    // each scan's candidates are enqueued job-tagged and the queue's
    // consumers do the model calls — a full-corpus re-drain is then
    // consumer-throughput bound (hours) instead of tick-budget bound (days),
    // and transient model failures redeliver instead of landing terminally.
    // The scans' version anti-joins stop re-discovering a trace once its
    // rows land; until then a re-enqueued duplicate is a cheap presence-check
    // no-op at the consumer, so no coordination state is needed. Without the
    // binding (self-host, local dev without queues) the passes run inline
    // exactly as before.
    if (env.TOPICS_QUEUE) {
      const [sweepScopes, refreshScopes] = await Promise.all([
        service.findSweepCandidateScopes(BACKFILL_ENQUEUE_PER_TICK),
        service.findRefreshCandidateScopes(BACKFILL_ENQUEUE_PER_TICK),
      ]);
      await enqueueTopicsBackfillBatch(env.TOPICS_QUEUE, logger, sweepScopes, "steering_sweep");
      await enqueueTopicsBackfillBatch(env.TOPICS_QUEUE, logger, refreshScopes, "batched_refresh");
    } else {
      // Steering backfill rides the same tick after the live pass: bounded
      // batch over already-enriched history missing steering rows. Quiet when
      // drained (one candidate query per tick, no log line).
      const backfill = await service.runSteeringBackfill(
        undefined,
        tickStartedAt + TICK_DEADLINES_MS.sweep,
      );
      if (backfill.scanned > 0) {
        logger.info("steering backfill tick", {
          cron: event.cron,
          mode,
          scanned: backfill.scanned,
          backfilled: backfill.enriched,
          failed: backfill.failed,
        });
      }

      // Batched-facet refresh takes the tick's tail: re-extracts history
      // written by an older batched extractor version. Quiet when current.
      const refresh = await service.runBatchedRefresh(
        undefined,
        tickStartedAt + TICK_DEADLINES_MS.refresh,
      );
      if (refresh.scanned > 0) {
        logger.info("batched refresh tick", {
          cron: event.cron,
          mode,
          scanned: refresh.scanned,
          refreshed: refresh.enriched,
          failed: refresh.failed,
        });
      }
    }
  } catch (error) {
    // Swallow (no rethrow): the scheduled() orchestrator already wraps every
    // job in waitUntil(handler().catch(log)) — rethrowing double-logs.
    logger.error(
      error instanceof Error
        ? error
        : new Error("Topics enrichment tick failed"),
      { cron: event.cron },
    );
  } finally {
    await logger.flush();
  }
};
