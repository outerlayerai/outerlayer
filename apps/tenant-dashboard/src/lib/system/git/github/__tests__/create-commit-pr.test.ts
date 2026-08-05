/**
 * GitHub provider — the fallback/forced PR path with a stable, reused head
 * branch.
 *
 * Drives the REAL `GitHubProvider.createCommitWithFallback` against the actual
 * Octokit HTTP calls (intercepted by MSW) and pins the accumulation contract:
 * when an open PR already targets the head branch the commit is rebuilt ON the
 * head-branch tip and the ref is fast-forwarded (no force) — an earlier save on
 * the branch is never dropped; when there is no open PR a fresh branch is
 * (re)created and a PR opened, and the reason the change went to a PR is
 * reported.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Octokit } from 'octokit';
import { server } from '../../../../../test-helpers/msw-server';
import { GitHubProvider } from '../client';
import type { FileChange, CommitAuthor } from '../../types';

const REPO = 'acme/repo';
const API = 'https://api.github.com/repos/acme/repo';
// Connected-branch (main) tip vs the reused head branch's current tip.
const TIP_SHA = 'a'.repeat(40);
const HEAD_TIP_SHA = 'b'.repeat(40);
const STABLE_BRANCH = 'outerlayer/context/main';
const committer: CommitAuthor = { name: 'Test User', email: 'test@example.com' };
const changes: FileChange[] = [
  { path: '.outerlayer/AGENTS.md', content: 'hi', operation: 'update' },
];

interface Recorder {
  commitParents: string[][];
  patchedRefs: Array<{ url: string; sha?: string; force?: boolean }>;
  createdRefBody: { ref?: string; sha?: string };
  pullsCreated: number;
}

/**
 * Git-data handlers shared by the forced-PR scenarios. `getRef` distinguishes
 * the connected branch (→ TIP_SHA) from the reused head branch (→ HEAD_TIP_SHA)
 * by the ref in the URL, so the rebuilt commit's parent proves which tip it was
 * built on. `createCommit` returns a sha derived from the parent so the result
 * commit is traceable to base-tip vs head-tip.
 */
function seedGitData(opts: {
  openPrs: unknown[];
  createRefStatus?: number;
}): Recorder {
  const rec: Recorder = {
    commitParents: [],
    patchedRefs: [],
    createdRefBody: {},
    pullsCreated: 0,
  };

  server.use(
    http.get(`${API}/git/ref/*`, ({ request }) =>
      HttpResponse.json({
        ref: 'refs/heads/x',
        object: { sha: request.url.includes('context') ? HEAD_TIP_SHA : TIP_SHA },
      })
    ),
    http.get(`${API}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({ sha: params.sha, tree: { sha: `tree-${params.sha}` } })
    ),
    http.post(`${API}/git/blobs`, () => HttpResponse.json({ sha: 'blob-sha' })),
    http.post(`${API}/git/trees`, () => HttpResponse.json({ sha: 'new-tree' })),
    http.post(`${API}/git/commits`, async ({ request }) => {
      const body = (await request.json()) as { parents: string[] };
      rec.commitParents.push(body.parents);
      const sha = body.parents[0] === HEAD_TIP_SHA ? 'acc-commit' : 'base-commit';
      return HttpResponse.json({
        sha,
        author: { name: committer.name, email: committer.email, date: '2026-06-16T00:00:00Z' },
        html_url: `https://github.com/acme/repo/commit/${sha}`,
      });
    }),
    http.get(`${API}/pulls`, () => HttpResponse.json(opts.openPrs)),
    http.post(`${API}/git/refs`, async ({ request }) => {
      rec.createdRefBody = (await request.json()) as Recorder['createdRefBody'];
      if (opts.createRefStatus) {
        return HttpResponse.json({ message: 'Reference already exists' }, { status: opts.createRefStatus });
      }
      return HttpResponse.json({ ref: rec.createdRefBody.ref, object: { sha: rec.createdRefBody.sha } });
    }),
    http.patch(`${API}/git/refs/*`, async ({ request }) => {
      const body = (await request.json()) as { sha?: string; force?: boolean };
      rec.patchedRefs.push({ url: request.url, sha: body.sha, force: body.force });
      return HttpResponse.json({ object: { sha: body.sha } });
    }),
    http.post(`${API}/pulls`, () => {
      rec.pullsCreated += 1;
      return HttpResponse.json({ html_url: 'https://github.com/acme/repo/pull/42', number: 42 });
    })
  );

  return rec;
}

