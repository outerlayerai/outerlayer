/**
 * Canary + first converted case for the fake `GitProvider` fixture
 * (`src/lib/fake-git-provider.ts`).
 *
 * The canary pins the registry-override contract: `installFakeGitProvider()`
 * makes `createGitProviderForApp` — the ONE place `save-service`,
 * `resolveAppGitProvider`, and context-sync all resolve a provider from —
 * return a `FakeGitProvider` for a normal `provider: 'github'` connection row,
 * with zero schema change and zero other test-only wiring.
 *
 * The converted case drives `runSaveContextFile` (`@/features/context/actions/save-context-file-action.ts`
 * — the UPDATE path: its schema requires a `baseBlobSha` string, so a create
 * goes through the sibling `runCreateContextFile` action instead) as a true
 * Server Action call, composed with the session-cookie fixture (`actAsInOrg`)
 * — exactly the composition a git-write action needs: both fixtures
 * together. The sibling suite
 * (`context-save-tenant-coherence.acceptance.test.ts`) stops at the DB
 * boundary and pins the connection *read* only; here the commit actually lands
 * in the fake repo — asserted by content and commit log, not by a
 * re-implemented read.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient, createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';
import { uniqueInstallationId } from '../../lib/app-test-utils';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import {
  installFakeGitProvider,
  seedFakeRepo,
  getFakeRepoFile,
  getFakeRepoCommits,
  getFakeRepoPullRequests,
  fakeBlobSha,
  failNextCall,
  resetFakeRepos,
} from '../../lib/fake-git-provider';
import { createGitProviderForApp } from '@/lib/system/git/connection';
import { runSaveContextFile } from '@/features/context/actions/save-context-file-action';
import { GitProviderError } from '@/lib/system/git/errors';

describe('fake GitProvider fixture', () => {
  const admin = createSupabaseAdminClient();
  let restoreProviderFactory: (() => void) | undefined;

  let owner: SameTenantUser;
  let appId: string;
  let repository: string;

  beforeAll(async () => {
    restoreProviderFactory = installFakeGitProvider();

    owner = await createTenantWithOwner();
    repository = `fake-org/repo-${randomUUID().slice(0, 8)}`;

    const { data: appRow, error: appError } = await admin
      .from('app')
      .insert({
        name: `fake-git-${randomUUID().slice(0, 8)}`,
        tenant_id: owner.tenantId,
        created_by: owner.id,
      })
      .select('id')
      .single();
    if (appError) throw new Error(`seed app: ${appError.message}`);
    appId = appRow!.id;

    // A normal provider: 'github' connection row — the fixture's whole point
    // is that this needs no schema change (git_connection.provider stays
    // CHECK-constrained to 'github' | 'gitlab'); the registry override, not
    // the row, is what routes it to the fake.
    //
    // installation_id must be unique per run:
    // excl_git_connection_installation_one_tenant binds an installation to a
    // single tenant, so a literal shared with another suite's tenant raises
    // 23P01 whenever the two overlap. The fake ignores the value.
    const { error: connError } = await admin.from('git_connection').insert({
      app_id: appId,
      tenant_id: owner.tenantId,
      provider: 'github',
      repository,
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
    // beforeAll may have thrown before the assignment (a seed failure), in
    // which case there is nothing to restore.
    restoreProviderFactory?.();
    await admin.from('git_branch').delete().eq('app_id', appId);
    await admin.from('git_connection').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('membership').delete().eq('user_id', owner.id);
    await admin.from('profile').delete().eq('id', owner.id);
    try {
      await admin.auth.admin.deleteUser(owner.id);
    } catch {
      // best-effort; a leaked auth user does not affect other suites
    }
    await admin.from('tenant').delete().eq('tenant_id', owner.tenantId);
  });

  // proves AC-068-05
  it('installFakeGitProvider routes createGitProviderForApp to the fake for a normal github connection', async () => {
    seedFakeRepo(repository, { branch: 'main', files: {} });

    const provider = await createGitProviderForApp(admin, appId);
    expect(provider).not.toBeNull();
    expect(provider!.type).toBe('github');
    expect(await provider!.listBranches(repository)).toEqual(['main']);
  });

  it('runSaveContextFile (real Server Action) updates an existing context file and the commit lands in the fake repo', async () => {
    const path = '.outerlayer/docs/onboarding.md';
    const original = '# Onboarding\n\nOriginal steps.';
    seedFakeRepo(repository, { branch: 'main', files: { [path]: original } });
    await actAsInOrg(owner, owner.tenantId);

    const content = '# Onboarding\n\nUpdated steps.';
    const baseBlobSha = fakeBlobSha(original);

    const result = await runSaveContextFile({
      appId,
      path,
      content,
      baseBlobSha,
      commitMessage: 'Update onboarding doc',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('saved');
    if (result.data.status !== 'saved') return;
    expect(result.data.result.landed).toBe('branch');

    // The commit actually landed in the fake repo — content and commit log,
    // not a re-implemented DB read. `seedFakeRepo` records its own initial
    // file set as a synthetic seed commit, so the real save is the SECOND
    // (newest) commit on the branch.
    expect(getFakeRepoFile(repository, 'main', path)).toBe(content);
    const commits = getFakeRepoCommits(repository, 'main');
    expect(commits).toHaveLength(2);
    const saveCommit = commits.at(-1)!;
    // The user-supplied commitMessage becomes the subject; the actor identity
    // still lands in the `Saved-by:` trailer save-service always appends.
    expect(saveCommit.message).toContain('Update onboarding doc');
    expect(saveCommit.message).toContain(`Saved-by: ${owner.email}`);
  });

  it('runSaveContextFile opens a PR instead of a direct commit when the app requires one', async () => {
    const path = '.outerlayer/docs/policy.md';
    const original = '# Policy\n\nOriginal.';
    seedFakeRepo(repository, { branch: 'main', files: { [path]: original } });
    await actAsInOrg(owner, owner.tenantId);

    const { error: policyError } = await admin
      .from('app')
      .update({ require_pull_request: true })
      .eq('id', appId);
    if (policyError) throw new Error(`set require_pull_request: ${policyError.message}`);

    try {
      const result = await runSaveContextFile({
        appId,
        path,
        content: '# Policy\n\nEdited.',
        baseBlobSha: fakeBlobSha(original),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('saved');
      if (result.data.status !== 'saved') return;
      expect(result.data.result.landed).toBe('pull_request');

      // The target branch is untouched — the commit landed on a separate head
      // branch, recorded as an open PR the fake repo can be asked about.
      expect(getFakeRepoFile(repository, 'main', path)).toBe(original);
      const prs = getFakeRepoPullRequests(repository);
      expect(prs).toHaveLength(1);
      expect(prs[0]).toMatchObject({ baseBranch: 'main', state: 'open' });
    } finally {
      await admin.from('app').update({ require_pull_request: false }).eq('id', appId);
    }
  });

  it('runSaveContextFile surfaces a scripted provider failure as a git_error, without writing', async () => {
    const path = '.outerlayer/docs/flaky.md';
    const original = '# Flaky\n\nOriginal.';
    seedFakeRepo(repository, { branch: 'main', files: { [path]: original } });
    await actAsInOrg(owner, owner.tenantId);

    // Fires on save-service's pre-write conflict read (getRemoteSha calls
    // provider.getFileContent BEFORE createCommitWithFallback) — the first
    // call to this method from anywhere, not the write itself.
    failNextCall('getFileContent', new GitProviderError('fake outage', 'github', 'UNKNOWN_ERROR', 500));

    const result = await runSaveContextFile({
      appId,
      path,
      content: '# Flaky\n\nEdited.',
      baseBlobSha: fakeBlobSha(original),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('git_error');
    if (result.data.status !== 'git_error') return;
    expect(result.data.message).toBe('fake outage');

    // No commit fired and the file is untouched — only the seed commit exists.
    expect(getFakeRepoFile(repository, 'main', path)).toBe(original);
    expect(getFakeRepoCommits(repository, 'main')).toHaveLength(1);
  });

  it('runSaveContextFile reports a conflict when the fake repo head has moved since baseBlobSha', async () => {
    const path = '.outerlayer/docs/setup.md';
    seedFakeRepo(repository, { branch: 'main', files: { [path]: '# Setup\n\nOriginal.' } });
    await actAsInOrg(owner, owner.tenantId);

    const result = await runSaveContextFile({
      appId,
      path,
      content: '# Setup\n\nEdited.',
      baseBlobSha: 'stale-sha-that-does-not-match',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('conflict');
    if (result.data.status !== 'conflict') return;
    expect(result.data.reason).toBe('modified');

    // No new commit fired — the fake repo's file is untouched, and only the
    // seedFakeRepo synthetic seed commit is on record.
    expect(getFakeRepoFile(repository, 'main', path)).toBe('# Setup\n\nOriginal.');
    expect(getFakeRepoCommits(repository, 'main')).toHaveLength(1);
  });
});
