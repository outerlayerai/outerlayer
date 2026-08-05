import { recordReviewMilestone } from "@/lib/system/pr-tracking/review-milestones";

/**
 * Minimal shape of a GitHub `pull_request_review` webhook payload (only the
 * fields we use). The GitHub App must be subscribed to `pull_request_review`
 * events — until that subscription is enabled this handler receives nothing
 * in production; enabling it requires no code change, and the repo-link
 * backfill fills the same columns from API history regardless.
 */
export interface GitHubPullRequestReviewPayload {
  action: string; // submitted | edited | dismissed
  review?: {
    state?: string; // approved | changes_requested | commented (lowercase in webhook payloads)
    submitted_at?: string | null;
    user?: { id?: number; type?: string }; // type: "User" | "Bot" | "Organization"
  };
  // The full PR object rides along on review events — same lifecycle fields
  // as the `pull_request` event, so a review on a PR we've never seen heals
  // (creates) its row instead of dropping the timestamp.
  pull_request?: {
    number: number;
    html_url?: string;
    state?: string; // open | closed
    user?: { id?: number };
    created_at?: string | null;
    closed_at?: string | null;
    merged_at?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  };
  repository?: { full_name?: string };
}

/**
 * GitHub `pull_request_review` → review milestones on `pull_request`
 * for decomposed cycle time (open → first review → first
 * approval → merge).
 *
 * Payload semantics live here; the write contract (monotone
 * first-occurrence, update-only on existing rows, heal-on-missing) lives in
 * `@/lib/system/pr-tracking/review-milestones`:
 * - Only `submitted` actions count. `edited`/`dismissed` are ignored — a
 *   dismissed approval doesn't un-happen the review latency it measured.
 * - Self-reviews (review author = PR author) are ignored — an author
 *   commenting on their own PR is not review latency. BOT reviews are also
 *   ignored (industry-standard): an instant bot reviewer would zero out
 *   pickup time on every PR and hide exactly the human-review bottleneck
 *   the decomposition exists to expose. Bot review activity is a separate
 *   lens, not part of these milestones.
 * - Timestamps come from the PAYLOAD (`review.submitted_at`), never webhook
 *   delivery time; `now` is only the fallback.
 * - Reviews can land on closed or merged PRs (post-merge approvals), hence
 *   the full state derivation for the healing snapshot.
 */
export async function handlePullRequestReviewEvent(
  payload: GitHubPullRequestReviewPayload
): Promise<void> {
  if (payload.action !== "submitted") return;
  const pr = payload.pull_request;
  const review = payload.review;
  const repository = payload.repository?.full_name;
  if (!pr || !review || !repository) return;
  if (review.user?.id != null && review.user.id === pr.user?.id) return;
  if ((review.user?.type ?? "").toLowerCase() === "bot") return;

  const merged = Boolean(pr.merged_at);
  await recordReviewMilestone({
    provider: "github",
    repository,
    prNumber: pr.number,
    submittedAt: review.submitted_at ?? new Date().toISOString(),
    isApproval: (review.state ?? "").toLowerCase() === "approved",
    lifecycle: {
      headBranch: pr.head?.ref ?? "",
      headSha: pr.head?.sha ?? null,
      baseBranch: pr.base?.ref ?? "",
      state: pr.state === "closed" ? (merged ? "merged" : "closed") : "open",
      url: pr.html_url ?? null,
      openedAt: pr.created_at ?? null,
      closedAt: pr.state === "closed" ? (pr.closed_at ?? null) : null,
      mergedAt: pr.merged_at ?? null,
    },
  });
}
