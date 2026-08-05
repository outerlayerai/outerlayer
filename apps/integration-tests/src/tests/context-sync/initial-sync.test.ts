/**
 * Integration: the LINK path (`contextSync.initialSync`) against a real
 * Postgres mirror, plus `advanceCommitPointers` and the `context_sync_event`
 * CHECK constraints.
 *
 * Seam: this is exactly the wiring `saveGithubRepository` runs after the
 * gateway link call (sections/apps/actions/actions.ts) —
 *   buildContextSync({ db: createSupabaseContextMirrorPort(admin), git }).initialSync(...)
 *   → on a synced outcome, advanceCommitPointers(admin, { appId, commitSha }).
 * The git provider is faked at the port; the Supabase mirror + snapshot RPC +
 * ledger are real. The 39 fake-port unit tests in packages/context-sync cover
 * the algorithm; this covers the REAL database layer they mock.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFIER_VERSION } from '@repo/context-core';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  buildContextSync,
  createSupabaseContextMirrorPort,
} from 'tenant-dashboard/src/lib/system/context-sync';
import { advanceCommitPointers } from 'tenant-dashboard/src/lib/system/git/commit-pointers';
import {
  cleanupTenant,
  createFakeGit,
  readHead,
  readPointers,
  readSyncEvents,
  seedApp,
  seedGitBranch,
  seedGitConnection,
  seedNonDefaultEnv,
  seedTenant,
  type SeededApp,
} from './helpers';

const admin = createSupabaseAdminClient();
const BRANCH = 'main';
const REPO = 'octo/ctx-link';

/** Two content files + one excluded skill asset + one ignored root file. */
function fakeRepo(headSha: string) {
  return createFakeGit({
    headSha,
    files: {
      '.outerlayer/AGENTS.md': '# agents instructions',
      '.outerlayer/skills/foo/SKILL.md': '# foo skill',
    },
    blobShas: {
      '.outerlayer/AGENTS.md': 'sha-agents',
      '.outerlayer/skills/foo/SKILL.md': 'sha-skill',
    },
    extraTreePaths: [
      { path: '.outerlayer/skills/foo/assets/logo.png', sha: 'sha-logo', size: 20 },
      { path: 'README.md', sha: 'sha-readme', size: 5 },
    ],
  });
}

function sync(git: ReturnType<typeof createFakeGit>) {
  return buildContextSync({ db: createSupabaseContextMirrorPort(admin), git });
}

