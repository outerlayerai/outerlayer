/**
 * GitHubProvider unit tests.
 *
 * Tests the GitHub client adapter that wraps Octokit to conform
 * to the GitProvider interface. Each test mocks the underlying
 * Octokit API calls.
 */

// Mock server-only (imported by github/client.ts)
vi.mock('server-only', () => ({}));

// Mock verifySignature
const mockVerifySignature = vi.fn();
vi.mock('@repo/shared-utils', () => ({
  verifySignature: (...args: unknown[]) => mockVerifySignature(...args),
}));

import { GitHubProvider } from '../github/client';
import {
  AuthenticationError,
  RepositoryNotFoundError,
  FileNotFoundError,
  RateLimitError,
} from '../errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock Octokit instance with all methods stubbed. */
function createMockOctokit() {
  return {
    request: vi.fn(),
    rest: {
      repos: {
        listBranches: vi.fn(),
        getBranch: vi.fn(),
        getContent: vi.fn(),
        compareCommits: vi.fn(),
        createWebhook: vi.fn(),
        deleteWebhook: vi.fn(),
      },
      git: {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
        updateRef: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(mock as any), octokit: mock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubProvider', () => {
  // -----------------------------------------------------------------------
  // Constructor and type
  // -----------------------------------------------------------------------

  it('should have type "github"', () => {
    const { provider } = createProvider();
    expect(provider.type).toBe('github');
  });

  // -----------------------------------------------------------------------
  // fromContext
  // -----------------------------------------------------------------------

  describe('fromContext', () => {
    it('should throw AuthenticationError when installationId is missing', async () => {
      const mockApp = { getInstallationOctokit: vi.fn() } as any;

      await expect(
        GitHubProvider.fromContext({ provider: 'github' }, mockApp)
      ).rejects.toThrow(AuthenticationError);
    });

    it('should create a GitHubProvider when installationId is present', async () => {
      const mockOctokit = createMockOctokit();
      const mockApp = {
        getInstallationOctokit: vi.fn().mockResolvedValue(mockOctokit),
      } as any;

      const provider = await GitHubProvider.fromContext(
        { provider: 'github', installationId: 999 },
        mockApp
      );

      expect(provider).toBeInstanceOf(GitHubProvider);
      expect(mockApp.getInstallationOctokit).toHaveBeenCalledWith(999);
    });
  });

  // -----------------------------------------------------------------------
  // listRepositories
  // -----------------------------------------------------------------------

  describe('listRepositories', () => {
    it('should return mapped repositories on success', async () => {
      const { provider, octokit } = createProvider();

      octokit.request.mockResolvedValue({
        data: {
          repositories: [
            { full_name: 'org/repo-a', name: 'repo-a', default_branch: 'main' },
            { full_name: 'org/repo-b', name: 'repo-b', default_branch: null },
          ],
        },
      });

      const repos = await provider.listRepositories();

      expect(repos).toEqual([
        { fullName: 'org/repo-a', name: 'repo-a', defaultBranch: 'main' },
        { fullName: 'org/repo-b', name: 'repo-b', defaultBranch: 'main' },
      ]);
    });

    it('should return empty array when repositories is falsy', async () => {
      const { provider, octokit } = createProvider();

      octokit.request.mockResolvedValue({ data: { repositories: null } });

      const repos = await provider.listRepositories();
      expect(repos).toEqual([]);
    });

    it('should throw AuthenticationError on 401', async () => {
      const { provider, octokit } = createProvider();
      octokit.request.mockRejectedValue({ status: 401, message: 'Bad credentials' });

      await expect(provider.listRepositories()).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError on 403', async () => {
      const { provider, octokit } = createProvider();
      octokit.request.mockRejectedValue({ status: 403, message: 'Forbidden' });

      await expect(provider.listRepositories()).rejects.toThrow(AuthenticationError);
    });
  });

  // -----------------------------------------------------------------------
  // listBranches
  // -----------------------------------------------------------------------

  describe('listBranches', () => {
    it('should return branch names on success', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.listBranches.mockResolvedValue({
        data: [{ name: 'main' }, { name: 'develop' }],
      });

      const branches = await provider.listBranches('org/repo');

      expect(branches).toEqual(['main', 'develop']);
      expect(octokit.rest.repos.listBranches).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        per_page: 100,
        page: 1,
      });
    });

    it('should paginate when a full page is returned', async () => {
      const { provider, octokit } = createProvider();

      // First call returns exactly 100 items (triggers next page)
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        name: `branch-${i}`,
      }));
      octokit.rest.repos.listBranches
        .mockResolvedValueOnce({ data: fullPage })
        .mockResolvedValueOnce({ data: [{ name: 'extra' }] });

      const branches = await provider.listBranches('org/repo');

      expect(branches).toHaveLength(101);
      expect(octokit.rest.repos.listBranches).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no branches exist', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.listBranches.mockResolvedValue({ data: [] });

      const branches = await provider.listBranches('org/repo');
      expect(branches).toEqual([]);
    });

    it('should throw RepositoryNotFoundError on 404', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.listBranches.mockRejectedValue({ status: 404 });

      await expect(provider.listBranches('org/repo')).rejects.toThrow(
        RepositoryNotFoundError
      );
    });

    it('should throw RepositoryNotFoundError when repo format is invalid', async () => {
      const { provider } = createProvider();

      await expect(provider.listBranches('invalid-repo')).rejects.toThrow(
        RepositoryNotFoundError
      );
    });

    it('should throw RateLimitError on 429', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.listBranches.mockRejectedValue({ status: 429 });

      await expect(provider.listBranches('org/repo')).rejects.toThrow(RateLimitError);
    });
  });

  // -----------------------------------------------------------------------
  // getLatestCommitSha
  // -----------------------------------------------------------------------

  describe('getLatestCommitSha', () => {
    it('should return the commit SHA on success', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.getBranch.mockResolvedValue({
        data: { commit: { sha: 'abc123' } },
      });

      const sha = await provider.getLatestCommitSha('org/repo', 'main');
      expect(sha).toBe('abc123');
    });

    it('should return null on error', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.getBranch.mockRejectedValue(new Error('Not found'));

      const sha = await provider.getLatestCommitSha('org/repo', 'nonexistent');
      expect(sha).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getFileContent
  // -----------------------------------------------------------------------

  describe('getFileContent', () => {
    it('should return decoded file content on success', async () => {
      const { provider, octokit } = createProvider();
      const fileContent = 'hello world';
      const base64Content = Buffer.from(fileContent).toString('base64');

      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'README.md',
          content: base64Content,
          sha: 'file-sha-123',
          size: 11,
        },
      });

      const result = await provider.getFileContent('org/repo', 'README.md', 'main');

      expect(result).toEqual({
        path: 'README.md',
        content: 'hello world',
        sha: 'file-sha-123',
        size: 11,
        encoding: 'utf-8',
      });
    });

    it('should throw FileNotFoundError when response is an array (directory)', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.getContent.mockResolvedValue({
        data: [{ name: 'file.txt', path: 'dir/file.txt', type: 'file' }],
      });

      await expect(
        provider.getFileContent('org/repo', 'dir', 'main')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should throw FileNotFoundError when data type is not file', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'dir', path: 'some-dir' },
      });

      await expect(
        provider.getFileContent('org/repo', 'some-dir', 'main')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should throw FileNotFoundError on 404', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });

      await expect(
        provider.getFileContent('org/repo', 'missing.txt', 'main')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should throw AuthenticationError on 401', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.repos.getContent.mockRejectedValue({ status: 401, message: 'Unauthorized' });

      await expect(
        provider.getFileContent('org/repo', 'secret.txt', 'main')
      ).rejects.toThrow(AuthenticationError);
    });
  });

  // -----------------------------------------------------------------------
  // listDirectory
  // -----------------------------------------------------------------------

  describe('listDirectory', () => {
    it('should return mapped directory entries on success', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.getContent.mockResolvedValue({
        data: [
          { path: 'src/index.ts', name: 'index.ts', type: 'file', sha: 'sha1', size: 100 },
          { path: 'src/utils', name: 'utils', type: 'dir', sha: 'sha2', size: 0 },
        ],
      });

      const entries = await provider.listDirectory('org/repo', 'src', 'main');

      expect(entries).toEqual([
        { path: 'src/index.ts', name: 'index.ts', type: 'file', sha: 'sha1', size: 100 },
        { path: 'src/utils', name: 'utils', type: 'dir', sha: 'sha2', size: 0 },
      ]);
    });

    it('should return empty array when response is a single file', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'file', path: 'single.txt' },
      });

      const entries = await provider.listDirectory('org/repo', 'single.txt', 'main');
      expect(entries).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // compareCommits
  // -----------------------------------------------------------------------

  describe('compareCommits', () => {
    it('should return mapped file diffs on success', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.compareCommits.mockResolvedValue({
        data: {
          files: [
            {
              filename: 'src/index.ts',
              status: 'modified',
              additions: 5,
              deletions: 2,
              patch: '@@ -1 +1 @@',
              sha: 'diff-sha',
            },
            {
              filename: 'src/new.ts',
              status: 'added',
              additions: 10,
              deletions: 0,
              sha: 'new-sha',
            },
          ],
        },
      });

      const diffs = await provider.compareCommits('org/repo', 'abc', 'def');

      expect(diffs).toHaveLength(2);
      expect(diffs[0]!).toEqual({
        path: 'src/index.ts',
        status: 'modified',
        previousPath: undefined,
        additions: 5,
        deletions: 2,
        patch: '@@ -1 +1 @@',
        sha: 'diff-sha',
      });
      expect(diffs[1]!.status).toBe('added');
    });

    it('should return empty array when files is undefined', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.compareCommits.mockResolvedValue({
        data: { files: undefined },
      });

      const diffs = await provider.compareCommits('org/repo', 'abc', 'def');
      expect(diffs).toEqual([]);
    });

    it('should map renamed status correctly', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.compareCommits.mockResolvedValue({
        data: {
          files: [
            {
              filename: 'new-name.ts',
              status: 'renamed',
              previous_filename: 'old-name.ts',
              additions: 0,
              deletions: 0,
              sha: 'sha',
            },
          ],
        },
      });

      const diffs = await provider.compareCommits('org/repo', 'abc', 'def');
      expect(diffs[0]!.status).toBe('renamed');
      expect(diffs[0]!.previousPath).toBe('old-name.ts');
    });

    it('should map removed status correctly', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.compareCommits.mockResolvedValue({
        data: {
          files: [
            {
              filename: 'deleted.ts',
              status: 'removed',
              additions: 0,
              deletions: 10,
              sha: 'sha',
            },
          ],
        },
      });

      const diffs = await provider.compareCommits('org/repo', 'abc', 'def');
      expect(diffs[0]!.status).toBe('removed');
    });

    it('should default unknown status to modified', async () => {
      const { provider, octokit } = createProvider();

      octokit.rest.repos.compareCommits.mockResolvedValue({
        data: {
          files: [
            {
              filename: 'file.ts',
              status: 'changed',
              additions: 1,
              deletions: 1,
              sha: 'sha',
            },
          ],
        },
      });

      const diffs = await provider.compareCommits('org/repo', 'abc', 'def');
      expect(diffs[0]!.status).toBe('modified');
    });
  });

  // -----------------------------------------------------------------------
  // verifyWebhookSignature
  // -----------------------------------------------------------------------

  describe('verifyWebhookSignature', () => {
    it('should return false when signature does not start with sha256=', async () => {
      const { provider } = createProvider();

      const result = await provider.verifyWebhookSignature('body', 'invalid-sig', 'secret');
      expect(result).toBe(false);
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });

    it('should delegate to verifySignature when signature prefix is correct', async () => {
      const { provider } = createProvider();
      mockVerifySignature.mockResolvedValue(true);

      const result = await provider.verifyWebhookSignature('body', 'sha256=abcdef', 'secret');

      expect(result).toBe(true);
      expect(mockVerifySignature).toHaveBeenCalledWith('secret', 'sha256=abcdef', 'body');
    });

    it('should return false when verifySignature throws', async () => {
      const { provider } = createProvider();
      mockVerifySignature.mockRejectedValue(new Error('crypto error'));

      const result = await provider.verifyWebhookSignature('body', 'sha256=abcdef', 'secret');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // parseRepo error handling
  // -----------------------------------------------------------------------

  describe('repository format validation', () => {
    it('should throw RepositoryNotFoundError when repo has no slash', async () => {
      const { provider } = createProvider();

      await expect(provider.listBranches('noslash')).rejects.toThrow(
        RepositoryNotFoundError
      );
    });

    it('should throw RepositoryNotFoundError when repo has empty segments', async () => {
      const { provider } = createProvider();

      await expect(provider.listBranches('/repo')).rejects.toThrow(
        RepositoryNotFoundError
      );
    });

    it('should throw RepositoryNotFoundError when repo has too many segments', async () => {
      const { provider } = createProvider();

      await expect(provider.listBranches('a/b/c')).rejects.toThrow(
        RepositoryNotFoundError
      );
    });
  });

  // -----------------------------------------------------------------------
  // getRecursiveTree
  //
  // The build cache uses this to look up blob SHAs for the paths recorded
  // in a prior deployment's build_manifest. The implementation calls
  // octokit.rest.repos.getCommit to find the commit's tree SHA, then
  // octokit.rest.git.getTree with recursive=true to enumerate every blob.
  // -----------------------------------------------------------------------

  describe('getRecursiveTree', () => {
    function stubCommitAndTree(
      octokit: MockOctokit,
      opts: { treeSha?: string; tree: unknown[]; truncated?: boolean }
    ) {
      // Production code calls octokit.rest.repos.getCommit and
      // octokit.rest.git.getTree. Neither is in the default mock helper
      // (which only stubs the methods existing tests need), so install them
      // explicitly here.
      (octokit.rest.repos as Record<string, unknown>)['getCommit'] = vi.fn().mockResolvedValue({
        data: { commit: { tree: { sha: opts.treeSha ?? 'tree-sha-abc' } } },
      });
      (octokit.rest.git as Record<string, unknown>)['getTree'] = vi.fn().mockResolvedValue({
        data: { sha: opts.treeSha ?? 'tree-sha-abc', tree: opts.tree, truncated: opts.truncated ?? false },
      });
    }

    it('returns one entry per blob with {path, contentSha} from the recursive tree', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, {
        tree: [
          { path: 'src/handler.ts', sha: 'sha-handler', type: 'blob' },
          { path: 'src/utils', sha: 'sha-utils-tree', type: 'tree' }, // dir → excluded
          { path: 'src/utils/helper.ts', sha: 'sha-helper', type: 'blob' },
          { path: 'package.json', sha: 'sha-pkg', type: 'blob' },
          { path: 'commit-marker', sha: 'sha-commit', type: 'commit' }, // submodule → excluded
        ],
      });

      const entries = await provider.getRecursiveTree('owner/repo', 'main');

      // Only blob entries are returned (no trees, no commit/submodule entries).
      expect(entries).toEqual([
        { path: 'src/handler.ts', contentSha: 'sha-handler' },
        { path: 'src/utils/helper.ts', contentSha: 'sha-helper' },
        { path: 'package.json', contentSha: 'sha-pkg' },
      ]);
    });

    it('throws when GitHub returns truncated:true (cache requires complete tree)', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, {
        tree: [{ path: 'src/handler.ts', sha: 'sha-handler', type: 'blob' }],
        truncated: true,
      });

      // The implementation throws an explicit "tree is truncated" Error which
      // handleError wraps as a generic provider error. Either way the throw
      // is the contract — former caller caught and degraded to null; the throw remains the contract.
      await expect(provider.getRecursiveTree('owner/repo', 'main')).rejects.toThrow();
    });

    it('passes recursive:"true" to git.getTree (otherwise we would only get the root level)', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, { tree: [] });

      await provider.getRecursiveTree('owner/repo', 'main');

      const getTreeCall = (octokit.rest.git as Record<string, unknown>)['getTree'] as ReturnType<typeof vi.fn>;
      expect(getTreeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          tree_sha: 'tree-sha-abc',
          recursive: 'true',
        })
      );
    });

    it('skips entries with non-string path or sha (defensive against malformed responses)', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, {
        tree: [
          { path: 'good.ts', sha: 'sha-good', type: 'blob' },
          { path: undefined, sha: 'sha-no-path', type: 'blob' },
          { path: 'no-sha.ts', sha: undefined, type: 'blob' },
          { path: 'wrong-type.ts', sha: 'sha-x', type: undefined }, // missing type
        ],
      });

      const entries = await provider.getRecursiveTree('owner/repo', 'main');
      expect(entries).toEqual([{ path: 'good.ts', contentSha: 'sha-good' }]);
    });
  });

  // -----------------------------------------------------------------------
  // listTree — same commit→tree plumbing as getRecursiveTree but returns
  // {path, sha, size} for the context mirror. Covered separately because the
  // two implementations are deliberately independent (see the source comment
  // on listTree).
  // -----------------------------------------------------------------------

  describe('listTree', () => {
    function stubCommitAndTree(
      octokit: MockOctokit,
      opts: { tree: unknown[]; truncated?: boolean }
    ) {
      (octokit.rest.repos as Record<string, unknown>)['getCommit'] = vi.fn().mockResolvedValue({
        data: { commit: { tree: { sha: 'tree-sha-abc' } } },
      });
      (octokit.rest.git as Record<string, unknown>)['getTree'] = vi.fn().mockResolvedValue({
        data: { sha: 'tree-sha-abc', tree: opts.tree, truncated: opts.truncated ?? false },
      });
    }

    it('returns blobs only with size (0 when absent) and skips malformed entries', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, {
        tree: [
          { path: 'src/a.ts', sha: 'sha-a', type: 'blob', size: 120 },
          { path: 'src/dir', sha: 'sha-dir', type: 'tree', size: 3 }, // dir → excluded
          { path: 'sizeless.ts', sha: 'sha-s', type: 'blob' }, // no size → 0
          { path: undefined, sha: 'sha-no-path', type: 'blob', size: 1 }, // malformed
          { path: 'no-sha.ts', sha: undefined, type: 'blob', size: 2 }, // malformed
        ],
      });

      const entries = await provider.listTree('owner/repo', 'main');
      expect(entries).toEqual([
        { path: 'src/a.ts', sha: 'sha-a', size: 120 },
        { path: 'sizeless.ts', sha: 'sha-s', size: 0 },
      ]);
    });

    it('throws when the tree is truncated rather than mirroring a partial tree', async () => {
      const { provider, octokit } = createProvider();
      stubCommitAndTree(octokit, { tree: [], truncated: true });
      await expect(provider.listTree('owner/repo', 'main')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // createCommit — bounded blob-creation concurrency
  //
  // A batch commit's blob-creation fan-out is capped so a large batch never
  // holds more than the shared concurrency limit of `createBlob` calls in
  // flight at once against GitHub's secondary rate limit.
  // -----------------------------------------------------------------------

  describe('createCommit — bounded blob-creation concurrency', () => {
    function stubCommitPlumbing(octokit: MockOctokit, opts: { createBlob: (...args: any[]) => any }) {
      octokit.rest.git.getRef.mockResolvedValue({ data: { object: { sha: 'parent-commit-sha' } } });
      octokit.rest.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'base-tree-sha' } } });
      octokit.rest.git.createBlob.mockImplementation(opts.createBlob);
      octokit.rest.git.createTree.mockResolvedValue({ data: { sha: 'new-tree-sha' } });
      octokit.rest.git.createCommit.mockResolvedValue({
        data: {
          sha: 'new-commit-sha',
          message: 'batch commit',
          author: { name: 'Bot', email: 'bot@example.com', date: '2026-07-10T00:00:00Z' },
          html_url: 'https://github.com/owner/repo/commit/new-commit-sha',
        },
      });
      octokit.rest.git.updateRef.mockResolvedValue({});
    }

    it('never holds more than 10 createBlob calls in flight, and every blob still lands in the tree', async () => {
      const { provider, octokit } = createProvider();
      let inFlight = 0;
      let maxInFlight = 0;
      const createBlob = vi.fn(async (args: { content: string }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { data: { sha: `blob-sha-${Buffer.from(args.content, 'base64').toString()}` } };
      });
      stubCommitPlumbing(octokit, { createBlob });

      const changes = Array.from({ length: 25 }, (_, i) => ({
        path: `docs/file-${i}.md`,
        content: `content-${i}`,
        operation: 'update' as const,
      }));

      await provider.createCommit('owner/repo', changes, 'batch commit', 'main', {
        name: 'Bot',
        email: 'bot@example.com',
      });

      expect(createBlob).toHaveBeenCalledTimes(25);
      expect(maxInFlight).toBeLessThanOrEqual(10);
      expect(maxInFlight).toBeGreaterThan(1);

      const treeCall = octokit.rest.git.createTree.mock.calls[0]![0] as { tree: Array<{ path: string; sha: string }> };
      expect(treeCall.tree.map((t) => t.path).sort()).toEqual(changes.map((c) => c.path).sort());
      expect(treeCall.tree).toHaveLength(25);
    });

    it('creates zero blobs for a delete-only batch', async () => {
      const { provider, octokit } = createProvider();
      const createBlob = vi.fn();
      stubCommitPlumbing(octokit, { createBlob });

      await provider.createCommit(
        'owner/repo',
        [{ path: 'docs/gone.md', content: '', operation: 'delete' }],
        'delete commit',
        'main',
        { name: 'Bot', email: 'bot@example.com' },
      );

      expect(createBlob).not.toHaveBeenCalled();
      const treeCall = octokit.rest.git.createTree.mock.calls[0]![0] as { tree: Array<{ path: string; sha: string | null }> };
      expect(treeCall.tree).toEqual([{ path: 'docs/gone.md', mode: '100644', type: 'blob', sha: null }]);
    });
  });
});
