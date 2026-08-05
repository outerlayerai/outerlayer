/**
 * GitHubProvider unit tests.
 *
 * Covers the headless link-flow methods:
 *   - listRepositories: paginated `/installation/repositories` walk
 *   - listBranches: paginated `/repos/{owner}/{repo}/branches` walk
 *   - getLatestCommitSha: best-effort branch HEAD lookup
 *
 * `streamFile` is not exercised here — it's exercised by the existing
 * dataset-streamer integration tests that mock the Cloudflare Worker
 * ReadableStream. Adding stream-controller unit assertions here would
 * duplicate that coverage.
 *
 * Octokit is constructed lazily inside `GitHubProvider.create` from a
 * (installationId, env) tuple; we inject a stub via `Object.assign`
 * onto a freshly-built provider so the tests don't need the real
 * GitHub App private key.
 */

import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../github';

interface OctokitRequestArgs {
  url: string;
  options: Record<string, unknown>;
}

/**
 * Build a GitHubProvider whose `octokit.request` returns a queued
 * sequence of responses. Each call shifts the next response off the
 * queue; an empty queue throws so we notice over-paging bugs.
 */
function makeProvider(responses: Array<{ data: unknown; status?: number }>) {
  const calls: OctokitRequestArgs[] = [];
  const queue = [...responses];

  const fakeOctokit = {
    request: vi.fn(async (url: string, options: Record<string, unknown>) => {
      calls.push({ url, options });
      const next = queue.shift();
      if (!next) {
        throw new Error(`Unexpected extra Octokit request to ${url} (queue empty)`);
      }
      return { data: next.data, status: next.status ?? 200, headers: {}, url };
    }),
  };

  // GitHubProvider's constructor is private; we use a typed any-cast
  // to wire the stub. This is the smallest possible test surface —
  // the only thing we're verifying is that the provider calls Octokit
  // with the right URLs and aggregates pages correctly.
  const ProviderCtor = GitHubProvider as unknown as new (
    octokit: unknown,
    installationId: number,
    appId: string,
  ) => GitHubProvider;
  const provider = new ProviderCtor(fakeOctokit, 12345, 'fake-app-id');

  return { provider, calls };
}

describe('GitHubProvider.listRepositories', () => {
  it('aggregates a single page when fewer than per_page results', async () => {
    const { provider, calls } = makeProvider([
      {
        data: {
          repositories: [
            { full_name: 'acme/alpha', name: 'alpha', default_branch: 'main' },
            { full_name: 'acme/beta', name: 'beta', default_branch: 'master' },
          ],
        },
      },
    ]);

    const repos = await provider.listRepositories();

    expect(repos).toEqual([
      { fullName: 'acme/alpha', name: 'alpha', defaultBranch: 'main' },
      { fullName: 'acme/beta', name: 'beta', defaultBranch: 'master' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('GET /installation/repositories');
    expect(calls[0]!.options).toMatchObject({ per_page: 100, page: 1 });
  });

  it('walks pages until a partial page signals the end', async () => {
    // 100 first page → 50 second page (signals stop)
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      full_name: `acme/repo-${i}`,
      name: `repo-${i}`,
      default_branch: 'main',
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      full_name: `acme/repo-${100 + i}`,
      name: `repo-${100 + i}`,
      default_branch: 'main',
    }));
    const { provider, calls } = makeProvider([
      { data: { repositories: page1 } },
      { data: { repositories: page2 } },
    ]);

    const repos = await provider.listRepositories();

    expect(repos).toHaveLength(150);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options).toMatchObject({ page: 2 });
  });

  it('defaults the branch to "main" when GitHub omits default_branch', async () => {
    const { provider } = makeProvider([
      {
        data: {
          repositories: [
            { full_name: 'acme/no-default', name: 'no-default' /* default_branch missing */ },
          ],
        },
      },
    ]);

    const repos = await provider.listRepositories();
    expect(repos[0]!.defaultBranch).toBe('main');
  });
});

describe('GitHubProvider.listBranches', () => {
  it('paginates GET /repos/{owner}/{repo}/branches and aggregates names', async () => {
    const { provider, calls } = makeProvider([
      { data: [{ name: 'main' }, { name: 'develop' }] },
    ]);

    const branches = await provider.listBranches('acme/triage');

    expect(branches).toEqual(['main', 'develop']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('GET /repos/{owner}/{repo}/branches');
    expect(calls[0]!.options).toMatchObject({
      owner: 'acme',
      repo: 'triage',
      per_page: 100,
      page: 1,
    });
  });

  it('throws on malformed repository strings (no slash)', async () => {
    const { provider } = makeProvider([]);
    await expect(provider.listBranches('not-a-repo-path')).rejects.toThrow(
      /Invalid repository format/,
    );
  });
});

describe('GitHubProvider.getLatestCommitSha', () => {
  it('returns the commit SHA for a found branch', async () => {
    const { provider, calls } = makeProvider([
      { data: { commit: { sha: 'abc123sha' } } },
    ]);

    const sha = await provider.getLatestCommitSha('acme/triage', 'main');

    expect(sha).toBe('abc123sha');
    expect(calls[0]!.url).toBe('GET /repos/{owner}/{repo}/branches/{branch}');
    expect(calls[0]!.options).toMatchObject({
      owner: 'acme',
      repo: 'triage',
      branch: 'main',
    });
  });

  it('returns null on malformed repository (does not throw)', async () => {
    const { provider } = makeProvider([]);
    const sha = await provider.getLatestCommitSha('no-slash', 'main');
    expect(sha).toBeNull();
  });

  it('returns null when Octokit errors (does not propagate — best-effort)', async () => {
    const { provider } = makeProvider([]);
    // Empty queue → next call throws → method swallows + returns null
    const sha = await provider.getLatestCommitSha('acme/triage', 'main');
    expect(sha).toBeNull();
  });
});
