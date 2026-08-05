/**
 * backfillPullRequests — provider history → `pull_request` rows.
 *
 * Supabase runs through MSW (no client mocks); the GitProvider is a stubbed
 * seam (the real listPullRequests/listPullRequestReviews mappings have their
 * own per-provider tests). Pins the exact upsert payload/target (column
 * names, conflict key), the never-throws contract the repo-link flow depends
 * on, and the review-enrichment rules: newest-slice cap, per-PR failure
 * fallback to existing values, and providers without review listing preserving webhook-captured
 * milestones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../test-helpers/msw-server';
import { getAdminDataClient } from '@/lib/system/admin-client';
import type { GitProvider } from '../../git/git-provider.interface';
import type { PullRequestSummary, PullRequestReviewSummary } from '../../git/types';
import {
  backfillPullRequests,
  computeReviewFirsts,
  PR_BACKFILL_LIMIT,
  REVIEW_BACKFILL_PR_LIMIT,
} from '../backfill';

const logger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/observability/server-logger', () => ({ serverLogger: logger }));

const API = 'http://localhost:54321/rest/v1';

function summary(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7,
    authorId: 501,
    draft: false,
    headBranch: 'agent/feat-x',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    state: 'merged',
    url: 'https://github.com/acme/repo/pull/7',
    openedAt: '2026-07-01T10:00:00Z',
    closedAt: '2026-07-03T12:00:00Z',
    mergedAt: '2026-07-03T12:00:00Z',
    ...over,
  };
}

function stubProvider(prs: PullRequestSummary[] | Error, type: 'github' | 'other' = 'github') {
  const listPullRequests = vi.fn(async () => {
    if (prs instanceof Error) throw prs;
    return prs;
  });
  return { provider: { type, listPullRequests } as unknown as GitProvider, listPullRequests };
}

/** Provider that ALSO lists reviews (per-PR map; missing key → []). */
function stubReviewProvider(
  prs: PullRequestSummary[],
  reviewsByNumber: Record<number, PullRequestReviewSummary[] | Error>
) {
  const { provider, listPullRequests } = stubProvider(prs);
  const listPullRequestReviews = vi.fn(async (_repo: string, prNumber: number) => {
    const entry = reviewsByNumber[prNumber] ?? [];
    if (entry instanceof Error) throw entry;
    return entry;
  });
  (provider as { listPullRequestReviews?: unknown }).listPullRequestReviews =
    listPullRequestReviews;
  return { provider, listPullRequests, listPullRequestReviews };
}

