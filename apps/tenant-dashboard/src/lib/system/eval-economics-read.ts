import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";

/**
 * The latest completed Report Card's economics, reduced to one ROI figure:
 * the BETTER (cheaper) config's cost per resolved task. A card always
 * carries two $/resolved numbers (it is an A-vs-B comparison); the tile
 * shows the best the org has demonstrably achieved, and the description
 * points at the full card for the comparison.
 */
interface EvalEconomics {
  /** The cheaper config's $/resolved from the latest succeeded run, or null
   * when that run resolved zero tasks (∞ never renders as a number). */
  bestCostPerResolvedUsd: number | null;
  /** Measured total spend of the run (both configs), from the column. */
  totalRunCostUsd: number;
  ranAt: string;
}

/**
 * Widget-route read path. The RLS-bypassing admin client is constructed
 * HERE, in the service layer (data-access boundary): the tile must render
 * for any dashboard viewer, while eval_run RLS gates on eval_run.read. In
 * exchange, tenantId MUST come from a verified TenantContext.
 *
 * `card.stats.dollarsPerResolved.{a,b}` is written by the report-card
 * pipeline as plain numbers; a 0-resolved config serializes its Infinity as
 * null (JSON has no Infinity), so non-finite values are treated as absent —
 * unknown, never $0.
 */
export async function fetchLatestEvalEconomics(params: {
  tenantId: string;
  appId: string;
  /** `org` sweeps every app in the tenant — the exec dashboard's org toggle. */
  scope: "app" | "org";
}): Promise<EvalEconomics | null> {
  let query = getAdminDataClient()
    .from("eval_run")
    .select("card, cost_usd, created_at")
    .eq("tenant_id", params.tenantId)
    .eq("status", "succeeded")
    .not("card", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (params.scope !== "org") {
    query = query.eq("app_id", params.appId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`eval_run read failed: ${error.message}`);
  }
  if (!data) return null;

  const stats = (data.card as { stats?: { dollarsPerResolved?: { a?: unknown; b?: unknown } } } | null)
    ?.stats;
  const candidates = [stats?.dollarsPerResolved?.a, stats?.dollarsPerResolved?.b].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
  );
  return {
    bestCostPerResolvedUsd: candidates.length > 0 ? Math.min(...candidates) : null,
    totalRunCostUsd: Number(data.cost_usd ?? 0),
    ranAt: data.created_at,
  };
}
