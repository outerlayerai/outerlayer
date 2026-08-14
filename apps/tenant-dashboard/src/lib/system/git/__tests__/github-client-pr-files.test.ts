/**
 * GitHubProvider.listPullRequestFiles tests.
 *
 * The evidence comment's proof-criteria fetch reads the PR's changed files
 * and head sha through this method, so its contract is pinned here: the
 * mapped path/status pairs, the head sha extraction (null when absent), and
 * the bounded pagination (three pages of 100, then stop). Mocks the
 * underlying Octokit calls, mirroring `github-client-pr-commits.test.ts`.
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
        listFiles: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(mock as unknown as Octokit), octokit: mock };
}

function filePage(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `${prefix}-${i}.ts`,
    status: 'modified',
  }));
}

describe('GitHubProvider.listPullRequestFiles', () => {
  it('returns the PR head sha and the mapped path/status pairs in order', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { head: { sha: 'beefcafe' } } });
    octokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        { filename: 'acceptance/083-artifacts.md', status: 'added' },
        { filename: 'src/index.ts', status: 'removed' },
      ],
    });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner: 'org', repo: 'repo', pull_number: 42 },
    );
    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      headSha: 'beefcafe',
      files: [
        { path: 'acceptance/083-artifacts.md', status: 'added' },
        { path: 'src/index.ts', status: 'removed' },
      ],
    });
  });

  it('paginates past full pages, stops at the three-page bound, and concatenates in page order', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { head: { sha: 'beefcafe' } } });
    octokit.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: filePage(100, 'p1') })
      .mockResolvedValueOnce({ data: filePage(100, 'p2') })
      .mockResolvedValueOnce({ data: filePage(100, 'p3') })
      .mockResolvedValueOnce({ data: filePage(100, 'p4') });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    // The three-page cap: page 4 is never requested even though page 3 was full.
    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(3);
    expect(octokit.rest.pulls.listFiles).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 2,
    });
    expect(octokit.rest.pulls.listFiles).toHaveBeenNthCalledWith(3, {
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 3,
    });
    expect(result.files).toHaveLength(300);
    expect(result.files[0]).toEqual({ path: 'p1-0.ts', status: 'modified' });
    expect(result.files[100]).toEqual({ path: 'p2-0.ts', status: 'modified' });
    expect(result.files[299]).toEqual({ path: 'p3-99.ts', status: 'modified' });
  });

  it('stops after a short page instead of requesting the next one', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { head: { sha: 'beefcafe' } } });
    octokit.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: filePage(100, 'p1') })
      .mockResolvedValueOnce({ data: filePage(99, 'p2') });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect(result.files).toHaveLength(199);
  });

  it('returns headSha null when the PR payload carries no usable sha', async () => {
    const { provider, octokit } = createProvider();
    octokit.request.mockResolvedValue({ data: { head: {} } });
    octokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(result).toEqual({ headSha: null, files: [] });
  });
});
