import { NextRequest } from "next/server";
import { CRON_SECRET } from "@/config-global.server";
import { safeCompare } from "@/utils/safe-compare";
import { runPrSessionSweep } from "@/lib/system/pr-session-reconciler";
import { runOutcomeScoresSweep } from "@/lib/system/outcome-scores";
import { refreshPrSessionComment } from "@/lib/system/pr-session-comment";
import type { ChangedPrTarget } from "@/lib/system/pr-session-reconciler/reconciler";

/**
 * Session-side PR↔session reconciliation sweep. The PR side reconciles
 * inline on webhook events; this covers the other arrival order — sessions
 * that sync AFTER their PRs' events landed (local syncs lag minutes to
 * days, and a backfill re-ingests months at once).
 *
 * The window is INGEST time (`InsertedAt`), not session time, so a
 * re-ingested historical corpus reconciles in one wide-window pass:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$HOST/api/cron/pr-session-reconcile?sinceHours=720"
 *
 * Scheduled hourly with the default window; `sinceHours` up to 720 for
 * manual catch-up runs after backfills.
 *
 * After reconciling, the outcome-score sweep converges PR-outcome scores for
 * PRs whose lifecycle row OR links changed inside the window — ordered after
 * reconciliation so links confirmed this tick emit this tick. Its window
 * defaults to `sinceHours`; `emitSinceHours` (up to 8760) widens it
 * independently, which doubles as the historical score backfill:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$HOST/api/cron/pr-session-reconcile?emitSinceHours=8760"
 *
 * Finally, refresh the GitHub comment for every PR whose links this tick
 * actually changed (`result.changed`). This is a SAFETY NET, never the
 * comment's primary path — the `pull_request` webhook and a debounced
 * queue off ingest post/update comments within the p50 ≤ 2 min latency
 * budget on their own; this hourly sweep only exists to catch what those
 * miss (an offline machine syncing sessions days late, a dropped queue
 * message). Refreshing every PR the sweep merely looked at — instead of only
 * the ones that changed — would be a rate-limit problem on a busy tenant,
 * so this stays scoped to `result.changed`.
 */
export const maxDuration = 300;

/** Refreshes the GitHub comment for each changed PR. One failure must not
 * abort the rest — `refreshPrSessionComment` already never throws, but the
 * try/catch is defensive in case a future change to it does. */
async function refreshChangedComments(
  changed: ChangedPrTarget[],
): Promise<{ attempted: number; failed: number }> {
  let failed = 0;
  for (const target of changed) {
    try {
      const result = await refreshPrSessionComment(target);
      if (result.status === "failed") failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: changed.length, failed };
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeCompare(authHeader, `Bearer ${CRON_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const raw = Number.parseInt(request.nextUrl.searchParams.get("sinceHours") ?? "", 10);
  const sinceHours = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 720) : 24;
  const rawEmit = Number.parseInt(
    request.nextUrl.searchParams.get("emitSinceHours") ?? "",
    10,
  );
  const emitSinceHours = Number.isFinite(rawEmit)
    ? Math.min(Math.max(rawEmit, 1), 8760)
    : sinceHours;

  try {
    const result = await runPrSessionSweep({ sinceHours });
    if (result.skipped) {
      return Response.json({ skipped: true, reason: "clickhouse not configured" });
    }
    const outcomeScores = await runOutcomeScoresSweep({ sinceHours: emitSinceHours });
    const commentRefresh = await refreshChangedComments(result.changed);
    return Response.json({
      sinceHours,
      ...result.counts,
      outcomeScores: outcomeScores.skipped
        ? { skipped: true }
        : { emitSinceHours, ...outcomeScores },
      commentRefresh,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
