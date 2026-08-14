/**
 * GitHubProvider.getPullRequestBaseBranch tests.
 *
 * The evidence policy is read at the PR's base branch through this method,
 * so its contract is pinned here: the base ref name, and the typed
 * degradations — 403/404 → null — that make an unreadable PR mean "no
 * policy" rather than a failed comment. Mirrors
 * `github-client-pr-commits.test.ts`.
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

describe('GitHubProvider.getPullRequestBaseBranch', () => {
  it('returns the base ref of the pull request', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { base: { ref: 'main' } } });

    await expect(provider.getPullRequestBaseBranch('org/repo', 42)).resolves.toEqual('main');
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
    });
  });

  it('returns null when the response carries no base ref', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: {} });

    await expect(provider.getPullRequestBaseBranch('org/repo', 42)).resolves.toEqual(null);
  });

  it('returns null on 403 and 404 without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });
    await expect(provider.getPullRequestBaseBranch('org/repo', 42)).resolves.toEqual(null);

    octokit.request.mockRejectedValueOnce({ status: 404, message: 'Not Found' });
    await expect(provider.getPullRequestBaseBranch('org/repo', 42)).resolves.toEqual(null);
  });

  it('throws through the shared error handler on any other failure', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockRejectedValue({ status: 500, message: 'kaboom' });

    await expect(provider.getPullRequestBaseBranch('org/repo', 42)).rejects.toThrow();
  });
});