describe('context-sync · initial sync (link path)', () => {
  let tenantId: string;
  const tenantsToClean: string[] = [];

  async function freshApp(): Promise<SeededApp> {
    tenantId = await seedTenant(admin);
    tenantsToClean.push(tenantId);
    const app = await seedApp(admin, tenantId);
    await seedGitConnection(admin, { tenantId, appId: app.appId, repository: REPO, provider: 'github' });
    await seedGitBranch(admin, { tenantId, appId: app.appId, branch: BRANCH });
    return app;
  }

  afterEach(async () => {
    while (tenantsToClean.length) await cleanupTenant(admin, tenantsToClean.pop()!);
  });

  beforeAll(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL must be set (integration global setup should provide it)');
    }
  });

  it('mirrors the tree, advances head, records a synced link event, and stamps pointers', async () => {
    const { appId, defaultEnvId } = await freshApp();
    const nonDefaultEnvId = await seedNonDefaultEnv(admin, { tenantId, appId, name: 'staging' });

    const outcome = await sync(fakeRepo('sha-c1')).initialSync({
      appId,
      tenantId,
      repo: REPO,
      branch: BRANCH,
    });

    // The link seam advances pointers only on a synced outcome.
    expect(outcome.kind).toBe('resynced');
    expect(outcome.commitSha).toBe('sha-c1');
    const snapshotId = outcome.snapshotId!;
    await advanceCommitPointers(admin, { appId, commitSha: outcome.commitSha! });

    // --- blobs: content-addressed, only the two classified content files ---
    const { data: blobs } = await admin
      .from('context_blob')
      .select('blob_sha, content, size')
      .eq('app_id', appId)
      .order('blob_sha', { ascending: true });
    expect(blobs).toEqual([
      { blob_sha: 'sha-agents', content: '# agents instructions', size: 21 },
      { blob_sha: 'sha-skill', content: '# foo skill', size: 11 },
    ]);

    // --- tree entries: classified path + kind + scope, oversize/ignored absent ---
    const { data: entries } = await admin
      .from('context_tree_entry')
      .select('path, blob_sha, kind, scope_path')
      .eq('snapshot_id', snapshotId)
      .order('path', { ascending: true });
    expect(entries).toEqual([
      { path: '.outerlayer/AGENTS.md', blob_sha: 'sha-agents', kind: 'instructions', scope_path: '' },
      { path: '.outerlayer/skills/foo/SKILL.md', blob_sha: 'sha-skill', kind: 'skill', scope_path: '' },
    ]);

    // --- snapshot: sha + classifier version + excluded-asset annotation ---
    const { data: snapshot } = await admin
      .from('context_snapshot')
      .select('commit_sha, classifier_version, excluded_counts')
      .eq('id', snapshotId)
      .single();
    expect(snapshot).toEqual({
      commit_sha: 'sha-c1',
      classifier_version: CLASSIFIER_VERSION,
      excluded_counts: [{ scopePath: '', skillName: 'foo', count: 1 }],
    });

    // --- head advanced to the synced snapshot ---
    expect(await readHead(admin, appId)).toEqual({
      branch: BRANCH,
      commit_sha: 'sha-c1',
      snapshot_id: snapshotId,
    });

    // --- exactly one synced link event ---
    const events = await readSyncEvents(admin, appId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trigger: 'link',
      status: 'synced',
      commit_sha: 'sha-c1',
      commit_message: null,
      error: null,
      snapshot_id: snapshotId,
      branch: BRANCH,
    });
    expect(typeof events[0]!.duration_ms).toBe('number');
    expect(events[0]!.duration_ms).toBeGreaterThanOrEqual(0);

    // --- pointers: app + DEFAULT env only; non-default env untouched ---
    const { appCommitSha, envs } = await readPointers(admin, appId);
    expect(appCommitSha).toBe('sha-c1');
    expect(envs.find((e) => e.id === defaultEnvId)!.current_commit_sha).toBe('sha-c1');
    expect(envs.find((e) => e.id === nonDefaultEnvId)!.current_commit_sha).toBeNull();
  });

  it('records a FAILED link event with null sha when HEAD never resolves, leaving no head or pointers', async () => {
    const { appId } = await freshApp();

    const outcome = await sync(
      createFakeGit({ failOn: 'getLatestCommitSha', failMessage: 'github 500' }),
    ).initialSync({ appId, tenantId, repo: REPO, branch: BRANCH });

    expect(outcome.kind).toBe('failed');
    expect(outcome.commitSha).toBeUndefined();

    const events = await readSyncEvents(admin, appId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trigger: 'link',
      status: 'failed',
      commit_sha: null,
      error: 'github 500',
      snapshot_id: null,
    });

    // No snapshot, no head, pointers never advanced (link failure is non-fatal
    // but leaves the mirror "not synced yet").
    expect(await readHead(admin, appId)).toBeNull();
    const { count } = await admin
      .from('context_snapshot')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId);
    expect(count).toBe(0);
    expect((await readPointers(admin, appId)).appCommitSha).toBeNull();
  });

  it('records a FAILED link event carrying the resolved sha when the failure is post-HEAD', async () => {
    const { appId } = await freshApp();

    const outcome = await sync(
      createFakeGit({ headSha: 'sha-resolved', failOn: 'listTree', failMessage: 'tree truncated' }),
    ).initialSync({ appId, tenantId, repo: REPO, branch: BRANCH });

    expect(outcome.kind).toBe('failed');
    expect(outcome.commitSha).toBe('sha-resolved');

    const events = await readSyncEvents(admin, appId);
    expect(events).toEqual([
      expect.objectContaining({
        trigger: 'link',
        status: 'failed',
        commit_sha: 'sha-resolved',
        error: 'tree truncated',
        snapshot_id: null,
      }),
    ]);
    expect(await readHead(admin, appId)).toBeNull();
  });

  describe('context_sync_event CHECK constraints', () => {
    it('rejects a failed row with no error text (chk_sync_event_error)', async () => {
      const { appId } = await freshApp();
      const { error } = await admin.from('context_sync_event').insert({
        app_id: appId,
        tenant_id: tenantId,
        branch: BRANCH,
        commit_sha: 'sha-x',
        trigger: 'push',
        status: 'failed',
        error: null,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain('chk_sync_event_error');
    });

    it('rejects a synced row with no commit sha (chk_sync_event_sha)', async () => {
      const { appId } = await freshApp();
      const { error } = await admin.from('context_sync_event').insert({
        app_id: appId,
        tenant_id: tenantId,
        branch: BRANCH,
        commit_sha: null,
        trigger: 'link',
        status: 'synced',
        error: null,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain('chk_sync_event_sha');
    });
  });
});
