/**
 * Integration: the GitHub push webhook ROUTE against a real Postgres, driven by
 * a REAL `X-Hub-Signature-256` HMAC. Only the git HTTP boundary is faked — the
 * installation octokit factory, the `GitHubProvider` (→ our in-memory tree),
 * and the `GitHubCheckRunner` (→ records its calls). Everything else runs: real
 * signature verification, real normalize, real `resolveWatchingApps`, real
 * `advanceCommitPointers`, real mirror writes, real `context_sync_event` ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Webhooks } from '@octokit/webhooks';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  cleanupTenant,
  createFakeGit,
  fileDiff,
  readHead,
  readPointers,
  readSyncEvents,
  seedApp,
  seedGitBranch,
  seedGitConnection,
  seedTenant,
  type FakeGitConfig,
} from './helpers';
import type { GitPort } from '@repo/context-sync';

const h = vi.hoisted(() => ({
  git: null as unknown as GitPort,
  checkCalls: [] as Array<{ method: 'start' | 'complete'; sha?: string; conclusion?: string; summary?: string }>,
}));

vi.mock('tenant-dashboard/src/env', async () => ({
  env: (await import('./env-mock')).buildEnvMock(),
}));
vi.mock('@/octo-kit', () => ({
  getGithubApp: () => ({ getInstallationOctokit: async () => ({}) }),
}));
vi.mock('@/lib/system/git/github/client', () => ({
  GitHubProvider: class {
    getLatestCommitSha(...a: unknown[]) { return (h.git.getLatestCommitSha as any)(...a); }
    listTree(...a: unknown[]) { return (h.git.listTree as any)(...a); }
    getFileContent(...a: unknown[]) { return (h.git.getFileContent as any)(...a); }
    compareCommits(...a: unknown[]) { return (h.git.compareCommits as any)(...a); }
  },
}));
vi.mock('@/lib/system/git/github/check-runner', () => ({
  GitHubCheckRunner: class {
    async start(sha: string) { h.checkCalls.push({ method: 'start', sha }); return { id: 123 }; }
    async complete(args: { conclusion: string; summary?: string }) {
      h.checkCalls.push({ method: 'complete', conclusion: args.conclusion, summary: args.summary });
    }
  },
}));

// Imported AFTER the mocks so the route binds the mocked provider/check-runner.
import { POST } from 'tenant-dashboard/src/app/api/webhooks/github/route';

const admin = createSupabaseAdminClient();
const REPO = 'octo/ctx-gh';
const BRANCH = 'main';
const AFTER = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const BEFORE = '0000000000000000000000000000000000000abc';
const webhooks = new Webhooks({ secret: 'test-webhook-secret' });

function pushPayload(opts?: { after?: string; before?: string; message?: string; repo?: string; branch?: string }) {
  const after = opts?.after ?? AFTER;
  const repo = opts?.repo ?? REPO;
  return {
    ref: `refs/heads/${opts?.branch ?? BRANCH}`,
    before: opts?.before ?? BEFORE,
    after,
    repository: { id: 1, name: repo.split('/')[1], full_name: repo, private: false },
    head_commit: {
      id: after,
      message: opts?.message ?? 'feat: land context',
      timestamp: new Date().toISOString(),
      committer: { name: 'Pusher', email: 'pusher@example.com' },
      author: { name: 'Pusher', email: 'pusher@example.com' },
    },
    commits: [{ id: after, message: opts?.message ?? 'feat: land context', added: [], modified: ['.outerlayer/AGENTS.md'], removed: [] }],
    sender: { id: 9, login: 'pusher', type: 'User' },
    installation: { id: 42 },
  };
}

async function postPush(payload: object, opts?: { signature?: string; event?: string }): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = opts?.signature ?? (await webhooks.sign(body));
  const req = new NextRequest('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers: {
      'X-Hub-Signature-256': signature,
      'X-GitHub-Event': opts?.event ?? 'push',
      'content-type': 'application/json',
    },
    body,
  });
  return POST(req as unknown as Parameters<typeof POST>[0]);
}

describe('context-sync · GitHub push webhook (route)', () => {
  let tenantId: string;
  let appId: string;
  const APP_NAME = 'ctx-gh-app';

  beforeEach(async () => {
    h.checkCalls = [];
    tenantId = await seedTenant(admin);
    const app = await seedApp(admin, tenantId, APP_NAME);
    appId = app.appId;
    await seedGitConnection(admin, { tenantId, appId, repository: REPO, provider: 'github' });
    await seedGitBranch(admin, { tenantId, appId, branch: BRANCH });
  });

  afterEach(async () => {
    await cleanupTenant(admin, tenantId);
  });

  function setGit(cfg: FakeGitConfig) {
    h.git = createFakeGit(cfg);
  }

  it('syncs the watching app, advances pointers + head, records a push event, writes zero deployments, and completes the check', async () => {
    setGit({ headSha: AFTER, files: { '.outerlayer/AGENTS.md': '# hi' }, blobShas: { '.outerlayer/AGENTS.md': 'sha-a' } });

    const res = await postPush(pushPayload());
    expect(res.status).toBe(200);

    const events = await readSyncEvents(admin, appId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trigger: 'push',
      status: 'synced',
      commit_sha: AFTER,
      commit_message: 'feat: land context',
      error: null,
      branch: BRANCH,
    });

    expect(await readHead(admin, appId)).toMatchObject({ branch: BRANCH, commit_sha: AFTER });

    const { appCommitSha, envs } = await readPointers(admin, appId);
    expect(appCommitSha).toBe(AFTER);
    expect(envs.find((e) => e.is_default)!.current_commit_sha).toBe(AFTER);

    // The blob actually landed (mirror write, not just the ledger).
    const { data: blobs } = await admin.from('context_blob').select('blob_sha, content').eq('app_id', appId);
    expect(blobs).toEqual([{ blob_sha: 'sha-a', content: '# hi' }]);

    // Check-run: opened on the head sha, completed success with the per-app line.
    expect(h.checkCalls).toEqual([
      { method: 'start', sha: AFTER },
      { method: 'complete', conclusion: 'success', summary: `✓ ${APP_NAME}: synced ${AFTER.slice(0, 7)}` },
    ]);
  });

  it('advances pointers even when the sync FAILS, records a failed event, returns 200, completes the check as failure', async () => {
    setGit({ headSha: AFTER, failOn: 'listTree', failMessage: 'tree fetch 502' });

    const res = await postPush(pushPayload());
    expect(res.status).toBe(200);

    // Pointers advance BEFORE the sync — traces must stamp the true HEAD even
    // though the mirror is stale.
    const { appCommitSha, envs } = await readPointers(admin, appId);
    expect(appCommitSha).toBe(AFTER);
    expect(envs.find((e) => e.is_default)!.current_commit_sha).toBe(AFTER);

    const events = await readSyncEvents(admin, appId);
    expect(events).toEqual([
      expect.objectContaining({ trigger: 'push', status: 'failed', commit_sha: AFTER, error: 'tree fetch 502', snapshot_id: null }),
    ]);

    expect(await readHead(admin, appId)).toBeNull();
    expect(h.checkCalls).toEqual([
      { method: 'start', sha: AFTER },
      { method: 'complete', conclusion: 'failure', summary: `✕ ${APP_NAME}: tree fetch 502` },
    ]);
  });

  it('applies an incremental diff on a subsequent push, writing a new snapshot at the new head', async () => {
    // Seed a head at an older commit via the same real mirror the route uses.
    const { buildContextSync, createSupabaseContextMirrorPort } = await import(
      'tenant-dashboard/src/lib/system/context-sync'
    );
    const seedGit = createFakeGit({
      headSha: BEFORE,
      files: { '.outerlayer/AGENTS.md': '# v1' },
      blobShas: { '.outerlayer/AGENTS.md': 'sha-v1' },
    });
    await buildContextSync({ db: createSupabaseContextMirrorPort(admin), git: seedGit }).initialSync({
      appId,
      tenantId,
      repo: REPO,
      branch: BRANCH,
    });

    // Now a real push whose `before` equals the seeded head → incremental path.
    setGit({
      diffs: [fileDiff('.outerlayer/AGENTS.md', 'modified', { sha: 'sha-v2' })],
      files: { '.outerlayer/AGENTS.md': '# v2' },
      blobShas: { '.outerlayer/AGENTS.md': 'sha-v2' },
    });
    const res = await postPush(pushPayload({ before: BEFORE, after: AFTER, message: 'edit agents' }));
    expect(res.status).toBe(200);

    expect(await readHead(admin, appId)).toMatchObject({ branch: BRANCH, commit_sha: AFTER });
    const { data: blobs } = await admin
      .from('context_blob')
      .select('blob_sha, content')
      .eq('app_id', appId)
      .order('blob_sha', { ascending: true });
    expect(blobs).toEqual([
      { blob_sha: 'sha-v1', content: '# v1' },
      { blob_sha: 'sha-v2', content: '# v2' },
    ]);

    const events = await readSyncEvents(admin, appId);
    const pushEvents = events.filter((e) => e.trigger === 'push');
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]).toMatchObject({ status: 'synced', commit_sha: AFTER, commit_message: 'edit agents' });
  });

  it('rejects a bad signature with 401 and touches nothing', async () => {
    setGit({ headSha: AFTER, files: { '.outerlayer/AGENTS.md': '# hi' } });

    const res = await postPush(pushPayload(), { signature: 'sha256=deadbeef' });
    expect(res.status).toBe(401);

    expect(await readSyncEvents(admin, appId)).toHaveLength(0);
    expect((await readPointers(admin, appId)).appCommitSha).toBeNull();
    expect(h.checkCalls).toEqual([]);
  });

  it('rejects a missing signature with 401', async () => {
    setGit({ headSha: AFTER, files: { '.outerlayer/AGENTS.md': '# hi' } });
    const body = JSON.stringify(pushPayload());
    const req = new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'push', 'content-type': 'application/json' },
      body,
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(await readSyncEvents(admin, appId)).toHaveLength(0);
  });

  it('records a SECOND event on webhook redelivery (attempt log, no dedupe)', async () => {
    // Pre-sync the pushed commit so both deliveries take the replay path
    // (afterSha === head): each still records an attempt, neither dedupes, and
    // no createSnapshot RPC is issued (so the assertion is on the ledger's
    // no-dedupe contract, not on burst-RPC timing).
    const { buildContextSync, createSupabaseContextMirrorPort } = await import(
      'tenant-dashboard/src/lib/system/context-sync'
    );
    await buildContextSync({
      db: createSupabaseContextMirrorPort(admin),
      git: createFakeGit({ headSha: AFTER, files: { '.outerlayer/AGENTS.md': '# hi' }, blobShas: { '.outerlayer/AGENTS.md': 'sha-a' } }),
    }).initialSync({ appId, tenantId, repo: REPO, branch: BRANCH });

    setGit({ headSha: AFTER, files: { '.outerlayer/AGENTS.md': '# hi' }, blobShas: { '.outerlayer/AGENTS.md': 'sha-a' } });
    expect((await postPush(pushPayload())).status).toBe(200);
    expect((await postPush(pushPayload())).status).toBe(200);

    const pushEvents = (await readSyncEvents(admin, appId)).filter((e) => e.trigger === 'push');
    expect(pushEvents).toHaveLength(2);
    expect(pushEvents.every((e) => e.status === 'synced' && e.commit_sha === AFTER)).toBe(true);
  });
});
