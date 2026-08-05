import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { PULL_REQUEST_TABLE } from "@/lib/system/pr-tracking/constants";

/**
 * Earlier of two ISO timestamps; a null/absent side loses. The primitive
 * behind every monotone first-occurrence milestone on `pull_request`
 * (review milestones here; ready_for_review_at in the PR/MR handlers).
 */
export function earliest(a: string | null | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * A review milestone plus the lifecycle snapshot to heal a missing row from.
 * Fed by the GitHub `pull_request_review` handler from the embedded PR object.
 */
interface ReviewMilestoneInput {
  provider: "github";
  repository: string;
  prNumber: number;
  /** Payload-true review time (never webhook delivery time). */
  submittedAt: string;
  /** Approving review → also advances first_approved_at. */
  isApproval: boolean;
  /** Lifecycle snapshot used ONLY when the row doesn't exist yet. */
  lifecycle: {
    headBranch: string;
    headSha: string | null;
    baseBranch: string;
    state: "open" | "closed" | "merged";
    url: string | null;
    openedAt: string | null;
    closedAt: string | null;
    mergedAt: string | null;
  };
}

/**
 * Persist a review milestone onto `pull_request` for every app connected to
 * the repo (feeds the decomposed cycle-time metric).
 *
 * `first_review_at` / `first_approved_at` are FIRST-OCCURRENCE timestamps,
 * monotone by construction (earliest of existing and incoming). An EXISTING
 * row gets ONLY its review columns updated — lifecycle stays owned by the
 * PR-lifecycle events + backfill, so an out-of-order review delivery can
 * never regress state/closed_at/merged_at. A MISSING row is created whole
 * from the lifecycle snapshot (a review can be the first event we see on a
 * connected repo).
 *
 * The RLS-bypassing admin client is constructed HERE, in the service layer:
 * `pull_request` writes are service_role-only, and this is a system webhook
 * path with no user session.
 */
export async function recordReviewMilestone(
  input: ReviewMilestoneInput
): Promise<void> {
  const { provider, repository, prNumber, submittedAt, isApproval, lifecycle } =
    input;

  const supabase = getAdminDataClient();
  const { data: connections } = await supabase
    .from("git_connection")
    .select("app_id, tenant_id")
    .eq("repository", repository);
  if (!connections?.length) return;

  for (const { app_id, tenant_id } of connections) {
    const { data: existing } = await supabase
      .from(PULL_REQUEST_TABLE)
      .select("first_review_at, first_approved_at")
      .eq("app_id", app_id)
      .eq("pr_number", prNumber)
      .maybeSingle();

    const firstReviewAt = earliest(existing?.first_review_at, submittedAt);
    const firstApprovedAt = isApproval
      ? earliest(existing?.first_approved_at, submittedAt)
      : (existing?.first_approved_at ?? null);

    const { error } = existing
      ? await supabase
          .from(PULL_REQUEST_TABLE)
          .update({
            first_review_at: firstReviewAt,
            first_approved_at: firstApprovedAt,
          })
          .eq("app_id", app_id)
          .eq("pr_number", prNumber)
      : await supabase.from(PULL_REQUEST_TABLE).upsert(
          {
            app_id,
            tenant_id,
            provider,
            pr_number: prNumber,
            head_branch: lifecycle.headBranch,
            head_sha: lifecycle.headSha,
            base_branch: lifecycle.baseBranch,
            state: lifecycle.state,
            url: lifecycle.url,
            ...(lifecycle.openedAt ? { opened_at: lifecycle.openedAt } : {}),
            closed_at: lifecycle.closedAt,
            merged_at: lifecycle.mergedAt,
            first_review_at: firstReviewAt,
            first_approved_at: firstApprovedAt,
          },
          { onConflict: "app_id,pr_number" }
        );
    if (error) {
      await serverLogger.error(error, {
        context: `[GitHub Webhook] review milestone upsert failed`,
        app_id,
        pr_number: prNumber,
      });
    }
  }
}
