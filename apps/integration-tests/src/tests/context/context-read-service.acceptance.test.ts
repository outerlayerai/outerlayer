/**
 * Acceptance: the context feature's read surface — every read shape a plain
 * member drives through the real RLS wire.
 *
 * Surface enumerated from `features/context/read-actions.ts` and
 * `features/context/service.ts` (the `context.read`-gated actions and the
 * `ContextReadService` / adoption functions they wrap):
 *   - ContextReadService.getTree   → getContextTree
 *   - ContextReadService.getFile   → getContextFile
 *   - getSkillAdoption             → getContextSkillAdoption
 *   - getSkillDrilldown            → getContextSkillDrilldown
 *   - getMcpAdoption               → getContextMcpAdoption
 *   - getMcpDrilldown              → getContextMcpDrilldown
 *
 * This suite drives `ContextReadService` and the adoption functions directly
 * (the same "exported service method" the read actions call after their
 * `authorizedAction` permission check), against a real authenticated,
 * tenant-scoped Supabase client — so `context_snapshot` / `context_blob` /
 * `context_tree_entry` / `context_head`'s RLS (`context.read` + tenant match,
 * see `supabase/schemas/33-context.sql`) is exercised for real, not mocked.
 *
 * The write actions (save/create/commit/delete/enumerate-skill-deletion,
 * check-pending-pull-requests, read-remote-context-file) are UNCOVERABLE
 * here: every one resolves a real `GitProvider` via
 * `services/git/connection.ts` (`createGitProviderForApp`) and either calls
 * out to it directly or requires the `authorizedAction` Next.js request scope
 * this harness does not fake — unlike `context-sync`'s own suite, which fakes
 * the sync pipeline's `GitPort` at a different, already-covered seam
 * (`tests/context-sync/*.test.ts`). `save-service.ts`'s pure branching logic
 * (conflict/validation outcomes) is unit-tested with faked ports where it
 * lives; there is no real-git-provider seam this stack can drive.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  createCustomRole,
  assignCustomRole,
  setCustomRoleClaim,
  type SameTenantUser,
} from '../custom-roles/helpers';
import { ContextReadService } from 'tenant-dashboard/src/features/context/service';
import {
  getSkillAdoption,
  getSkillDrilldown,
  getMcpAdoption,
  getMcpDrilldown,
} from 'tenant-dashboard/src/features/context/service';
import { NotFoundError } from '@repo/observability-service';

describe('context read surface — ContextReadService + adoption overlays under real RLS', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser; // holds context.read (built-in owner role)
  let otherOrg: SameTenantUser; // a wholly separate tenant

  // connectedAppId: git-connected, synced, one skill + one mcp.json file, one oversize file
  let connectedAppId: string;
  let repository: string;
  const branch = 'main';
  let headSnapshotId: string;
  let historicalSnapshotId: string;
  const headCommitSha = 'commit-head';
  const historicalCommitSha = 'commit-old';

  // unconnectedAppId: no git_connection row at all
  let unconnectedAppId: string;
  // connectedButUnsyncedAppId: git_connection exists, no context_head row
  let unsyncedAppId: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();

    const suffix = randomUUID().slice(0, 8);
    repository = `octo/ctx-read-${suffix}`;

    const mkApp = async (name: string) => {
      const { data, error } = await admin
        .from('app')
        .insert({ name, tenant_id: owner.tenantId, created_by: owner.id })
        .select('id')
        .single();
      if (error) throw new Error(`app insert (${name}): ${error.message}`);
      return data!.id as string;
    };
    connectedAppId = await mkApp(`ctx-connected-${suffix}`);
    unconnectedAppId = await mkApp(`ctx-unconnected-${suffix}`);
    unsyncedAppId = await mkApp(`ctx-unsynced-${suffix}`);

    // require_pull_request = true on the connected app, so the tree's policy
    // projection is exercised against a non-default value.
    await admin.from('app').update({ require_pull_request: true }).eq('id', connectedAppId);

    for (const appId of [connectedAppId, unsyncedAppId]) {
      const { error } = await admin
        .from('git_connection')
        .insert({ app_id: appId, tenant_id: owner.tenantId, provider: 'github', repository, created_by: owner.id });
      if (error) throw new Error(`git_connection insert: ${error.message}`);
      const { error: branchError } = await admin
        .from('git_branch')
        .insert({ app_id: appId, tenant_id: owner.tenantId, branch_name: branch });
      if (branchError) throw new Error(`git_branch insert: ${branchError.message}`);
    }

    // Historical snapshot: one plain instruction file only.
    const { data: histSnap, error: histSnapError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        commit_sha: historicalCommitSha,
        classifier_version: 1,
      })
      .select('id')
      .single();
    if (histSnapError) throw new Error(`historical snapshot: ${histSnapError.message}`);
    historicalSnapshotId = histSnap!.id;

    await admin.from('context_blob').insert({
      tenant_id: owner.tenantId,
      app_id: connectedAppId,
      blob_sha: 'sha-old-agents',
      content: '# old AGENTS.md',
      size: 16,
    });
    await admin.from('context_tree_entry').insert({
      snapshot_id: historicalSnapshotId,
      tenant_id: owner.tenantId,
      app_id: connectedAppId,
      path: '.outerlayer/AGENTS.md',
      blob_sha: 'sha-old-agents',
      kind: 'instructions',
      scope_path: '.outerlayer',
    });

    // Head snapshot: instructions file, an mcp.json (2 servers), an oversize
    // file (tree entry with no matching blob), and a .gitkeep folder-keeper
    // entry (kind 'folder') anchoring an otherwise-empty skill directory.
    const { data: headSnap, error: headSnapError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        commit_sha: headCommitSha,
        classifier_version: 1,
        excluded_counts: [{ scopePath: '.outerlayer', skillName: 'deploy', count: 3 }],
      })
      .select('id')
      .single();
    if (headSnapError) throw new Error(`head snapshot: ${headSnapError.message}`);
    headSnapshotId = headSnap!.id;

    await admin.from('context_blob').insert([
      {
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        blob_sha: 'sha-agents',
        content: '# AGENTS.md\ncurrent instructions',
        size: 32,
      },
      {
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        blob_sha: 'sha-mcp',
        content: JSON.stringify({ mcpServers: { github: {}, linear: {} } }),
        size: 40,
      },
    ]);

    await admin.from('context_tree_entry').insert([
      {
        snapshot_id: headSnapshotId,
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        path: '.outerlayer/AGENTS.md',
        blob_sha: 'sha-agents',
        kind: 'instructions',
        scope_path: '.outerlayer',
      },
      {
        snapshot_id: headSnapshotId,
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        path: '.outerlayer/mcp.json',
        blob_sha: 'sha-mcp',
        kind: 'mcp',
        scope_path: '.outerlayer',
      },
      {
        snapshot_id: headSnapshotId,
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        path: '.outerlayer/deploy-notes.md',
        blob_sha: 'sha-oversize-missing',
        kind: 'instructions',
        scope_path: '.outerlayer',
      },
      {
        snapshot_id: headSnapshotId,
        tenant_id: owner.tenantId,
        app_id: connectedAppId,
        path: '.outerlayer/skills/x/.gitkeep',
        blob_sha: 'sha-gitkeep-x',
        kind: 'folder',
        scope_path: '.outerlayer',
      },
    ]);

    const { error: headError } = await admin.from('context_head').insert({
      app_id: connectedAppId,
      tenant_id: owner.tenantId,
      branch,
      commit_sha: headCommitSha,
      snapshot_id: headSnapshotId,
    });
    if (headError) throw new Error(`context_head insert: ${headError.message}`);
  }, 120000);

  afterAll(async () => {
    // `app` cascade-deletes context_snapshot/context_blob/context_tree_entry/
    // context_head/git_connection/git_branch (all FK app_id ON DELETE CASCADE),
    // so cleanupTenantAndUsers's app delete is sufficient.
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  }, 60000);

  describe('getTree — the tree read the editor seeds from', () => {
    it('projects entries, mcp server counts, excluded counts, and the publish policy at head', async () => {
      const service = new ContextReadService(owner.client as never);
      const tree = await service.getTree(connectedAppId);

      expect(tree.gitConnection).toEqual({ repository, branch, provider: 'github' });
      expect(tree.head).toEqual({ commitSha: headCommitSha, snapshotId: headSnapshotId, syncedAt: expect.any(String) });
      expect(tree.requirePullRequest).toBe(true);
      expect(tree.excludedCounts).toEqual([{ scopePath: '.outerlayer', skillName: 'deploy', count: 3 }]);

      const paths = tree.entries.map((e) => e.path).sort();
      expect(paths).toEqual([
        '.outerlayer/AGENTS.md',
        '.outerlayer/deploy-notes.md',
        '.outerlayer/mcp.json',
        '.outerlayer/skills/x/.gitkeep',
      ]);

      const folderEntry = tree.entries.find((e) => e.path === '.outerlayer/skills/x/.gitkeep');
      expect(folderEntry?.kind).toBe('folder');

      expect(tree.mcpServerCounts).toEqual([
        { path: '.outerlayer/mcp.json', count: 2, servers: ['github', 'linear'] },
      ]);
    });

    it('resolves an explicit historical snapshotId instead of head', async () => {
      const service = new ContextReadService(owner.client as never);
      const tree = await service.getTree(connectedAppId, historicalSnapshotId);

      expect(tree.entries.map((e) => e.path)).toEqual(['.outerlayer/AGENTS.md']);
      // head still reports the CURRENT head pointer, not the pinned snapshot —
      // the caller uses the explicit snapshotId, not `tree.head`, to know which
      // snapshot was actually read.
      expect(tree.head).toEqual({ commitSha: headCommitSha, snapshotId: headSnapshotId, syncedAt: expect.any(String) });
    });

    it('returns the "connect a repo" empty state when the app has no git connection', async () => {
      const service = new ContextReadService(owner.client as never);
      const tree = await service.getTree(unconnectedAppId);

      expect(tree).toEqual({
        gitConnection: null,
        head: null,
        entries: [],
        excludedCounts: [],
        issues: [],
        mcpServerCounts: [],
        requirePullRequest: false,
      });
    });

    it('returns the "set up context" empty state when connected but never synced', async () => {
      const service = new ContextReadService(owner.client as never);
      const tree = await service.getTree(unsyncedAppId);

      expect(tree.gitConnection).toEqual({ repository, branch, provider: 'github' });
      expect(tree.head).toBeNull();
      expect(tree.entries).toEqual([]);
    });

    it('denies a cross-tenant read: an app_id from another org never leaks a connection or entries', async () => {
      const service = new ContextReadService(otherOrg.client as never);
      const tree = await service.getTree(connectedAppId);

      expect(tree.gitConnection).toBeNull();
      expect(tree.entries).toEqual([]);
    });

    it('denies a same-row read for a member without context.read: RLS empties the tree, no error thrown', async () => {
      const role = await createCustomRole(admin, owner.tenantId, `no-context-read-${randomUUID().slice(0, 6)}`, []);
      const member = await addUserToTenant(owner.tenantId, 'read');
      await assignCustomRole(admin, member.membershipId, role.id);
      await setCustomRoleClaim(admin, member.id, role.id, member.client);

      try {
        const service = new ContextReadService(member.client as never);
        const tree = await service.getTree(connectedAppId);
        expect(tree.gitConnection).toBeNull();
        expect(tree.entries).toEqual([]);
      } finally {
        await admin.from('membership').delete().eq('id', member.membershipId);
        await admin.from('profile').delete().eq('id', member.id);
        await admin.auth.admin.deleteUser(member.id);
        await admin.from('custom_role').delete().eq('id', role.id);
      }
    });
  });

  describe('getFile — one file at head or an explicit snapshot', () => {
    it('returns the content, kind, and commitSha for a mirrored path at head', async () => {
      const service = new ContextReadService(owner.client as never);
      const file = await service.getFile(connectedAppId, '.outerlayer/AGENTS.md');

      expect(file.path).toBe('.outerlayer/AGENTS.md');
      expect(file.kind).toBe('instructions');
      expect(file.blobSha).toBe('sha-agents');
      expect(file.commitSha).toBe(headCommitSha);
      expect(file.content).toBe('# AGENTS.md\ncurrent instructions');
      expect(file.oversize).toBe(false);
    });

    it('resolves content + commitSha from an explicit historical snapshot, not head', async () => {
      const service = new ContextReadService(owner.client as never);
      const file = await service.getFile(connectedAppId, '.outerlayer/AGENTS.md', historicalSnapshotId);

      expect(file.content).toBe('# old AGENTS.md');
      expect(file.commitSha).toBe(historicalCommitSha);
    });

    it('returns oversize:true with null content when the tree entry has no mirrored blob', async () => {
      const service = new ContextReadService(owner.client as never);
      const file = await service.getFile(connectedAppId, '.outerlayer/deploy-notes.md');

      expect(file.content).toBeNull();
      expect(file.oversize).toBe(true);
      expect(file.frontmatter).toEqual({ parsed: null, issues: [] });
    });

    it('throws NotFoundError for a path absent from the resolved snapshot', async () => {
      const service = new ContextReadService(owner.client as never);
      await expect(service.getFile(connectedAppId, 'nowhere.md')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuses to open a folder-keeper (.gitkeep) entry as a file — a folder has no viewable content', async () => {
      const service = new ContextReadService(owner.client as never);
      await expect(service.getFile(connectedAppId, '.outerlayer/skills/x/.gitkeep')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('throws NotFoundError for an app with no git connection', async () => {
      const service = new ContextReadService(owner.client as never);
      await expect(service.getFile(unconnectedAppId, '.outerlayer/AGENTS.md')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('denies a cross-tenant file read as NotFoundError, never leaking content', async () => {
      const service = new ContextReadService(otherOrg.client as never);
      await expect(service.getFile(connectedAppId, '.outerlayer/AGENTS.md')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('skill/MCP adoption overlays — degrade to empty when no analytics backend is configured', () => {
    // The integration harness runs with CLICKHOUSE_HOST unset (src/test-setup.ts),
    // so createTenantReadClient() returns null and every overlay function takes
    // its documented empty-fallback path. That fallback IS the behavior
    // under test — a real ClickHouse-backed adoption read (skills/servers
    // populated from usage rollups) is UNCOVERABLE here: this harness has no
    // ClickHouse fixture for this suite.
    it('getSkillAdoption returns an empty overlay with the window bounds, not an error', async () => {
      const result = await getSkillAdoption({ tenantId: owner.tenantId, appId: connectedAppId });
      expect(result).toEqual({ skills: [], recentDays: 14, lookbackDays: 90 });
    });

    it('getSkillDrilldown returns empty trend/sessions/topics with the lookback bound', async () => {
      const result = await getSkillDrilldown({ tenantId: owner.tenantId, appId: connectedAppId, skill: 'deploy' });
      expect(result).toEqual({ trend: [], sessions: [], topics: [], lookbackDays: 90 });
    });

    it('getMcpAdoption returns an empty overlay with the window bounds, not an error', async () => {
      const result = await getMcpAdoption({ tenantId: owner.tenantId, appId: connectedAppId });
      expect(result).toEqual({ servers: [], recentDays: 14, lookbackDays: 90 });
    });

    it('getMcpDrilldown returns empty tools/trend/sessions with both window bounds', async () => {
      const result = await getMcpDrilldown({ tenantId: owner.tenantId, appId: connectedAppId, server: 'github' });
      expect(result).toEqual({ tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 });
    });
  });
});
