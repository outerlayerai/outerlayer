import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { serverLogger } from "@/lib/observability/server-logger";
import { earliest } from "@/lib/system/pr-tracking/review-milestones";
import { PULL_REQUEST_TABLE } from "@/lib/system/pr-tracking/constants";
import { parseRevertTarget } from "@/lib/system/pr-tracking/revert-detection";
import { reconcilePullRequest, tenantChQuery } from "@/lib/system/pr-session-reconciler";
import { emitOutcomeScoresForPrs, scoresInsertFn } from "@/lib/system/outcome-scores";
import { repoJoinKey } from "@/lib/system/workers/persist-agent-session";
import { refreshPrSessionComment } from "@/lib/system/pr-session-comment";

/**
 * Actions that (re)materialize a PR's diff/session set and therefore warrant
 * a comment refresh. `opened`/`reopened` is the empty-state trigger — this
 * is what puts a "No agent sessions linked yet" comment on every PR of
 * a connected repo from the moment it opens, so a *missing* comment reliably
 * means "app not connected". `synchronize` (a new push) is what keeps it
 * current as sessions link in. Everything else (labeled, review activity,
 * `closed`, ...) leaves the comment untouched — no new session-linking
 * information arrives on those actions.
 */
const COMMENT_REFRESH_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

/**
 * Minimal shape of a GitHub `pull_request` webhook payload (only the fields we
 * use). The GitHub App must be subscribed to `pull_request` events.
 */
export interface GitHubPullRequestPayload {
  action: string; // opened | synchronize | reopened | closed | ready_for_review | ...
  pull_request?: {
    number: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    merged?: boolean;
    draft?: boolean;
    created_at?: string | null;
    updated_at?: string | null;
    closed_at?: string | null;
    merged_at?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string; sha?: string };
    // Diff size — present on every pull_request event payload.
    additions?: number;
    deletions?: number;
    changed_files?: number;
  };
  repository?: { full_name?: string };
  installation?: { id: number };
}

type PrState = "open" | "closed" | "merged";

/**
 * Persist a pull request's lifecycle into `pull_request`. EVERY PR on a
 * connected repo is tracked — the agent-fleet PR metrics (merge rate,
 * cycle time) undercount otherwise. Runs via service_role (system path, no
 * user session).
 */
