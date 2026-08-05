import "server-only";

/**
 * Git Provider Abstraction - Shared Types
 *
 * Common types used across all Git provider implementations.
 */

// =============================================================================
// Provider Types
// =============================================================================

export type GitProviderType = 'github';

// =============================================================================
// File Operations
// =============================================================================

export interface FileContent {
  path: string;
  content: string; // Decoded content (not base64)
  sha: string; // Content hash for comparison
  size: number;
  encoding: 'utf-8' | 'base64';
}

export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sha?: string;
  size?: number;
}

export interface FileChange {
  path: string;
  content: string;
  operation: 'create' | 'update' | 'delete';
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  previousPath?: string; // For renamed files
  additions: number;
  deletions: number;
  patch?: string; // Unified diff patch (for incremental updates)
  sha: string; // File content hash
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: CommitAuthor;
  timestamp: string; // ISO 8601
  url: string;
}

/**
 * Outcome of a commit that may have fallen back to a pull request because the
 * target branch was protected.
 *
 * - `landed: 'branch'` — the commit was pushed directly to the target branch.
 * - `landed: 'pull_request'` — the target branch rejected the direct push, so
 *   the commit was placed on a separate branch and a PR was opened back to it;
 *   `pullRequestUrl` + `fallbackBranch` are set.
 */
export interface CommitWithFallbackResult {
  landed: 'branch' | 'pull_request';
  commit: Commit;
  /** Set only when `landed === 'pull_request'`. */
  pullRequestUrl?: string;
  /** The PR number, when a PR was opened. */
  pullRequestNumber?: number;
  /** The separate branch the commit was placed on, when a PR was opened. */
  fallbackBranch?: string;
  /**
   * Set only when `landed === 'pull_request'`: whether a new PR was opened
   * (`'created'`) or an already-open PR on the reused head branch was updated
   * with this commit (`'updated'`).
   */
  pullRequestAction?: 'created' | 'updated';
  /**
   * Set only when `landed === 'pull_request'`: why the change went to a PR
   * rather than a direct push — `'forced'` (the caller's `forcePullRequest`
   * policy) or `'protected_branch'` (the direct push was rejected by branch
   * protection).
   */
  fallbackReason?: 'forced' | 'protected_branch';
}

/**
 * Options controlling the pull-request behavior of `createCommitWithFallback`.
 *
 * Without options the method preserves its original contract: direct push,
 * with a PR opened only as a fallback when the branch rejects the push
 * (protected branch). With `forcePullRequest`, the direct push is skipped
 * entirely and the change always lands on a PR — this is the per-app
 * `require_pull_request` publish policy.
 */
export interface CommitFallbackOptions {
  /**
   * Force the PR path even when the target branch would accept a direct push.
   * Used by the per-app publish policy (`app.require_pull_request`).
   */
  forcePullRequest?: boolean;
  /**
   * Prefix for the generated head branch. Defaults to `outerlayer/dataset`.
   * Prompt/template publishes pass `outerlayer/publish` for legibility.
   */
  headBranchPrefix?: string;
  /**
   * Human-legible slug appended to the head branch prefix (sanitized by the
   * provider). e.g. the prompt path. A uniqueness suffix is always added.
   */
  headBranchSlug?: string;
  /**
   * User-provided branch name (preview publishes). Used verbatim — no prefix,
   * no suffix — so it doubles as the preview env name and a re-publish targets
   * the SAME branch (updating the open PR). Takes precedence over slug/prefix.
   */
  headBranchName?: string;
  /**
   * Pull request title for a newly opened PR. Falls back to the commit subject
   * when omitted. A caller reusing one accumulating PR passes a stable,
   * commit-independent title so it doesn't go stale on the first commit subject.
   */
  pullRequestTitle?: string;
  /** Pull request body (markdown). Falls back to a default when omitted. */
  pullRequestBody?: string;
}

// =============================================================================
// Webhook Types
// =============================================================================

export interface WebhookRegistration {
  id: string; // Provider-specific webhook ID
  url: string;
  active: boolean;
  events: string[];
  createdAt: string;
}

