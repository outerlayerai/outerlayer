import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import { fetchOutcomesForTraces, type SessionPrOutcome } from "./session-outcome-read";

/**
 * Request-layer glue for the Sessions list's Outcome column: builds the
 * tenant-scoped ClickHouse reader, does ONE batched outcome read over the
 * page's traces, and hands back a lookup the route calls per row. Kept out of
 * the route so the wiring (the degrade-to-empty on failure, the per-row
 * default, pulling trace ids off the rows) is unit-testable without standing
 * up the whole request. The Supabase client is injected — the route supplies
 * the request-scoped one — so this stays a pure, mockable seam.
 *
 * Returns a function, not a Map, so callers never repeat the "missing → []"
 * default at the call site. A scores-read failure (or no ClickHouse) yields a
 * lookup that returns [] for every trace — the column just doesn't render
 * rather than blanking the list.
 */
export async function getSessionListOutcomes(
  scope: { tenantId: string; appId: string },
  supabase: SupabaseClient,
  rows: readonly Record<string, unknown>[],
): Promise<(traceId: string) => SessionPrOutcome[]> {
  const empty = new Map<string, SessionPrOutcome[]>();
  const chQuery = tenantChQuery(scope);
  const byTrace = chQuery
    ? await fetchOutcomesForTraces(supabase, chQuery, {
        tenantId: scope.tenantId,
        appId: scope.appId,
        traceIds: rows.map((r) => String(r.traceId)),
      }).catch(() => empty)
    : empty;
  return (traceId: string) => byTrace.get(traceId) ?? [];
}
