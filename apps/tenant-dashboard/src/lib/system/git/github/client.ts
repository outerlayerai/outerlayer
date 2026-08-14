import "server-only";

/**
 * GitHub Provider - Client Adapter
 *
 * Wraps existing Octokit implementation to conform to the GitProvider interface.
 * Uses GitHub App installation authentication via @octokit/app.
 */

import 'server-only';

import type { Octokit } from 'octokit';
import type { App } from 'octokit';
import type { GitProvider } from '../git-provider.interface';
import { ciConclusionFromGitHub } from '../../pr-tracking/ci-status';
import type {
  FileContent,
  FileEntry,
  FileChange,
  FileDiff,
  Commit,
  CommitWithFallbackResult,
  CommitFallbackOptions,
  WebhookRegistration,
  GitConnectionContext,
  CommitHistoryOptions,
  CommitHistoryResult,
  CommitWithPath,
  ListPullRequestsOptions,
  PullRequestSummary,
  PullRequestReviewSummary,
} from '../types';
import { buildFallbackBranchName } from '../branch-naming';
import { mapWithConcurrency } from '../utils';
import {
  AuthenticationError,
  RepositoryNotFoundError,
  FileNotFoundError,
  RateLimitError,
  CommitError,
  ProtectedBranchError,
  NonFastForwardError,
  wrapError,
} from '../errors';

/**
 * Result of creating, updating, or fetching an issue comment (PR comments
 * are issue comments in GitHub's API). A discriminated union rather than a
 * thrown error, mirroring `CommitWithFallbackResult.landed` elsewhere in this
 * file: a permission failure here is expected steady-state, not exceptional
 * — the GitHub App does not yet hold `issues: write` on every installation,
 * and each org admin must separately approve the upgraded permission set.
 * Callers must treat `not_permitted` as a silent no-op, never surface it as
 * an error.
 */
export type IssueCommentResult =
  | { status: 'ok'; id: number; body: string; htmlUrl: string }
  /** The App lacks `issues: write` on this installation (403). Silent no-op. */
  | { status: 'not_permitted' }
  /** The comment no longer exists on GitHub (404 on update/get). The caller
   *  should clear any stored comment id and post a fresh comment. */
  | { status: 'gone' };

/**
 * Result of listing an issue/PR's comments. `not_permitted` mirrors
 * {@link IssueCommentResult}: a 403 is the expected steady state on an
 * installation whose admin has not approved the upgraded permission set, and
 * must degrade silently rather than throw.
 */
export type IssueCommentListResult =
  | { status: 'ok'; comments: { id: number; body: string }[] }
  | { status: 'not_permitted' };

/**
 * Page size and page ceiling for {@link GitHubProvider.listIssueComments}.
 * The only caller looks for one bot comment it posted itself, so this is a
 * bounded scan, never a full thread walk: 100 × 5 covers 500 comments, far
 * past any real PR, and stops rather than paginating a pathological thread.
 */
const ISSUE_COMMENTS_PAGE_SIZE = 100;
const ISSUE_COMMENTS_MAX_PAGES = 5;

/**
 * Result of listing a pull request's commits. `not_permitted` mirrors
 * {@link IssueCommentResult}: a 403 must degrade silently on an installation
 * whose admin has not approved the needed permission. `unavailable` is a 404
 * — the PR isn't addressable from this installation — and likewise means
 * "commits unknown", never an error the caller should surface.
 */
export type PullRequestCommitListResult =
  | { status: 'ok'; commits: { sha: string }[] }
  | { status: 'not_permitted' }
  | { status: 'unavailable' };

/**
 * Same tri-state contract as {@link PullRequestCommitListResult}: a 403/404
 * is "files unknown", never an error the caller should surface. `status` is
 * GitHub's per-file change status (`added`/`modified`/`removed`/…), which is
 * what lets a caller distinguish "adds tests" from "deletes tests".
 */
export type PullRequestFileListResult =
  | { status: 'ok'; files: { filename: string; changeStatus: string }[] }
  | { status: 'not_permitted' }
  | { status: 'unavailable' };

/**
 * Page size and page ceiling for {@link GitHubProvider.listPullRequestCommits}.
 * GitHub's list-PR-commits endpoint returns at most 250 commits regardless
 * of pagination, so 100 × 3 covers everything the API will ever hand back.
 */
const PR_COMMITS_PAGE_SIZE = 100;
const PR_COMMITS_MAX_PAGES = 3;

/**
 * Maximum number of times a non-fast-forward push is retried before the
 * caller surfaces a "retry — concurrent commit" error.
 */
const MAX_NON_FAST_FORWARD_RETRIES = 3;

/** Bounds in-flight blob-create calls per commit — a large batch hits GitHub's secondary rate limit otherwise. */
const BLOB_CREATE_CONCURRENCY = 10;
import { verifySignature } from '@repo/shared-utils';

/**
 * GitHub provider implementation using Octokit.
 *
 * Implements `GitProvider` — the dashboard contract for webhooks, commits,
 * history, and branch discovery.
 */
export class GitHubProvider implements GitProvider {
  readonly type = 'github' as const;