export interface NormalizedPushEvent {
  provider: GitProviderType;
  repository: string; // Format: owner/repo
  branch: string; // Branch name without refs/heads/
  commitSha: string;
  /**
   * The branch head BEFORE this push (the payload's `before` sha). Drives
   * context-sync's catch-up sync (see `handlePushEvent`). Explicit `null`
   * forces catch-up (synthetic events with no payload diff).
   */
  beforeSha?: string | null;
  /**
   * The head commit's message from the push payload (`head_commit.message`).
   * Null when the payload carries no head commit (e.g. a branch deletion).
   * Recorded on the `context_sync_event` via `syncOnPush`.
   */
  commitMessage: string | null;
  commits: NormalizedCommit[];
  sender: {
    username: string;
    email?: string;
  };
  timestamp: string;
  // Original payload for provider-specific handling
  raw: unknown;
}

export interface NormalizedCommit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
    username?: string;
  };
  added: string[];
  modified: string[];
  removed: string[];
  timestamp: string;
}

// =============================================================================
// Connection Context
// =============================================================================

/**
 * Connection context for authenticated operations.
 */
export interface GitConnectionContext {
  provider: GitProviderType;
  repository?: string; // Optional: not needed for provider initialization
  installationId?: number; // GitHub App installation id
  appId?: string; // App ID for database operations (webhook management)
  supabase?: unknown; // Supabase client for database operations (typed as unknown to avoid circular deps)
}

// =============================================================================
// Commit History Types
// =============================================================================

/**
 * Options for retrieving commit history.
 */
export interface CommitHistoryOptions {
  /**
   * File path to filter commits.
   * Only commits affecting this path will be returned.
   */
  path?: string;

  /**
   * Branch name to retrieve commits from.
   */
  branch: string;

  /**
   * Page number for pagination.
   * @default 1
   */
  page?: number;

  /**
   * Number of commits per page.
   * @default 10
   * @max 100
   */
  perPage?: number;

  /**
   * Continue from a specific SHA (for rename tracking).
   * Used when following file history across renames.
   */
  continueSha?: string;

  /**
   * Continue with a different path (for rename tracking).
   * Used when following file history across renames.
   */
  continuePath?: string;
}

/**
 * Options for listing a repository's pull/merge requests.
 */
export interface ListPullRequestsOptions {
  /**
   * Maximum number of PRs/MRs to return, newest-first by creation date.
   * @max effectively provider-paginated in pages of ≤100
   */
  limit: number;
}

/**
 * One pull request — the lifecycle fields the `pull_request` table tracks.
 * `number` is the GitHub PR number.
 */
export interface PullRequestSummary {
  number: number;
  /**
   * Provider user id of the PR author (GitHub `user.id`). Used to drop
   * self-reviews when computing review milestones; never persisted (fleet
   * metrics are team-level only).
   */
  authorId: number | null;
  /**
   * Whether the PR is currently a draft (GitHub `draft`). Drives the
   * backfill's ready_for_review_at approximation: non-draft → openedAt,
   * draft → null (still coding).
   */
  draft: boolean;
  headBranch: string;
  headSha: string | null;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  url: string | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
}

/**
 * One submitted review on a pull request, provider-neutral. `state` is
 * normalized lowercase (`approved` | `changes_requested` | `commented` |
 * `dismissed`); a dismissed review still counts as review latency, just not
 * as an approval. Pending (unsubmitted) reviews are filtered out by the
 * provider.
 */
export interface PullRequestReviewSummary {
  /** Review author's provider user id — compared to `PullRequestSummary.authorId` to drop self-reviews. */
  authorId: number | null;
  /**
   * Whether the reviewer is a bot (GitHub `user.type === "Bot"`). Bot
   * reviews are excluded from the review milestones — an instant bot
   * reviewer would zero out pickup time on every PR.
   */
  isBot: boolean;
  state: string;
  submittedAt: string | null;
}

/**
 * Result of a commit history query.
 */
export interface CommitHistoryResult {
  /**
   * Array of commits matching the query.
   */
  commits: CommitWithPath[];

  /**
   * Whether more commits are available.
   */
  hasMore: boolean;

  /**
   * If file was renamed, the path to continue from.
   */
  nextPath?: string;

  /**
   * If file was renamed, the SHA to continue from.
   */
  nextSha?: string;
}

/**
 * Commit with additional file path context.
 * Used to track commits across file renames.
 */
export interface CommitWithPath extends Commit {
  /**
   * The file path at the time of this commit.
   * May differ from current path if file was renamed.
   */
  filePath: string;
}

