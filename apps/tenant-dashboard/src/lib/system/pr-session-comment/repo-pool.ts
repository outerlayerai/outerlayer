import "server-only";

import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

/**
 * The concurrency policy every PR-comment refresh caller has to obey.
 *
 * GitHub's secondary rate limits are PER-REPOSITORY and punish bursts of
 * writes to one repo — exactly the shape both callers produce. The cron
 * sweep hits it on a backfill; the internal batch route hits it because the
 * queue consumer coalesces per `(tenant, repo, PR)` only, so fifty distinct
 * PRs on one busy monorepo arrive as a single POST.
 *
 * Octokit's throttling plugin does NOT save us here: `getInstallationOctokit`
 * mints a fresh client per refresh, so N concurrent refreshes hold N
 * independent limiters that share no state and therefore coordinate nothing.
 * The serialization has to happen above the client, which is here.
 *
 * So: serial within a repository, {@link REPO_REFRESH_CONCURRENCY} repos in
 * flight at once. This lives in the module rather than in either route
 * because a second caller that forgets the rule is precisely how the rule
 * gets lost.
 */
const REPO_REFRESH_CONCURRENCY = 4;

/** The identity a refresh is serialized on — one comment per PR, and PRs of
 * the same repo share a rate-limit bucket. */
interface RepoScoped {
  tenantId: string;
  repository: string;
}

/**
 * Runs `run` over every target: serially within each `(tenant, repository)`,
 * with at most {@link REPO_REFRESH_CONCURRENCY} repositories in flight.
 *
 * Returns results aligned to `targets` BY INDEX, so a caller can zip them
 * back onto its own input without re-deriving the grouping. `run` is
 * expected to absorb its own failures (both callers do, since one bad item
 * must never lose a sibling's result); anything it throws propagates.
 */
export async function refreshEachByRepo<T extends RepoScoped, R>(
  targets: readonly T[],
  run: (target: T) => Promise<R>,
  concurrency: number = REPO_REFRESH_CONCURRENCY,
): Promise<R[]> {
  // NUL delimiter: the one character guaranteed absent from a tenant id and
  // an `owner/repo`, so no pair of distinct scopes can collide into one
  // queue. Written as the `\0` escape, never as a raw byte — a literal NUL
  // makes the file binary to git and invisible to ripgrep.
  const byRepo = new Map<string, number[]>();
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i]!;
    // The cron path passes `git_connection`'s stored spelling, which can
    // differ across two connections naming the same repo — keying on the
    // raw string would split one rate-limit bucket into two concurrent
    // lanes, defeating the serialization this pool exists for.
    const key = `${t.tenantId}\0${canonicalPrCommentRepo(t.repository) ?? t.repository}`;
    const group = byRepo.get(key);
    if (group) group.push(i);
    else byRepo.set(key, [i]);
  }

  const groups = [...byRepo.values()];
  const results = new Array<R>(targets.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let g = next++; g < groups.length; g = next++) {
      for (const index of groups[g]!) {
        results[index] = await run(targets[index]!);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, worker),
  );
  return results;
}
