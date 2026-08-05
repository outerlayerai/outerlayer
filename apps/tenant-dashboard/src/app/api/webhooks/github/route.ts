import * as Sentry from "@/lib/observability/error-reporting/sentry";
import { NextRequest, NextResponse } from "next/server";
import { Webhooks } from "@octokit/webhooks";
import { GITHUB_APP_ID, GITHUB_APP_WEBHOOK_SECRET } from "@/config-global.server";
import { handleInstallationEvent } from "./handle-installtion-event";
import {
  handlePullRequestEvent,
  type GitHubPullRequestPayload,
} from "./handle-pull-request-event";
import {
  handlePullRequestReviewEvent,
  type GitHubPullRequestReviewPayload,
} from "./handle-pull-request-review-event";
import {
  normalizeGitHubPushEvent,
  type GitHubPushPayload,
} from "@/lib/system/git/github/webhooks";
import { getGithubApp } from "@/octo-kit";
import { GitHubProvider } from "@/lib/system/git/github/client";
import { GitHubCheckRunner } from "@/lib/system/git/github/check-runner";
import { serverLogger } from "@/lib/observability/server-logger";
import { handlePushEvent } from "@/lib/system/context-sync/handle-push-event";
import { scanPushForReverts } from "@/lib/system/pr-tracking/push-revert-scan";
import { ciConclusionFromGitHub, recordFirstPassCiResult } from "@/lib/system/pr-tracking/ci-status";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  Sentry.setTag("git.provider", "github");

  // Verify webhook signature
  const webhooks = new Webhooks({
    // @ts-expect-error - Webhooks type is not compatible with the Github app ID
    appId: GITHUB_APP_ID,
    secret: GITHUB_APP_WEBHOOK_SECRET,
  });

  const reqClone = request.clone();
  const bodyText = await request.text();
  const githubSecret = request.headers.get("X-Hub-Signature-256");

  if (!githubSecret || !(await webhooks.verify(bodyText, githubSecret))) {
    // Return 401 directly — this guard runs BEFORE the try/catch below, so
    // throwing here escaped the error→status mapping and surfaced as a 500.
    return NextResponse.json("Invalid signature", { status: 401 });
  }

  const githubEvent = request.headers.get("X-GitHub-Event");
  const body = await reqClone.json();

  try {
    if (githubEvent === "push") {
      const payload = body as GitHubPushPayload;
      await serverLogger.info("[GitHub Webhook] Push event received", {
        repository: payload.repository?.full_name,
        ref: payload.ref,
        commits: payload.commits?.length,
      });

      // Adapter: verify (done) → normalize → build provider + check runner →
      // hand off to the provider-agnostic push core. The core owns routing,
      // pointer advance, mirror sync, and the check-run lifecycle, and never
      // throws — so a push always returns 200 past signature verification.
      const push = normalizeGitHubPushEvent(payload);
      const githubApp = getGithubApp();
      const octokit = await githubApp.getInstallationOctokit(payload.installation!.id);
      const provider = new GitHubProvider(octokit);

      // Repo coordinates for the Checks API. `full_name` is "owner/repo".
      // Branch deletions have head SHA `0000…0000` and produce no check.
      const [owner, repo] = (payload.repository?.full_name ?? "").split("/");
      const headSha = payload.after;
      const canPostCheck =
        Boolean(owner) &&
        Boolean(repo) &&
        Boolean(headSha) &&
        headSha !== "0000000000000000000000000000000000000000";

      const checkRunner = canPostCheck
        ? new GitHubCheckRunner(octokit, { owner: owner!, repo: repo! })
        : null;

      await handlePushEvent({
        push,
        provider,
        checkRunner,
        source: "GitHub Webhook",
      });

      // Manual-revert detection: a `git revert` pushed straight to a base
      // branch never produces a pull_request event, so the push payload's
      // commit messages are the only signal. Independent of context-sync.
      await scanPushForReverts({
        repository: push.repository,
        branch: push.branch,
        commits: push.commits.map((c) => ({
          sha: c.sha,
          message: c.message,
          timestamp: c.timestamp,
        })),
      });
    }

    // First-pass CI verdicts. workflow_run covers GitHub Actions; check_run
    // covers Checks-API CI (CircleCI, Buildkite, …). Actions repos emit BOTH
    // for the same run — recordFirstPassCiResult is monotone (sha-locked,
    // failure-sticky), so double-processing converges on the same verdict.
    // Requires the GitHub App to subscribe to these events (Checks: read).
    if (githubEvent === "workflow_run" || githubEvent === "check_run") {
      const payload = body as {
        action?: string;
        workflow_run?: { head_sha?: string; conclusion?: string | null; updated_at?: string };
        check_run?: { head_sha?: string; conclusion?: string | null; completed_at?: string };
        repository?: { full_name?: string };
      };
      const run = githubEvent === "workflow_run" ? payload.workflow_run : payload.check_run;
      const conclusion = ciConclusionFromGitHub(run?.conclusion);
      const repository = payload.repository?.full_name;
      if (payload.action === "completed" && run?.head_sha && repository && conclusion) {
        await recordFirstPassCiResult({
          repository,
          headSha: run.head_sha,
          conclusion,
          completedAt:
            githubEvent === "workflow_run"
              ? payload.workflow_run?.updated_at
              : payload.check_run?.completed_at,
        });
      }
    }

    if (githubEvent === "installation_repositories") {
      await handleInstallationEvent(body);
    }

    if (githubEvent === "pull_request") {
      await handlePullRequestEvent(body as GitHubPullRequestPayload);
    }

    if (githubEvent === "pull_request_review") {
      await handlePullRequestReviewEvent(
        body as GitHubPullRequestReviewPayload
      );
    }
  } catch (error: any) {
    await serverLogger.error(error, { context: "[GitHub Webhook] Error processing webhook" });
    return NextResponse.json(error.message, { status: error.code });
  }

  return NextResponse.json("success");
}
