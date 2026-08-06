import "server-only";

import { createHash } from "node:crypto";

import { APP_URL } from "@/config-global";
import { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";
import { getGithubApp } from "@/octo-kit";
import { GitHubProvider, type IssueCommentResult } from "@/lib/system/git/github/client";
import { tenantChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";

import { readLinkedSessions } from "./read";
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
 * Repository identity: `params.repository` arrives in TWO different formats
 * depending on the caller — the webhook and the cron sweep pass
 * `git_connection.repository`'s own `owner/repo` form, while the queue path
 * passes ClickHouse's `agent_session_summary.GitRepo` join key, which is
 * host-qualified (`github.com/owner/repo`). Every downstream read/write in
 * this module (the read layer, the installation lookup, the
 * `pr_session_comment` row, the GitHub client) must key off ONE canonical
 * form — `git_connection.repository`'s `owner/repo` — so the first step
 * below strips a leading `github.com/` before anything else runs. This
 * feature is GitHub-only today, so a single fixed prefix is sufficient.
 *
 * Algorithm:
 *   1. `readLinkedSessions` → `null` (no enabled app) ⇒ no-op.
 *   2. `readTopicLabels` for the returned trace ids.
 *   3. `renderComment`.
 *   4. Hash the body. Equal to the stored `last_body_hash` ⇒ return WITHOUT
 *      touching GitHub — three trigger paths hit one comment, and
 *      at-least-once queue delivery means duplicates are the normal case.
 *   5. Load the `pr_session_comment` row. No `github_comment_id` ⇒ create.
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

export type RefreshPrSessionCommentResult =
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
export interface PrSessionCommentGithubClient {
  createIssueComment(repo: string, issueNumber: number, body: string): Promise<IssueCommentResult>;
  updateIssueComment(repo: string, commentId: number, body: string): Promise<IssueCommentResult>;
}

export interface RefreshPrSessionCommentDeps {
  /** Test seam for ClickHouse — see `read.ts` / `topics.ts`. Also used for
   * production when omitted (`tenantChQuery`). */
  chQuery?: ChQueryFn;
  /** Test seam for the GitHub issue-comment client — see
   * {@link PrSessionCommentGithubClient}. */
  githubClient?: PrSessionCommentGithubClient;
}

type AdminClient = ReturnType<typeof getAdminDataClient>;

/** Bounded scan — same posture as `read.ts`'s `git_connection` reads: a
 * comment refresh, never a full-table walk. */
const MAX_GIT_CONNECTIONS = 1_000;

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

export async function refreshPrSessionComment(
  params: RefreshPrSessionCommentParams,
  deps: RefreshPrSessionCommentDeps = {},
): Promise<RefreshPrSessionCommentResult> {
  const { tenantId, prNumber } = params;
  // Canonicalize to git_connection's own owner/repo identity — see the
  // module doc comment above. Every read/write below uses this, never
  // params.repository directly.
  const repository = params.repository.replace(/^github\.com\//, "");

  try {
    const chQuery = deps.chQuery ?? tenantChQuery({ tenantId });

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
    const links: RenderLinks = {
      baseUrl: APP_URL,
      orgName: orgName ?? tenantId,
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
      .select("github_comment_id, last_body_hash")
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
    if (existing && existing.last_body_hash === bodyHash) {
      return { status: "unchanged", commentId: existing.github_comment_id };
    }

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

    let result: IssueCommentResult;
    let created = !existing?.github_comment_id;
    if (existing?.github_comment_id) {
      result = await githubClient.updateIssueComment(repository, existing.github_comment_id, body);
      // The comment was hand-deleted on GitHub (or the stored id is stale)
      // — post fresh and overwrite the stored id below, rather than
      // erroring or leaving the PR without a comment.
      if (result.status === "gone") {
        result = await githubClient.createIssueComment(repository, prNumber, body);
        created = true;
      }
    } else {
      // AC-057-02: no existing github_comment_id ⇒ this is the first post
      // for (tenant, repository, prNumber) — one comment per PR, enforced
      // by the unique constraint this upsert targets below.
      result = await githubClient.createIssueComment(repository, prNumber, body);
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
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
