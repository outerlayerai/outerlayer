import "server-only";

/**
 * Git Provider Abstraction - Provider Factory
 *
 * Factory function for creating Git provider instances.
 * Resolves the appropriate provider implementation based on type.
 */

import type { GitProvider, GitProviderConfig } from './git-provider.interface';
import type { GitProviderType, GitConnectionContext } from './types';
import { GitProviderError, AuthenticationError } from './errors';
import { GitHubProvider } from './github/client';
import { getGithubApp } from '../../../octo-kit';

/**
 * Registry of provider factory functions.
 * Each provider registers its own factory during module initialization.
 */
const providerFactories = new Map<
  GitProviderType,
  (context: GitConnectionContext, config?: GitProviderConfig) => Promise<GitProvider>
>();

/**
 * Register a provider factory function.
 * Used by provider implementations to register themselves.
 *
 * @param type - Provider type identifier
 * @param factory - Factory function that creates provider instances
 */
function registerProviderFactory(
  type: GitProviderType,
  factory: (context: GitConnectionContext, config?: GitProviderConfig) => Promise<GitProvider>
): void {
  providerFactories.set(type, factory);
}

/**
 * Test-infrastructure seam: temporarily override the registered factory for
 * `type`, returning a function that restores the prior entry. Production code
 * never calls this — it exists so the integration harness can substitute an
 * in-memory `GitProvider` for `'github'` without a new provider type or a
 * database `CHECK` constraint change (`git_connection.provider` still allows
 * `'github' | 'gitlab'` for legacy rows, even though only `'github'` has a
 * registered factory). Nothing else in this module changes: the real GitHub
 * registration still runs at module init, and this override does nothing
 * unless a caller invokes it. Each call captures whatever was registered at
 * that moment, so nested/repeated overrides of the same `type` must be
 * restored in the reverse order they were applied (last override restored
 * first) to unwind back to the original entry.
 */
// eslint-disable-next-line import/no-unused-modules -- consumed by apps/integration-tests' fake GitProvider fixture, a separate package the lint rule doesn't traverse
export function overrideProviderFactoryForTesting(
  type: GitProviderType,
  factory: (context: GitConnectionContext, config?: GitProviderConfig) => Promise<GitProvider>
): () => void {
  const previous = providerFactories.get(type);
  providerFactories.set(type, factory);
  return () => {
    if (previous) {
      providerFactories.set(type, previous);
    } else {
      providerFactories.delete(type);
    }
  };
}

/**
 * Create a Git provider instance for the given type and context.
 *
 * @param type - Provider type ('github')
 * @param context - Connection context with authentication details
 * @param config - Optional provider configuration
 * @returns Configured provider instance
 * @throws GitProviderError if provider type is not registered
 *
 * @example
 * ```typescript
 * const provider = await createGitProvider('github', {
 *   provider: 'github',
 *   installationId: 12345,
 * });
 *
 * const content = await provider.getFileContent('owner/repo', 'README.md', 'main');
 * ```
 */
export async function createGitProvider(
  type: GitProviderType,
  context: GitConnectionContext,
  config?: GitProviderConfig
): Promise<GitProvider> {
  const factory = providerFactories.get(type);

  if (!factory) {
    throw new GitProviderError(
      `Provider '${type}' is not registered. Available providers: ${Array.from(providerFactories.keys()).join(', ') || 'none'}`,
      type,
      'PROVIDER_NOT_REGISTERED',
      500
    );
  }

  return factory(context, config);
}

// =============================================================================
// Provider Registration
// =============================================================================

/**
 * GitHub provider factory.
 * Uses GitHub App installation authentication.
 */
registerProviderFactory('github', async (context) => {
  if (!context.installationId) {
    throw new AuthenticationError('github', 'Installation ID is required for GitHub provider');
  }

  const githubApp = getGithubApp();
  return GitHubProvider.fromContext(context, githubApp);
});
