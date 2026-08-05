import "server-only";

/**
 * Git Provider Abstraction
 *
 * Unified interface for interacting with Git hosting providers.
 * Provides a consistent API for repository operations, webhooks, and authentication.
 *
 * @example
 * ```typescript
 * import { createGitProviderForApp, type GitProvider } from '@/lib/system/git';
 *
 * const provider = await createGitProviderForApp(supabase, appId);
 *
 * // Read file content
 * const content = await provider.getFileContent('owner/repo', 'README.md', 'main');
 *
 * // List directory
 * const files = await provider.listDirectory('owner/repo', 'src', 'main');
 * ```
 */

// Core interface
export type { GitProvider } from './git-provider.interface';

// Types - only export what's imported from this module
// eslint-disable-next-line import/no-unused-modules -- Re-exported for external module consumers
export type { FileDiff } from './types';

// Errors - only export what's imported from this module

// Connection management (database-backed provider creation)
export { createGitProviderForApp } from './connection';
