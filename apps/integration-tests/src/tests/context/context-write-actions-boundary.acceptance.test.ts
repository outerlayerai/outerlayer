/**
 * Acceptance: the context WRITE surface driven as real `authorizedAction`
 * Server Action calls — the session-cookie fixture (`actAs`/`actAsInOrg`,
 * `src/lib/session-cookie.ts`) mints a real request scope, so every action's
 * own permission gate (`app_authorize` RPC, resolved from `appId`) runs for
 * real, not a hand-replicated query.
 *
 * `runCheckPendingPullRequests`'s handler is a plain `pull_request` SELECT
 * with no `GitProvider` involved at all — its full behavior (clean status,
 * the decided-PR filter, and the permission gate) is covered end-to-end here
 * as the real action.
 *
 * Every context write action shares one permission-gate ordering
 * (`authorizedAction`, step 3 before the handler body runs): a foreign
 * `appId` is rejected as `forbidden` before `GitConnectionPort.loadForApp` or
 * any `GitProvider` call ever fires. That makes cross-tenant denial coverable
 * here, for every action, with no git fixture at all — see "cross-tenant
 * denial" below.
 *
 * `runEnumerateSkillDeletion`'s `not_connected` short-circuit (no
 * `git_connection` row) is covered directly against the real production
 * ports, below.
 *
 * The action-level `forbidden` denial and the RLS-layer denial are DISTINCT
 * proofs, deliberately not collapsed into one: the permission gate fires
 * BEFORE the query ever runs, so an action-level pass says nothing about
 * whether the underlying RLS policy still holds. `runCheckPendingPullRequests`
 * keeps both — the action-level cross-tenant case here, and a raw
 * `otherOrg.client` SELECT against `pull_request` pinning the policy itself.
 *
 * UNCOVERABLE here (needs the fake-`GitProvider` fixture too — see
 * `context-write-actions-git.acceptance.test.ts`):
 *   - `runReadRemoteContextFile`'s content round-trip: `resolveAppGitProvider`
 *     — real provider.
 *   - `runSaveContextFile` / `runCreateContextFile` / `runCommit*` past the
 *     `not_connected` check: `getRemoteSha`/`createCommitWithFallback` call
 *     the real provider.
 *   - `runEnumerateSkillDeletion`'s connected path: `walkDirectoryFiles`/
 *     `listTree` always call `GitProvider`.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { createGitConnectionPort } from 'tenant-dashboard/src/lib/system/context-save/production-ports';
import { enumerateSkillDeletion } from 'tenant-dashboard/src/lib/system/context-save/save-service';
import { runCheckPendingPullRequests } from '@/features/context/actions/check-pending-pull-requests-action';
import { runSaveContextFile } from '@/features/context/actions/save-context-file-action';
import { runCreateContextFile } from '@/features/context/actions/create-context-file-action';
import { runReadRemoteContextFile } from '@/features/context/actions/read-remote-context-file-action';
import { runEnumerateSkillDeletion } from '@/features/context/actions/enumerate-skill-deletion-action';
import { runCommitUpdateFirst } from '@/features/context/actions/commit-context-changes-action';

describe('context write-action boundaries not gated by a live git provider', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `ctx-write-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id;
  }, 60000);

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  afterEach(() => {
    resetRequestScope();
  });

  describe('runCheckPendingPullRequests (real Server Action, session-cookie fixture)', () => {
    let openPrNumber: number;
    let mergedPrNumber: number;
    let closedPrNumber: number;

    beforeAll(async () => {
      openPrNumber = 200;
      mergedPrNumber = 201;
      closedPrNumber = 202;
      const { error } = await admin.from('pull_request').insert([
        {
          tenant_id: owner.tenantId,
          app_id: appId,
          pr_number: openPrNumber,
          head_branch: 'outerlayer/publish/d',
          base_branch: 'main',
          state: 'open',
        },
        {
          tenant_id: owner.tenantId,
          app_id: appId,
          pr_number: mergedPrNumber,
          head_branch: 'outerlayer/publish/e',
          base_branch: 'main',
          state: 'merged',
        },
        {
          tenant_id: owner.tenantId,
          app_id: appId,
          pr_number: closedPrNumber,
          head_branch: 'outerlayer/publish/f',
          base_branch: 'main',
          state: 'closed',
        },
      ]);
      if (error) throw new Error(`pull_request insert: ${error.message}`);
    }, 30000);

    it('reports no decided PRs when the only tracked PR is still open', async () => {
      await actAsInOrg(owner, owner.tenantId);
      const result = await runCheckPendingPullRequests({ appId, prNumbers: [openPrNumber] });
      expect(result).toEqual({ ok: true, data: { decided: [] } });
    });

    // AC-066-09
    it('filters merged and closed PRs into decided, leaving the open one out', async () => {
      await actAsInOrg(owner, owner.tenantId);
      const result = await runCheckPendingPullRequests({
        appId,
        prNumbers: [openPrNumber, mergedPrNumber, closedPrNumber],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.decided.sort()).toEqual([closedPrNumber, mergedPrNumber].sort());
    });

    it('denies a foreign tenant before the query ever runs — no PR-state leak', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runCheckPendingPullRequests({
        appId,
        prNumbers: [openPrNumber, mergedPrNumber, closedPrNumber],
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('the underlying RLS policy independently denies a foreign org — no rows, not just no permission', async () => {
      // Distinct from the action-level case above: this bypasses authorizedAction
      // entirely and hits the `pull_request` SELECT policy directly, so a
      // regression in the RLS policy itself (not just the app_authorize gate)
      // fails this test, not just the one above.
      const { data, error } = await otherOrg.client
        .from('pull_request')
        .select('pr_number, state')
        .eq('app_id', appId)
        .in('pr_number', [openPrNumber, mergedPrNumber, closedPrNumber])
        .neq('state', 'open');

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('cross-tenant denial: every context write action rejects a foreign appId before touching git', () => {
    // AC-066-10
    it('runSaveContextFile', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runSaveContextFile({
        appId,
        path: '.outerlayer/docs/x.md',
        content: 'x',
        baseBlobSha: 'irrelevant',
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('runCreateContextFile', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runCreateContextFile({
        appId,
        path: '.outerlayer/docs/y.md',
        content: 'y',
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('runReadRemoteContextFile', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runReadRemoteContextFile({ appId, path: '.outerlayer/docs/x.md' });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('runEnumerateSkillDeletion', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runEnumerateSkillDeletion({ appId, skillDir: '.outerlayer/skills/deploy' });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('runCommitUpdateFirst', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runCommitUpdateFirst({
        appId,
        files: [{ path: '.outerlayer/docs/x.md', content: 'x', baseBlobSha: 'irrelevant' }],
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });
  });

  describe('enumerateSkillDeletion, not_connected short-circuit (real production ports, no git call)', () => {
    // AC-066-08
    it('returns status "not_connected" for an app with no git_connection row — never reaches GitProvider', async () => {
      const result = await enumerateSkillDeletion(
        {
          connection: createGitConnectionPort(owner.client as never),
          policy: { loadForApp: async () => ({ requirePullRequest: false }) },
          mirror: { headBlobSha: async () => null, snapshotPaths: async () => [] },
        },
        appId,
        '.outerlayer/skills/deploy',
      );

      expect(result).toEqual({ status: 'not_connected' });
    });

    it('a foreign tenant’s client gets not_connected for an app it has no membership on, even though the app IS connected', async () => {
      // A real git_connection + git_branch row exists — owner's own client can
      // see it (proving the row is genuinely there, not merely absent) — but
      // otherOrg's client, scoped to a different tenant, hits RLS denial on
      // the connection SELECT before ever reaching branch/provider lookup.
      const { data: connApp, error: connAppError } = await admin
        .from('app')
        .insert({ name: `ctx-write-connected-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
        .select('id')
        .single();
      if (connAppError) throw new Error(`connected app insert: ${connAppError.message}`);
      const connectedAppId = connApp!.id;

      const { error: gitConnError } = await admin
        .from('git_connection')
        .insert({ app_id: connectedAppId, tenant_id: owner.tenantId, provider: 'github', repository: `octo/ctx-write-${suffix}`, created_by: owner.id });
      if (gitConnError) throw new Error(`git_connection insert: ${gitConnError.message}`);
      const { error: gitBranchError } = await admin
        .from('git_branch')
        .insert({ app_id: connectedAppId, tenant_id: owner.tenantId, branch_name: 'main' });
      if (gitBranchError) throw new Error(`git_branch insert: ${gitBranchError.message}`);

      const { data: ownerSees } = await owner.client
        .from('git_connection')
        .select('app_id')
        .eq('app_id', connectedAppId);
      expect(ownerSees).toEqual([{ app_id: connectedAppId }]);

      const result = await enumerateSkillDeletion(
        {
          connection: createGitConnectionPort(otherOrg.client as never),
          policy: { loadForApp: async () => ({ requirePullRequest: false }) },
          mirror: { headBlobSha: async () => null, snapshotPaths: async () => [] },
        },
        connectedAppId,
        '.outerlayer/skills/deploy',
      );

      expect(result).toEqual({ status: 'not_connected' });
    });
  });
});
