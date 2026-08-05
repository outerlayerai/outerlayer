/**
 * Integration test for the GitHub `pull_request_review` webhook handler
 * (`handlePullRequestReviewEvent`) — review milestones for decomposed PR
 * cycle time — against a REAL local Supabase.
 *
 * Everything DB-side runs for real: git_connection resolution, the
 * review-column UPDATE on tracked rows, the full-row healing INSERT for
 * untracked PRs, and the monotone first-occurrence semantics. No external
 * seams needed — the handler talks only to Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSupabaseAdminClient } from '../lib/supabase-admin';
import {
  createAuthenticatedUser,
  cleanupTestUsers,
  type TestUser,
} from '../lib/test-utils';
import { createTestApp, createTestGitConnection } from '../lib/app-test-utils';

import { handlePullRequestReviewEvent } from 'tenant-dashboard/src/app/api/webhooks/github/handle-pull-request-review-event';
import {
  handlePullRequestEvent,
  type GitHubPullRequestPayload,
} from 'tenant-dashboard/src/app/api/webhooks/github/handle-pull-request-event';

const admin = createSupabaseAdminClient();

let repoCounter = 0;

/** App + git_connection(repo). Reviews don't need git_branch resolution. */
async function seedConnectedApp(
  tenantId: string
): Promise<{ appId: string; repo: string }> {
  repoCounter += 1;
  const repo = `acme/pr-review-webhook-${Date.now()}-${repoCounter}`;
  const app = await createTestApp(tenantId, {
    name: `pr-review-webhook-${repoCounter}`,
  });
  await createTestGitConnection(tenantId, {
    appId: app.id,
    provider: 'github',
    repository: repo,
  });
  return { appId: app.id, repo };
}

/** An `opened` pull_request payload — used to pre-track PRs the normal way. */
function prOpenedPayload(repo: string, number: number): GitHubPullRequestPayload {
  return {
    action: 'opened',
    pull_request: {
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      merged: false,
      created_at: '2026-07-01T09:00:00Z',
      head: { ref: 'agent/feat-x', sha: 'head-sha-1' },
      base: { ref: 'main', sha: 'base-sha-1' },
    },
    repository: { full_name: repo },
  };
}

function reviewPayload(
  repo: string,
  number: number,
  opts: {
    action?: string;
    reviewState?: string;
    submittedAt?: string;
    reviewUserId?: number;
    reviewUserType?: string;
    prUserId?: number;
    prState?: string;
    mergedAt?: string | null;
    closedAt?: string | null;
  } = {}
) {
  return {
    action: opts.action ?? 'submitted',
    review: {
      state: opts.reviewState ?? 'commented',
      submitted_at: opts.submittedAt ?? '2026-07-02T10:00:00Z',
      user: { id: opts.reviewUserId ?? 777, type: opts.reviewUserType ?? 'User' },
    },
    pull_request: {
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      state: opts.prState ?? 'open',
      user: { id: opts.prUserId ?? 501 },
      created_at: '2026-07-01T09:00:00Z',
      closed_at: opts.closedAt ?? null,
      merged_at: opts.mergedAt ?? null,
      head: { ref: 'agent/feat-x', sha: 'head-sha-1' },
      base: { ref: 'main' },
    },
    repository: { full_name: repo },
  };
}

async function getPrRow(appId: string, prNumber: number) {
  const { data } = await admin
    .from('pull_request')
    .select('*')
    .eq('app_id', appId)
    .eq('pr_number', prNumber)
    .maybeSingle();
  return data;
}

describe('handlePullRequestReviewEvent (integration, real Supabase)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createAuthenticatedUser('admin');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('sets first_review_at (not first_approved_at) on a tracked PR without touching lifecycle', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prOpenedPayload(repo, 7));

    await handlePullRequestReviewEvent(
      reviewPayload(repo, 7, { reviewState: 'changes_requested' })
    );

    const row = await getPrRow(appId, 7);
    expect(row).toMatchObject({
      state: 'open',
      opened_at: '2026-07-01T09:00:00+00:00',
      first_review_at: '2026-07-02T10:00:00+00:00',
      first_approved_at: null,
    });
  });

  it('an approval sets both milestones; a later review moves neither (monotone)', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prOpenedPayload(repo, 8));

    await handlePullRequestReviewEvent(
      reviewPayload(repo, 8, {
        reviewState: 'approved',
        submittedAt: '2026-07-02T10:00:00Z',
      })
    );
    await handlePullRequestReviewEvent(
      reviewPayload(repo, 8, {
        reviewState: 'approved',
        submittedAt: '2026-07-05T10:00:00Z',
      })
    );

    const row = await getPrRow(appId, 8);
    expect(row).toMatchObject({
      first_review_at: '2026-07-02T10:00:00+00:00',
      first_approved_at: '2026-07-02T10:00:00+00:00',
    });
  });

  it('an out-of-order EARLIER review moves the milestone back', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prOpenedPayload(repo, 9));

    await handlePullRequestReviewEvent(
      reviewPayload(repo, 9, { submittedAt: '2026-07-02T10:00:00Z' })
    );
    await handlePullRequestReviewEvent(
      reviewPayload(repo, 9, { submittedAt: '2026-07-01T12:00:00Z' })
    );

    const row = await getPrRow(appId, 9);
    expect(row).toMatchObject({
      first_review_at: '2026-07-01T12:00:00+00:00',
      first_approved_at: null,
    });
  });

  it('a review on an UNTRACKED merged PR heals the full row from the embedded PR object', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    await handlePullRequestReviewEvent(
      reviewPayload(repo, 11, {
        reviewState: 'approved',
        prState: 'closed',
        mergedAt: '2026-07-03T08:00:00Z',
        closedAt: '2026-07-03T08:00:00Z',
      })
    );

    const row = await getPrRow(appId, 11);
    expect(row).toMatchObject({
      provider: 'github',
      head_branch: 'agent/feat-x',
      base_branch: 'main',
      state: 'merged',
      opened_at: '2026-07-01T09:00:00+00:00',
      closed_at: '2026-07-03T08:00:00+00:00',
      merged_at: '2026-07-03T08:00:00+00:00',
      first_review_at: '2026-07-02T10:00:00+00:00',
      first_approved_at: '2026-07-02T10:00:00+00:00',
      environment_id: null,
    });
  });

  it('ignores bot reviews — an instant bot approval must not zero out pickup time', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prOpenedPayload(repo, 13));

    await handlePullRequestReviewEvent(
      reviewPayload(repo, 13, {
        reviewState: 'approved',
        reviewUserId: 900,
        reviewUserType: 'Bot',
        submittedAt: '2026-07-01T09:00:30Z',
      })
    );

    const row = await getPrRow(appId, 13);
    expect(row).toMatchObject({ first_review_at: null, first_approved_at: null });
  });

  it('ignores self-reviews and non-submitted actions (no row, no milestone)', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    // Self-review on an untracked PR — must not even create the row.
    await handlePullRequestReviewEvent(
      reviewPayload(repo, 12, { reviewUserId: 501, prUserId: 501 })
    );
    expect(await getPrRow(appId, 12)).toBeNull();

    // Dismissed action on a tracked PR — milestone untouched.
    await handlePullRequestEvent(prOpenedPayload(repo, 12));
    await handlePullRequestReviewEvent(
      reviewPayload(repo, 12, { action: 'dismissed' })
    );
    const row = await getPrRow(appId, 12);
    expect(row).toMatchObject({ first_review_at: null, first_approved_at: null });
  });
});
