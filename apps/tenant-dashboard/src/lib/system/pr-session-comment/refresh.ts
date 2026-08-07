import "server-only";

import { createHash } from "node:crypto";

import { APP_URL } from "@/config-global";
import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { getGithubApp } from "@/octo-kit";
import { GitHubProvider, type IssueCommentResult } from "@/lib/system/git/github/client";
import { tenantChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";

import { canonicalPrCommentRepo } from "@repo/gateway-core/lib/pr-comment-repo-key";

import { LinksUnreadableError, LINKS_UNREADABLE_REASON, readLinkedSessions } from "./read";
import { readTopicLabels } from "./topics";
import { renderComment, type RenderLinks } from "./render";

/**
 * The orchestrator: the single idempotent entry point all three trigger
 * paths (the `pull_request` webhook, the debounced queue off session sync,
 * and the hourly cron gap-repair sweep) call to bring one PR's session
 * comment up to date.
 *
 * Composes the read layer, the topic-label reader, the pure renderer, and
 * the GitHub issue-comment client into one idempotent write, guarded by the
 * `pr_session_comment` identity row.
 *
 * Repository identity: `params.repository` can arrive in more than one
 * spelling depending on the caller — the webhook and the cron sweep pass
 * `git_connection.repository`'s own `owner/repo` form, while the queue path
 * passes ClickHouse's `agent_session_summary.GitRepo` join key, which is
 * host-qualified (`github.com/owner/repo`). Every downstream read/write in
 * this module (the read layer, the installation lookup, the
 * `pr_session_comment` row, the GitHub client) must key off ONE canonical
 * form, because two spellings mean two identity rows and therefore two
 * comments on one PR. That decision does NOT live here: it lives in the
 * shared `canonicalPrCommentRepo`, which the queue producer, the queue
 * consumer, and this function all call, and which returns null (rather than
 * a plausible-looking guess) for anything that isn't a GitHub.com
 * `owner/repo` — a GHES host, an ssh remote. An unparseable repository
 * fails loudly here instead of quietly creating a duplicate.
 *
 * Algorithm:
 *   1. `readLinkedSessions` → `null` (no enabled app) ⇒ no-op.
 *   2. `readTopicLabels` for the returned trace ids.
 *   3. `renderComment`.
 *   4. Hash the body. Equal to the stored `last_body_hash` AND a comment id
 *      is stored AND that id was confirmed recently ⇒ return WITHOUT
 *      touching GitHub — three trigger paths hit one comment, and
 *      at-least-once queue delivery means duplicates are the normal case.
 *      The two extra conditions are what stop the short-circuit from hiding
 *      a comment that was never posted, or one hand-deleted on GitHub (see
 *      {@link COMMENT_VERIFY_INTERVAL_MS}).
 *   5. Load the `pr_session_comment` row. No `github_comment_id` ⇒ claim the
 *      row, then create (see {@link claimCreate} — the claim, not the
 *      create, is what makes "one comment per PR" true under concurrency).
 *      Has one ⇒ update; a `gone` result (comment hand-deleted) ⇒ create
 *      fresh and overwrite the stored id.
 *   6. Persist `github_comment_id`, the new hash, and `last_posted_at`.
 *   7. `not_permitted` ⇒ log a structured event and return cleanly — every
 *      call returns this until each org admin approves `issues: write`, and
 *      the feature must stay silent.
 *
 * NEVER throws to its caller: a `pull_request` webhook must not 500 because
 * a comment failed. The whole body is wrapped, and every failure mode
 * (including ones this function didn't anticipate) resolves to `{status:
 * "failed", reason}` rather than an exception.
 *
 * Tenancy: `tenantId` MUST come from a verified source — a signed webhook
 * payload's `tenant_id`, or a `TenantContext` resolved from the caller's
 * session — never a request body field taken at face value. Same convention
 * as `read.ts` and `pr-lifecycle-read.ts`.
 */

type RefreshPrSessionCommentResult =
  | { status: "created"; commentId: number }
  | { status: "updated"; commentId: number }
  /** The rendered body is byte-identical to the last posted one — no GitHub
   * call was made. `commentId` is null when nothing has ever been posted
   * (an empty-state comment rendering the same text twice, pre-first-post). */
  | { status: "unchanged"; commentId: number | null }
  /** No app has `pr_comments_enabled` for this repo — `readLinkedSessions`
   * returned `null`. Not an error: most repos never opt in. */
  | { status: "skipped-disabled" }
  /** The GitHub App lacks `issues: write` on this installation. Silent by
   * design — logged as a structured event, never thrown. */
  | { status: "not-permitted" }
  /** Anything else that went wrong (a read/write failure, a missing
   * installation, an unexpected exception) — the caller can log `reason`
   * but must not surface it to the end user as a hard error. */
  | { status: "failed"; reason: string };

export interface RefreshPrSessionCommentParams {
  tenantId: string;
  repository: string;
  prNumber: number;
}

/** The subset of `GitHubProvider` this module calls — a test seam so unit
 * tests never construct a real GitHub App installation Octokit client. The
 * production path resolves a real `GitHubProvider` (see
 * {@link resolveGithubClient}), which satisfies this shape structurally. */
interface PrSessionCommentGithubClient {
  createIssueComment(repo: string, issueNumber: number, body: string): Promise<IssueCommentResult>;
  updateIssueComment(repo: string, commentId: number, body: string): Promise<IssueCommentResult>;
  /** Existence probe for the staleness escape hatch — see
   * {@link COMMENT_VERIFY_INTERVAL_MS}. Optional so a test fake can omit it;
   * when absent, the escape hatch degrades to the plain short-circuit. */
  getIssueComment?(repo: string, commentId: number): Promise<IssueCommentResult>;
}

interface RefreshPrSessionCommentDeps {
  /** Test seam for ClickHouse — see `read.ts` / `topics.ts`. Also used for
   * production when omitted (`tenantChQuery`). Explicitly `null` means "the
   * caller resolved its own client and got nothing" — an unreachable
   * ClickHouse — and is honoured as such rather than re-resolved, matching
   * `readLinkedSessions`' own contract. */
  chQuery?: ChQueryFn | null;
  /** Test seam for the GitHub issue-comment client — see
   * {@link PrSessionCommentGithubClient}. */
  githubClient?: PrSessionCommentGithubClient;
}

type AdminClient = ReturnType<typeof getAdminDataClient>;

/** Bounded scan — same posture as `read.ts`'s `git_connection` reads: a
 * comment refresh, never a full-table walk. */
const MAX_GIT_CONNECTIONS = 1_000;

/**
 * How long a byte-identical body is trusted to mean "the comment is still
 * there" before the hash short-circuit pays for one `getIssueComment` to
 * confirm it.
 *
 * Without this the short-circuit permanently hides a hand-deleted comment:
 * body posted → someone deletes it on GitHub → nothing about the sessions
 * changes → every later refresh renders the identical body, matches
 * `last_body_hash`, and returns `unchanged` without ever calling GitHub. The
 * `gone` recovery path is unreachable in that state, because reaching it
 * requires the body to have CHANGED, and the cron sweep doesn't help either
 * — it only refreshes PRs whose links moved. Six hours bounds how long a
 * deleted comment stays missing while costing at most one extra GET per PR
 * per six hours, which is nothing against GitHub's rate limits.
 */
const COMMENT_VERIFY_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * How long an unfinished create claim is honored before another caller may
 * take it over — see {@link claimCreate}. Comfortably longer than a create
 * round-trip, short enough that a claimant that died mid-post (a crashed
 * worker, a 403) doesn't strand the PR for long.
 */
const CREATE_CLAIM_TTL_MS = 60_000;

/** Hash of the rendered body — this is what makes the at-least-once
 * delivery cheap: an unchanged body never reaches GitHub. Not a security
 * boundary, so a full sha256/hex digest is plenty; matches the hashing style
 * already in this codebase (`outcome-scores/score-rows.ts`). */
function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The tenant's `organization_name` — the `orgName` URL segment the renderer
 * needs but the read layer (`read.ts`) has no org context to supply. Same
 * `tenant` table / `tenant_id` lookup `membership-service.ts` uses for its
 * email templates. Null when the tenant row is somehow missing (should not
 * happen for a verified tenantId) — the caller falls back to the raw id
 * rather than failing the whole refresh over a cosmetic URL segment.
 */
async function resolveOrgName(admin: AdminClient, tenantId: string): Promise<string | null> {
  const { data } = await admin
    .from("tenant")
    .select("organization_name")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return data?.organization_name ?? null;
}

/**
 * An installation id for `(tenantId, repository)` from any
 * `pr_comments_enabled` connection — the same scope `readLinkedSessions`
 * already proved non-empty (it returned non-null), so this is a second,
 * narrower read rather than a new gate. Two apps in one tenant can share a
 * repo (no unique index on `git_connection (tenant_id, repository)`); any
 * one of their installations can post the comment, since a GitHub App
 * installation is scoped to the repository, not the app.
 */
async function resolveInstallationId(
  admin: AdminClient,
  tenantId: string,
  repository: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("git_connection")
    .select("installation_id")
    .eq("tenant_id", tenantId)
    .eq("repository", repository)
    // Same provider gate as the read layer: an installation id only means
    // anything for a GitHub App connection.
    .eq("provider", "github")
    .eq("pr_comments_enabled", true)
    .limit(MAX_GIT_CONNECTIONS);
  if (error) {
    throw new Error(`git_connection installation read failed: ${error.message}`);
  }
  const row = (data ?? []).find((r) => r.installation_id != null);
  return row ? Number(row.installation_id) : null;
}

/** Resolves the real GitHub issue-comment client from an installation id.
 * Never called in unit tests — `deps.githubClient` always short-circuits
 * this in `__tests__/refresh.test.ts`, since a real installation Octokit
 * client requires a network round-trip to mint. */
async function resolveGithubClient(installationId: number): Promise<PrSessionCommentGithubClient> {
  return GitHubProvider.fromContext({ provider: "github", installationId }, getGithubApp());
}

/**
 * Outcome of trying to win the right to POST the first comment for a PR.
 */
type CreateClaim =
  /** This caller owns the create. Nobody else will POST for this PR. */
  | { outcome: "won" }
  /** Another caller already posted — take the update path with this id. */
  | { outcome: "posted"; commentId: number }
  /** Another caller holds a live claim and hasn't finished posting. */
  | { outcome: "in-flight" };

/**
 * Claims the right to create the comment for `(tenant, repository,
 * prNumber)` BEFORE posting it.
 *
 * The webhook, the queue consumer, and the cron sweep all call
 * `refreshPrSessionComment` concurrently — PR-open fires the webhook while
 * the session that opened the PR is syncing, which is exactly the queue
 * path, and the queue's 30 s debounce narrows that window without closing
 * it. Without a claim, two callers both read no `github_comment_id`, both
 * POST, and both upsert: the unique constraint keeps one ROW, but GitHub now
 * carries TWO comments and the loser's id was never stored, so nothing will
 * ever edit or delete it. AC-057-02 says never a second comment.
 *
 * So the insert — not the POST — is the lock. `ignoreDuplicates` makes
 * `uq_pr_session_comment (tenant_id, repository, pr_number)` arbitrate:
 * exactly one caller gets a row back and earns the right to create. A loser
 * re-reads and either takes the update path (the winner already posted) or
 * backs off with `in-flight`, letting the queue retry / the sweep repair.
 *
 * A claim that is never completed (the claimant crashed, or its create
 * returned 403) would otherwise strand the PR forever, so a claim older than
 * {@link CREATE_CLAIM_TTL_MS} can be taken over — with a compare-and-set on
 * `updated_at` so exactly one taker wins that too.
 */
async function claimCreate(
  admin: AdminClient,
  params: RefreshPrSessionCommentParams,
  /** The stored id GitHub just reported `gone`, when this is a re-post of a
   * hand-deleted comment rather than a first post. */
  replacingCommentId: number | null = null,
): Promise<CreateClaim> {
  const { tenantId, repository, prNumber } = params;
  const now = new Date().toISOString();

  if (replacingCommentId === null) {
    const { data: inserted, error: insertError } = await admin
      .from("pr_session_comment")
      .upsert(
        {
          tenant_id: tenantId,
          repository,
          pr_number: prNumber,
          last_body_hash: "",
          updated_at: now,
        },
        { onConflict: "tenant_id,repository,pr_number", ignoreDuplicates: true },
      )
      .select("id");
    if (insertError) {
      throw new Error(`pr_session_comment claim failed: ${insertError.message}`);
    }
    // A returned row means THIS caller's insert is the one that landed.
    if ((inserted ?? []).length > 0) return { outcome: "won" };
  } else {
    // Re-post path: the row already exists, so there is no insert to
    // arbitrate. CLEARING the dead id is the claim instead — a
    // compare-and-set on that exact id, so of two callers who both saw
    // `gone`, exactly one clears it and earns the create; the other falls
    // through to the shared loser path below.
    const { data: cleared, error: clearError } = await admin
      .from("pr_session_comment")
      .update({ github_comment_id: null, last_body_hash: "", updated_at: now })
      .eq("tenant_id", tenantId)
      .eq("repository", repository)
      .eq("pr_number", prNumber)
      .eq("github_comment_id", replacingCommentId)
      .select("id");
    if (clearError) {
      throw new Error(`pr_session_comment claim (re-post) failed: ${clearError.message}`);
    }
    if ((cleared ?? []).length > 0) return { outcome: "won" };
  }

  const { data: row, error: readError } = await admin
    .from("pr_session_comment")
    .select("id, github_comment_id, updated_at")
    .eq("tenant_id", tenantId)
    .eq("repository", repository)
    .eq("pr_number", prNumber)
    .maybeSingle();
  if (readError) {
    throw new Error(`pr_session_comment claim re-read failed: ${readError.message}`);
  }
  // Raced with a delete of the row itself. Back off rather than POST blind.
  if (!row) return { outcome: "in-flight" };
  if (row.github_comment_id) {
    return { outcome: "posted", commentId: Number(row.github_comment_id) };
  }

  const claimedAt = Date.parse(row.updated_at ?? "");
  const abandoned = Number.isFinite(claimedAt) && Date.now() - claimedAt > CREATE_CLAIM_TTL_MS;
  if (!abandoned) return { outcome: "in-flight" };

  // Take over an abandoned claim. The `updated_at` equality is the
  // compare-and-set: if another taker moved it first, this updates 0 rows
  // and we back off instead of double-posting.
  const { data: taken, error: takeError } = await admin
    .from("pr_session_comment")
    .update({ updated_at: now })
    .eq("id", row.id)
    .is("github_comment_id", null)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (takeError) {
    throw new Error(`pr_session_comment claim takeover failed: ${takeError.message}`);
  }
  return (taken ?? []).length > 0 ? { outcome: "won" } : { outcome: "in-flight" };
}

/** Structured, greppable log for a permission gap — every call fails this
 * way until each org admin approves `issues: write` on the installation.
 * Routed through `serverLogger` (not a bare `console.warn`) so it reaches
 * Logtail in production, where it is queryable as
 * `pr_session_comment.not_permitted` — see
 * `docs/pr-session-comment-permission-rollout.md` for how to query it and
 * why this event, not an admin page, is the visibility surface for the
 * rollout. Deliberately `.info`, not `.error`: this is expected steady-state
 * for any installation pending admin approval, not an incident, and must
 * never page anyone or land in Sentry. Never throw or surface it as a hard
 * error. */
async function logNotPermitted(params: RefreshPrSessionCommentParams): Promise<void> {
  await serverLogger.info("[pr-session-comment] refresh blocked: issues:write not permitted", {
    event: "pr_session_comment.not_permitted",
    tenantId: params.tenantId,
    repository: params.repository,
    prNumber: params.prNumber,
    timestamp: new Date().toISOString(),
  });
}

/**
 * The one failure worth alerting on: confirmed links exist for this PR and
 * we cannot read the sessions behind them. Logged as its own event (`.error`
 * — unlike the not-permitted event, this one IS an incident when sustained)
 * so a run of it is visible without having to grep generic `failed` reasons.
 */
async function logLinksUnreadable(
  params: RefreshPrSessionCommentParams,
  error: LinksUnreadableError,
): Promise<void> {
  await serverLogger.error(error, {
    context: "[pr-session-comment] confirmed links exist but are unreadable",
    event: LINKS_UNREADABLE_REASON,
    _metric: true,
    metric_name: LINKS_UNREADABLE_REASON,
    metric_value: 1,
    tenantId: params.tenantId,
    repository: params.repository,
    prNumber: params.prNumber,
    confirmedLinkCount: error.confirmedLinkCount,
  });
}

export async function refreshPrSessionComment(
  params: RefreshPrSessionCommentParams,
  deps: RefreshPrSessionCommentDeps = {},
): Promise<RefreshPrSessionCommentResult> {
  const { tenantId, prNumber } = params;
  // Canonicalize to git_connection's own owner/repo identity through the
  // SHARED helper — see the module doc comment above. Every read/write below
  // uses this, never params.repository directly. Null means the caller named
  // something this feature cannot address (a GHES host, an ssh remote): fail
  // loudly rather than key off a half-parsed string and post a duplicate.
  const repository = canonicalPrCommentRepo(params.repository);
  if (repository === null) {
    return {
      status: "failed",
      reason: `unparseable repository (expected owner/repo): ${params.repository}`,
    };
  }

  try {
    // `'chQuery' in deps` (not `??`), for the reason spelled out on
    // `readLinkedSessions`: a caller that already resolved its own client —
    // even to null — must not have this module resolve a SECOND one behind
    // its back. Only an absent key means "resolve ours".
    const chQuery = ("chQuery" in deps ? deps.chQuery : tenantChQuery({ tenantId })) ?? null;

    const rows = await readLinkedSessions({ tenantId, repository, prNumber }, { chQuery });
    // AC-057-04's "no app connected" no-op — the read layer already proved
    // no app has pr_comments_enabled for this repo. Never post or edit.
    if (rows === null) {
      return { status: "skipped-disabled" };
    }

    const traceIds = rows.map((row) => row.traceId);
    const topics = await readTopicLabels({ chQuery, traceIds });

    const admin = getAdminDataClient();
    const orgName = await resolveOrgName(admin, tenantId);
    // `orgName ?? tenantId` would put a raw tenant UUID in the `/orgs/<...>`
    // segment and every link in the comment would 404 — on a public PR.
    // This "should not happen" for a verified tenantId, which is exactly why
    // it fails loudly instead of degrading: the cron sweep retries, and a
    // missing comment is strictly better than a comment full of dead links.
    if (!orgName) {
      return { status: "failed", reason: `no organization_name for tenant ${tenantId}` };
    }
    const links: RenderLinks = {
      baseUrl: APP_URL,
      orgName,
      prNumber,
    };

    // AC-057-03: rows/topics are re-read from ClickHouse on every call, so
    // the rendered body always reflects present state, never a first-sight
    // snapshot — a session that accrues more work produces a different body
    // (and therefore a different hash) on the very next refresh.
    const body = renderComment(rows, topics, links);
    const bodyHash = hashBody(body);

    const { data: existing, error: readError } = await admin
      .from("pr_session_comment")
      .select("github_comment_id, last_body_hash, last_posted_at")
      .eq("tenant_id", tenantId)
      .eq("repository", repository)
      .eq("pr_number", prNumber)
      .maybeSingle();
    if (readError) {
      return { status: "failed", reason: `pr_session_comment read failed: ${readError.message}` };
    }

    // Three trigger paths hit one comment and queue delivery is
    // at-least-once, so duplicates are the normal case. An unchanged body
    // MUST NOT reach GitHub — this is the entire rate-limit defense.
    //
    // Two conditions beyond the hash, both load-bearing:
    //   - a stored id must EXIST. A row with a matching hash and no
    //     `github_comment_id` is a claim (or a create that failed); short-
    //     circuiting there would mean the comment is never posted at all.
    //   - the id must have been confirmed recently. Otherwise a comment
    //     hand-deleted on GitHub is hidden forever: the body never changes,
    //     so the hash always matches and GitHub is never called again. Past
    //     the interval we spend one `getIssueComment` to check
    //     (see COMMENT_VERIFY_INTERVAL_MS).
    const bodyUnchanged = existing?.last_body_hash === bodyHash;
    const lastPostedAt = Date.parse(existing?.last_posted_at ?? "");
    const verifiedRecently =
      Number.isFinite(lastPostedAt) && Date.now() - lastPostedAt < COMMENT_VERIFY_INTERVAL_MS;
    if (bodyUnchanged && existing?.github_comment_id && verifiedRecently) {
      return { status: "unchanged", commentId: existing.github_comment_id };
    }
    // Nothing has ever been posted and the body still renders identically
    // (the empty state, refreshed twice before its first post): there is no
    // comment to check and nothing new to say, but a create still has to
    // happen — fall through.

    let githubClient: PrSessionCommentGithubClient;
    if (deps.githubClient) {
      // Test seam — bypasses the installation lookup entirely, since the
      // fake client needs no real GitHub App installation id.
      githubClient = deps.githubClient;
    } else {
      const installationId = await resolveInstallationId(admin, tenantId, repository);
      if (installationId === null) {
        return { status: "failed", reason: "no installation id for this repository" };
      }
      githubClient = await resolveGithubClient(installationId);
    }

    let commentId = existing?.github_comment_id ?? null;
    // The stored id GitHub has told us no longer exists, kept so the claim
    // below can compare-and-set on it rather than blindly clearing.
    let goneCommentId: number | null = null;

    // Staleness escape hatch (see COMMENT_VERIFY_INTERVAL_MS): the body is
    // unchanged and an id is stored, but it's been long enough that we no
    // longer trust the id to still exist. Ask GitHub instead of assuming.
    if (bodyUnchanged && commentId !== null && githubClient.getIssueComment) {
      const probe = await githubClient.getIssueComment(repository, commentId);
      if (probe.status === "not_permitted") {
        await logNotPermitted({ tenantId, repository, prNumber });
        return { status: "not-permitted" };
      }
      if (probe.status === "ok") {
        // Still there. Re-stamp so the next refresh short-circuits for
        // free rather than probing again immediately.
        await admin
          .from("pr_session_comment")
          .update({ last_posted_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("repository", repository)
          .eq("pr_number", prNumber);
        return { status: "unchanged", commentId };
      }
      // `gone` — it was hand-deleted. Skip the pointless update (there is
      // nothing to edit) and go straight to re-posting.
      goneCommentId = commentId;
      commentId = null;
    }

    let result: IssueCommentResult | null = null;
    let created = false;

    if (commentId !== null) {
      result = await githubClient.updateIssueComment(repository, commentId, body);
      // The comment was hand-deleted on GitHub (or the stored id is stale)
      // — post fresh below rather than erroring or leaving the PR without a
      // comment. The re-post goes through the same claim as a first post.
      if (result.status === "gone") {
        goneCommentId = commentId;
        commentId = null;
        result = null;
      }
    }

    if (result === null) {
      // AC-057-02, one comment per PR: the RIGHT to create is claimed
      // before the POST, never inferred from a null id read moments earlier
      // — see claimCreate for the race this closes.
      const claim = await claimCreate(admin, { tenantId, repository, prNumber }, goneCommentId);
      if (claim.outcome === "in-flight") {
        // Another trigger is mid-create for this PR. Backing off is the
        // point: whichever caller holds the claim will post exactly one
        // comment, and this call's retry (queue) or the sweep picks up any
        // content this render would have added.
        return { status: "failed", reason: "concurrent create in flight for this PR" };
      }
      if (claim.outcome === "posted") {
        // Someone posted while we were rendering. Edit theirs — this is
        // exactly what the claim buys: the second caller updates.
        commentId = claim.commentId;
        result = await githubClient.updateIssueComment(repository, commentId, body);
        if (result.status === "gone") {
          return { status: "failed", reason: "comment deleted between claim and update" };
        }
      } else {
        result = await githubClient.createIssueComment(repository, prNumber, body);
        created = true;
      }
    }

    if (result.status === "not_permitted") {
      await logNotPermitted({ tenantId, repository, prNumber });
      return { status: "not-permitted" };
    }
    if (result.status === "gone") {
      // Defensive only: `createIssueComment`'s declared return type is the
      // full `IssueCommentResult` union, but it never actually answers
      // "gone" — a fresh POST has no prior comment id to 404 against. Not
      // an assertion-worthy state, just another way this call can fail.
      return { status: "failed", reason: "unexpected 'gone' result from createIssueComment" };
    }

    const { error: upsertError } = await admin.from("pr_session_comment").upsert(
      {
        tenant_id: tenantId,
        repository,
        pr_number: prNumber,
        github_comment_id: result.id,
        last_body_hash: bodyHash,
        last_posted_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,repository,pr_number" },
    );
    if (upsertError) {
      return { status: "failed", reason: `pr_session_comment upsert failed: ${upsertError.message}` };
    }

    return created ? { status: "created", commentId: result.id } : { status: "updated", commentId: result.id };
  } catch (error) {
    // One failure mode is separated out of the catch-all: confirmed links
    // that cannot be read. Everything else here is ordinary transient noise;
    // a sustained run of THAT is an incident, because it is the only state
    // in which the empty state could overwrite a populated comment. Its
    // reason string carries a stable, alertable prefix (the error's own
    // message), and it gets its own log event.
    if (error instanceof LinksUnreadableError) {
      await logLinksUnreadable({ tenantId, repository, prNumber }, error);
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
