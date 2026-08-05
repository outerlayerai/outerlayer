import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import type { PrLifecycleRow } from "@/lib/dashboards/pr-metrics";

/**
 * Decided (non-open) PR lifecycle rows for an app, with `closed_at` from
 * `sinceDay` (UTC, `YYYY-MM-DD`) onward — the fetch behind the PR-lifecycle
 * widgets: both metrics read decided PRs only, and the merge-rate
 * tile's change indicator needs the prior window, so callers pass that
 * window's start as `sinceDay`. The phase-boundary columns
 * (`ready_for_review_at`/`first_review_at`/`first_approved_at`) ride along for
 * the decomposed cycle-time widget; they're NULL on rows that never reached a
 * given milestone and the metric math treats NULL as "phase not measurable".
 *
 * The RLS-bypassing admin client is constructed HERE, in the service layer:
 * `pull_request` writes are service_role-only and the read must not depend on
 * the caller's RLS grants. In exchange, `tenantId`/`appId` MUST come from a
 * verified TenantContext — this function re-applies that scope to every row
 * and nothing else.
 */
const PR_LIFECYCLE_COLUMNS =
  "pr_number, head_branch, state, opened_at, closed_at, merged_at, ready_for_review_at, first_review_at, first_approved_at, reopen_count, reverted_at, additions, deletions, changed_files, first_ci_status";

export async function fetchDecidedPullRequests(params: {
  tenantId: string;
  appId: string;
  sinceDay: string;
}): Promise<PrLifecycleRow[]> {
  const { tenantId, appId, sinceDay } = params;
  const { data, error } = await getAdminDataClient()
    .from("pull_request")
    .select(PR_LIFECYCLE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("app_id", appId)
    .neq("state", "open")
    .gte("closed_at", `${sinceDay}T00:00:00Z`)
    .limit(5000);
  if (error) {
    throw new Error(`pull_request read failed: ${error.message}`);
  }
  return (data ?? []) as PrLifecycleRow[];
}

/**
 * Org-scope variant of `fetchDecidedPullRequests`: every decided PR across
 * the TENANT, each row tagged with its app's connected repository so the
 * caller can match session attribution within a repo (branch names and PR
 * numbers collide across repos — see `namespaceOrgPrRows`). Apps whose
 * git_connection is missing get `repo: ''` — they still count in the
 * denominator (a merge is a merge) but can never be agent-attributed, which
 * only ever UNDERCOUNTS agent share, never inflates it. Same admin-client
 * posture as the app-scope read: tenantId MUST come from a verified
 * TenantContext.
 */
export async function fetchDecidedPullRequestsForTenant(params: {
  tenantId: string;
  sinceDay: string;
}): Promise<(PrLifecycleRow & { repo: string; app_id: string })[]> {
  const { tenantId, sinceDay } = params;
  const supabase = getAdminDataClient();
  const [prResult, connectionResult] = await Promise.all([
    supabase
      .from("pull_request")
      .select(`app_id, ${PR_LIFECYCLE_COLUMNS}`)
      .eq("tenant_id", tenantId)
      .neq("state", "open")
      .gte("closed_at", `${sinceDay}T00:00:00Z`)
      .limit(5000),
    supabase.from("git_connection").select("app_id, repository").eq("tenant_id", tenantId),
  ]);
  if (prResult.error) {
    throw new Error(`pull_request tenant read failed: ${prResult.error.message}`);
  }
  if (connectionResult.error) {
    throw new Error(`git_connection tenant read failed: ${connectionResult.error.message}`);
  }
  const repoByApp = new Map(
    (connectionResult.data ?? []).map((c) => [c.app_id, c.repository ?? ""]),
  );
  return ((prResult.data ?? []) as (PrLifecycleRow & { app_id: string })[]).map((row) => ({
    ...row,
    repo: repoByApp.get(row.app_id) ?? "",
  }));
}
