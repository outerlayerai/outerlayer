import "server-only";

/**
 * Git Provider Abstraction - Interface Contract
 *
 * This file defines the common interface that Git providers must implement to
 * work with the platform.
 */

import type {
  GitProviderType,
  FileContent,
  FileEntry,
  FileChange,
  FileDiff,
  Commit,
  CommitAuthor,
  CommitWithFallbackResult,
  CommitFallbackOptions,
  WebhookRegistration,
  CommitHistoryOptions,
  CommitHistoryResult,
  ListPullRequestsOptions,
  PullRequestSummary,
  PullRequestReviewSummary,
} from './types';

// =============================================================================
// Git Provider Interface
// =============================================================================

/**
 * Common interface for all Git provider implementations.
 *
 * Each provider implements this interface to provide a consistent API for
 * repository operations, webhooks, and authentication.
 */
export interface GitProvider {
  /**
   * The provider type identifier.
   */
  readonly type: GitProviderType;

  // ---------------------------------------------------------------------------
  // Repository & Branch Discovery
  // ---------------------------------------------------------------------------

  /**
   * List repositories accessible to the authenticated user.
   *
   * @returns Array of repository info with full name and default branch
   */
  listRepositories(): Promise<{ fullName: string; name: string; defaultBranch: string }[]>;

  /**
   * List branches for a repository.
   *
   * @param repo - Repository in format "owner/repo"
   * @returns Array of branch names
   */
  listBranches(repo: string): Promise<string[]>;

  /**
   * Get the latest commit SHA for a branch.
   *
   * @param repo - Repository in format "owner/repo"
   * @param branch - Branch name
   * @returns Commit SHA or null if branch not found
   */
  getLatestCommitSha(repo: string, branch: string): Promise<string | null>;

  /**
   * List every blob in the repository tree at a ref, in one bulk call —
   * GitHub's recursive Git Trees API. Used by the context mirror's full
   * resync to discover every `.outerlayer/` path before fetching content,
   * and by `ensureSnapshotAt` to materialize a snapshot for an arbitrary ref.
   *
   * `size` is the provider's reported blob size in bytes (GitHub's Trees API
   * returns it inline); callers still treat the fetched content's actual byte
   * length (from {@link getFileContent}) as authoritative for the oversize
   * guard — `size` here is a best-effort hint, not the enforcement point.
   *
   * @param repo - Repository in format "owner/repo"
   * @param ref - Branch, tag, or commit SHA
   * @returns Array of every blob (file) in the tree — directories are not
   *   included
   * @throws Error if the tree exceeds the provider's safety cap (truncated
   *   GitHub response)
   */
  listTree(repo: string, ref: string): Promise<Array<{ path: string; sha: string; size: number }>>;

  // ---------------------------------------------------------------------------
  // File Operations
  // ---------------------------------------------------------------------------

  /**
   * Get the content of a file from the repository.
   *
   * @param repo - Repository in format "owner/repo"
   * @param path - File path within the repository
   * @param ref - Branch, tag, or commit SHA
   * @returns File content and metadata
   * @throws RepositoryNotFoundError if repo doesn't exist
   * @throws AuthenticationError if access is denied
   */
  getFileContent(repo: string, path: string, ref: string): Promise<FileContent>;

  /**
   * Get raw file content as a readable stream (for large files).
   *
   * @param repo - Repository in format "owner/repo"
   * @param path - File path within the repository
   * @param ref - Branch, tag, or commit SHA
   * @returns Readable stream of file content
   */
  getFileRaw(repo: string, path: string, ref: string): Promise<ReadableStream<Uint8Array>>;

  /**
   * List files and directories at a given path.
   *
   * @param repo - Repository in format "owner/repo"
   * @param path - Directory path (empty string for root)
   * @param ref - Branch, tag, or commit SHA
   * @returns Array of file/directory entries
   */
  listDirectory(repo: string, path: string, ref: string): Promise<FileEntry[]>;

  /**
   * Create a commit with file changes.
   *
   * @param repo - Repository in format "owner/repo"
   * @param changes - Array of file changes to commit
   * @param message - Commit message
   * @param branch - Target branch name
   * @param committer - Committer name and email
   * @returns Created commit information
   */
  createCommit(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: CommitAuthor
  ): Promise<Commit>;

