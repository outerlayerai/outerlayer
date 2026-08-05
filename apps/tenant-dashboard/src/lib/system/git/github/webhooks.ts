import "server-only";

/**
 * GitHub Provider - Webhook Utilities
 *
 * Push-event normalization for the GitHub webhook handler.
 */

import 'server-only';

import type { NormalizedPushEvent, NormalizedCommit } from '../types';

/**
 * Normalize a GitHub push event to the common format.
 *
 * @param payload - GitHub push event payload
 * @returns Normalized push event
 */
export function normalizeGitHubPushEvent(payload: GitHubPushPayload): NormalizedPushEvent {
  // Extract branch name from refs/heads/branch-name
  const ref = payload.ref || '';
  const branch = ref.replace('refs/heads/', '');

  const commits: NormalizedCommit[] = (payload.commits || []).map((commit) => ({
    sha: commit.id,
    message: commit.message,
    author: {
      name: commit.author?.name || '',
      email: commit.author?.email || '',
      username: commit.author?.username,
    },
    added: commit.added || [],
    modified: commit.modified || [],
    removed: commit.removed || [],
    timestamp: commit.timestamp || '',
  }));

  return {
    provider: 'github',
    repository: payload.repository?.full_name || '',
    branch,
    commitSha: payload.head_commit?.id || payload.after || '',
    // Absent on a malformed payload — catch-up then falls back to the payload
    // diff (`null` is reserved for synthetic events with no payload diff).
    beforeSha: payload.before ?? undefined,
    commitMessage: payload.head_commit?.message ?? null,
    commits,
    sender: {
      username: payload.sender?.login || '',
      email: payload.head_commit?.committer?.email,
    },
    timestamp: payload.head_commit?.timestamp || new Date().toISOString(),
    raw: payload,
  };
}

// ---------------------------------------------------------------------------
// GitHub-specific payload types
// ---------------------------------------------------------------------------

/**
 * GitHub push webhook payload structure.
 */
export interface GitHubPushPayload {
  ref?: string;
  before?: string;
  after?: string;
  repository?: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  };
  head_commit?: {
    id: string;
    message?: string;
    timestamp?: string;
    author?: {
      name?: string;
      email?: string;
      username?: string;
    };
    committer?: {
      name?: string;
      email?: string;
      username?: string;
    };
  };
  commits?: Array<{
    id: string;
    message: string;
    timestamp?: string;
    author?: {
      name?: string;
      email?: string;
      username?: string;
    };
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  sender?: {
    id: number;
    login?: string;
    type?: string;
  };
  installation?: {
    id: number;
    node_id?: string;
  };
}
