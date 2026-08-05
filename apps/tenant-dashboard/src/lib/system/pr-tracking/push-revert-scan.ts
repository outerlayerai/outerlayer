import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { PULL_REQUEST_TABLE } from "./constants";
import { parseCommitRevertTargets } from "./revert-detection";

/** One pushed commit, already normalized by the provider webhook adapter. */
interface PushCommitForRevertScan {
  sha: string;
  message: string;
  /** Commit timestamp (ISO) — becomes reverted_at; push receipt time is the fallback. */
  timestamp?: string;
}

interface PushRevertScanInput {
  /** `owner/repo` — the git_connection key. */
  repository: string;
  /** The branch pushed to (no refs/heads/ prefix). */
  branch: string;
  commits: PushCommitForRevertScan[];
}

/** Push payloads cap their commit arrays (GitHub at 20); this is a defensive
 * ceiling against synthetic events, not pagination. */
const MAX_COMMITS_SCANNED = 100;

/**
 * Marks merged PRs/MRs as reverted when a pushed commit names them — the
 * manual-`git revert` gap in body-based detection (no revert PR ever exists
 * for a direct push, so the merge-event path never sees it).
 *
 * Guards, applied to every match:
 *  - target must be MERGED — unmerged work can't be "reverted", and a stray
 *    number in a commit message must not flag an open PR;
 *  - the push must land on the target's BASE branch — a revert only undoes
 *    shipped work when it lands where the work shipped (a revert commit on a
 *    feature branch flags nothing until it merges — at which point the merge
 *    commit/PR carries the same reference and lands on the base branch);
 *  - reverted_at only transitions NULL → set (first revert wins; webhook
 *    redeliveries and revert-of-revert chains never move it).
 *
 * Update-only, like the body path: an untracked target touches 0 rows.
 * Best-effort: failures log and never break push processing.
 */
export async function scanPushForReverts(input: PushRevertScanInput): Promise<void> {
  const commits = input.commits.slice(0, MAX_COMMITS_SCANNED);
  if (commits.length === 0) return;

  // Collect targets first — most pushes name none, and the git_connection
  // lookup is skipped entirely for them.
  const prTargets = new Map<number, string>(); // prNumber → reverted_at
  const shaTargets = new Map<string, string>(); // head_sha → reverted_at
  const now = new Date().toISOString();
  for (const commit of commits) {
    const { prNumbers, shas } = parseCommitRevertTargets(commit.message);
    const ts = commit.timestamp ?? now;
    for (const n of prNumbers) if (!prTargets.has(n)) prTargets.set(n, ts);
    for (const sha of shas) if (!shaTargets.has(sha)) shaTargets.set(sha, ts);
  }
  if (prTargets.size === 0 && shaTargets.size === 0) return;

  const supabase = getAdminDataClient();
  const { data: connections } = await supabase
    .from("git_connection")
    .select("app_id")
    .eq("repository", input.repository);
  if (!connections?.length) return;

  for (const { app_id } of connections) {
    for (const [prNumber, revertedAt] of prTargets) {
      const { error } = await supabase
        .from(PULL_REQUEST_TABLE)
        .update({ reverted_at: revertedAt })
        .eq("app_id", app_id)
        .eq("pr_number", prNumber)
        .eq("state", "merged")
        .eq("base_branch", input.branch)
        .is("reverted_at", null);
      if (error) {
        await serverLogger.error(error, {
          context: "[Push Revert Scan] revert flag by PR number failed",
          app_id,
          pr_number: prNumber,
        });
      }
    }

    for (const [sha, revertedAt] of shaTargets) {
      const { error } = await supabase
        .from(PULL_REQUEST_TABLE)
        .update({ reverted_at: revertedAt })
        .eq("app_id", app_id)
        .eq("head_sha", sha)
        .eq("state", "merged")
        .eq("base_branch", input.branch)
        .is("reverted_at", null);
      if (error) {
        await serverLogger.error(error, {
          context: "[Push Revert Scan] revert flag by head sha failed",
          app_id,
          head_sha: sha,
        });
      }
    }
  }
}
