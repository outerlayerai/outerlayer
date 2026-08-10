import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import type { ChangedPrTarget } from "@/lib/system/pr-session-reconciler/reconciler";

import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

/**
 * The comment refresh's durable backlog, stored on
 * `pr_session_comment.needs_refresh`.
 *
 * Why it has to exist. The cron sweep hands its route a `changed` list that
 * is EDGE-triggered: it names links whose method or verification differ from
 * what was stored. A PR the route defers past its per-tick cap is therefore
 * INVISIBLE next tick — this tick already persisted those links, so they
 * compare equal and drop out of `changed` for good. Without a flag written
 * somewhere, "deferred" silently means "never refreshed", and after a
 * backfill that is thousands of PRs whose comments never arrive.
 *
 * Writing the flag on the identity row (rather than a queue table) also
 * fixes fairness for free: the next tick drains flagged rows FIRST, so the
 * deterministic ordering that decides who gets capped stops meaning the same
 * late-sorting tenants lose every time.
 *
 * Tenancy: every function here is service-role and keyed by ids the caller
 * already resolved — this module is reachable only from the cron route.
 */

/**
 * Ceiling on how much backlog one tick drains. Kept below the route's
 * per-tick refresh cap so a large backlog can never crowd out that tick's own
 * changed PRs entirely: the freshly-changed ones are the latency-sensitive
 * half, the backlog is repair work that has already missed its window.
 */
const MAX_BACKLOG_PER_TICK = 100;

export interface BacklogTarget extends ChangedPrTarget {
  /** The flagged `pr_session_comment.id` — the handle used to clear the flag
   * once this PR has been refreshed. */
  backlogId: string;
}

type AdminClient = ReturnType<typeof getAdminDataClient>;

/** PRs a previous tick could not get to, oldest first. */
export async function readCommentRefreshBacklog(
  admin: AdminClient = getAdminDataClient(),
): Promise<BacklogTarget[]> {
  const { data, error } = await admin
    .from("pr_session_comment")
    .select("id, tenant_id, repository, pr_number")
    .eq("needs_refresh", true)
    .order("updated_at", { ascending: true })
    .limit(MAX_BACKLOG_PER_TICK);
  if (error) {
    // Best-effort: a backlog read failure must not cost this tick its own
    // changed PRs. The flags stay set, so the next tick tries again.
    await serverLogger.error(error, {
      context: "[pr-session-comment] refresh backlog read failed",
    });
    return [];
  }
  return (data ?? []).map((row) => ({
    backlogId: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    prNumber: Number(row.pr_number),
  }));
}

/**
 * Remembers PRs a tick did not refresh — the ones past its cap, and the ones
 * that failed — so a later tick picks them up.
 *
 * Upserts a PARTIAL column set on purpose: on conflict PostgREST updates only
 * the columns named here, so an existing row keeps its comment id, hash, and
 * claim. On insert the rest take their defaults, which leaves `claimed_at`
 * NULL — deliberately, since a marker row is NOT a create claim and must not
 * block the next real poster for a claim TTL (see `claimCreate`).
 */
export async function markCommentRefreshNeeded(
  targets: readonly ChangedPrTarget[],
  admin: AdminClient = getAdminDataClient(),
): Promise<void> {
  const rows = targets
    .map((target) => ({
      tenant_id: target.tenantId,
      // Keyed the way the refresher keys it, or not written at all: an
      // unaddressable repository (a GHES host, an ssh remote) fails every
      // refresh anyway, so flagging it would only build backlog that can
      // never drain.
      repository: canonicalPrCommentRepo(target.repository),
      pr_number: target.prNumber,
      needs_refresh: true,
    }))
    .filter((row): row is typeof row & { repository: string } => row.repository !== null);
  if (rows.length === 0) return;

  const { error } = await admin
    .from("pr_session_comment")
    .upsert(rows, { onConflict: "tenant_id,repository,pr_number" });
  if (error) {
    await serverLogger.error(error, {
      context: "[pr-session-comment] refresh backlog write failed",
      deferred: rows.length,
    });
  }
}

/**
 * Clears the flag on rows a tick refreshed.
 *
 * Needed even though a successful post clears its own flag while persisting
 * the comment id: an `unchanged` refresh writes nothing at all, and that is
 * the common case for a flagged PR whose body has since settled.
 */
export async function clearCommentRefreshBacklog(
  ids: readonly string[],
  admin: AdminClient = getAdminDataClient(),
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await admin
    .from("pr_session_comment")
    .update({ needs_refresh: false })
    .in("id", [...ids]);
  if (error) {
    await serverLogger.error(error, {
      context: "[pr-session-comment] refresh backlog clear failed",
      cleared: ids.length,
    });
  }
}