describe('computeReviewFirsts', () => {
  it('takes the earliest non-author review and earliest non-author approval', () => {
    const firsts = computeReviewFirsts(
      [
        { authorId: 501, isBot: false, state: 'commented', submittedAt: '2026-07-01T11:00:00Z' }, // self — ignored
        { authorId: 777, isBot: false, state: 'changes_requested', submittedAt: '2026-07-01T12:00:00Z' },
        { authorId: 888, isBot: false, state: 'approved', submittedAt: '2026-07-02T09:00:00Z' },
      ],
      501
    );
    expect(firsts).toEqual({
      first_review_at: '2026-07-01T12:00:00Z',
      first_approved_at: '2026-07-02T09:00:00Z',
    });
  });

  it('counts a dismissed review as review latency but never as an approval', () => {
    const firsts = computeReviewFirsts(
      [
        { authorId: 777, isBot: false, state: 'dismissed', submittedAt: '2026-07-01T08:00:00Z' },
        { authorId: 888, isBot: false, state: 'approved', submittedAt: '2026-07-01T09:00:00Z' },
      ],
      501
    );
    expect(firsts).toEqual({
      first_review_at: '2026-07-01T08:00:00Z',
      first_approved_at: '2026-07-01T09:00:00Z',
    });
  });

  it('an approval can itself be the first review', () => {
    const firsts = computeReviewFirsts(
      [
        { authorId: 777, isBot: false, state: 'approved', submittedAt: '2026-07-01T08:00:00Z' },
        { authorId: 888, isBot: false, state: 'commented', submittedAt: '2026-07-01T09:00:00Z' },
      ],
      501
    );
    expect(firsts).toEqual({
      first_review_at: '2026-07-01T08:00:00Z',
      first_approved_at: '2026-07-01T08:00:00Z',
    });
  });

  it('skips reviews without a submitted timestamp and returns nulls when nothing qualifies', () => {
    expect(computeReviewFirsts([], 501)).toEqual({
      first_review_at: null,
      first_approved_at: null,
    });
    expect(
      computeReviewFirsts([{ authorId: 777, isBot: false, state: 'approved', submittedAt: null }], 501)
    ).toEqual({ first_review_at: null, first_approved_at: null });
  });

  it('skips bot reviews entirely — an instant bot approval never sets a milestone', () => {
    const firsts = computeReviewFirsts(
      [
        { authorId: 900, isBot: true, state: 'approved', submittedAt: '2026-07-01T08:00:01Z' },
        { authorId: 777, isBot: false, state: 'commented', submittedAt: '2026-07-01T14:00:00Z' },
      ],
      501
    );
    expect(firsts).toEqual({
      first_review_at: '2026-07-01T14:00:00Z',
      first_approved_at: null,
    });
    expect(
      computeReviewFirsts(
        [{ authorId: 900, isBot: true, state: 'approved', submittedAt: '2026-07-01T08:00:01Z' }],
        501
      )
    ).toEqual({ first_review_at: null, first_approved_at: null });
  });

  it('with an unknown PR author (null) no review is treated as a self-review', () => {
    const firsts = computeReviewFirsts(
      [{ authorId: null, isBot: false, state: 'approved', submittedAt: '2026-07-01T08:00:00Z' }],
      null
    );
    expect(firsts).toEqual({
      first_review_at: '2026-07-01T08:00:00Z',
      first_approved_at: '2026-07-01T08:00:00Z',
    });
  });
});

