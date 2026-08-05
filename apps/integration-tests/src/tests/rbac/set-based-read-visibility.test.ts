/**
 * Positive read-visibility pins for the set-based app-scoped RLS policies.
 *
 * The app-scoped policies filter with `app_id IN (SELECT
 * private.authorized_app_ids(<perm>))`. A "select allow" assertion that only
 * checks error === null cannot tell an authorized read from a policy that hides
 * every row — both return an empty error. These pins seed a known row through
 * the service role, then assert the least-privileged permitted role actually
 * SEES it (id equality), and that a member of another tenant does not.

 */
import { cleanupTestUsers } from '../../lib/test-utils';
import { createTestUser, createTestData } from '../../lib/rbac-test-utils';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';
import { supabase as anonClient } from '../../lib/supabase';

async function seedAppWithEnv(tenantId: string, ownerId: string, label: string) {
  const app = await createTestData('app', {
    name: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    tenant_id: tenantId,
    created_by: ownerId,
  });
  const environmentId = await ensureDefaultEnvironment(app.id, tenantId);
  return { appId: app.id, environmentId };
}

describe('set-based RLS read visibility', () => {
  afterAll(async () => {
    await cleanupTestUsers();
  });

  // Dashboard and its widgets: without an authenticated read asserting positive
  // visibility, a perturbation of the read policy's permission (dashboard.read →
  // dashboard.delete) survives the suite unnoticed.
  describe('dashboard', () => {
    it('an org read-role member sees a dashboard and its widget', async () => {
      const reader = await createTestUser('read');
      const { appId } = await seedAppWithEnv(reader.tenantId, reader.id, 'dash-visible');
      const dashboard = await createTestData('dashboard', {
        tenant_id: reader.tenantId,
        app_id: appId,
        name: `Dash ${Date.now()}`,
      });
      const widget = await createTestData('dashboard_widget', {
        tenant_id: reader.tenantId,
        dashboard_id: dashboard.id,
        title: 'Widget',
        metric: 'requests',
      });

      const dash = await reader.client.from('dashboard').select('id').eq('id', dashboard.id);
      expect(dash.error).toBeNull();
      expect((dash.data ?? []).map((r) => r.id)).toEqual([dashboard.id]);

      const wid = await reader.client.from('dashboard_widget').select('id').eq('id', widget.id);
      expect(wid.error).toBeNull();
      expect((wid.data ?? []).map((r) => r.id)).toEqual([widget.id]);
    });

    it('a member of another tenant sees neither', async () => {
      const reader = await createTestUser('read');
      const { appId } = await seedAppWithEnv(reader.tenantId, reader.id, 'dash-crosstenant');
      const dashboard = await createTestData('dashboard', {
        tenant_id: reader.tenantId,
        app_id: appId,
        name: `Dash ${Date.now()}`,
      });

      const outsider = await createTestUser('owner');
      const dash = await outsider.client.from('dashboard').select('id').eq('id', dashboard.id);
      expect(dash.error).toBeNull();
      expect(dash.data ?? []).toHaveLength(0);
    });
  });

  // Production reads the five context tables through the service role, which
  // bypasses RLS — so only these tests cover their authenticated read policies.
  describe('context tables', () => {
    it('an org read-role member sees rows across all five context tables', async () => {
      const reader = await createTestUser('read');
      const { appId } = await seedAppWithEnv(reader.tenantId, reader.id, 'ctx-visible');
      const base = { tenant_id: reader.tenantId, app_id: appId };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const snapshot = await createTestData('context_snapshot', {
        ...base,
        commit_sha: `sha-${stamp}`,
        classifier_version: 1,
      });
      await createTestData('context_blob', {
        ...base,
        blob_sha: `blob-${stamp}`,
        content: 'hello',
        size: 5,
      });
      await createTestData('context_tree_entry', {
        ...base,
        snapshot_id: snapshot.id,
        path: `file-${stamp}`,
        blob_sha: `blob-${stamp}`,
        kind: 'file',
        scope_path: '/',
      });
      await createTestData('context_head', {
        ...base,
        branch: `branch-${stamp}`,
        commit_sha: `sha-${stamp}`,
        snapshot_id: snapshot.id,
      });
      await createTestData('context_sync_event', {
        ...base,
        branch: `branch-${stamp}`,
        trigger: 'push',
        status: 'synced',
        commit_sha: `sha-${stamp}`,
      });

      // Most context tables are keyed by composite PKs, not a surrogate id, so
      // each probe filters on the unique column it was seeded with and asserts
      // exactly the one row comes back for this authenticated reader.
      const cases: Array<[string, string, string]> = [
        ['context_snapshot', 'commit_sha', `sha-${stamp}`],
        ['context_blob', 'blob_sha', `blob-${stamp}`],
        ['context_tree_entry', 'path', `file-${stamp}`],
        ['context_head', 'branch', `branch-${stamp}`],
        ['context_sync_event', 'branch', `branch-${stamp}`],
      ];
      for (const [table, column, value] of cases) {
        const { data, error } = await reader.client.from(table).select(column).eq(column, value);
        expect(error).toBeNull();
        expect((data ?? []).map((r) => (r as Record<string, string>)[column])).toEqual([value]);
      }
    });
  });

  // The converted policies scope to authenticated. On these anon-granted tables
  // an anon SELECT must find NO applicable policy and return an empty set — not
  // hard-error. A policy left open to PUBLIC would run authorized_app_ids as the
  // anon role, which has no EXECUTE on it, and surface "permission denied for
  // function authorized_app_ids" instead.
  describe('anon reads return empty, never a function permission error', () => {
    const ANON_GRANTED_TABLES = ['env_var', 'dashboard'] as const;
    for (const table of ANON_GRANTED_TABLES) {
      it(`anon SELECT on ${table} is empty with no error`, async () => {
        const { data, error } = await anonClient.from(table).select('id');
        expect(error).toBeNull();
        expect(data ?? []).toHaveLength(0);
      });
    }
  });
});
