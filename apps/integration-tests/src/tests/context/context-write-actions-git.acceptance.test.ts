/**
 * Acceptance: the context WRITE surface that needs BOTH fixtures — the
 * session-cookie fixture (`actAsInOrg`, for the real Server Action call) and
 * the fake `GitProvider` fixture (`installFakeGitProvider`, for the git
 * round-trip past `not_connected`). `runSaveContextFile`'s update path,
 * PR-fallback, and provider-error branches are already covered by
 * `git-provider-fixture/fake-git-provider-fixture.acceptance.test.ts` (the
 * fixture's own canary + first converted case) — not duplicated here. This
 * file covers the remaining context write actions the same composition
 * unlocks: `runReadRemoteContextFile`'s content round-trip,
 * `runCreateContextFile`'s create + duplicate-path conflict,
 * `runCommit*`'s multi-file atomic commit (including a delete-first batch),
 * and `runEnumerateSkillDeletion`'s connected-app directory walk.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient, createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { uniqueInstallationId } from '../../lib/app-test-utils';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import {
  installFakeGitProvider,
  seedFakeRepo,
  getFakeRepoFile,
  getFakeRepoCommits,
  fakeBlobSha,
  resetFakeRepos,
} from '../../lib/fake-git-provider';
import { runReadRemoteContextFile } from '@/features/context/actions/read-remote-context-file-action';
import { runCreateContextFile } from '@/features/context/actions/create-context-file-action';
import { runCommitUpdateFirst, runCommitDeleteFirst } from '@/features/context/actions/commit-context-changes-action';
import { runEnumerateSkillDeletion } from '@/features/context/actions/enumerate-skill-deletion-action';

describe('context write-action git round-trips (session-cookie + fake GitProvider)', () => {
  const admin = createSupabaseAdminClient();
  let restoreProviderFactory: (() => void) | undefined;

  let owner: SameTenantUser;
  let appId: string;
  let repository: string;

  beforeAll(async () => {
    restoreProviderFactory = installFakeGitProvider();

    owner = await createTenantWithOwner();
    repository = `fake-org/ctx-git-${randomUUID().slice(0, 8)}`;

    const { data: appRow, error: appError } = await admin
      .from('app')
      .insert({ name: `ctx-git-${randomUUID().slice(0, 8)}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`seed app: ${appError.message}`);
    appId = appRow!.id;

    const { error: connError } = await admin.from('git_connection').insert({
      app_id: appId,
      tenant_id: owner.tenantId,
      provider: 'github',
      repository,
      // Unique per call: excl_git_connection_installation_one_tenant binds an
      // installation to one tenant, so a literal shared with the sibling
      // fake-provider suite's tenant raises 23P01 when both overlap.
      installation_id: uniqueInstallationId(),
      created_by: owner.id,
    });
    if (connError) throw new Error(`seed git_connection: ${connError.message}`);

    const { error: branchError } = await createSupabaseAdminClientUntyped()
      .from('git_branch')
      .insert({ app_id: appId, tenant_id: owner.tenantId, branch_name: 'main', repo: repository });
    if (branchError) throw new Error(`seed git_branch: ${branchError.message}`);
  }, 90000);

  afterEach(() => {
    resetRequestScope();
    resetFakeRepos();
  });

  afterAll(async () => {
    restoreProviderFactory?.();
    await admin.from('git_branch').delete().eq('app_id', appId);
    await admin.from('git_connection').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
  });

  describe('runReadRemoteContextFile', () => {
    it('reads the file content, blob sha, and commit sha at the connected branch head', async () => {
      const path = '.outerlayer/docs/readme.md';
      const content = '# Readme\n\nHello.';
      seedFakeRepo(repository, { branch: 'main', files: { [path]: content } });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runReadRemoteContextFile({ appId, path });
      expect(result).toEqual({
        ok: true,
        data: {
          data: {
            content,
            blobSha: fakeBlobSha(content),
            commitSha: getFakeRepoCommits(repository, 'main')[0]!.sha,
          },
        },
      });
    });

    it('reports a null content/blobSha when the path is absent at the remote head (deleted)', async () => {
      seedFakeRepo(repository, { branch: 'main', files: {} });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runReadRemoteContextFile({ appId, path: '.outerlayer/docs/gone.md' });
      expect(result).toEqual({
        ok: true,
        data: { data: { content: null, blobSha: null, commitSha: null } },
      });
    });
  });

  describe('runCreateContextFile', () => {
    it('creates a new path and the commit lands in the fake repo', async () => {
      seedFakeRepo(repository, { branch: 'main', files: {} });
      await actAsInOrg(owner, owner.tenantId);

      const path = '.outerlayer/docs/new.md';
      const content = '# New\n\nContent.';
      const result = await runCreateContextFile({ appId, path, content, commitMessage: 'Add new doc' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('saved');
      expect(getFakeRepoFile(repository, 'main', path)).toBe(content);
    });

    it('rejects a duplicate path as a conflict — no commit fired', async () => {
      const path = '.outerlayer/docs/existing.md';
      const original = '# Existing\n\nAlready here.';
      seedFakeRepo(repository, { branch: 'main', files: { [path]: original } });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runCreateContextFile({ appId, path, content: '# Existing\n\nOverwrite attempt.' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        status: 'conflict',
        path,
        remoteSha: fakeBlobSha(original),
        reason: 'exists',
      });
      // Only the seed commit exists — the conflict never reached createCommitWithFallback.
      expect(getFakeRepoCommits(repository, 'main')).toHaveLength(1);
      expect(getFakeRepoFile(repository, 'main', path)).toBe(original);
    });
  });

  describe('runCommitUpdateFirst / runCommitDeleteFirst', () => {
    it('lands a mixed update+create batch as one atomic commit', async () => {
      const updatePath = '.outerlayer/docs/a.md';
      const createPath = '.outerlayer/docs/b.md';
      const originalA = '# A\n\nOriginal.';
      seedFakeRepo(repository, { branch: 'main', files: { [updatePath]: originalA } });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runCommitUpdateFirst({
        appId,
        message: 'Batch update + create',
        files: [
          { path: updatePath, content: '# A\n\nEdited.', baseBlobSha: fakeBlobSha(originalA) },
          { path: createPath, content: '# B\n\nNew.', baseBlobSha: null },
        ],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('saved');
      expect(getFakeRepoFile(repository, 'main', updatePath)).toBe('# A\n\nEdited.');
      expect(getFakeRepoFile(repository, 'main', createPath)).toBe('# B\n\nNew.');
      // One atomic commit for both files, on top of the seed commit.
      const commits = getFakeRepoCommits(repository, 'main');
      expect(commits).toHaveLength(2);
    });

    it('lands a delete-only batch through runCommitDeleteFirst, removing the file at head', async () => {
      const path = '.outerlayer/docs/c.md';
      const original = '# C\n\nTo be deleted.';
      seedFakeRepo(repository, { branch: 'main', files: { [path]: original } });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runCommitDeleteFirst({
        appId,
        message: 'Remove doc C',
        files: [{ path, content: '', baseBlobSha: fakeBlobSha(original), delete: true }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('saved');
      expect(getFakeRepoFile(repository, 'main', path)).toBeNull();
    });

    it('reports a stale-base conflict for the batch, no commit fired', async () => {
      const path = '.outerlayer/docs/d.md';
      seedFakeRepo(repository, { branch: 'main', files: { [path]: '# D\n\nOriginal.' } });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runCommitUpdateFirst({
        appId,
        files: [{ path, content: '# D\n\nEdited.', baseBlobSha: 'stale-sha' }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        status: 'conflict',
        conflicts: [{ path, remoteSha: fakeBlobSha('# D\n\nOriginal.'), reason: 'modified' }],
      });
      expect(getFakeRepoCommits(repository, 'main')).toHaveLength(1);
    });
  });

  describe('runEnumerateSkillDeletion — connected app, live directory walk', () => {
    it('lists every file under the skill directory via the fake provider listTree', async () => {
      const skillDir = '.outerlayer/skills/deploy';
      const files = {
        [`${skillDir}/SKILL.md`]: '# Deploy',
        [`${skillDir}/scripts/run.sh`]: '#!/bin/sh',
        [`${skillDir}/assets/logo.png`]: 'binary-stand-in',
        '.outerlayer/docs/unrelated.md': '# Unrelated',
      };
      seedFakeRepo(repository, { branch: 'main', files });
      await actAsInOrg(owner, owner.tenantId);

      const result = await runEnumerateSkillDeletion({ appId, skillDir });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('ok');
      if (result.data.status !== 'ok') return;
      expect(result.data.enumeration.paths).toEqual(
        [`${skillDir}/SKILL.md`, `${skillDir}/assets/logo.png`, `${skillDir}/scripts/run.sh`].sort(),
      );
      // No context_head/snapshot is seeded for this app, so the mirror sees
      // nothing — every listed path is reported as an asset (mirror-blind).
      expect(result.data.enumeration.assetPaths.sort()).toEqual(
        [`${skillDir}/SKILL.md`, `${skillDir}/assets/logo.png`, `${skillDir}/scripts/run.sh`].sort(),
      );
      expect(result.data.enumeration.shas[`${skillDir}/SKILL.md`]).toBe(fakeBlobSha('# Deploy'));
    });
  });
});
