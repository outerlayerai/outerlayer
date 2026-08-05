/**
 * Integration: the manual RESYNC path against a real Postgres. Seam mirrors
 * resync-context-action.ts's core: buildContextSync({ db, git }).resync(...) → on a
 * synced outcome, advanceCommitPointers. Resync recovers BOTH the mirror and
 * the trace-stamping pointers after a webhook outage; a failed resync must
 * leave both untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  seedTenant,
} from './helpers';

const admin = createSupabaseAdminClient();
const REPO = 'octo/ctx-resync';
const BRANCH = 'main';
const OLD = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const NEW = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';

function sync(git: ReturnType<typeof createFakeGit>) {
  return buildContextSync({ db: createSupabaseContextMirrorPort(admin), git });
}

/** Bring the mirror + pointers to OLD, as if a prior link/push had synced. */
async function primeAtOld(appId: string, tenantId: string) {
  await sync(
    createFakeGit({ headSha: OLD, files: { '.outerlayer/AGENTS.md': '# v1' }, blobShas: { '.outerlayer/AGENTS.md': 'sha-v1' } }),
  ).initialSync({ appId, tenantId, repo: REPO, branch: BRANCH });
  await advanceCommitPointers(admin, { appId, commitSha: OLD });
}

describe('context-sync · resync', () => {
  let tenantId: string;
  let appId: string;

  beforeEach(async () => {
    tenantId = await seedTenant(admin);
    const app = await seedApp(admin, tenantId);
    appId = app.appId;
    await seedGitConnection(admin, { tenantId, appId, repository: REPO, provider: 'github' });
    await seedGitBranch(admin, { tenantId, appId, branch: BRANCH });
  });

  afterEach(async () => {
    await cleanupTenant(admin, tenantId);
  });

  it('advances the mirror AND the pointers from a drifted state', async () => {
    await primeAtOld(appId, tenantId);
    expect(await readHead(admin, appId)).toMatchObject({ commit_sha: OLD });

    const outcome = await sync(
      createFakeGit({ headSha: NEW, files: { '.outerlayer/AGENTS.md': '# v2' }, blobShas: { '.outerlayer/AGENTS.md': 'sha-v2' } }),
    ).resync({ appId, tenantId, repo: REPO, branch: BRANCH });

    expect(outcome.kind).toBe('resynced');
    expect(outcome.commitSha).toBe(NEW);
    // The action advances pointers only on a resolved-sha outcome.
    await advanceCommitPointers(admin, { appId, commitSha: outcome.commitSha! });

    // Mirror advanced to NEW.
    expect(await readHead(admin, appId)).toMatchObject({ branch: BRANCH, commit_sha: NEW, snapshot_id: outcome.snapshotId });

    // Exactly one resync event, synced, no commit message (resync doesn't fetch one).
    const resyncEvents = (await readSyncEvents(admin, appId)).filter((e) => e.trigger === 'resync');
    expect(resyncEvents).toEqual([
      expect.objectContaining({ trigger: 'resync', status: 'synced', commit_sha: NEW, commit_message: null, error: null, snapshot_id: outcome.snapshotId }),
    ]);

    // Pointers advanced to NEW.
    const { appCommitSha, envs } = await readPointers(admin, appId);
    expect(appCommitSha).toBe(NEW);
    expect(envs.find((e) => e.is_default)!.current_commit_sha).toBe(NEW);
  });

  it('leaves the mirror and pointers untouched when the provider is unreachable', async () => {
    await primeAtOld(appId, tenantId);

    const outcome = await sync(
      createFakeGit({ failOn: 'getLatestCommitSha', failMessage: 'gitlab unreachable' }),
    ).resync({ appId, tenantId, repo: REPO, branch: BRANCH });

    expect(outcome.kind).toBe('failed');
    expect(outcome.commitSha).toBeUndefined();
    // resync-action skips advanceCommitPointers when there is no resolved sha.

    const resyncEvents = (await readSyncEvents(admin, appId)).filter((e) => e.trigger === 'resync');
    expect(resyncEvents).toEqual([
      expect.objectContaining({ trigger: 'resync', status: 'failed', commit_sha: null, error: 'gitlab unreachable', snapshot_id: null }),
    ]);

    // Mirror head still at OLD; pointers still at OLD.
    expect(await readHead(admin, appId)).toMatchObject({ commit_sha: OLD });
    const { appCommitSha, envs } = await readPointers(admin, appId);
    expect(appCommitSha).toBe(OLD);
    expect(envs.find((e) => e.is_default)!.current_commit_sha).toBe(OLD);
  });
});