describe('GitHubProvider.createCommitWithFallback — reused head branch', () => {
  it('accumulates onto an already-open PR: commit built on the head tip, ref fast-forwarded (no force), no new PR', async () => {
    const rec = seedGitData({
      openPrs: [{ html_url: 'https://github.com/acme/repo/pull/7', number: 7 }],
    });
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));

    const result = await provider.createCommitWithFallback(
      REPO,
      changes,
      'context: update instructions',
      'main',
      committer,
      { forcePullRequest: true, headBranchName: STABLE_BRANCH }
    );

    expect(result.landed).toBe('pull_request');
    expect(result.pullRequestAction).toBe('updated');
    expect(result.pullRequestNumber).toBe(7);
    expect(result.pullRequestUrl).toBe('https://github.com/acme/repo/pull/7');
    expect(result.fallbackReason).toBe('forced');
    // The landed commit was rebuilt on the HEAD branch tip, not the base tip.
    expect(result.commit.sha).toBe('acc-commit');
    expect(rec.commitParents).toContainEqual([HEAD_TIP_SHA]);
    // Ref moved to the accumulated commit as a fast-forward (force never set).
    expect(rec.patchedRefs).toEqual([
      { url: expect.stringContaining('context'), sha: 'acc-commit', force: undefined },
    ]);
    // No duplicate PR opened.
    expect(rec.pullsCreated).toBe(0);
  });

  it('no open PR + a stale branch ref: force-resets the branch to the base-tip commit and opens a fresh PR', async () => {
    const rec = seedGitData({ openPrs: [], createRefStatus: 422 });
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));

    const result = await provider.createCommitWithFallback(
      REPO,
      changes,
      'context: update instructions',
      'main',
      committer,
      { forcePullRequest: true, headBranchName: STABLE_BRANCH }
    );

    expect(result.landed).toBe('pull_request');
    expect(result.pullRequestAction).toBe('created');
    expect(result.pullRequestNumber).toBe(42);
    expect(result.fallbackReason).toBe('forced');
    // The PR carries the base-tip commit (no head branch to accumulate on).
    expect(result.commit.sha).toBe('base-commit');
    expect(rec.commitParents).toEqual([[TIP_SHA]]);
    // The stale ref was force-reset to the base-built commit.
    expect(rec.patchedRefs).toEqual([
      { url: expect.stringContaining('context'), sha: 'base-commit', force: true },
    ]);
    expect(rec.pullsCreated).toBe(1);
  });

  it('retries the reuse fast-forward when a concurrent save advances the head (first PATCH 422s)', async () => {
    const rec = seedGitData({
      openPrs: [{ html_url: 'https://github.com/acme/repo/pull/7', number: 7 }],
    });
    // The fast-forward updateRef on the reused branch races another save: the
    // first attempt is a non-fast-forward, the retry (rebuilt on the new tip)
    // lands. Override only the side-branch PATCH; leave the recorder intact.
    let ffAttempts = 0;
    server.use(
      http.patch(`${API}/git/refs/*`, async ({ request }) => {
        const body = (await request.json()) as { sha?: string };
        rec.patchedRefs.push({ url: request.url, sha: body.sha, force: undefined });
        ffAttempts += 1;
        if (ffAttempts === 1) {
          return HttpResponse.json({ message: 'Update is not a fast forward' }, { status: 422 });
        }
        return HttpResponse.json({ object: { sha: body.sha } });
      })
    );
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));

    const result = await provider.createCommitWithFallback(
      REPO,
      changes,
      'context: update instructions',
      'main',
      committer,
      { forcePullRequest: true, headBranchName: STABLE_BRANCH }
    );

    expect(result.landed).toBe('pull_request');
    expect(result.pullRequestAction).toBe('updated');
    expect(result.pullRequestNumber).toBe(7);
    // Two fast-forward attempts: the 422 then the successful retry.
    expect(ffAttempts).toBe(2);
    // The head tip was re-read and the commit rebuilt before the retry.
    expect(rec.commitParents.filter((p) => p[0] === HEAD_TIP_SHA)).toHaveLength(2);
    expect(rec.pullsCreated).toBe(0);
  });

  it('reports a protected-branch fallback (not a forced one) when the direct push is rejected', async () => {
    const rec = seedGitData({ openPrs: [] });
    // The direct push to the connected branch is rejected by branch protection.
    // Octokit percent-encodes the ref, so match the whole `/git/refs/*` tail and
    // reject only the connected branch (the side branch carries `context`).
    server.use(
      http.patch(`${API}/git/refs/*`, ({ request }) => {
        if (request.url.includes('context')) {
          return HttpResponse.json({ object: { sha: 'x' } });
        }
        return HttpResponse.json(
          { message: 'At least 1 approving review is required — protected branch' },
          { status: 403 }
        );
      })
    );
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));

    const result = await provider.createCommitWithFallback(
      REPO,
      changes,
      'context: update instructions',
      'main',
      committer,
      // No forcePullRequest: the PR happens only because the push was rejected.
      { headBranchName: STABLE_BRANCH }
    );

    expect(result.landed).toBe('pull_request');
    expect(result.fallbackReason).toBe('protected_branch');
    expect(result.pullRequestAction).toBe('created');
    expect(result.pullRequestNumber).toBe(42);
    expect(rec.pullsCreated).toBe(1);
  });
});