describe('backfillPullRequests', () => {
  let upserts: Array<{ body: unknown; onConflict: string | null; prefer: string | null }>;
  let existingRows: Array<{
    pr_number: number;
    ready_for_review_at?: string | null;
    first_review_at: string | null;
    first_approved_at: string | null;
  }>;

  beforeEach(() => {
    logger.info.mockReset();
    logger.error.mockReset();
    upserts = [];
    existingRows = [];
    server.use(
      http.get(`${API}/pull_request`, () => HttpResponse.json(existingRows)),
      http.post(`${API}/pull_request`, async ({ request }) => {
        upserts.push({
          body: await request.json(),
          onConflict: new URL(request.url).searchParams.get('on_conflict'),
          prefer: request.headers.get('prefer'),
        });
        return HttpResponse.json([{}], { status: 201 });
      })
    );
  });

  it('upserts one lifecycle row per PR with the exact column set, keyed on (app_id, pr_number)', async () => {
    const { provider, listPullRequests } = stubProvider([
      summary(),
      summary({ number: 6, state: 'open', closedAt: null, mergedAt: null }),
    ]);

    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    expect(result).toEqual({ synced: 2 });
    expect(listPullRequests).toHaveBeenCalledWith('acme/repo', { limit: PR_BACKFILL_LIMIT });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.onConflict).toBe('app_id,pr_number');
    expect(upserts[0]!.prefer).toContain('resolution=merge-duplicates');
    expect(upserts[0]!.body).toEqual([
      {
        app_id: 'app-1',
        tenant_id: 'tenant-1',
        provider: 'github',
        pr_number: 7,
        head_branch: 'agent/feat-x',
        head_sha: 'a'.repeat(40),
        base_branch: 'main',
        state: 'merged',
        url: 'https://github.com/acme/repo/pull/7',
        opened_at: '2026-07-01T10:00:00Z',
        ready_for_review_at: '2026-07-01T10:00:00Z',
        closed_at: '2026-07-03T12:00:00Z',
        merged_at: '2026-07-03T12:00:00Z',
        first_review_at: null,
        first_approved_at: null,
      },
      {
        app_id: 'app-1',
        tenant_id: 'tenant-1',
        provider: 'github',
        pr_number: 6,
        head_branch: 'agent/feat-x',
        head_sha: 'a'.repeat(40),
        base_branch: 'main',
        state: 'open',
        url: 'https://github.com/acme/repo/pull/7',
        opened_at: '2026-07-01T10:00:00Z',
        ready_for_review_at: '2026-07-01T10:00:00Z',
        closed_at: null,
        merged_at: null,
        first_review_at: null,
        first_approved_at: null,
      },
    ]);
  });

  it('stamps the provider type from the provider instance (non-github)', async () => {
    const { provider } = stubProvider([summary({ number: 3 })], 'other');

    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
      limit: 25,
    });

    expect(result).toEqual({ synced: 1 });
    expect((upserts[0]!.body as Array<{ provider: string }>)[0]!.provider).toBe('other');
  });

  it('passes a custom limit through to the provider', async () => {
    const { provider, listPullRequests } = stubProvider([summary()]);
    await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
      limit: 25,
    });
    expect(listPullRequests).toHaveBeenCalledWith('acme/repo', { limit: 25 });
  });

  it('returns synced 0 without any write when the repo has no PRs', async () => {
    const { provider } = stubProvider([]);
    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });
    expect(result).toEqual({ synced: 0 });
    expect(upserts).toHaveLength(0);
  });

  it('never throws: a provider failure becomes an error result, with no write', async () => {
    const { provider } = stubProvider(new Error('github unreachable'));
    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });
    expect(result).toEqual({ error: 'github unreachable' });
    expect(upserts).toHaveLength(0);
  });

  it('never throws: an upsert rejection becomes an error result', async () => {
    server.use(
      http.post(`${API}/pull_request`, () =>
        HttpResponse.json({ message: 'permission denied', code: '42501' }, { status: 403 })
      )
    );
    const { provider } = stubProvider([summary()]);
    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });
    expect(result).toEqual({ error: 'permission denied' });
  });

  it('enriches rows with review milestones (self-reviews excluded via the PR author id)', async () => {
    const { provider, listPullRequestReviews } = stubReviewProvider(
      [summary(), summary({ number: 6, authorId: 999, state: 'open', closedAt: null, mergedAt: null })],
      {
        7: [
          { authorId: 501, isBot: false, state: 'commented', submittedAt: '2026-07-01T10:30:00Z' }, // self
          { authorId: 777, isBot: false, state: 'changes_requested', submittedAt: '2026-07-01T11:00:00Z' },
          { authorId: 777, isBot: false, state: 'approved', submittedAt: '2026-07-02T08:00:00Z' },
        ],
        6: [],
      }
    );

    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    expect(result).toEqual({ synced: 2 });
    expect(listPullRequestReviews).toHaveBeenCalledTimes(2);
    expect(listPullRequestReviews).toHaveBeenCalledWith('acme/repo', 7);
    expect(listPullRequestReviews).toHaveBeenCalledWith('acme/repo', 6);
    const rows = upserts[0]!.body as Array<{
      pr_number: number;
      first_review_at: string | null;
      first_approved_at: string | null;
    }>;
    expect(rows.map((r) => [r.pr_number, r.first_review_at, r.first_approved_at])).toEqual([
      [7, '2026-07-01T11:00:00Z', '2026-07-02T08:00:00Z'],
      [6, null, null],
    ]);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('caps review fetches at the newest REVIEW_BACKFILL_PR_LIMIT PRs and logs the partial coverage', async () => {
    const prs = Array.from({ length: REVIEW_BACKFILL_PR_LIMIT + 10 }, (_, i) =>
      summary({ number: 1000 - i }) // newest-first, like the providers return
    );
    existingRows = [
      {
        pr_number: 1000 - REVIEW_BACKFILL_PR_LIMIT, // first PR beyond the cap
        first_review_at: '2026-06-01T00:00:00Z',
        first_approved_at: null,
      },
    ];
    const { provider, listPullRequestReviews } = stubReviewProvider(prs, {
      1000: [{ authorId: 777, isBot: false, state: 'approved', submittedAt: '2026-07-01T09:00:00Z' }],
    });

    await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    expect(listPullRequestReviews).toHaveBeenCalledTimes(REVIEW_BACKFILL_PR_LIMIT);
    // The newest PR was enriched…
    const rows = upserts[0]!.body as Array<{
      pr_number: number;
      first_review_at: string | null;
      first_approved_at: string | null;
    }>;
    expect(rows[0]).toMatchObject({
      pr_number: 1000,
      first_review_at: '2026-07-01T09:00:00Z',
      first_approved_at: '2026-07-01T09:00:00Z',
    });
    // …the first beyond-cap PR kept its existing webhook-captured milestone…
    expect(rows[REVIEW_BACKFILL_PR_LIMIT]).toMatchObject({
      pr_number: 1000 - REVIEW_BACKFILL_PR_LIMIT,
      first_review_at: '2026-06-01T00:00:00Z',
      first_approved_at: null,
    });
    // …and the truncation is not silent.
    expect(logger.info).toHaveBeenCalledWith(
      '[PR Backfill] review enrichment partial: 0 fetch failures, 10 PRs beyond the review cap keep existing review columns',
      { app_id: 'app-1', repository: 'acme/repo' }
    );
  });

  it('a failed review fetch keeps that PR\'s existing milestones while others enrich (and is logged)', async () => {
    existingRows = [
      { pr_number: 7, first_review_at: '2026-07-01T09:00:00Z', first_approved_at: null },
    ];
    const { provider } = stubReviewProvider(
      [summary(), summary({ number: 6, state: 'open', closedAt: null, mergedAt: null })],
      {
        7: new Error('rate limited'),
        6: [{ authorId: 777, isBot: false, state: 'approved', submittedAt: '2026-07-02T10:00:00Z' }],
      }
    );

    const result = await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    expect(result).toEqual({ synced: 2 });
    const rows = upserts[0]!.body as Array<{
      pr_number: number;
      first_review_at: string | null;
      first_approved_at: string | null;
    }>;
    expect(rows.map((r) => [r.pr_number, r.first_review_at, r.first_approved_at])).toEqual([
      [7, '2026-07-01T09:00:00Z', null],
      [6, '2026-07-02T10:00:00Z', '2026-07-02T10:00:00Z'],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      '[PR Backfill] review enrichment partial: 1 fetch failures, 0 PRs beyond the review cap keep existing review columns',
      { app_id: 'app-1', repository: 'acme/repo' }
    );
  });

  it('ready_for_review_at: drafts stay NULL, non-drafts approximate to openedAt, webhook-exact stamps win', async () => {
    existingRows = [
      {
        pr_number: 5,
        // Webhook saw the actual draft→ready transition — must beat the
        // openedAt approximation.
        ready_for_review_at: '2026-07-02T08:00:00Z',
        first_review_at: null,
        first_approved_at: null,
      },
    ];
    const { provider } = stubProvider([
      summary({ number: 5 }),
      summary({ number: 4, draft: true, state: 'open', closedAt: null, mergedAt: null }),
      summary({ number: 3, state: 'open', closedAt: null, mergedAt: null }),
    ]);

    await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    const rows = upserts[0]!.body as Array<{
      pr_number: number;
      ready_for_review_at: string | null;
    }>;
    expect(rows.map((r) => [r.pr_number, r.ready_for_review_at])).toEqual([
      [5, '2026-07-02T08:00:00Z'], // exact webhook stamp preserved
      [4, null], // draft — still coding
      [3, '2026-07-01T10:00:00Z'], // non-draft — ready at open
    ]);
  });

  it('a provider without review listing preserves existing webhook-captured milestones', async () => {
    existingRows = [
      {
        pr_number: 3,
        first_review_at: null,
        first_approved_at: '2026-07-01T15:00:00Z',
      },
    ];
    const { provider } = stubProvider([summary({ number: 3 })], 'other');

    await backfillPullRequests({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/repo',
    });

    const rows = upserts[0]!.body as Array<{
      pr_number: number;
      first_review_at: string | null;
      first_approved_at: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr_number: 3,
      first_review_at: null,
      first_approved_at: '2026-07-01T15:00:00Z',
    });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
