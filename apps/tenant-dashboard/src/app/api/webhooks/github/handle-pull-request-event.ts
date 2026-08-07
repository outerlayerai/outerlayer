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
 * `pull_request` webhook actions that warrant a comment refresh.
 *
 * What this path contributes, given sessions arrive on their own path (the
 * sync-ingest queue): it is the PR-SIDE trigger. Sessions can't tell us a PR
 * exists before it is opened, so `opened`/`reopened` is what puts the "No
 * agent sessions linked yet" comment on a connected repo's PR from the
 * moment it opens — which is what makes a *missing* comment legible as "app
 * not connected" rather than "no sessions yet". It is also the only trigger
 * that fires on PR-side state the sessions never mention: a push
 * (`synchronize`) reconciles branch-inferred links, and `ready_for_review`
 * is when a draft — where a lot of agent work sits — first gets read by a
 * human.
 *
 * `closed` is included so the comment keeps updating after merge, per issue
 * #10's recommendation ("yes, update indefinitely"). That also makes the two
 * paths AGREE: the cron sweep already refreshes merged PRs whose links move
 * late, so excluding `closed` here made post-merge behavior "sometimes
 * frozen" depending on which trigger fired. A session that syncs an hour
 * after merge still belongs on the record of how that PR got built.
 *
 * Everything else (labeled, review activity, assignment, ...) leaves the
 * comment untouched — no new session-linking information arrives on those.
 */
const COMMENT_REFRESH_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "closed",
]);

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

  // Tenants whose comment for this (repository, PR) needs refreshing once
  // the per-connection work below is done. A Set because the refresh is
  // keyed by (tenant, repository, prNumber) — several connected apps in one
  // tenant produce ONE refresh, not one each.
  const commentRefreshTenantIds = new Set<string>();

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

      // The comment refresh is NOT done here, per connection — it is keyed
      // by (tenant, repository, prNumber), which carries no app_id, so two
      // apps in one tenant sharing a repo would call it twice with
      // identical arguments: a second full re-read and re-render just to
      // reach the body-hash short-circuit, and worse, two concurrent-ish
      // create attempts on a fresh PR. Collected here, refreshed once per
      // distinct tenant after the loop.
      if (COMMENT_REFRESH_ACTIONS.has(payload.action)) {
        commentRefreshTenantIds.add(tenant_id);
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

  // Refresh the PR session comment — ONCE per distinct tenant, and AFTER
  // every connection's reconciliation, so the rendered body reflects all the
  // links this event just materialized (an empty result still renders the
  // "No agent sessions linked yet" empty state; see COMMENT_REFRESH_ACTIONS
  // above). Sequential, not Promise.all: concurrent refreshes for one repo
  // are what the create-claim in `refreshPrSessionComment` exists to
  // survive, and there is no reason to manufacture more of them here.
  // `refreshPrSessionComment` is documented to never throw, but each call is
  // still wrapped defensively: a `pull_request` webhook must not 500 because
  // a comment failed.
  for (const tenantId of commentRefreshTenantIds) {
    try {
      await refreshPrSessionComment({
        tenantId,
        repository,
        prNumber: pr.number,
      });
    } catch (commentError) {
      await serverLogger.error(commentError as Error, {
        context: "[GitHub Webhook] pr-session comment refresh failed",
        tenant_id: tenantId,
        pr_number: pr.number,
      });
    }
  }
}
