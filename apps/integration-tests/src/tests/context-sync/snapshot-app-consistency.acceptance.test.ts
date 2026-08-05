/**
 * Acceptance: a context row cannot point at a snapshot another app owns.
 *
 * context_tree_entry, context_head, and context_sync_event each carry their own
 * app_id beside a snapshot_id. RLS on these tables filters by the local app_id,
 * so if the two are allowed to disagree, a row describing one org's repo content
 * can be written under an app another org owns — and the policies serve it,
 * because from their side the row looks legitimate.
 *
 * tenant_app_fk does not cover this. On such a row the (tenant_id, app_id) pair
 * is internally consistent; the snapshot linkage is what is not.
 *
 * Every write here goes through the SERVICE ROLE, which bypasses RLS. That is
 * the point: RLS was never what stopped a mismatched row, so a test driving an
 * authenticated client would pass for the wrong reason.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from '../app-level-roles/helpers';

describe('context snapshot / app consistency is a database invariant', () => {
  const admin = createSupabaseAdminClient();

  let owning: SameTenantUser; // owns the snapshot
  let foreign: SameTenantUser; // an unrelated org
  let owningAppId: string;
  let foreignAppId: string;
  let snapshotId: string;

  beforeAll(async () => {
    owning = await createTenantWithOwner();
    foreign = await createTenantWithOwner();

    const mkApp = async (u: SameTenantUser) => {
      const { data, error } = await admin
        .from('app')
        .insert({ name: `ctx-${randomUUID().slice(0, 8)}`, tenant_id: u.tenantId, created_by: u.id })
        .select('id')
        .single();
      if (error) throw new Error(`app create: ${error.message}`);
      return data.id as string;
    };
    owningAppId = await mkApp(owning);
    foreignAppId = await mkApp(foreign);

    const { data, error } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: owning.tenantId,
        app_id: owningAppId,
        commit_sha: `sha-${randomUUID().slice(0, 8)}`,
        classifier_version: 1,
      })
      .select('id')
      .single();
    if (error) throw new Error(`snapshot create: ${error.message}`);
    snapshotId = data.id;
  });

  afterAll(async () => {
    await admin.from('context_snapshot').delete().eq('app_id', owningAppId);
    await cleanupTenantAndUsers(owning.tenantId, [owning]);
    await cleanupTenantAndUsers(foreign.tenantId, [foreign]);
  });

  it('rejects a tree entry whose app_id is not the snapshot owner', async () => {
    const { data, error } = await admin
      .from('context_tree_entry')
      .insert({
        snapshot_id: snapshotId,
        tenant_id: foreign.tenantId,
        app_id: foreignAppId,
        path: 'leak.md',
        blob_sha: 'sha-leak',
        kind: 'doc',
        scope_path: '/',
      })
      .select('path');

    // Asserting the constraint name too, so this fails loudly if some other key
    // starts rejecting the row and the test stops covering what it claims to.
    expect(error?.code).toBe('23503');
    expect(error?.message).toContain('context_tree_entry_snapshot_app_fk');
    expect(data).toBeNull();
  });

  it('rejects a head and a sync event pointing at a foreign snapshot', async () => {
    const { error: headError } = await admin.from('context_head').insert({
      app_id: foreignAppId,
      tenant_id: foreign.tenantId,
      branch: 'main',
      commit_sha: 'sha-leak',
      snapshot_id: snapshotId,
    });
    expect(headError?.code).toBe('23503');
    expect(headError?.message).toContain('context_head_snapshot_app_fk');

    const { error: eventError } = await admin.from('context_sync_event').insert({
      tenant_id: foreign.tenantId,
      app_id: foreignAppId,
      branch: 'main',
      status: 'synced',
      trigger: 'push',
      commit_sha: 'sha-leak',
      snapshot_id: snapshotId,
    });
    expect(eventError?.code).toBe('23503');
    expect(eventError?.message).toContain('context_sync_event_snapshot_app_fk');
  });

  it('accepts the same rows when the app owns the snapshot', async () => {
    // The constraints must not have overshot — the normal sync path writes all
    // three of these on every push.
    const { error: entryError } = await admin.from('context_tree_entry').insert({
      snapshot_id: snapshotId,
      tenant_id: owning.tenantId,
      app_id: owningAppId,
      path: 'ok.md',
      blob_sha: 'sha-ok',
      kind: 'doc',
      scope_path: '/',
    });
    expect(entryError).toBeNull();

    const { error: headError } = await admin.from('context_head').insert({
      app_id: owningAppId,
      tenant_id: owning.tenantId,
      branch: 'main',
      commit_sha: 'sha-ok',
      snapshot_id: snapshotId,
    });
    expect(headError).toBeNull();

    const { error: eventError } = await admin.from('context_sync_event').insert({
      tenant_id: owning.tenantId,
      app_id: owningAppId,
      branch: 'main',
      status: 'synced',
      trigger: 'push',
      commit_sha: 'sha-ok',
      snapshot_id: snapshotId,
    });
    expect(eventError).toBeNull();
  });

  it('prunes a snapshot without nulling app_id on the audit row', async () => {
    // context_sync_event uses ON DELETE SET NULL (snapshot_id). The column list
    // matters: a bare SET NULL would also target app_id, which is
    // NOT NULL, and retention-pruning would fail outright.
    const { data: snap, error: snapError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: owning.tenantId,
        app_id: owningAppId,
        commit_sha: `prune-${randomUUID().slice(0, 8)}`,
        classifier_version: 1,
      })
      .select('id')
      .single();
    if (snapError) throw new Error(`prune snapshot: ${snapError.message}`);

    await admin.from('context_tree_entry').insert({
      snapshot_id: snap.id,
      tenant_id: owning.tenantId,
      app_id: owningAppId,
      path: 'pruned.md',
      blob_sha: 'sha-prune',
      kind: 'doc',
      scope_path: '/',
    });
    const { data: event } = await admin
      .from('context_sync_event')
      .insert({
        tenant_id: owning.tenantId,
        app_id: owningAppId,
        branch: 'prune-branch',
        status: 'synced',
        trigger: 'push',
        commit_sha: 'sha-prune',
        snapshot_id: snap.id,
      })
      .select('id')
      .single();

    const { error: deleteError } = await admin
      .from('context_snapshot')
      .delete()
      .eq('id', snap.id);
    expect(deleteError).toBeNull();

    const { data: entries } = await admin
      .from('context_tree_entry')
      .select('path')
      .eq('snapshot_id', snap.id);
    expect(entries).toEqual([]);

    const { data: survived } = await admin
      .from('context_sync_event')
      .select('snapshot_id, app_id')
      .eq('id', event!.id)
      .single();
    expect(survived).toEqual({ snapshot_id: null, app_id: owningAppId });
  });
});