  private octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  /**
   * Create a GitHub provider from a connection context.
   */
  static async fromContext(
    context: GitConnectionContext,
    githubApp: App
  ): Promise<GitHubProvider> {
    if (!context.installationId) {
      throw new AuthenticationError('github', 'Installation ID is required for GitHub provider');
    }

    const octokit = await githubApp.getInstallationOctokit(context.installationId);
    return new GitHubProvider(octokit);
  }

  /**
   * List repositories accessible to the installation.
   */
  async listRepositories(): Promise<{ fullName: string; name: string; defaultBranch: string }[]> {
    try {
      const response = await this.octokit.request('GET /installation/repositories', {
        per_page: 100,
      });

      return (response.data.repositories || []).map((repo: { full_name: string; name: string; default_branch?: string | null }) => ({
        fullName: repo.full_name,
        name: repo.name,
        defaultBranch: repo.default_branch || 'main',
      }));
    } catch (error: unknown) {
      throw this.handleError(error, '');
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(repo: string): Promise<string[]> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const branches: string[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.octokit.rest.repos.listBranches({
          owner,
          repo: repoName,
          per_page: 100,
          page,
        });

        if (!response.data || response.data.length === 0) {
          hasMore = false;
        } else {
          branches.push(...response.data.map((branch: { name: string }) => branch.name));
          hasMore = response.data.length === 100;
          page++;
        }
      }

      return branches;
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * Get the latest commit SHA for a branch.
   */
  async getLatestCommitSha(repo: string, branch: string): Promise<string | null> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.getBranch({
        owner,
        repo: repoName,
        branch,
      });

      return response.data.commit.sha;
    } catch (error: unknown) {
      console.error('Error fetching latest commit SHA from GitHub:', error);
      return null;
    }
  }

