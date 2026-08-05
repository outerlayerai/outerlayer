import "server-only";

/**
 * AiCostService — the org-wide AI program cost read/write (`public.ai_cost_config`,
 * supabase/schemas/67-ai-cost-config.sql): the seats × $/seat/month half of
 * "Total Cost of AI". Every query runs through the caller's RLS-scoped
 * `ctx.db`: the `ai_cost_config.{read,insert,update}` policies plus the
 * `tenant_id()` match are the enforcement boundary, so a denied write is
 * indistinguishable from any other DB error here — the caller (the action)
 * surfaces it rather than assuming success.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import type { AiCostConfig } from "./types";
import type { UpdateAiCostConfigInput } from "./schemas";

class AiCostService {
  /** The tenant's config; null when never configured or the read was denied — both look identical under RLS. */
  async getConfig(ctx: ServiceContext): Promise<AiCostConfig | null> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("ai_cost_config")
      .select("seat_count, cost_per_seat_usd")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (error) throw new Error(`ai_cost_config read failed: ${error.message}`);
    if (!data) return null;
    return {
      seatCount: Number(data.seat_count ?? 0),
      costPerSeatUsd: Number(data.cost_per_seat_usd ?? 0),
    };
  }

  /**
   * Upserts the tenant's config and returns the row actually written.
   * `.select().single()` after the upsert means an RLS-denied write (which
   * matches zero rows — e.g. a role holding `update` but not `insert` on a
   * tenant's first-ever configure) surfaces as a real error here instead of
   * a silent no-op success — the caller must inspect the result to know a
   * write landed, it can never assume so.
   */
  async upsertConfig(ctx: ServiceContext, input: UpdateAiCostConfigInput): Promise<AiCostConfig> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("ai_cost_config")
      .upsert(
        {
          tenant_id: ctx.tenantId,
          seat_count: Math.max(0, Math.round(input.seatCount)),
          cost_per_seat_usd: Math.max(0, input.costPerSeatUsd),
        },
        { onConflict: "tenant_id" },
      )
      .select("tenant_id, seat_count, cost_per_seat_usd")
      .single();
    if (error) throw new Error(`ai_cost_config write failed: ${error.message}`);
    return {
      seatCount: Number(data.seat_count ?? 0),
      costPerSeatUsd: Number(data.cost_per_seat_usd ?? 0),
    };
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const aiCostService = new AiCostService();
