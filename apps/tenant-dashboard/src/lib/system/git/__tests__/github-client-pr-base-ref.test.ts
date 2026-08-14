/**
 * GitHubProvider.getPullRequestBaseRef tests.
 *
 * The evidence policy is read at the PR's base branch through this method,
 * so its contract is pinned here: the base ref name, and the typed
 * degradations — 403 → not_permitted, 404 or a missing ref → unavailable —
 * that make an unreadable PR mean "no policy" rather than a failed comment.
 * Mirrors `github-client-pr-commits.test.ts`.
 */

// Mock server-only (imported by github/client.ts)
vi.mock('server-only', () => ({}));

// Mock verifySignature (imported by github/client.ts, unused here but the
// module import chain requires it to resolve).
vi.mock('@repo/shared-utils', () => ({
  verifySignature: vi.fn(),
}));

import { asOctokit } from '@/test-helpers/mock-octokit';
import { GitHubProvider } from '../github/client';

function createMockOctokit() {
  return {
    request: vi.fn(),
    rest: {},
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(asOctokit(mock)), octokit: mock };
}

describe('GitHubProvider.getPullRequestBaseRef', () => {
  it('returns the base ref of the pull request', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { base: { ref: 'release/8' } } });

    await expect(provider.getPullRequestBaseRef('org/repo', 42)).resolves.toEqual({
      status: 'ok',
      baseRef: 'release/8',
    });
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
    });
  });

  it('answers unavailable when the response carries no base ref', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: {} });

    await expect(provider.getPullRequestBaseRef('org/repo', 42)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('degrades 403 to not_permitted and 404 to unavailable without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });
    await expect(provider.getPullRequestBaseRef('org/repo', 42)).resolves.toEqual({
      status: 'not_permitted',
    });

    octokit.request.mockRejectedValueOnce({ status: 404, message: 'Not Found' });
    await expect(provider.getPullRequestBaseRef('org/repo', 42)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('throws through the shared error handler on any other failure', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockRejectedValue({ status: 500, message: 'kaboom' });

    await expect(provider.getPullRequestBaseRef('org/repo', 42)).rejects.toThrow();
  });
});
