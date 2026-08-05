/**
 * Git Provider Factory tests.
 *
 * Tests that createGitProvider dispatches to the correct provider
 * factory and rejects unknown provider types.
 */

// Mock server-only (imported transitively by provider modules)
vi.mock('server-only', () => ({}));

// Mock Sentry (imported by the GitHub client)
vi.mock('@/lib/observability/error-reporting/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock the logger (imported by the GitHub client)
vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    withAppId: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// Mock verifySignature (imported by GitHub client)
vi.mock('@repo/shared-utils', () => ({
  verifySignature: vi.fn(),
}));

// Capture the mock Octokit so we can verify it was created
const mockGetInstallationOctokit = vi.fn().mockResolvedValue({ request: vi.fn() });
const mockGithubApp = {
  getInstallationOctokit: mockGetInstallationOctokit,
};

// Mock the octo-kit module that provides the GitHub App instance
vi.mock('@/octo-kit', () => ({
  getGithubApp: vi.fn(() => mockGithubApp),
}));

import { createGitProvider } from '../factory';
import { GitProviderError, AuthenticationError } from '../errors';
import type { GitConnectionContext } from '../types';

describe('createGitProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // GitHub provider creation
  // -------------------------------------------------------------------------

  describe('github provider', () => {
    it('should return a GitHubProvider when type is github and installationId is provided', async () => {
      const context: GitConnectionContext = {
        provider: 'github',
        installationId: 12345,
      };

      const provider = await createGitProvider('github', context);

      expect(provider.type).toBe('github');
      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(12345);
    });

    it('should throw AuthenticationError when installationId is missing for github', async () => {
      const context: GitConnectionContext = {
        provider: 'github',
        // no installationId
      };

      await expect(createGitProvider('github', context)).rejects.toThrow(AuthenticationError);
      await expect(createGitProvider('github', context)).rejects.toThrow(
        'Installation ID is required for GitHub provider'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unknown provider type
  // -------------------------------------------------------------------------

  describe('unknown provider type', () => {
    it('should throw GitProviderError when provider type is not registered', async () => {
      const context: GitConnectionContext = {
        provider: 'github', // type field doesn't matter, the first arg does
      };

      await expect(
        createGitProvider('bitbucket' as any, context)
      ).rejects.toThrow(GitProviderError);
    });

    it('should include available providers in the error message', async () => {
      const context: GitConnectionContext = {
        provider: 'github',
      };

      await expect(
        createGitProvider('bitbucket' as any, context)
      ).rejects.toThrow(/github/);
    });

    it('should set PROVIDER_NOT_REGISTERED error code', async () => {
      const context: GitConnectionContext = {
        provider: 'github',
      };

      try {
        await createGitProvider('bitbucket' as any, context);
        throw new Error('Expected createGitProvider to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(GitProviderError);
        expect((error as GitProviderError).code).toBe('PROVIDER_NOT_REGISTERED');
      }
    });
  });
});
