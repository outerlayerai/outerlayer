import "server-only";

import type { Octokit } from "octokit";
import {
  CHECK_NAME,
  type CheckRunner,
  type CheckRunRef,
  type CompleteArgs,
} from "../check-runner";

export { CHECK_NAME };

/**
 * GitHub Checks API implementation of {@link CheckRunner}.
 *
 * The GitHub App already installed on the tenant's repo (see
 * `apps/tenant-dashboard/src/octo-kit.ts`) posts a Check Run on every push
 * reporting whether the context mirror synced the pushed commit. Tenants can
 * add this check to branch protection; we deliberately do NOT manage branch
 * protection ourselves (that needs the heavyweight `administration` permission
 * and surprises users — it's a one-time repo-owner action).
 *
 * The check is OBSERVABILITY: a Checks API failure is caught by the caller's
 * try/catch and never affects the sync outcome (which is recorded on
 * `context_sync_event` regardless).
 */
export class GitHubCheckRunner implements CheckRunner {
  constructor(
    private readonly octokit: Octokit,
    private readonly target: { owner: string; repo: string },
  ) {}

  async start(headSha: string): Promise<CheckRunRef> {
    const { data } = await this.octokit.rest.checks.create({
      owner: this.target.owner,
      repo: this.target.repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    return { id: data.id };
  }

  async complete({ ref, conclusion, summary }: CompleteArgs): Promise<void> {
    // GitHub's check_run_id is numeric. The runner minted it from the API
    // response in start(); the caller hands it back to us opaquely.
    const checkRunId = ref.id as number;

    await this.octokit.rest.checks.update({
      owner: this.target.owner,
      repo: this.target.repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: titleForConclusion(conclusion),
        summary: summary ?? defaultSummary(conclusion),
      },
    });
  }
}

function titleForConclusion(conclusion: CompleteArgs["conclusion"]): string {
  if (conclusion === "success") return "Context synced";
  if (conclusion === "neutral") return "Nothing to sync";
  return "Context sync failed";
}

function defaultSummary(conclusion: CompleteArgs["conclusion"]): string {
  if (conclusion === "success") {
    return "The context mirror synced this push.";
  }
  if (conclusion === "neutral") {
    return "No app is watching this branch — nothing to sync.";
  }
  return "The context mirror failed to sync this push. It will retry on the next push, or resync from the Context tab.";
}
