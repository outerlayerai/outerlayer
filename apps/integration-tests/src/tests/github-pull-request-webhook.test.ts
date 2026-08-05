/**
 * Integration test for the GitHub `pull_request` webhook handler
 * (`handlePullRequestEvent`) — `pull_request` lifecycle tracking for fleet
 * metrics (merge rate, cycle time) — against a REAL local Supabase.
 *
 * Everything DB-side runs for real: app/git_connection resolution and the
 * `pull_request` upsert (RLS, UNIQUE, columns). No external-world seams to
 * stub: the handler touches no preview environments, Fly machines, or diff
 * API. Every PR on a connected repo is tracked unconditionally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSupabaseAdminClient } from '../lib/supabase-admin';
import {
  createAuthenticatedUser,
  cleanupTestUsers,
  type TestUser,
} from '../lib/test-utils';
import { createTestApp, createTestGitConnection } from '../lib/app-test-utils';

import { handlePullRequestEvent } from 'tenant-dashboard/src/app/api/webhooks/github/handle-pull-request-event';
import type { GitHubPullRequestPayload } from 'tenant-dashboard/src/app/api/webhooks/github/handle-pull-request-event';

const admin = createSupabaseAdminClient();

let repoCounter = 0;

/** App + git_connection(repo). Returns app id + repo. */
async function seedConnectedApp(
  tenantId: string
): Promise<{ appId: string; repo: string }> {
  repoCounter += 1;
  const repo = `acme/pr-webhook-${Date.now()}-${repoCounter}`;
  const app = await createTestApp(tenantId, {
    name: `pr-webhook-${repoCounter}`,
  });
  await createTestGitConnection(tenantId, {
    appId: app.id,
    provider: 'github',
    repository: repo,
  });
  return { appId: app.id, repo };
}

function prPayload(
  action: string,
  repo: string,
  opts: {
    number?: number;
    merged?: boolean;
    draft?: boolean;
    createdAt?: string;
    updatedAt?: string;
    headBranch?: string;
    headSha?: string;
  } = {}
): GitHubPullRequestPayload {
  return {
    action,
    pull_request: {
      number: opts.number ?? 7,
      html_url: `https://github.com/${repo}/pull/${opts.number ?? 7}`,
      merged: opts.merged ?? false,
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
      head: { ref: opts.headBranch ?? 'outerlayer/publish/x', sha: opts.headSha ?? 'head-sha-1' },
      base: { ref: 'main', sha: 'base-sha-1' },
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

describe('handlePullRequestEvent (integration, real Supabase)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createAuthenticatedUser('admin');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  it('opened: tracks the PR with payload-true lifecycle timestamps', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    await handlePullRequestEvent(
      prPayload('opened', repo, {
        number: 12,
        headBranch: 'greet-preview',
        headSha: 'sha-12',
        createdAt: '2026-07-10T09:00:00Z',
      })
    );

    const row = await getPrRow(appId, 12);
    expect(row).toMatchObject({
      provider: 'github',
      pr_number: 12,
      head_branch: 'greet-preview',
      head_sha: 'sha-12',
      base_branch: 'main',
      state: 'open',
    });
    expect(row?.opened_at).toBe('2026-07-10T09:00:00+00:00');
  });

  it('synchronize on an existing PR updates the same row (head sha advances)', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    await handlePullRequestEvent(prPayload('opened', repo, { number: 13, headSha: 'sha-a' }));
    await handlePullRequestEvent(prPayload('synchronize', repo, { number: 13, headSha: 'sha-b' }));

    const row = await getPrRow(appId, 13);
    expect(row?.head_sha).toBe('sha-b');
    expect(row?.state).toBe('open');

    // Still exactly one row for this PR (upsert, not insert).
    const { count } = await admin
      .from('pull_request')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId)
      .eq('pr_number', 13);
    expect(count).toBe(1);
  });

  it('closed/merged: marks the PR merged, stamping payload times', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prPayload('opened', repo, { number: 14 }));

    await handlePullRequestEvent(
      prPayload('closed', repo, { number: 14, merged: true })
    );

    const row = await getPrRow(appId, 14);
    expect(row?.state).toBe('merged');
    expect(row?.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.merged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('docs-only PR: tracked for fleet metrics same as any other PR', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    await handlePullRequestEvent(prPayload('opened', repo, { number: 15 }));

    const row = await getPrRow(appId, 15);
    expect(row?.state).toBe('open');
    expect(row?.pr_number).toBe(15);
  });

  it('RLS: a tenant member with git_connection.read can read PR rows; the table is service_role-write', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);
    await handlePullRequestEvent(prPayload('opened', repo, { number: 16 }));

    // admin role carries git_connection.read → SELECT visible via the user client.
    const { data: visible } = await user.client
      .from('pull_request')
      .select('pr_number, state')
      .eq('app_id', appId);
    expect(visible).toEqual([{ pr_number: 16, state: 'open' }]);

    // No authenticated INSERT policy → a user-scoped write is rejected (RLS).
    const { error } = await user.client.from('pull_request').insert({
      app_id: appId,
      tenant_id: user.tenantId,
      pr_number: 999,
      head_branch: 'x',
      head_sha: 'y',
      base_branch: 'main',
      state: 'open',
    });
    expect(error).not.toBeNull();
    expect(await getPrRow(appId, 999)).toBeNull();
  });

  it('draft-aware pickup: draft opens with NULL ready_for_review_at; the ready_for_review transition stamps it once', async () => {
    const { appId, repo } = await seedConnectedApp(user.tenantId);

    // Draft open → still coding, no pickup baseline.
    await handlePullRequestEvent(
      prPayload('opened', repo, { number: 17, draft: true, createdAt: '2026-07-01T09:00:00Z' })
    );
    expect(await getPrRow(appId, 17)).toMatchObject({ ready_for_review_at: null });

    // Draft → ready: the transition time becomes the pickup baseline.
    await handlePullRequestEvent(
      prPayload('ready_for_review', repo, {
        number: 17,
        draft: false,
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-02T10:00:00Z',
      })
    );
    expect(await getPrRow(appId, 17)).toMatchObject({
      ready_for_review_at: '2026-07-02T10:00:00+00:00',
    });

    // Re-draft + second ready: FIRST transition wins; a later sync never clears it.
    await handlePullRequestEvent(
      prPayload('ready_for_review', repo, {
        number: 17,
        draft: false,
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-05T12:00:00Z',
      })
    );
    await handlePullRequestEvent(prPayload('synchronize', repo, { number: 17, draft: false }));
    expect(await getPrRow(appId, 17)).toMatchObject({
      ready_for_review_at: '2026-07-02T10:00:00+00:00',
    });

    // Non-draft open on another PR → ready at open.
    await handlePullRequestEvent(
      prPayload('opened', repo, { number: 18, draft: false, createdAt: '2026-07-03T08:00:00Z' })
    );
    expect(await getPrRow(appId, 18)).toMatchObject({
      ready_for_review_at: '2026-07-03T08:00:00+00:00',
    });
  });
});
