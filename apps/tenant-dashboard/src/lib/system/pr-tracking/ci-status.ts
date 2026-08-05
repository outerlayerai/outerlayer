import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { PULL_REQUEST_TABLE } from "./constants";

/**
 * GitHub run/check conclusions → the first-pass CI vocabulary. Only
 * outcomes that SAY something about the code count: cancelled, skipped,
 * neutral, action_required and stale are dropped (recording them as either
 * verdict would poison the first-pass failure rate). Shared by the webhook
 * dispatch and the API backfill's worst-of reduction.
 */
export function ciConclusionFromGitHub(
  conclusion: string | null | undefined
): "success" | "failure" | null {
  if (conclusion === "success") return "success";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
    return "failure";
  }
  return null;
}

/**
 * A completed CI verdict for one commit, already reduced by the provider
 * webhook adapter: `success` / `failure` only. Neutral outcomes (cancelled,
 * skipped, action_required, …) must be dropped BEFORE this service — they say
 * nothing about whether the code passed, and recording them would poison the
 * first-pass verdict.
 */
interface CiCompletionInput {
  /** `owner/repo` — the git_connection key. */
  repository: string;
  /** The commit the run/check/pipeline executed against. */
  headSha: string;
  conclusion: "success" | "failure";
  /** When the conclusion landed (ISO); receipt time is the fallback. */
  completedAt?: string;
  /** PR number when the provider names it directly; otherwise rows are
   * matched by head_sha. */
  prNumber?: number;
}

/**
 * Records the FIRST-PASS CI verdict on `pull_request` rows — "did CI pass on
 * the first try?", the rework signal behind the first-pass-CI-failure-rate
 * comparison (agent vs human).
 *
 * Semantics (mirroring the column comments in 66-pull-request.sql):
 *  - The first completed conclusion LOCKS first_ci_sha to the sha it arrived
 *    on. Later pushes (new shas) never touch the verdict — re-runs after a
 *    fix are exactly what "first-pass failure" exists to count.
 *  - Within that first sha the verdict is failure-sticky: several runs/checks
 *    complete per commit (lint, tests, build), and the fastest green one must
 *    not shadow the failing test suite. success → failure escalates; failure
 *    never un-fails. first_ci_at keeps the FIRST conclusion's time.
 *
 * Both writes are guarded UPDATEs (compare-and-set), so concurrent webhook
 * deliveries converge: the lock only lands where first_ci_sha IS NULL, the
 * escalation only where the locked sha matches and the status is 'success'.
 * Update-only — a sha with no tracked PR touches 0 rows. Best-effort:
 * failures log and never break webhook processing.
 */
export async function recordFirstPassCiResult(input: CiCompletionInput): Promise<void> {
  if (!input.repository || !input.headSha) return;
  const completedAt = input.completedAt ?? new Date().toISOString();

  const supabase = getAdminDataClient();
  const { data: connections } = await supabase
    .from("git_connection")
    .select("app_id")
    .eq("repository", input.repository);
  if (!connections?.length) return;

  for (const { app_id } of connections) {
    // Match by PR number when the event names it directly; otherwise by head
    // sha. Deliberately NO state filter: a fast merge can
    // land before its CI finishes, and that verdict still belongs to the PR —
    // gating on 'open' would silently blank first-pass data for exactly the
    // quickest merges. Post-decision re-runs can't rewrite history: the sha
    // lock is already taken, or the re-run's sha no longer matches the row.
    const matchColumn = input.prNumber != null ? "pr_number" : "head_sha";
    const matchValue = input.prNumber != null ? input.prNumber : input.headSha;

    const { error: lockError } = await supabase
      .from(PULL_REQUEST_TABLE)
      .update({
        first_ci_sha: input.headSha,
        first_ci_status: input.conclusion,
        first_ci_at: completedAt,
      })
      .eq("app_id", app_id)
      .eq(matchColumn, matchValue)
      .is("first_ci_sha", null);
    if (lockError) {
      await serverLogger.error(lockError, {
        context: "[CI Status] first-pass verdict lock failed",
        app_id,
        head_sha: input.headSha,
      });
      continue;
    }

    if (input.conclusion === "failure") {
      const { error: escalateError } = await supabase
        .from(PULL_REQUEST_TABLE)
        .update({ first_ci_status: "failure" })
        .eq("app_id", app_id)
        .eq(matchColumn, matchValue)
        .eq("first_ci_sha", input.headSha)
        .eq("first_ci_status", "success");
      if (escalateError) {
        await serverLogger.error(escalateError, {
          context: "[CI Status] first-pass verdict escalation failed",
          app_id,
          head_sha: input.headSha,
        });
      }
    }
  }
}
