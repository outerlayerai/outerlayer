/**
 * GitHubProvider.listPullRequestCommits tests.
 *
 * The evidence comment's commit-provenance fact reads the PR's commits
 * through this method, so its contract is pinned here: the mapped shas, the
 * bounded pagination (the endpoint itself caps at 250 commits), and the
 * typed degradations — 403 → not_permitted, 404 → unavailable — that let
 * the caller omit the fact instead of failing the comment. Mocks the
 * underlying Octokit calls, mirroring `github-client-comments.test.ts`.
 */

// Mock server-only (imported by github/client.ts)
vi.mock('server-only', () => ({}));

// Mock verifySignature (imported by github/client.ts, unused here but the
// module import chain requires it to resolve).
vi.mock('@repo/shared-utils', () => ({
  verifySignature: vi.fn(),
}));

import type { Octokit } from 'octokit';

import { GitHubProvider } from '../github/client';

function createMockOctokit() {
  return {
    request: vi.fn(),
    rest: {
      pulls: {
        listCommits: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(mock as unknown as Octokit), octokit: mock };
}

function commitPage(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({ sha: `${prefix}-${i}` }));
}

describe('GitHubProvider.listPullRequestCommits', () => {
  it('lists the PR-commits endpoint and returns the mapped shas in order', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits.mockResolvedValue({
      data: [{ sha: 'aaa111' }, { sha: 'bbb222' }],
    });

    const result = await provider.listPullRequestCommits('org/repo', 42);

    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'ok',
      commits: [{ sha: 'aaa111' }, { sha: 'bbb222' }],
    });
  });

  it('paginates past a full page and concatenates in page order', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits
      .mockResolvedValueOnce({ data: commitPage(100, 'p1') })
      .mockResolvedValueOnce({ data: [{ sha: 'p2-0' }] });

    const result = await provider.listPullRequestCommits('org/repo', 42);

    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.listCommits).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.commits).toHaveLength(101);
    expect(result.commits[0]).toEqual({ sha: 'p1-0' });
    expect(result.commits[100]).toEqual({ sha: 'p2-0' });
  });

  it('stops at three pages even when every page is full — the endpoint caps at 250 commits', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits.mockResolvedValue({ data: commitPage(100, 'full') });

    const result = await provider.listPullRequestCommits('org/repo', 42);

    expect(octokit.rest.pulls.listCommits).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.commits).toHaveLength(300);
  });

  it('returns {status: "not_permitted"} on 403 without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits.mockRejectedValue({ status: 403, message: 'Forbidden' });

    await expect(provider.listPullRequestCommits('org/repo', 42)).resolves.toEqual({
      status: 'not_permitted',
    });
  });

  it('returns {status: "unavailable"} on 404 without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits.mockRejectedValue({ status: 404, message: 'Not Found' });

    await expect(provider.listPullRequestCommits('org/repo', 42)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('throws through the shared error handler on any other failure', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listCommits.mockRejectedValue({ status: 500, message: 'kaboom' });

    await expect(provider.listPullRequestCommits('org/repo', 42)).rejects.toThrow();
  });
});
