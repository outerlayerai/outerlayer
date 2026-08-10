/**
 * GitHubProvider issue-comment method tests.
 *
 * Covers `createIssueComment`, `updateIssueComment`, `getIssueComment`, and
 * `listIssueComments` —
 * all three hit the *issue*-comment endpoints (PR comments are issue
 * comments in GitHub's API), never the separate pull-request review-comment
 * endpoints. Each test mocks the underlying Octokit API calls, mirroring the
 * style of `github-client.test.ts`.
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
import { AuthenticationError } from '../errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock Octokit instance stubbed with the issue-comment endpoints. */
function createMockOctokit() {
  return {
    request: vi.fn(),
    rest: {
      issues: {
        createComment: vi.fn(),
        updateComment: vi.fn(),
        getComment: vi.fn(),
        listComments: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

function createProvider(octokit?: MockOctokit) {
  const mock = octokit ?? createMockOctokit();
  return { provider: new GitHubProvider(mock as unknown as Octokit), octokit: mock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubProvider issue comments', () => {
  // -----------------------------------------------------------------------
  // createIssueComment
  // -----------------------------------------------------------------------

  describe('createIssueComment', () => {
    it('should create a comment on the issue-comment endpoint and return the mapped result', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 555,
          body: 'Hello from the bot',
          html_url: 'https://github.com/org/repo/issues/12#issuecomment-555',
        },
      });

      const result = await provider.createIssueComment('org/repo', 12, 'Hello from the bot');

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 12,
        body: 'Hello from the bot',
      });
      expect(result).toEqual({
        status: 'ok',
        id: 555,
        body: 'Hello from the bot',
        htmlUrl: 'https://github.com/org/repo/issues/12#issuecomment-555',
      });
    });

    it('should return {status: "not_permitted"} on 403 without throwing', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.createComment.mockRejectedValue({ status: 403, message: 'Forbidden' });

      // .resolves (rather than .rejects) is itself the "does not throw"
      // assertion: if createIssueComment rejected, this would fail.
      await expect(provider.createIssueComment('org/repo', 12, 'body')).resolves.toEqual({
        status: 'not_permitted',
      });
    });

    it('should throw on a non-403 error', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.createComment.mockRejectedValue({ status: 500, message: 'Server error' });

      await expect(provider.createIssueComment('org/repo', 12, 'body')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // updateIssueComment
  // -----------------------------------------------------------------------

  describe('updateIssueComment', () => {
    it('should update the comment on the issue-comment endpoint and return the mapped result', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.updateComment.mockResolvedValue({
        data: {
          id: 555,
          body: 'Updated body',
          html_url: 'https://github.com/org/repo/issues/12#issuecomment-555',
        },
      });

      const result = await provider.updateIssueComment('org/repo', 555, 'Updated body');

      expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        comment_id: 555,
        body: 'Updated body',
      });
      expect(result).toEqual({
        status: 'ok',
        id: 555,
        body: 'Updated body',
        htmlUrl: 'https://github.com/org/repo/issues/12#issuecomment-555',
      });
    });

    it('should return {status: "not_permitted"} on 403 without throwing', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.updateComment.mockRejectedValue({ status: 403, message: 'Forbidden' });

      await expect(provider.updateIssueComment('org/repo', 555, 'body')).resolves.toEqual({
        status: 'not_permitted',
      });
    });

    it('should return {status: "gone"} on 404', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.updateComment.mockRejectedValue({ status: 404, message: 'Not Found' });

      const result = await provider.updateIssueComment('org/repo', 555, 'body');

      expect(result).toEqual({ status: 'gone' });
    });

    it('should throw on a non-403/404 error', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.updateComment.mockRejectedValue({ status: 401, message: 'Bad credentials' });

      await expect(provider.updateIssueComment('org/repo', 555, 'body')).rejects.toThrow(
        AuthenticationError
      );
    });
  });

  // -----------------------------------------------------------------------
  // getIssueComment
  // -----------------------------------------------------------------------

  describe('getIssueComment', () => {
    it('should fetch the comment from the issue-comment endpoint and return the mapped result', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.getComment.mockResolvedValue({
        data: {
          id: 555,
          body: 'Existing body',
          html_url: 'https://github.com/org/repo/issues/12#issuecomment-555',
        },
      });

      const result = await provider.getIssueComment('org/repo', 555);

      expect(octokit.rest.issues.getComment).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        comment_id: 555,
      });
      expect(result).toEqual({
        status: 'ok',
        id: 555,
        body: 'Existing body',
        htmlUrl: 'https://github.com/org/repo/issues/12#issuecomment-555',
      });
    });

    it('should return {status: "not_permitted"} on 403 without throwing', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.getComment.mockRejectedValue({ status: 403, message: 'Forbidden' });

      await expect(provider.getIssueComment('org/repo', 555)).resolves.toEqual({
        status: 'not_permitted',
      });
    });

    it('should return {status: "gone"} on 404', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.getComment.mockRejectedValue({ status: 404, message: 'Not Found' });

      const result = await provider.getIssueComment('org/repo', 555);

      expect(result).toEqual({ status: 'gone' });
    });

    it('should throw on a non-403/404 error', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.getComment.mockRejectedValue({ status: 429, message: 'Rate limited' });

      await expect(provider.getIssueComment('org/repo', 555)).rejects.toThrow();
    });
  });
  // -----------------------------------------------------------------------
  // listIssueComments
  // -----------------------------------------------------------------------

  describe('listIssueComments', () => {
    it('lists the issue-comment endpoint and maps id/body', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: 'first' },
          { id: 2, body: null },
        ],
      });

      const result = await provider.listIssueComments('acme/api', 812);

      expect(octokit.rest.issues.listComments).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'acme', repo: 'api', issue_number: 812 }),
      );
      expect(result).toEqual({
        status: 'ok',
        comments: [
          { id: 1, body: 'first' },
          { id: 2, body: '' },
        ],
      });
    });

    it('stops paginating once a short page arrives', async () => {
      const { provider, octokit } = createProvider();
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }));
      octokit.rest.issues.listComments
        .mockResolvedValueOnce({ data: fullPage })
        .mockResolvedValueOnce({ data: [{ id: 101, body: 'last' }] });

      const result = await provider.listIssueComments('acme/api', 812);

      expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('ok');
      expect(result.status === 'ok' && result.comments).toHaveLength(101);
    });

    // A bounded scan, not a full thread walk: a pathological thread must not
    // turn one recovery check into unbounded API calls.
    it('stops at the page ceiling rather than paginating forever', async () => {
      const { provider, octokit } = createProvider();
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }));
      octokit.rest.issues.listComments.mockResolvedValue({ data: fullPage });

      await provider.listIssueComments('acme/api', 812);

      expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(5);
    });

    // Same silence contract as the write methods: every call 403s until each
    // org admin approves the upgraded permission set.
    it('returns not_permitted on 403 rather than throwing', async () => {
      const { provider, octokit } = createProvider();
      octokit.rest.issues.listComments.mockRejectedValue({ status: 403 });

      await expect(provider.listIssueComments('acme/api', 812)).resolves.toEqual({
        status: 'not_permitted',
      });
    });
  });
});
