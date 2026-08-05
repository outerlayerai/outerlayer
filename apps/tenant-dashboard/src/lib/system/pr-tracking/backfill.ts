import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { serverLogger } from "@/lib/observability/server-logger";
import type { GitProvider } from "../git/git-provider.interface";
import type { PullRequestReviewSummary } from "../git/types";

/** Newest-first cap. Two provider pages; enough history for the fleet PR
 * metrics' default windows without unbounded API fan-out on huge repos. */
export const PR_BACKFILL_LIMIT = 200;

/** Review history costs one provider call PER PR (no bulk endpoint), and the
 * backfill is awaited inside the repo-link action — so review enrichment is
 * capped to the newest slice of the lifecycle backfill. The newest 50 cover
 * the default widget windows on most repos; older PRs keep NULL review
 * columns, which readers treat as unknown, never zero. */
export const REVIEW_BACKFILL_PR_LIMIT = 50;
const REVIEW_FETCH_CONCURRENCY = 5;

type PrBackfillResult = { synced: number } | { error: string };

interface ReviewFirsts {
  first_review_at: string | null;
  first_approved_at: string | null;
}

/**
 * First non-author HUMAN review + first non-author HUMAN approval from a
 * chronological (oldest-first) review list. Self-reviews are excluded — an
 * author commenting on their own PR is not review latency. Bot reviews are
 * excluded too (industry-standard): an instant bot reviewer would zero out
 * pickup time on every PR and hide the human-review bottleneck. `dismissed`
 * reviews still count as reviews (the latency happened) but never as
 * approvals. Reviews without a submitted timestamp are skipped.
 */
export function computeReviewFirsts(
  reviews: PullRequestReviewSummary[],
  prAuthorId: number | null
): ReviewFirsts {
  let firstReview: string | null = null;
  let firstApproved: string | null = null;
  for (const review of reviews) {
    if (!review.submittedAt) continue;
    if (review.isBot) continue;
    if (prAuthorId != null && review.authorId === prAuthorId) continue;
    if (firstReview === null || review.submittedAt < firstReview) {
      firstReview = review.submittedAt;
    }
    if (
      review.state === "approved" &&
      (firstApproved === null || review.submittedAt < firstApproved)
    ) {
      firstApproved = review.submittedAt;
    }
  }
  return { first_review_at: firstReview, first_approved_at: firstApproved };
}

/**
 * Backfill `pull_request` from provider history.
 *
 * Webhook-driven tracking only sees events from connect time forward, so a
 * newly connected repo would show empty fleet PR metrics (merge rate, cycle
 * time) for weeks. This pulls the most recent `limit` PRs across all
 * states and upserts their lifecycle rows, enriching the newest
 * `REVIEW_BACKFILL_PR_LIMIT` with review milestones where the provider
 * supports review listing (see `GitProvider.listPullRequestReviews`).
 *
 * Contracts:
 * - NEVER throws — the repo-link flow must not fail on a backfill error
 *   (same non-fatal contract as the context mirror's initialSync). A missed
 *   backfill self-heals on the next relink.
 * - Idempotent upsert on (app_id, pr_number); overwrites lifecycle columns
 *   with provider truth (healing rows staled by missed webhooks on relink)
 *   but never touches environment_id/comment_id — those are webhook-owned.
 * - Review columns: a SUCCESSFUL review fetch is authoritative for its PR,
 *   including explicit nulls (no qualifying reviews exist). A failed fetch,
 *   a PR beyond the review cap, or a provider without review listing keeps
 *   the row's EXISTING values — webhook-captured milestones are never nulled
 *   by a fetch gap. Partial enrichment is logged, not silent.
 * - Requires the service_role client: pull_request writes are RLS-denied to
 *   authenticated users.
 * - app = repo convention: rows are keyed by app; a relink to a DIFFERENT
 *   repo leaves the prior repo's rows in place (consistent with the rest of
 *   the product's app=repo assumption).
 */
export async function backfillPullRequests(params: {
  supabase: SupabaseClient;
  provider: GitProvider;
  appId: string;
  tenantId: string;
  repository: string;
  limit?: number;
}): Promise<PrBackfillResult> {
  const { supabase, provider, appId, tenantId, repository } = params;
  const limit = params.limit ?? PR_BACKFILL_LIMIT;
  try {
    const prs = await provider.listPullRequests(repository, { limit });
    if (prs.length === 0) return { synced: 0 };

    // Review enrichment — newest slice only; failures fall back per-PR.
    const reviewFirsts = new Map<number, ReviewFirsts>();
    if (provider.listPullRequestReviews) {
      const targets = prs.slice(0, REVIEW_BACKFILL_PR_LIMIT);
      let failed = 0;
      for (let i = 0; i < targets.length; i += REVIEW_FETCH_CONCURRENCY) {
        const chunk = targets.slice(i, i + REVIEW_FETCH_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map(async (pr) => ({
            number: pr.number,
            firsts: computeReviewFirsts(
              await provider.listPullRequestReviews!(repository, pr.number),
              pr.authorId
            ),
          }))
        );
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            reviewFirsts.set(outcome.value.number, outcome.value.firsts);
          } else {
            failed += 1;
          }
        }
      }
      const beyondCap = prs.length - targets.length;
      if (failed > 0 || beyondCap > 0) {
        await serverLogger.info(
          `[PR Backfill] review enrichment partial: ${failed} fetch failures, ${beyondCap} PRs beyond the review cap keep existing review columns`,
          { app_id: appId, repository }
        );
      }
    }

    // Existing milestone columns — preserved wherever this run has no
    // better verdict (review fetch gaps; webhook-exact ready stamps).
    const { data: existingRows } = await supabase
      .from("pull_request")
      .select("pr_number, ready_for_review_at, first_review_at, first_approved_at")
      .eq("app_id", appId)
      .in(
        "pr_number",
        prs.map((pr) => pr.number)
      );
    const existingByNumber = new Map(
      (existingRows ?? []).map((row) => [row.pr_number, row])
    );

    const rows = prs.map((pr) => {
      const existing = existingByNumber.get(pr.number);
      const firsts = reviewFirsts.get(pr.number) ?? {
        first_review_at: existing?.first_review_at ?? null,
        first_approved_at: existing?.first_approved_at ?? null,
      };
      return {
        app_id: appId,
        tenant_id: tenantId,
        provider: provider.type,
        pr_number: pr.number,
        head_branch: pr.headBranch,
        head_sha: pr.headSha,
        base_branch: pr.baseBranch,
        state: pr.state,
        url: pr.url,
        opened_at: pr.openedAt,
        closed_at: pr.closedAt,
        merged_at: pr.mergedAt,
        // Draft-aware pickup baseline: the list APIs carry only the CURRENT
        // draft flag, not the draft→ready transition time, so the backfill
        // approximates non-draft PRs as ready-at-open and leaves drafts NULL
        // (still coding). A webhook-exact stamp always wins over the
        // approximation.
        ready_for_review_at:
          existing?.ready_for_review_at ?? (pr.draft ? null : pr.openedAt),
        first_review_at: firsts.first_review_at,
        first_approved_at: firsts.first_approved_at,
      };
    });

    const { error } = await supabase
      .from("pull_request")
      .upsert(rows, { onConflict: "app_id,pr_number" });
    if (error) return { error: error.message };
    return { synced: rows.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