  /**
   * Get file content from a GitHub repository.
   */
  async getFileContent(repo: string, path: string, ref: string): Promise<FileContent> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path,
        ref,
      });

      const data = response.data;

      // GitHub can return array for directories or single file object
      if (Array.isArray(data)) {
        throw new FileNotFoundError('github', repo, path);
      }

      if (data.type !== 'file' || !('content' in data)) {
        throw new FileNotFoundError('github', repo, path);
      }

      // Decode base64 content
      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      return {
        path: data.path,
        content,
        sha: data.sha,
        size: data.size,
        encoding: 'utf-8',
      };
    } catch (error: unknown) {
      throw this.handleError(error, repo, path);
    }
  }

  /**
   * Get raw file content as a readable stream.
   */
  async getFileRaw(repo: string, path: string, ref: string): Promise<ReadableStream<Uint8Array>> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path,
        ref,
        mediaType: {
          format: 'raw',
        },
      });

      // For raw format, data is the string content
      const content = response.data as unknown as string;

      // Convert string to ReadableStream
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode(content);

      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(uint8Array);
          controller.close();
        },
      });
    } catch (error: unknown) {
      throw this.handleError(error, repo, path);
    }
  }

  /**
   * List directory contents.
   */
  async listDirectory(repo: string, path: string, ref: string): Promise<FileEntry[]> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: path || '',
        ref,
      });

      const data = response.data;

      if (!Array.isArray(data)) {
        // Single file was returned, not a directory
        return [];
      }

      return data.map((item) => ({
        path: item.path,
        name: item.name,
        type: item.type === 'dir' ? 'dir' : 'file',
        sha: item.sha,
        size: item.size,
      }));
    } catch (error: unknown) {
      throw this.handleError(error, repo, path);
    }
  }

  /**
   * Fetch the recursive file tree at a given ref (commit SHA, branch, or tag).
   *
   * Returns one entry per blob (file). Used by the build cache to look up
   * blob SHAs for paths recorded in a prior deployment's build_manifest:
   * GitHub already content-addresses every blob via its sha, so a path's
   * blob SHA matching the prior deploy's recorded SHA proves the file's
   * content hasn't changed.
   *
   * Throws if the tree is too large for a single response (>100k entries or
   * >7MB). Callers should fall back to "tree unavailable" on throw.
   */
  async getRecursiveTree(
    repo: string,
    ref: string
  ): Promise<Array<{ path: string; contentSha: string }>> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const commit = await this.octokit.rest.repos.getCommit({
        owner,
        repo: repoName,
        ref,
      });
      const treeSha = commit.data.commit.tree.sha;

      const tree = await this.octokit.rest.git.getTree({
        owner,
        repo: repoName,
        tree_sha: treeSha,
        recursive: 'true',
      });

      if (tree.data.truncated) {
        throw new Error(
          `GitHub tree at ${ref} is truncated (>100k entries or >7MB). Build cache requires a complete tree.`
        );
      }

      // typeof guards are runtime defense against malformed API responses;
      // the response types already promise strings, so no predicate is needed.
      return tree.data.tree
        .filter(
          (e) => typeof e.path === 'string' && typeof e.sha === 'string' && e.type === 'blob'
        )
        .map((e) => ({ path: e.path, contentSha: e.sha }));
    } catch (error: unknown) {
      throw this.handleError(error, repo, ref);
    }
  }

  /**
   * List every blob in the tree at a ref via GitHub's recursive Git Trees
   * API — one request (plus the commit→tree-sha lookup). GitHub's tree
   * entries carry `size` inline, so it is real, not a placeholder (see
   * {@link GitProvider.listTree}).
   *
   * Independent implementation from {@link getRecursiveTree} (used by the
   * build cache) despite the near-identical body — kept separate so a
   * future change to either caller's needs (e.g. build cache dropping
   * truncation tolerance) can't accidentally regress the other.
   */
  async listTree(
    repo: string,
    ref: string
  ): Promise<Array<{ path: string; sha: string; size: number }>> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const commit = await this.octokit.rest.repos.getCommit({
        owner,
        repo: repoName,
        ref,
      });
      const treeSha = commit.data.commit.tree.sha;

      const tree = await this.octokit.rest.git.getTree({
        owner,
        repo: repoName,
        tree_sha: treeSha,
        recursive: 'true',
      });

      if (tree.data.truncated) {
        throw new Error(
          `GitHub tree at ${ref} is truncated (>100k entries or >7MB). The context mirror requires a complete tree.`
        );
      }

      // Same malformed-response defense as getRecursiveTree.
      return tree.data.tree
        .filter(
          (e) => typeof e.path === 'string' && typeof e.sha === 'string' && e.type === 'blob'
        )
        .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
    } catch (error: unknown) {
      throw this.handleError(error, repo, ref);
    }
  }

  /**
   * Build a commit object (blobs + tree + commit) on top of `parentSha`
   * WITHOUT moving any branch ref. All `changes` go into one commit — this is
   * what makes a batch atomic.
   *
   * Returns the new commit SHA + the typed `Commit` payload. The caller is
   * responsible for pointing a ref at the commit (directly or via a PR branch).
   */
  private async buildCommitObject(
    owner: string,
    repoName: string,
    parentSha: string,
    changes: FileChange[],
    message: string,
    committer: { name: string; email: string }
  ): Promise<{ sha: string; commit: Commit }> {
    // Get the parent commit's tree.
    const parentCommit = await this.octokit.rest.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: parentSha,
    });
    const baseTreeSha = parentCommit.data.tree.sha;

    // Create blobs for each non-deletion change, bounded concurrency — a large
    // batch of independent blob creates would otherwise hit GitHub's secondary
    // rate limit.
    const treeItems = await mapWithConcurrency(
      changes.filter((change) => change.operation !== 'delete'),
      BLOB_CREATE_CONCURRENCY,
      async (change) => {
        const blobResponse = await this.octokit.rest.git.createBlob({
          owner,
          repo: repoName,
          content: Buffer.from(change.content).toString('base64'),
          encoding: 'base64',
        });
        return {
          path: change.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobResponse.data.sha,
        };
      },
    );

    // Deletions are tree entries with a null sha.
    const deletions = changes
      .filter((change) => change.operation === 'delete')
      .map((change) => ({
        path: change.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: null,
      }));

    const treeResponse = await this.octokit.rest.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseTreeSha,
      tree: [...treeItems, ...deletions],
    });

    const newCommitResponse = await this.octokit.rest.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: treeResponse.data.sha,
      parents: [parentSha],
      committer,
    });

    const commitData = newCommitResponse.data;
    return {
      sha: commitData.sha,
      commit: {
        sha: commitData.sha,
        message: commitData.message,
        author: {
          name: commitData.author?.name || 'Unknown',
          email: commitData.author?.email || '',
        },
        timestamp: commitData.author?.date || new Date().toISOString(),
        url: commitData.html_url,
      },
    };
  }

  /**
   * Classify a GitHub `updateRef` failure as either a non-fast-forward
   * rejection (concurrent commit) or a protected-branch rejection.
   */
  private classifyPushError(
    error: unknown,
    repo: string,
    branch: string
  ): NonFastForwardError | ProtectedBranchError | null {
    const status = (error as { status?: number })?.status;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    // Non-fast-forward: the ref moved underneath us. GitHub returns 422 with
    // an "is not a fast forward" / "update is not a fast forward" message.
    if (message.includes('fast forward') || message.includes('fast-forward')) {
      return new NonFastForwardError('github', repo, branch);
    }

    // Protected branch: 422/403 with a protected-branch / required-status /
    // pull-request-review message.
    if (
      (status === 422 || status === 403) &&
      (message.includes('protected branch') ||
        message.includes('branch protection') ||
        message.includes('required status check') ||
        message.includes('pull request') ||
        message.includes('not authorized to push'))
    ) {
      return new ProtectedBranchError('github', repo, branch);
    }

    return null;
  }

  /**
   * Create a commit with file changes.
   * Uses the GitHub Git Data API for atomic commits.
   */
  async createCommit(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: { name: string; email: string }
  ): Promise<Commit> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const refResponse = await this.octokit.rest.git.getRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refResponse.data.object.sha;

      const { sha, commit } = await this.buildCommitObject(
        owner,
        repoName,
        currentCommitSha,
        changes,
        message,
        committer
      );

      await this.octokit.rest.git.updateRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
        sha,
      });

      return commit;
    } catch (error: unknown) {
      if (error instanceof CommitError) {
        throw error;
      }
      throw new CommitError('github', repo, `Failed to create commit: ${(error as Error).message}`);
    }
  }

  /**
   * Create a commit with branch-protection fallback.
   * See {@link GitProvider.createCommitWithFallback}.
   */
  async createCommitWithFallback(
    repo: string,
    changes: FileChange[],
    message: string,
    branch: string,
    committer: { name: string; email: string },
    options?: CommitFallbackOptions
  ): Promise<CommitWithFallbackResult> {
    const [owner, repoName] = this.parseRepo(repo);

    // Retry the whole build-and-push on a non-fast-forward rejection: the
    // commit must be rebuilt on the new branch tip so the batch still lands
    // as one commit. Up to 3 attempts.
    for (let attempt = 1; attempt <= MAX_NON_FAST_FORWARD_RETRIES; attempt++) {
      let currentCommitSha: string;
      let built: { sha: string; commit: Commit };

      try {
        const refResponse = await this.octokit.rest.git.getRef({
          owner,
          repo: repoName,
          ref: `heads/${branch}`,
        });
        currentCommitSha = refResponse.data.object.sha;

        built = await this.buildCommitObject(
          owner,
          repoName,
          currentCommitSha,
          changes,
          message,
          committer
        );
      } catch (error: unknown) {
        throw new CommitError(
          'github',
          repo,
          `Failed to create commit: ${(error as Error).message}`
        );
      }

      // Per-app publish policy: never attempt the direct push, always open a
      // PR. The commit object is already built on the branch tip above.
      if (options?.forcePullRequest) {
        return this.openPullRequestForCommit(
          owner,
          repoName,
          built,
          changes,
          branch,
          message,
          committer,
          'forced',
          options
        );
      }

      try {
        await this.octokit.rest.git.updateRef({
          owner,
          repo: repoName,
          ref: `heads/${branch}`,
          sha: built.sha,
        });
        return { landed: 'branch', commit: built.commit };
      } catch (error: unknown) {
        const classified = this.classifyPushError(error, repo, branch);

        if (classified instanceof NonFastForwardError) {
          if (attempt >= MAX_NON_FAST_FORWARD_RETRIES) {
            throw classified;
          }
          // Branch advanced — rebuild on the new tip and retry.
          continue;
        }

        if (classified instanceof ProtectedBranchError) {
          // Direct push rejected. The commit object already exists;
          // point a fresh branch at it and open a PR back to `branch`.
          return this.openPullRequestForCommit(
            owner,
            repoName,
            built,
            changes,
            branch,
            message,
            committer,
            'protected_branch',
            options
          );
        }

        throw new CommitError(
          'github',
          repo,
          `Failed to create commit: ${(error as Error).message}`
        );
      }
    }

    // Unreachable — the loop either returns or throws.
    throw new NonFastForwardError('github', repo, branch);
  }

  /**
   * Land a commit on a side branch and open (or update) a PR back to the target
   * branch. `built` is the commit pre-built on the target-branch tip — used
   * as-is when opening a fresh PR. When the head branch already carries an open
   * PR, the commit is instead rebuilt on THAT branch's tip so the change
   * accumulates onto the existing PR rather than replacing it.
   */
  private async openPullRequestForCommit(
    owner: string,
    repoName: string,
    built: { sha: string; commit: Commit },
    changes: FileChange[],
    targetBranch: string,
    message: string,
    committer: { name: string; email: string },
    fallbackReason: 'forced' | 'protected_branch',
    options?: CommitFallbackOptions
  ): Promise<CommitWithFallbackResult> {
    const repo = `${owner}/${repoName}`;
    const fallbackBranch = buildFallbackBranchName(options);

    try {
      // Reuse an already-open PR from this head branch: build the commit ON TOP
      // of the branch's current tip and fast-forward the ref (no force), so an
      // earlier save on the same branch stays in the PR. The base-tip `built`
      // commit is discarded — an orphan commit object is harmless.
      const openPr = (
        await this.octokit.rest.pulls.list({
          owner,
          repo: repoName,
          state: 'open',
          head: `${owner}:${fallbackBranch}`,
        })
      ).data[0];

      if (openPr) {
        // Rebuild-and-retry on a concurrent advance of the head branch, same
        // bound as the direct-push loop: a fast-forward updateRef races other
        // saves landing on this shared branch, so re-read the tip and rebuild.
        for (let attempt = 1; attempt <= MAX_NON_FAST_FORWARD_RETRIES; attempt++) {
          const headRef = await this.octokit.rest.git.getRef({
            owner,
            repo: repoName,
            ref: `heads/${fallbackBranch}`,
          });
          const rebuilt = await this.buildCommitObject(
            owner,
            repoName,
            headRef.data.object.sha,
            changes,
            message,
            committer
          );
          try {
            await this.octokit.rest.git.updateRef({
              owner,
              repo: repoName,
              ref: `heads/${fallbackBranch}`,
              sha: rebuilt.sha,
            });
            return {
              landed: 'pull_request',
              commit: rebuilt.commit,
              pullRequestUrl: openPr.html_url,
              pullRequestNumber: openPr.number,
              pullRequestAction: 'updated',
              fallbackBranch,
              fallbackReason,
            };
          } catch (error: unknown) {
            const classified = this.classifyPushError(error, repo, fallbackBranch);
            if (classified instanceof NonFastForwardError && attempt < MAX_NON_FAST_FORWARD_RETRIES) {
              continue;
            }
            throw error;
          }
        }
        // Unreachable — the loop returns or throws.
        throw new NonFastForwardError('github', repo, fallbackBranch);
      }

      // No open PR. Point the side branch at the base-built commit — creating
      // it, or force-resetting a stale ref (422 = ref already exists) left by a
      // merged/closed PR so the new PR's diff isn't polluted by old commits.
      try {
        await this.octokit.rest.git.createRef({
          owner,
          repo: repoName,
          ref: `refs/heads/${fallbackBranch}`,
          sha: built.sha,
        });
      } catch (refError: unknown) {
        if ((refError as { status?: number }).status !== 422) throw refError;
        await this.octokit.rest.git.updateRef({
          owner,
          repo: repoName,
          ref: `heads/${fallbackBranch}`,
          sha: built.sha,
          force: true,
        });
      }

      // Open the PR, or reuse the open one already targeting this head branch
      // if a concurrent request beat us (422 = a PR exists) → an update.
      let prData: { html_url: string; number: number; action: 'created' | 'updated' };
      try {
        const pr = await this.octokit.rest.pulls.create({
          owner,
          repo: repoName,
          title: options?.pullRequestTitle ?? (message.split('\n')[0] || 'AgentMark dataset update'),
          head: fallbackBranch,
          base: targetBranch,
          body:
            options?.pullRequestBody ??
            `Automated pull request — the connected branch \`${targetBranch}\` is protected and rejects direct pushes.`,
        });
        prData = { html_url: pr.data.html_url, number: pr.data.number, action: 'created' };
      } catch (prError: unknown) {
        if ((prError as { status?: number }).status !== 422) throw prError;
        const existing = await this.octokit.rest.pulls.list({
          owner,
          repo: repoName,
          state: 'open',
          head: `${owner}:${fallbackBranch}`,
        });
        const open = existing.data[0];
        if (!open) throw prError;
        prData = { html_url: open.html_url, number: open.number, action: 'updated' };
      }

      return {
        landed: 'pull_request',
        commit: built.commit,
        pullRequestUrl: prData.html_url,
        pullRequestNumber: prData.number,
        pullRequestAction: prData.action,
        fallbackBranch,
        fallbackReason,
      };
    } catch (error: unknown) {
      throw new CommitError(
        'github',
        repo,
        `Failed to open fallback pull request: ${(error as Error).message}`
      );
    }
  }

  /**
   * Compare two commits and get file differences.
   */
  async compareCommits(repo: string, base: string, head: string): Promise<FileDiff[]> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.compareCommits({
        owner,
        repo: repoName,
        base,
        head,
      });

      return (response.data.files || []).map((file) => ({
        path: file.filename,
        status: this.mapStatus(file.status),
        previousPath: file.previous_filename,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        // The compare payload types `sha` as nullable; FileDiff promises a
        // string, so a missing blob sha degrades to '' rather than null.
        sha: file.sha ?? '',
      }));
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * Get commit history for a repository, optionally filtered by file path.
   * Supports following file renames across commits.
   */
  async getCommitHistory(repo: string, options: CommitHistoryOptions): Promise<CommitHistoryResult> {
    const [owner, repoName] = this.parseRepo(repo);
    const { path, branch, page = 1, perPage = 10, continuePath, continueSha } = options;

    const currentPath = continuePath || path;
    const currentSha = continueSha || `heads/${branch}`;
    const seenShas = new Set<string>();

    try {
      const { data: commits } = await this.octokit.request('GET /repos/{owner}/{repo}/commits', {
        owner,
        repo: repoName,
        sha: currentSha,
        path: currentPath,
        per_page: perPage,
        page,
      });

      const allCommits: CommitWithPath[] = [];

      // Filter duplicates and map to CommitWithPath
      for (const commit of commits) {
        if (seenShas.has(commit.sha)) continue;
        seenShas.add(commit.sha);

        allCommits.push({
          sha: commit.sha,
          message: commit.commit.message,
          author: {
            name: commit.commit.author?.name || 'Unknown',
            email: commit.commit.author?.email || '',
          },
          timestamp: commit.commit.author?.date || new Date().toISOString(),
          url: commit.html_url,
          filePath: currentPath || '',
        });
      }

      let nextPath: string | undefined;
      let nextSha: string | undefined;

      // Check for renames if we have a path and got fewer commits than requested
      const lastCommit = commits[commits.length - 1];
      if (currentPath && commits.length > 0 && commits.length < perPage && lastCommit) {
        const renameInfo = await this.checkForRename(owner, repoName, lastCommit.sha, currentPath);

        if (renameInfo.previousPath && renameInfo.previousSha) {
          // Try to fetch commits from the previous path
          try {
            const remainingCount = perPage - allCommits.length;
            const { data: previousCommits } = await this.octokit.request('GET /repos/{owner}/{repo}/commits', {
              owner,
              repo: repoName,
              sha: renameInfo.previousSha,
              path: renameInfo.previousPath,
              per_page: remainingCount,
              page: 1,
            });

            for (const commit of previousCommits) {
              if (seenShas.has(commit.sha)) continue;
              seenShas.add(commit.sha);

              allCommits.push({
                sha: commit.sha,
                message: commit.commit.message,
                author: {
                  name: commit.commit.author?.name || 'Unknown',
                  email: commit.commit.author?.email || '',
                },
                timestamp: commit.commit.author?.date || new Date().toISOString(),
                url: commit.html_url,
                filePath: renameInfo.previousPath!,
              });
            }

            if (previousCommits.length === remainingCount) {
              nextPath = renameInfo.previousPath;
              nextSha = renameInfo.previousSha;
            }
          } catch {
            // If fetching previous commits fails, set continuation info for next page
            nextPath = renameInfo.previousPath;
            nextSha = renameInfo.previousSha;
          }
        }
      }

      // Sort by timestamp descending
      allCommits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const hasMore = Boolean(nextPath) || allCommits.length === perPage;

      return {
        commits: allCommits,
        hasMore,
        nextPath,
        nextSha,
      };
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * List pull requests across all states, newest-first by creation, up to
   * `options.limit`. Backs the PR-history backfill. `state` is derived
   * merged-first: GitHub's list payload has `state: closed` for merged PRs —
   * `merged_at` is the discriminator.
   */
  async listPullRequests(repo: string, options: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
    const [owner, repoName] = this.parseRepo(repo);
    const results: PullRequestSummary[] = [];
    const perPage = Math.min(options.limit, 100);
    try {
      for (let page = 1; results.length < options.limit; page++) {
        const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo: repoName,
          state: 'all',
          sort: 'created',
          direction: 'desc',
          per_page: perPage,
          page,
        });
        for (const pr of data) {
          if (results.length >= options.limit) break;
          results.push({
            number: pr.number,
            // GitHub types ids as number | bigint; ids fit in a JS number and
            // authorId is only compared against reviewer ids, never persisted.
            authorId: pr.user ? Number(pr.user.id) : null,
            draft: pr.draft ?? false,
            headBranch: pr.head?.ref ?? '',
            headSha: pr.head?.sha ?? null,
            baseBranch: pr.base?.ref ?? '',
            state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
            url: pr.html_url ?? null,
            openedAt: pr.created_at ?? null,
            closedAt: pr.closed_at ?? null,
            mergedAt: pr.merged_at ?? null,
          });
        }
        if (data.length < perPage) break;
      }
      return results;
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * One PR's submitted reviews, oldest-first (GitHub returns them in
   * chronological order). First page only (100): "first review" / "first
   * approval" live at the FRONT of a chronological list, so page 1 answers
   * both except for the degenerate 100+-review PR whose first approval is
   * deeper — that PR keeps a NULL rather than costing a paginated walk per
   * PR of backfill. PENDING (unsubmitted) reviews are excluded; DISMISSED
   * ones are kept (normalized lowercase) — the review happened, it just no
   * longer approves.
   */
  async listPullRequestReviews(repo: string, prNumber: number): Promise<PullRequestReviewSummary[]> {
    const [owner, repoName] = this.parseRepo(repo);
    try {
      const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
      });
      return data
        .filter((review) => (review.state ?? '').toUpperCase() !== 'PENDING')
        .map((review) => ({
          // Same number | bigint id normalization as listPullRequests, so the
          // self-review comparison sees identical number values on both sides.
          authorId: review.user ? Number(review.user.id) : null,
          isBot: (review.user?.type ?? '').toLowerCase() === 'bot',
          state: (review.state ?? '').toLowerCase(),
          submittedAt: review.submitted_at ?? null,
        }));
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * One PR's diff-size stats. The list endpoint omits these — only the
   * per-PR GET carries them — so this exists for the enrichment backfill,
   * not the webhook path (the pull_request payload already has all three).
   */
  /**
   * The PR's base branch name — where the evidence policy is read from (a
   * PR must not be judged under its own policy edits). Same typed
   * degradation as the other PR reads: 403/404 mean "unknown", never an
   * error the caller should surface.
   */
  async getPullRequestBaseBranch(repo: string, prNumber: number): Promise<string | null> {
    const [owner, repoName] = this.parseRepo(repo);
    try {
      const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: prNumber,
      });
      return typeof data.base?.ref === 'string' ? data.base.ref : null;
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 404) {
        return null;
      }
      throw this.handleError(error, repo);
    }
  }

  async getPullRequestDiffStats(
    repo: string,
    prNumber: number
  ): Promise<{ additions: number | null; deletions: number | null; changedFiles: number | null }> {
    const [owner, repoName] = this.parseRepo(repo);
    try {
      const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: prNumber,
      });
      return {
        additions: typeof data.additions === 'number' ? data.additions : null,
        deletions: typeof data.deletions === 'number' ? data.deletions : null,
        changedFiles: typeof data.changed_files === 'number' ? data.changed_files : null,
      };
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * The worst-of CI verdict across a commit's check runs — the API-read
   * equivalent of the webhook path's failure-sticky first-pass rule: several
   * runs complete per commit (lint, tests, build) and the fastest green one
   * must not shadow the failing suite. Conclusions that say nothing about
   * the code (cancelled, skipped, neutral, …) are ignored; a sha with no
   * signal-bearing run returns null (unknown, never a pass). `completedAt`
   * is the earliest signal-bearing completion, mirroring the live path's
   * first-conclusion timestamp. First page only (100 runs) — a sha with
   * more is degenerate, and worst-of over the first 100 is already honest.
   */
  async getCommitCiVerdict(
    repo: string,
    sha: string
  ): Promise<{ conclusion: 'success' | 'failure' | null; completedAt: string | null }> {
    const [owner, repoName] = this.parseRepo(repo);
    try {
      const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner,
        repo: repoName,
        ref: sha,
        per_page: 100,
      });
      let sawFailure = false;
      let sawSuccess = false;
      let earliest: string | null = null;
      for (const run of data.check_runs ?? []) {
        const mapped = ciConclusionFromGitHub(run.conclusion);
        if (!mapped) continue;
        if (mapped === 'failure') sawFailure = true;
        else sawSuccess = true;
        if (run.completed_at && (!earliest || run.completed_at < earliest)) {
          earliest = run.completed_at;
        }
      }
      return {
        conclusion: sawFailure ? 'failure' : sawSuccess ? 'success' : null,
        completedAt: earliest,
      };
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * Check if a file was renamed in the specified commit.
   * @private
   */
  private async checkForRename(
    owner: string,
    repo: string,
    commitSha: string,
    filePath: string
  ): Promise<{ previousPath?: string; previousSha?: string }> {
    try {
      const { data: commitDetails } = await this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner,
        repo,
        ref: commitSha,
      });

      const renamedFile = commitDetails.files?.find(
        (f: { status: string; filename: string; previous_filename?: string }) =>
          f.status === 'renamed' && f.filename === filePath
      );

      if (renamedFile?.previous_filename) {
        return {
          previousPath: renamedFile.previous_filename,
          previousSha: commitDetails.parents[0]?.sha,
        };
      }

      return {};
    } catch {
      return {};
    }
  }

  /**
   * Register a webhook on the repository.
   * Note: For GitHub Apps, webhooks are typically configured at the app level,
   * not per-repository. This method is provided for completeness.
   */
  async registerWebhook(repo: string, webhookUrl: string): Promise<WebhookRegistration> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.repos.createWebhook({
        owner,
        repo: repoName,
        config: {
          url: webhookUrl,
          content_type: 'json',
        },
        events: ['push'],
        active: true,
      });

      return {
        id: String(response.data.id),
        url: response.data.config.url || webhookUrl,
        active: response.data.active,
        events: response.data.events || ['push'],
        createdAt: response.data.created_at || new Date().toISOString(),
      };
    } catch (error: unknown) {
      throw this.handleError(error, repo);
    }
  }

  /**
   * Remove a webhook from the repository.
   */
  async removeWebhook(repo: string, webhookId: string): Promise<void> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      await this.octokit.rest.repos.deleteWebhook({
        owner,
        repo: repoName,
        hook_id: parseInt(webhookId, 10),
      });
    } catch (error: unknown) {
      // Ignore 404 errors (webhook already removed)
      if ((error as { status?: number }).status === 404) {
        return;
      }
      throw this.handleError(error, repo);
    }
  }

  /**
   * Verify webhook signature.
   * GitHub uses HMAC-SHA256 with the secret.
   */
  async verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    // The signature format is "sha256=<hex>"
    const expectedPrefix = 'sha256=';
    if (!signature.startsWith(expectedPrefix)) {
      return false;
    }

    try {
      return await verifySignature(secret, signature, payload);
    } catch {
      return false;
    }
  }

  /**
   * Create a comment on an issue or pull request — PR comments are issue
   * comments in GitHub's API, so this hits `POST
   * /repos/{owner}/{repo}/issues/{issue_number}/comments`, not the separate
   * pull-request review-comment endpoints.
   *
   * Returns a typed `not_permitted` result rather than throwing on 403: the
   * GitHub App does not yet hold `issues: write` on every installation, and
   * every call fails this way until each org admin approves the upgraded
   * permission set. The feature that calls this must degrade silently.
   */
  async createIssueComment(
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<IssueCommentResult> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body,
      });

      return {
        status: 'ok',
        id: response.data.id,
        body: response.data.body ?? '',
        htmlUrl: response.data.html_url,
      };
    } catch (error: unknown) {
      if ((error as { status?: number }).status === 403) {
        return { status: 'not_permitted' };
      }
      throw this.handleError(error, repo);
    }
  }

  /**
   * Update an existing issue comment's body — `PATCH
   * /repos/{owner}/{repo}/issues/comments/{comment_id}`.
   *
   * A 404 means the comment was hand-deleted on GitHub (or the id is stale)
   * and returns a typed `gone` result so the caller can clear the stored
   * comment id and post a fresh comment instead of erroring. A 403 returns
   * `not_permitted` for the same reason as {@link createIssueComment}.
   */
  async updateIssueComment(
    repo: string,
    commentId: number,
    body: string
  ): Promise<IssueCommentResult> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.issues.updateComment({
        owner,
        repo: repoName,
        comment_id: commentId,
        body,
      });

      return {
        status: 'ok',
        id: response.data.id,
        body: response.data.body ?? '',
        htmlUrl: response.data.html_url,
      };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        return { status: 'not_permitted' };
      }
      if (status === 404) {
        return { status: 'gone' };
      }
      throw this.handleError(error, repo);
    }
  }

  /**
   * Fetch a single issue comment by id — `GET
   * /repos/{owner}/{repo}/issues/comments/{comment_id}`. Same typed
   * `not_permitted` / `gone` handling as {@link updateIssueComment}.
   */
  /**
   * List an issue/PR's comments — `GET
   * /repos/{owner}/{repo}/issues/{issue_number}/comments`, bounded to
   * {@link ISSUE_COMMENTS_MAX_PAGES}.
   *
   * Exists for one job: letting a poster find a comment it already posted
   * when the id was never persisted (see `PR_SESSION_COMMENT_MARKER`). A 403
   * returns `not_permitted` for the same reason as the write methods; there
   * is no `gone` case, since a missing thread just lists empty.
   */
  async listIssueComments(repo: string, issueNumber: number): Promise<IssueCommentListResult> {
    const [owner, repoName] = this.parseRepo(repo);
    const comments: { id: number; body: string }[] = [];

    try {
      for (let page = 1; page <= ISSUE_COMMENTS_MAX_PAGES; page += 1) {
        const response = await this.octokit.rest.issues.listComments({
          owner,
          repo: repoName,
          issue_number: issueNumber,
          per_page: ISSUE_COMMENTS_PAGE_SIZE,
          page,
        });
        for (const comment of response.data) {
          comments.push({ id: comment.id, body: comment.body ?? '' });
        }
        if (response.data.length < ISSUE_COMMENTS_PAGE_SIZE) break;
      }
      return { status: 'ok', comments };
    } catch (error: unknown) {
      if ((error as { status?: number }).status === 403) {
        return { status: 'not_permitted' };
      }
      throw this.handleError(error, repo);
    }
  }

  /**
   * List a pull request's commits — `GET
   * /repos/{owner}/{repo}/pulls/{pull_number}/commits`, bounded to
   * {@link PR_COMMITS_MAX_PAGES} (the endpoint itself caps at 250 commits).
   *
   * Exists for the evidence comment's commit-provenance fact: the PR's own
   * commit shas, matched against the linked sessions' recorded commits. A
   * 403 returns `not_permitted` and a 404 `unavailable` — both mean the
   * fact simply cannot be computed, and the caller omits it rather than
   * failing the comment.
   */
  async listPullRequestCommits(
    repo: string,
    prNumber: number
  ): Promise<PullRequestCommitListResult> {
    const [owner, repoName] = this.parseRepo(repo);
    const commits: { sha: string }[] = [];

    try {
      for (let page = 1; page <= PR_COMMITS_MAX_PAGES; page += 1) {
        const response = await this.octokit.rest.pulls.listCommits({
          owner,
          repo: repoName,
          pull_number: prNumber,
          per_page: PR_COMMITS_PAGE_SIZE,
          page,
        });
        for (const commit of response.data) {
          commits.push({ sha: commit.sha });
        }
        if (response.data.length < PR_COMMITS_PAGE_SIZE) break;
      }
      return { status: 'ok', commits };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        return { status: 'not_permitted' };
      }
      if (status === 404) {
        return { status: 'unavailable' };
      }
      throw this.handleError(error, repo);
    }
  }

  async listPullRequestFiles(
    repo: string,
    prNumber: number
  ): Promise<PullRequestFileListResult> {
    const [owner, repoName] = this.parseRepo(repo);
    const files: { filename: string; changeStatus: string }[] = [];

    try {
      for (let page = 1; page <= PR_COMMITS_MAX_PAGES; page += 1) {
        const response = await this.octokit.rest.pulls.listFiles({
          owner,
          repo: repoName,
          pull_number: prNumber,
          per_page: PR_COMMITS_PAGE_SIZE,
          page,
        });
        for (const file of response.data) {
          files.push({ filename: file.filename, changeStatus: file.status });
        }
        if (response.data.length < PR_COMMITS_PAGE_SIZE) break;
      }
      return { status: 'ok', files };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        return { status: 'not_permitted' };
      }
      if (status === 404) {
        return { status: 'unavailable' };
      }
      throw this.handleError(error, repo);
    }
  }

  async getIssueComment(repo: string, commentId: number): Promise<IssueCommentResult> {
    const [owner, repoName] = this.parseRepo(repo);

    try {
      const response = await this.octokit.rest.issues.getComment({
        owner,
        repo: repoName,
        comment_id: commentId,
      });

      return {
        status: 'ok',
        id: response.data.id,
        body: response.data.body ?? '',
        htmlUrl: response.data.html_url,
      };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        return { status: 'not_permitted' };
      }
      if (status === 404) {
        return { status: 'gone' };
      }
      throw this.handleError(error, repo);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseRepo(repo: string): [string, string] {
    const parts = repo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new RepositoryNotFoundError('github', repo);
    }
    return [parts[0], parts[1]];
  }

  private mapStatus(status: string): FileDiff['status'] {
    switch (status) {
      case 'added':
        return 'added';
      case 'removed':
        return 'removed';
      case 'renamed':
        return 'renamed';
      default:
        return 'modified';
    }
  }

  private handleError(error: unknown, repo: string, path?: string): never {
    const octoError = error as { status?: number; message?: string };

    if (octoError.status === 401 || octoError.status === 403) {
      throw new AuthenticationError('github', octoError.message);
    }

    if (octoError.status === 404) {
      if (path) {
        throw new FileNotFoundError('github', repo, path);
      }
      throw new RepositoryNotFoundError('github', repo);
    }

    if (octoError.status === 429) {
      throw new RateLimitError('github');
    }

    throw wrapError(error, 'github');
  }
}
