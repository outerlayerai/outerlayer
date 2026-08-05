/**
 * GitHub provider — PR listing for the PR-history backfill.
 *
 * Drives the REAL `GitHubProvider.listPullRequests` against MSW-intercepted
 * Octokit calls and pins the two things the backfill depends on:
 *   1. the lifecycle mapping — especially that a closed-with-merged_at PR maps
 *      to state "merged" (GitHub's list payload says `state: closed` for
 *      merged PRs; merged_at is the discriminator), and
 *   2. pagination + the limit cap (newest-first, state=all).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Octokit } from 'octokit';
import { server } from '../../../../../test-helpers/msw-server';
import { GitHubProvider } from '../client';

const REPO = 'acme/repo';
const API = 'https://api.github.com/repos/acme/repo';

function ghPr(over: Record<string, unknown> = {}) {
  return {
    number: 1,
    state: 'open',
    user: { id: 501 },
    draft: false,
    html_url: 'https://github.com/acme/repo/pull/1',
    created_at: '2026-07-01T10:00:00Z',
    closed_at: null,
    merged_at: null,
    head: { ref: 'feat/x', sha: 'a'.repeat(40) },
    base: { ref: 'main' },
    ...over,
  };
}

describe('GitHubProvider.listPullRequests', () => {
  let requestedSearch: URLSearchParams[];

  beforeEach(() => {
    requestedSearch = [];
  });

  it('maps lifecycle fields; merged_at (not state) discriminates merged from closed', async () => {
    server.use(
      http.get(`${API}/pulls`, ({ request }) => {
        requestedSearch.push(new URL(request.url).searchParams);
        return HttpResponse.json([
          ghPr({ number: 3 }),
          ghPr({
            number: 2,
            state: 'closed',
            closed_at: '2026-07-02T12:00:00Z',
            merged_at: '2026-07-02T12:00:00Z',
            html_url: 'https://github.com/acme/repo/pull/2',
          }),
          ghPr({
            number: 1,
            state: 'closed',
            closed_at: '2026-07-01T18:00:00Z',
            merged_at: null,
          }),
        ]);
      })
    );

    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    const prs = await provider.listPullRequests(REPO, { limit: 50 });

    expect(prs).toEqual([
      {
        number: 3,
        authorId: 501,
        draft: false,
        headBranch: 'feat/x',
        headSha: 'a'.repeat(40),
        baseBranch: 'main',
        state: 'open',
        url: 'https://github.com/acme/repo/pull/1',
        openedAt: '2026-07-01T10:00:00Z',
        closedAt: null,
        mergedAt: null,
      },
      {
        number: 2,
        authorId: 501,
        draft: false,
        headBranch: 'feat/x',
        headSha: 'a'.repeat(40),
        baseBranch: 'main',
        state: 'merged',
        url: 'https://github.com/acme/repo/pull/2',
        openedAt: '2026-07-01T10:00:00Z',
        closedAt: '2026-07-02T12:00:00Z',
        mergedAt: '2026-07-02T12:00:00Z',
      },
      {
        number: 1,
        authorId: 501,
        draft: false,
        headBranch: 'feat/x',
        headSha: 'a'.repeat(40),
        baseBranch: 'main',
        state: 'closed',
        url: 'https://github.com/acme/repo/pull/1',
        openedAt: '2026-07-01T10:00:00Z',
        closedAt: '2026-07-01T18:00:00Z',
        mergedAt: null,
      },
    ]);
    // Backfill wants history across ALL states, newest-first by creation.
    expect(requestedSearch[0]!.get('state')).toBe('all');
    expect(requestedSearch[0]!.get('sort')).toBe('created');
    expect(requestedSearch[0]!.get('direction')).toBe('desc');
  });

  it('maps the draft flag (true, and false when the payload omits it)', async () => {
    server.use(
      http.get(`${API}/pulls`, () => {
        const noDraftField = ghPr({ number: 1 }) as Record<string, unknown>;
        delete noDraftField.draft;
        return HttpResponse.json([ghPr({ number: 2, draft: true }), noDraftField]);
      })
    );

    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    const prs = await provider.listPullRequests(REPO, { limit: 50 });

    expect(prs.map((p) => [p.number, p.draft])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('paginates full pages and stops exactly at the limit', async () => {
    server.use(
      http.get(`${API}/pulls`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        requestedSearch.push(params);
        const page = Number(params.get('page'));
        const perPage = Number(params.get('per_page'));
        // Every page is full — only the limit can stop the loop.
        const start = (page - 1) * perPage;
        return HttpResponse.json(
          Array.from({ length: perPage }, (_, i) => ghPr({ number: 1000 - (start + i) }))
        );
      })
    );

    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    const prs = await provider.listPullRequests(REPO, { limit: 150 });

    expect(prs).toHaveLength(150);
    expect(prs[0]!.number).toBe(1000);
    expect(prs[149]!.number).toBe(851);
    // 100-per-page → exactly two requests for limit 150.
    expect(requestedSearch.map((p) => p.get('page'))).toEqual(['1', '2']);
    expect(requestedSearch[0]!.get('per_page')).toBe('100');
  });

  it('stops after a short page (no phantom extra request)', async () => {
    server.use(
      http.get(`${API}/pulls`, ({ request }) => {
        requestedSearch.push(new URL(request.url).searchParams);
        return HttpResponse.json([ghPr({ number: 5 }), ghPr({ number: 4 })]);
      })
    );

    const provider = new GitHubProvider(new Octokit({ auth: 'test-token' }));
    const prs = await provider.listPullRequests(REPO, { limit: 100 });

    expect(prs.map((p) => p.number)).toEqual([5, 4]);
    expect(requestedSearch).toHaveLength(1);
  });
});
