import "server-only";

import { getAdminDataClient } from "./admin-client";

/** The AI-cost settings read/write shape (`public.ai_cost_config`, supabase/schemas/67-ai-cost-config.sql). */
export interface AiCostConfig {
  /** Paid AI tool seats across the org (blended across tools). */
  seatCount: number;
  /** Blended monthly $ per seat. */
  costPerSeatUsd: number;
}

const EMPTY_AI_COST_CONFIG: AiCostConfig = { seatCount: 0, costPerSeatUsd: 0 };

/**
 * Widget-route read path. The RLS-bypassing admin client is constructed
 * HERE (`src/lib/system/**`): `ai_cost_config` writes are `update`-gated,
 * but the Total Cost of AI tile must render for every dashboard viewer
 * regardless of their grants. In exchange, `tenantId` MUST come from a
 * verified TenantContext — this function re-applies that scope and nothing
 * else.
 */
export async function fetchAiCostConfigForTenant(tenantId: string): Promise<AiCostConfig> {
  const { data, error } = await getAdminDataClient()
    .from("ai_cost_config")
    .select("seat_count, cost_per_seat_usd")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`ai_cost_config admin read failed: ${error.message}`);
  if (!data) return EMPTY_AI_COST_CONFIG;
  return {
    seatCount: Number(data.seat_count ?? 0),
    costPerSeatUsd: Number(data.cost_per_seat_usd ?? 0),
  };
}