  /**
   * Create a commit with branch-protection fallback.
   *
   * All `changes` land in exactly ONE commit — atomic, no partial success.
   * Behavior:
   *
   * 1. Attempt a direct push to `branch`. On a non-fast-forward rejection
   *    (a concurrent commit landed first) retry up to 3 times.
   * 2. If `branch` is protected and rejects the direct push, place the commit
   *    on a separate branch and open a pull request back to `branch`. The
   *    result reports `landed: 'pull_request'` with the PR URL.
   *
   * When `options.forcePullRequest` is set, step 1 is skipped: the commit is
   * always placed on a separate branch and opened as a PR (the per-app
   * `require_pull_request` publish policy). `options` also customizes the head
   * branch name, PR title, and PR body.
   *
   * Head-branch reuse (a stable `options.headBranchName`): if an open PR
   * already targets the head branch, the commit is built on that branch's
   * current tip and the ref is fast-forwarded — the change accumulates onto the
   * existing PR (`pullRequestAction: 'updated'`). Otherwise the head branch is
   * (re)created from a base-tip commit and a fresh PR is opened
   * (`pullRequestAction: 'created'`); a stale ref left by a merged/closed PR is
   * reset so the new PR isn't polluted. `fallbackReason` records whether the PR
   * path was forced by policy or triggered by branch protection.
   *
   * @param repo - Repository in format "owner/repo"
   * @param changes - File changes — all committed together, atomically
   * @param message - Commit message
   * @param branch - Target branch (the app's connected branch)
   * @param committer - Committer name and email
   * @param options - PR behavior overrides (force PR, branch name, PR body)
   * @returns Where the commit landed (direct branch vs PR)
   */
  createCommitWithFallback(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: CommitAuthor,
    options?: CommitFallbackOptions
  ): Promise<CommitWithFallbackResult>;

  /**
   * Compare two commits and get the file differences.
   *
   * @param repo - Repository in format "owner/repo"
   * @param base - Base commit SHA
   * @param head - Head commit SHA
   * @returns Array of file differences
   */
  compareCommits(repo: string, base: string, head: string): Promise<FileDiff[]>;

  /**
   * Get commit history for a repository, optionally filtered by file path.
   *
   * @param repo - Repository in format "owner/repo"
   * @param options - Query options including branch, path, and pagination
   * @returns Paginated commit history with rename tracking support
   *
   * @example
   * ```typescript
   * // Get all commits on main branch
   * const result = await provider.getCommitHistory('owner/repo', {
   *   branch: 'main',
   *   perPage: 20,
   * });
   *
   * // Get commits for a specific file
   * const fileHistory = await provider.getCommitHistory('owner/repo', {
   *   branch: 'main',
   *   path: 'src/components/Button.tsx',
   * });
   *
   * // Continue after a rename
   * if (result.nextPath) {
   *   const continued = await provider.getCommitHistory('owner/repo', {
   *     branch: 'main',
   *     continuePath: result.nextPath,
   *     continueSha: result.nextSha,
   *   });
   * }
   * ```
   */
  getCommitHistory(repo: string, options: CommitHistoryOptions): Promise<CommitHistoryResult>;

  /**
   * List the repository's pull/merge requests across ALL states, newest-first
   * by creation date, up to `options.limit`.
   *
   * Exists for the PR-history backfill: webhook-driven tracking only
   * sees events from connect time forward, so the fleet PR metrics (merge
   * rate, cycle time) would otherwise start empty on every newly connected
   * repo.
   *
   * @param repo - Repository in format "owner/repo"
   * @param options - Result cap
   * @returns Provider-neutral lifecycle summaries (see PullRequestSummary)
   */
  listPullRequests(repo: string, options: ListPullRequestsOptions): Promise<PullRequestSummary[]>;

  /**
   * List one PR's submitted reviews, oldest-first — feeds the review-milestone
   * backfill (`first_review_at` / `first_approved_at`).
   *
   * Optional: the backfill treats absence of this method as "preserve
   * whatever the webhooks captured".
   *
   * @param repo - Repository in format "owner/repo"
   * @param prNumber - The PR number
   * @returns Chronological (oldest-first) submitted reviews; pending reviews excluded
   */
  listPullRequestReviews?(repo: string, prNumber: number): Promise<PullRequestReviewSummary[]>;

  // ---------------------------------------------------------------------------
  // Webhook Operations
  // ---------------------------------------------------------------------------

  /**
   * Register a webhook for push events on a repository.
   *
   * @param repo - Repository in format "owner/repo"
   * @param webhookUrl - URL to receive webhook events
   * @returns Webhook registration details
   */
  registerWebhook(repo: string, webhookUrl: string): Promise<WebhookRegistration>;

  /**
   * Remove a previously registered webhook.
   *
   * @param repo - Repository in format "owner/repo"
   * @param webhookId - Provider-specific webhook ID
   */
  removeWebhook(repo: string, webhookId: string): Promise<void>;

  /**
   * Verify the signature of an incoming webhook request.
   *
   * @param payload - Raw request body as string
   * @param signature - Signature from request headers
   * @param secret - Webhook secret used during registration
   * @returns Promise resolving to true if signature is valid
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean>;
}

// =============================================================================
// Provider Factory Types
// =============================================================================

/**
 * Configuration required to create a provider instance.
 */
export interface GitProviderConfig {
  github?: {
    appId: string;
    privateKey: string;
  };
}

