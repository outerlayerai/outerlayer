/**
 * GitHub provider — per-PR review listing for the review-milestone backfill
 * for decomposed cycle time.
 *
 * Drives the REAL `GitHubProvider.listPullRequestReviews` against
 * MSW-intercepted Octokit calls and pins what `computeReviewFirsts` depends
 * on: state normalized to lowercase, PENDING (unsubmitted) reviews dropped,
 * DISMISSED kept, author id + submitted_at carried through, and the
 * single-page (first 100, chronological) fetch shape.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Octokit } from 'octokit';
import { server } from '../../../../../test-helpers/msw-server';
import { GitHubProvider } from '../client';

const REPO = 'acme/repo';
const API = 'https://api.github.com/repos/acme/repo';

describe('GitHubProvider.listPullRequestReviews', () => {
  it('maps submitted reviews (lowercased state), drops PENDING, keeps DISMISSED', async () => {
    const requested: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/pulls/7/reviews`, ({ request }) => {
        requested.push(new URL(request.url).searchParams);
        return HttpResponse.json([
          {
            user: { id: 777, type: 'User' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-07-01T11:00:00Z',
          },
          { user: { id: 888, type: 'User' }, state: 'PENDING', submitted_at: null },
          {
            user: { id: 900, type: 'Bot' },
            state: 'APPROVED',
            submitted_at: '2026-07-01T11:30:00Z',
          },
          {
            user: { id: 888, type: 'User' },
            state: 'DISMISSED',
            submitted_at: '2026-07-01T12:00:00Z',
          },
          {
            user: null,
            state: 'APPROVED',
            submitted_at: '2026-07-02T09:00:00Z',
          },
        ]);
      })
    );

    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    const reviews = await provider.listPullRequestReviews(REPO, 7);

    expect(reviews).toEqual([
      { authorId: 777, isBot: false, state: 'changes_requested', submittedAt: '2026-07-01T11:00:00Z' },
      { authorId: 900, isBot: true, state: 'approved', submittedAt: '2026-07-01T11:30:00Z' },
      { authorId: 888, isBot: false, state: 'dismissed', submittedAt: '2026-07-01T12:00:00Z' },
      { authorId: null, isBot: false, state: 'approved', submittedAt: '2026-07-02T09:00:00Z' },
    ]);
    // One full first page — "first review"/"first approval" live at the front
    // of GitHub's chronological list, so no pagination walk.
    expect(requested).toHaveLength(1);
    expect(requested[0]!.get('per_page')).toBe('100');
  });

  it('returns [] for a PR with no reviews', async () => {
    server.use(http.get(`${API}/pulls/9/reviews`, () => HttpResponse.json([])));
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    expect(await provider.listPullRequestReviews(REPO, 9)).toEqual([]);
  });

  it('maps provider errors through handleError (typed, repo-tagged)', async () => {
    server.use(
      http.get(`${API}/pulls/8/reviews`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 })
      )
    );
    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    await expect(provider.listPullRequestReviews(REPO, 8)).rejects.toThrow(/acme\/repo/);
  });
});
