import { NextRequest } from "next/server";
import { CRON_SECRET } from "@/config-global.server";
import { safeCompare } from "@/utils/safe-compare";
import { serverLogger } from "@/lib/observability/server-logger";
import { runPrSessionSweep } from "@/lib/system/pr-session-reconciler";
import { runOutcomeScoresSweep } from "@/lib/system/outcome-scores";
import { refreshPrSessionComment } from "@/lib/system/pr-session-comment";
import { refreshEachByRepo } from "@/lib/system/pr-session-comment/repo-pool";
import {
  clearCommentRefreshBacklog,
  markCommentRefreshNeeded,
  readCommentRefreshBacklog,
  type BacklogTarget,
} from "@/lib/system/pr-session-comment/backlog";
import type { ChangedPrTarget } from "@/lib/system/pr-session-reconciler/reconciler";
import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

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
 * actually changed (`result.changed`), plus any PR a previous tick had to
 * defer (`pr_session_comment.needs_refresh`). This is a SAFETY NET, never the
 * comment's primary path — the `pull_request` webhook and a debounced
 * queue off ingest post/update comments within the p50 ≤ 2 min latency
 * budget on their own; this hourly sweep only exists to catch what those
 * miss (an offline machine syncing sessions days late, a dropped queue
 * message). Refreshing every PR the sweep merely looked at — instead of only
 * the ones that changed — would be a rate-limit problem on a busy tenant,
 * so this stays scoped to `result.changed`, and even that is capped and
 * rate-shaped per tick (see {@link MAX_COMMENT_REFRESHES_PER_TICK} and
 * {@link REPO_REFRESH_CONCURRENCY}) so one backfill can't blow the
 * `maxDuration` budget or burst-write a single repository.
 */
export const maxDuration = 300;

/**
 * Ceiling on comment refreshes per tick. `changed` is unbounded — after a
 * backfill (`sinceHours=720`) it can be thousands of PRs, each costing
 * several Supabase reads, a ClickHouse query, and a GitHub write. Refreshing
 * all of them times the route out mid-list, and the tail would never be
 * reached at all. Capping makes each tick finish; what's left over is
 * REMEMBERED (see `pr-session-comment/backlog.ts`) rather than merely
 * reported.
 */
const MAX_COMMENT_REFRESHES_PER_TICK = 150;

type RefreshTarget = ChangedPrTarget & Partial<Pick<BacklogTarget, "backlogId">>;

/** Identity of a refresh target, in the same canonical spelling
 * `refreshPrSessionComment` keys its row by — so a backlog row (stored
 * canonical) and a sweep target (spelled the way `git_connection` holds it)
 * are recognized as the same PR instead of refreshed twice. */
function targetKey(target: ChangedPrTarget): string {
  const repo = canonicalPrCommentRepo(target.repository) ?? target.repository.toLowerCase();
  return `${target.tenantId} ${repo} ${target.prNumber}`;
}

/** Refreshes the GitHub comment for each PR that needs one — backlog first,
 * then this tick's changed PRs in a deterministic order — capped, and
 * serialized per repository by the module's shared pool (see
 * `pr-session-comment/repo-pool.ts` for the rate-limit reason). One failure
 * must not abort the rest — `refreshPrSessionComment` already never throws,
 * but the try/catch is defensive in case a future change to it does. */
async function refreshChangedComments(
  changed: ChangedPrTarget[],
): Promise<{ attempted: number; failed: number; deferred: number; fromBacklog: number }> {
  const backlog = await readCommentRefreshBacklog();

  // Stable total order for the changed half, so a cap slices it the same way
  // every tick rather than at an arbitrary point in PostgREST's row order.
  const orderedChanged = [...changed].sort(
    (a, b) =>
      a.tenantId.localeCompare(b.tenantId) ||
      a.repository.localeCompare(b.repository) ||
      a.prNumber - b.prNumber,
  );

  // Backlog first — it has already waited a tick — then the changed PRs,
  // minus any the backlog already covers.
  const seen = new Set<string>();
  const ordered: RefreshTarget[] = [];
  for (const target of [...backlog, ...orderedChanged]) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(target);
  }

  const batch = ordered.slice(0, MAX_COMMENT_REFRESHES_PER_TICK);
  const deferred = ordered.slice(MAX_COMMENT_REFRESHES_PER_TICK);

  const outcomes = await refreshEachByRepo(batch, async (target) => {
    try {
      // Explicit fields, not the target object: `backlogId` is this route's
      // bookkeeping and has no business crossing into the refresher.
      const result = await refreshPrSessionComment({
        tenantId: target.tenantId,
        repository: target.repository,
        prNumber: target.prNumber,
      });
      return result.status === "failed";
    } catch {
      return true;
    }
  });

  // A failed refresh is exactly the case the backlog exists for, so it is
  // re-flagged alongside the deferred tail; a succeeded backlog entry is
  // cleared.
  const failedTargets = batch.filter((_, i) => outcomes[i]);
  const clearableIds = batch
    .filter((target, i) => !outcomes[i] && target.backlogId)
    .map((target) => target.backlogId!);
  await markCommentRefreshNeeded([...deferred, ...failedTargets]);
  await clearCommentRefreshBacklog(clearableIds);

  return {
    attempted: batch.length,
    failed: failedTargets.length,
    deferred: deferred.length,
    fromBacklog: batch.filter((target) => target.backlogId).length,
  };
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
    // Scores are best-effort TELEMETRY, and they run BEFORE the comment
    // refresh (so links confirmed this tick emit this tick) — which means an
    // unguarded throw here would take the refresh down with it, after the
    // sweep already persisted the links. That is the one ordering where a
    // telemetry failure costs the repair path a tick's work, so it gets its
    // own catch, exactly as the webhook handler gives it. Same posture as
    // every other scores call site: log, report, carry on.
    let outcomeScores: Awaited<ReturnType<typeof runOutcomeScoresSweep>> | null = null;
    let outcomeScoresError: string | null = null;
    try {
      outcomeScores = await runOutcomeScoresSweep({ sinceHours: emitSinceHours });
    } catch (error) {
      outcomeScoresError = error instanceof Error ? error.message : String(error);
      await serverLogger.error(error as Error, {
        context: "[pr-session-reconcile] outcome-score sweep failed",
      });
    }

    const commentRefresh = await refreshChangedComments(result.changed);
    return Response.json({
      sinceHours,
      ...result.counts,
      outcomeScores: outcomeScoresError
        ? { error: outcomeScoresError }
        : outcomeScores?.skipped
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
