/**
 * Scheduled entry point for the nightly agent-findings compute. Fires on its
 * own daily cron trigger; resolve config, bail silently when disabled, run
 * the pass, log a summary. Composition happens here — the service is pure
 * orchestration over injected seams.
 */

import { GatewayScheduleContext } from "@repo/gateway-core/types";
// Cross-tenant by construction: the pass recomputes every active tenant's
// findings — there is no single "current tenant" to scope by (sanctioned
// use #2 in system-client.ts).
import { createSystemAdminClient } from "@repo/gateway-core/lib/system-client";
import { createLoggerFromContext } from "../services/logger";
import { createFindingsStore } from "../stores/clickhouse/findings-store";
import { clickHouseWriteAuth } from "@repo/gateway-core/stores/clickhouse/write-identity";
import {
  createSkillInventoryStore,
  type SkillInventoryClient,
} from "../stores/supabase/skill-inventory-store";
import {
  resolveFindingsComputeConfig,
  runFindingsCompute,
  type FindingsPersistClient,
} from "../services/findings-compute-service";
import { createThemesLlmClient } from "../services/themes-llm-client";

/**
 * The daily trigger this job fires on. Must match an entry in
 * `apps/gateway/wrangler.toml` `[triggers] crons`; the Worker's `scheduled()`
 * routes this cron string here INSTEAD of the every-minute jobs (which fire
 * as their own event).
 */
export const FINDINGS_COMPUTE_CRON = "30 3 * * *";

export const findingsComputeHandler = async ({
  env,
}: GatewayScheduleContext) => {
  const config = resolveFindingsComputeConfig(env);
  if (!config.enabled) return;

  const logger = createLoggerFromContext(env, {
    source: "scheduled:findings-compute",
  });

  // The mirror lives behind the cross-tenant admin client (same client the
  // persist step uses); the store reads only the context-mirror tables.
  const systemClient = createSystemAdminClient(env);
  const skillInventory = createSkillInventoryStore(
    systemClient as unknown as SkillInventoryClient,
  );

  const store = createFindingsStore({
    url: env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(env),
    onRowCapHit: (scope, rows) =>
      logger.warn("span row cap hit — findings cover a subset of the window", {
        tenantId: scope.tenantId,
        appId: scope.appId,
        rows,
      }),
  });

  await runFindingsCompute({
    store,
    supabase: systemClient as unknown as FindingsPersistClient,
    config,
    // Same provider + key as topics enrichment — no second vendor key.
    themesClient: createThemesLlmClient(env),
    skillInventory,
    log: logger,
    now: () => new Date(),
  });
};
