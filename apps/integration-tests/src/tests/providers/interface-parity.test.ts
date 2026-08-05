/**
 * Git Provider Interface Parity Tests
 *
 * Verifies that the GitHub provider implements the GitProvider interface
 * with consistent method signatures and behavior contracts.
 *
 * These tests validate:
 * - All interface methods are implemented
 * - Method signatures match the interface contract
 * - Return types conform to expected shapes
 * - Error handling follows common patterns
 *
 * @module tests/providers/interface-parity
 */

import { FakeGitProvider } from '../../lib/fake-git-provider';

// Mock server-only - must be before imports
vi.mock('server-only', () => ({}));

// Interface method names that must be implemented
const REQUIRED_METHODS = [
  'listRepositories',
  'listBranches',
  'getLatestCommitSha',
  'getFileContent',
  'getFileRaw',
  'listDirectory',
  'createCommit',
  'compareCommits',
  'registerWebhook',
  'removeWebhook',
  'verifyWebhookSignature',
] as const;

// Expected method parameter counts (excluding 'this')
const METHOD_PARAM_COUNTS: Record<string, number> = {
  listRepositories: 0,
  listBranches: 1,
  getLatestCommitSha: 2,
  getFileContent: 3,
  getFileRaw: 3,
  listDirectory: 3,
  createCommit: 5,
  compareCommits: 3,
  registerWebhook: 2,  // (repo, webhookUrl)
  removeWebhook: 2,
  verifyWebhookSignature: 3,
};

describe('Git Provider Interface Parity', () => {
  // Provider classes - loaded dynamically
  let GitHubProvider: any;
  let errors: any;
  let githubProvider: any;
  let fakeProvider: any;

  beforeAll(async () => {
    try {
      // Dynamic import to ensure mock is applied first
      const githubModule = await import('tenant-dashboard/src/lib/system/git/github/client');
      errors = await import('tenant-dashboard/src/lib/system/git/errors');

      GitHubProvider = githubModule.GitHubProvider;

      // Create instances
      const mockOctokit = {} as any;
      githubProvider = new GitHubProvider(mockOctokit);
      fakeProvider = new FakeGitProvider();
    } catch (e) {
      console.error('Error in beforeAll:', e);
      throw e;
    }
  });

  describe('Method Implementation', () => {
    it('GitHubProvider implements all required interface methods', () => {
      // Check type property
      expect(githubProvider.type).toBe('github');

      // Check all required methods exist
      for (const method of REQUIRED_METHODS) {
        expect(typeof githubProvider[method]).toBe('function');
      }
    });

    it('GitHubProvider method signatures match the expected parameter counts', () => {
      for (const method of REQUIRED_METHODS) {
        const githubMethod = githubProvider[method] as Function;
        expect(githubMethod.length).toBe(METHOD_PARAM_COUNTS[method]);
      }
    });

    // The harness's in-memory fake is a third GitProvider
    // implementation. Running it through the same method-presence +
    // signature check means a future GitProvider interface change breaks the
    // fake in the same commit that changes the interface, instead of surfacing
    // later as a silent behavioral gap in whatever test happens to use it.
    it('FakeGitProvider implements all required interface methods with matching signatures', () => {
      expect(fakeProvider.type).toBe('github');

      for (const method of REQUIRED_METHODS) {
        expect(typeof fakeProvider[method]).toBe('function');
        const fakeMethod = fakeProvider[method] as Function;
        expect(fakeMethod.length).toBe(METHOD_PARAM_COUNTS[method]);
      }
    });
  });

  describe('Webhook Signature Verification', () => {
    it('GitHubProvider verifyWebhookSignature returns Promise<boolean>', async () => {
      const result = await githubProvider.verifyWebhookSignature('payload', 'invalid', 'secret');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Error Types', () => {
    it('The provider uses the common error classes', () => {
      // Verify error classes exist (constructable functions)
      expect(typeof errors.AuthenticationError).toBe('function');
      expect(typeof errors.RepositoryNotFoundError).toBe('function');
      expect(typeof errors.FileNotFoundError).toBe('function');
      expect(typeof errors.RateLimitError).toBe('function');
      expect(typeof errors.CommitError).toBe('function');

      // Verify error hierarchy
      const authError = new errors.AuthenticationError('github');
      const repoError = new errors.RepositoryNotFoundError('github', 'owner/repo');

      expect(authError.provider).toBe('github');
      expect(repoError.provider).toBe('github');
      expect(repoError.repository).toBe('owner/repo');
    });
  });

});