export async function handlePullRequestEvent(
  payload: GitHubPullRequestPayload
): Promise<void> {
  const pr = payload.pull_request;
  const repository = payload.repository?.full_name;
  if (!pr || !repository) return;

  const headBranch = pr.head?.ref ?? "";
  const baseBranch = pr.base?.ref ?? "";
  const supabase = createSupabaseAdminClient();

  const { data: connections } = await supabase
    .from("git_connection")
    .select("app_id, tenant_id")
    .eq("repository", repository);
  if (!connections?.length) return;

  // Fate comes from PAYLOAD TRUTH, never the action name: events that arrive
  // AFTER a PR is decided (labeled, edited, review activity) still carry
  // merged/closed_at/merged_at, and deriving from `action === "closed"`
  // would regress a decided row back to open and CLEAR its fate stamps.
  // A `reopened` payload carries closed_at = null, so reopen still clears.
  const isClosed = payload.action === "closed" || pr.closed_at != null;
  const state: PrState =
    pr.merged || pr.merged_at != null ? "merged" : isClosed ? "closed" : "open";
  const headSha = pr.head?.sha ?? null;
  const now = new Date().toISOString();

  // Diff size (batch-size guardrail). Written only when the payload carries
  // real numbers — an absent field must leave any previously stored size
  // intact on conflict, and never write 0 for "unknown".
  const diffStats = {
    ...(typeof pr.additions === "number" ? { additions: pr.additions } : {}),
    ...(typeof pr.deletions === "number" ? { deletions: pr.deletions } : {}),
    ...(typeof pr.changed_files === "number"
      ? { changed_files: pr.changed_files }
      : {}),
  };

  // Lifecycle timestamps come from the PAYLOAD (event truth), not webhook
  // delivery time; `now` is the fallback, never the primary. opened_at is
  // written on every event (created_at is immutable, and a PR first seen via
  // `synchronize` would otherwise keep a NULL forever); closed_at/merged_at
  // are written unconditionally so a reopen CLEARS them.
  const openedAt =
    pr.created_at ?? (payload.action === "opened" ? now : null);
  const closedAt = isClosed ? (pr.closed_at ?? now) : null;
  const mergedAt = state === "merged" ? (pr.merged_at ?? now) : null;

  // Draft-aware pickup baseline (decomposed cycle time): non-draft PRs
  // are ready at open; drafts become ready on the `ready_for_review`
  // transition (monotone first-occurrence — a draft→ready→draft→ready cycle
  // keeps the FIRST ready time, resolved per-app inside the loop). Every
  // other action leaves the column untouched (key omitted from the upsert),
  // so an exact stamp is never overwritten. `pr.draft === false` (not
  // "not true"): a payload missing the flag stamps nothing, and readers
  // COALESCE(ready_for_review_at, opened_at).
  const openedReady =
    payload.action === "opened" && pr.draft === false
      ? (pr.created_at ?? now)
      : undefined;
  const isReadyTransition = payload.action === "ready_for_review";
  // A close→reopen bumps reopen_count (reopen rate). Like the
  // ready transition it needs the app's current value, so it's a read-then-
  // increment inside the loop; every other action omits the column, leaving
  // it untouched on conflict (and defaulting 0 on a first insert).
  const isReopen = payload.action === "reopened";

  // A merged PR whose body references an earlier PR ("Reverts owner/repo#N")
  // marks THAT target as reverted (durability signal — the target's work did
  // not stick). Only merged reverts count: an unmerged revert never undid
  // anything. Resolved once (repo-wide), applied per connected app below.
  const revertTarget =
    state === "merged" ? parseRevertTarget(pr.body) : null;

  for (const { app_id, tenant_id } of connections) {
    // ready_for_review transitions resolve first-occurrence against the
    // app's existing row (rare action → one extra read only then).
    let readyForReviewAt = openedReady;
    if (isReadyTransition) {
      const { data: existingRow } = await supabase
        .from(PULL_REQUEST_TABLE)
        .select("ready_for_review_at")
        .eq("app_id", app_id)
        .eq("pr_number", pr.number)
        .maybeSingle();
      readyForReviewAt = earliest(
        existingRow?.ready_for_review_at,
        pr.updated_at ?? now
      );
    }

    let reopenCount: number | undefined;
    if (isReopen) {
      const { data: existingRow } = await supabase
        .from(PULL_REQUEST_TABLE)
        .select("reopen_count")
        .eq("app_id", app_id)
        .eq("pr_number", pr.number)
        .maybeSingle();
      reopenCount = (existingRow?.reopen_count ?? 0) + 1;
    }

    const { error } = await supabase.from(PULL_REQUEST_TABLE).upsert(
      {
        app_id,
        tenant_id,
        provider: "github",
        pr_number: pr.number,
        head_branch: headBranch,
        head_sha: headSha,
        base_branch: baseBranch,
        state,
        url: pr.html_url ?? null,
        ...(openedAt ? { opened_at: openedAt } : {}),
        ...(readyForReviewAt !== undefined
          ? { ready_for_review_at: readyForReviewAt }
          : {}),
        ...(reopenCount !== undefined ? { reopen_count: reopenCount } : {}),
        ...diffStats,
        closed_at: closedAt,
        merged_at: mergedAt,
      },
      { onConflict: "app_id,pr_number" }
    );
    if (error) {
      await serverLogger.error(error, {
        context: "[GitHub Webhook] pull_request upsert failed",
        app_id,
        pr_number: pr.number,
      });
    } else {
      // Link agent sessions to this PR (two-sided reconciliation — the
      // session-side sweep covers late syncs). Best-effort: a reconcile
      // failure must never fail the webhook, and a deployment without
      // ClickHouse configured skips silently.
      try {
        const chQuery = tenantChQuery({ tenantId: tenant_id, appId: app_id });
        const repo = repoJoinKey(repository, "github");
        if (chQuery && repo) {
          await reconcilePullRequest(supabase, chQuery, {
            tenantId: tenant_id,
            appId: app_id,
            prNumber: pr.number,
            headBranch,
            repo,
            openedAt,
            decidedAt: mergedAt ?? closedAt,
          });
        }
      } catch (reconcileError) {
        await serverLogger.error(reconcileError as Error, {
          context: "[GitHub Webhook] pr-session reconcile failed",
          app_id,
          pr_number: pr.number,
        });
      }

      // Refresh the PR session comment — AFTER reconciliation, so the
      // rendered body reflects the links reconciliation just materialized
      // (an empty result still renders the "No agent sessions linked yet"
      // empty state; see COMMENT_REFRESH_ACTIONS above). `refreshPrSessionComment`
      // is documented to never throw, but the call is still wrapped
      // defensively: a `pull_request` webhook must not 500 because a comment
      // failed, including on an unanticipated rejection this function didn't
      // itself anticipate.
      if (COMMENT_REFRESH_ACTIONS.has(payload.action)) {
        try {
          await refreshPrSessionComment({
            tenantId: tenant_id,
            repository,
            prNumber: pr.number,
          });
        } catch (commentError) {
          await serverLogger.error(commentError as Error, {
            context: "[GitHub Webhook] pr-session comment refresh failed",
            app_id,
            pr_number: pr.number,
          });
        }
      }
    }

    // Flag the reverted target (a DIFFERENT row than the revert PR just
    // upserted). Update-only: if the target PR isn't tracked, this touches 0
    // rows and is a no-op — we never fabricate a row for an untracked target.
    if (revertTarget) {
      const revertedAt = mergedAt ?? now;
      const { error: revertError } = await supabase
        .from(PULL_REQUEST_TABLE)
        .update({ reverted_at: revertedAt })
        .eq("app_id", app_id)
        .eq("pr_number", revertTarget.prNumber);
      if (revertError) {
        await serverLogger.error(revertError, {
          context: "[GitHub Webhook] pull_request revert flag failed",
          app_id,
          pr_number: revertTarget.prNumber,
        });
      }
    }

    // Materialize outcome scores for this PR's confirmed sessions — and the
    // revert target's, whose durability signal just flipped. Runs AFTER the
    // upsert, reconcile, and revert flag so the converge reads settled state.
    // Best-effort: scores are telemetry; a failure (or a deployment without
    // ClickHouse) must never fail the webhook. The cron sweep re-converges
    // anything missed here.
    try {
      const insertScores = scoresInsertFn();
      if (insertScores) {
        await emitOutcomeScoresForPrs(supabase, insertScores, {
          appId: app_id,
          prNumbers: [
            pr.number,
            ...(revertTarget ? [revertTarget.prNumber] : []),
          ],
        });
      }
    } catch (emitError) {
      await serverLogger.error(emitError as Error, {
        context: "[GitHub Webhook] outcome-score emission failed",
        app_id,
        pr_number: pr.number,
      });
    }
  }
}
