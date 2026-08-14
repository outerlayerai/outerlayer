/**
 * GitHubProvider.getPullRequestClosingIssues tests.
 *
 * The evidence comment's issue integration reads the PR's declared closing
 * references through this method, so its contract is pinned here: the
 * GraphQL query's variables, the field mapping (labels flattened, a missing
 * issue type becoming null), and the one degradation — ANY failure is
 * `unavailable`, never an error the comment should surface.
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
    graphql: vi.fn(),
    rest: {},
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(asOctokit(mock)), octokit: mock };
}

describe('GitHubProvider.getPullRequestClosingIssues', () => {
  it('maps the closing references with labels flattened and type nullable', async () => {
    const { provider, octokit } = createProvider();
    octokit.graphql.mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                number: 91,
                title: 'Fix the flaky signup',
                body: '### Validation required\n- [ ] red-then-green\n',
                labels: { nodes: [{ name: 'bug' }, { name: 'auth' }] },
                issueType: { name: 'Bug' },
              },
              {
                number: 92,
                title: 'Add the allowlist',
                body: null,
                labels: null,
                issueType: null,
              },
              null,
            ],
          },
        },
      },
    });

    const result = await provider.getPullRequestClosingIssues('org/repo', 42);

    expect(octokit.graphql).toHaveBeenCalledWith(expect.stringContaining('closingIssuesReferences'), {
      owner: 'org',
      repo: 'repo',
      number: 42,
    });
    expect(result).toEqual({
      status: 'ok',
      issues: [
        {
          number: 91,
          title: 'Fix the flaky signup',
          body: '### Validation required\n- [ ] red-then-green\n',
          labels: ['bug', 'auth'],
          typeName: 'Bug',
        },
        { number: 92, title: 'Add the allowlist', body: '', labels: [], typeName: null },
      ],
    });
  });

  it('returns ok with no issues for a PR that closes nothing', async () => {
    const { provider, octokit } = createProvider();
    octokit.graphql.mockResolvedValue({
      repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } },
    });

    await expect(provider.getPullRequestClosingIssues('org/repo', 42)).resolves.toEqual({
      status: 'ok',
      issues: [],
    });
  });

  it('degrades to unavailable on any failure — GraphQL errors included', async () => {
    const { provider, octokit } = createProvider();
    octokit.graphql.mockRejectedValue(new Error('GraphQL error: something exploded'));
    await expect(provider.getPullRequestClosingIssues('org/repo', 42)).resolves.toEqual({
      status: 'unavailable',
    });

    octokit.graphql.mockResolvedValue({ repository: null });
    await expect(provider.getPullRequestClosingIssues('org/repo', 42)).resolves.toEqual({
      status: 'ok',
      issues: [],
    });
  });
});
