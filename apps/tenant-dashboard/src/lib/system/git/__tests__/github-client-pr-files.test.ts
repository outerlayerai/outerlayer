/**
 * GitHubProvider.listPullRequestFiles tests.
 *
 * Red-then-green's "does the diff add tests" input reads the PR's changed
 * files through this method, so its contract is pinned here: filename +
 * change status mapped per file, bounded pagination, and the typed
 * degradations — 403 → not_permitted, 404 → unavailable — that let the
 * caller suppress the rule instead of approximating it. Mirrors
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
  return { provider: new GitHubProvider(asOctokit(mock)), octokit: mock };
}

function filePage(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `${prefix}-${i}.ts`,
    status: 'modified',
  }));
}

describe('GitHubProvider.listPullRequestFiles', () => {
  it('lists the PR-files endpoint and maps filename and change status per file', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        { filename: 'src/lib/a.ts', status: 'modified' },
        { filename: 'src/lib/__tests__/a.test.ts', status: 'added' },
        { filename: 'src/lib/old.ts', status: 'removed' },
      ],
    });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'ok',
      files: [
        { filename: 'src/lib/a.ts', changeStatus: 'modified' },
        { filename: 'src/lib/__tests__/a.test.ts', changeStatus: 'added' },
        { filename: 'src/lib/old.ts', changeStatus: 'removed' },
      ],
    });
  });

  it('paginates past a full page and concatenates in page order', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: filePage(100, 'p1') })
      .mockResolvedValueOnce({ data: [{ filename: 'p2-0.ts', status: 'added' }] });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.listFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.files).toHaveLength(101);
    expect(result.files[0]).toEqual({ filename: 'p1-0.ts', changeStatus: 'modified' });
    expect(result.files[100]).toEqual({ filename: 'p2-0.ts', changeStatus: 'added' });
  });

  it('stops at three full pages — the same page ceiling as the commits read', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles.mockResolvedValue({ data: filePage(100, 'full') });

    const result = await provider.listPullRequestFiles('org/repo', 42);

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.files).toHaveLength(300);
  });

  it('returns {status: "not_permitted"} on 403 without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles.mockRejectedValue({ status: 403, message: 'Forbidden' });

    await expect(provider.listPullRequestFiles('org/repo', 42)).resolves.toEqual({
      status: 'not_permitted',
    });
  });

  it('returns {status: "unavailable"} on 404 without throwing', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles.mockRejectedValue({ status: 404, message: 'Not Found' });

    await expect(provider.listPullRequestFiles('org/repo', 42)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('throws through the shared error handler on any other failure', async () => {
    const { provider, octokit } = createProvider();
    octokit.rest.pulls.listFiles.mockRejectedValue({ status: 500, message: 'kaboom' });

    await expect(provider.listPullRequestFiles('org/repo', 42)).rejects.toThrow();
  });
});
