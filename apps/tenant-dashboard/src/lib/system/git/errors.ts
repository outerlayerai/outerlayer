import "server-only";

/**
 * Git Provider Abstraction - Error Classes
 *
 * Custom error classes for Git provider operations.
 * All errors include provider type for Sentry tagging.
 */

import type { GitProviderType } from './types';

/**
 * Base error class for all Git provider errors.
 */
export class GitProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: GitProviderType,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GitProviderError';

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, GitProviderError.prototype);
  }

  /**
   * Get error context for logging/Sentry.
   */
  toContext(): Record<string, unknown> {
    return {
      provider: this.provider,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
    };
  }
}

/**
 * Thrown when authentication fails (invalid token, expired, revoked).
 */
export class AuthenticationError extends GitProviderError {
  constructor(provider: GitProviderType, message = 'Authentication failed') {
    super(message, provider, 'AUTH_FAILED', 401);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Thrown when rate limit is exceeded.
 */
export class RateLimitError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly retryAfter?: number
  ) {
    super('Rate limit exceeded', provider, 'RATE_LIMITED', 429);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return {
      ...super.toContext(),
      retryAfter: this.retryAfter,
    };
  }
}

/**
 * Thrown when a repository is not found or inaccessible.
 */
export class RepositoryNotFoundError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly repository: string
  ) {
    super(`Repository not found: ${repository}`, provider, 'REPO_NOT_FOUND', 404);
    this.name = 'RepositoryNotFoundError';
    Object.setPrototypeOf(this, RepositoryNotFoundError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return {
      ...super.toContext(),
      repository: this.repository,
    };
  }
}

/**
 * Thrown when a file is not found in the repository.
 */
export class FileNotFoundError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly repository: string,
    public readonly path: string
  ) {
    super(`File not found: ${path} in ${repository}`, provider, 'FILE_NOT_FOUND', 404);
    this.name = 'FileNotFoundError';
    Object.setPrototypeOf(this, FileNotFoundError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return {
      ...super.toContext(),
      repository: this.repository,
      path: this.path,
    };
  }
}

/**
 * Thrown when a commit operation fails.
 */
export class CommitError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly repository: string,
    message = 'Failed to create commit'
  ) {
    super(message, provider, 'COMMIT_FAILED', 500);
    this.name = 'CommitError';
    Object.setPrototypeOf(this, CommitError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return {
      ...super.toContext(),
      repository: this.repository,
    };
  }
}

/**
 * Raised when a push is rejected because the target branch is protected and
 * does not allow a direct push. The caller is expected
 * to catch this and fall back to a separate branch + pull request.
 */
export class ProtectedBranchError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly repository: string,
    public readonly branch: string,
    message = 'Branch is protected and rejects direct pushes'
  ) {
    super(message, provider, 'PROTECTED_BRANCH', 422);
    this.name = 'ProtectedBranchError';
    Object.setPrototypeOf(this, ProtectedBranchError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return { ...super.toContext(), repository: this.repository, branch: this.branch };
  }
}

/**
 * Raised when a push is rejected because the branch tip moved underneath us
 * (a concurrent commit landed first). The caller
 * retries up to 3× before surfacing this.
 */
export class NonFastForwardError extends GitProviderError {
  constructor(
    provider: GitProviderType,
    public readonly repository: string,
    public readonly branch: string,
    message = 'Push rejected — the branch advanced (non-fast-forward)'
  ) {
    super(message, provider, 'NON_FAST_FORWARD', 409);
    this.name = 'NonFastForwardError';
    Object.setPrototypeOf(this, NonFastForwardError.prototype);
  }

  override toContext(): Record<string, unknown> {
    return { ...super.toContext(), repository: this.repository, branch: this.branch };
  }
}

/**
 * Helper to check if an error is a Git provider error.
 */
export function isGitProviderError(error: unknown): error is GitProviderError {
  return error instanceof GitProviderError;
}

/**
 * Helper to wrap unknown errors as GitProviderError.
 */
export function wrapError(
  error: unknown,
  provider: GitProviderType,
  fallbackMessage = 'An unexpected error occurred'
): GitProviderError {
  if (isGitProviderError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : fallbackMessage;
  const cause = error instanceof Error ? error : undefined;

  return new GitProviderError(message, provider, 'UNKNOWN_ERROR', 500, cause);
}
