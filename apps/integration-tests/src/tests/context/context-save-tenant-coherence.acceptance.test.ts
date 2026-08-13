/**
 * Acceptance: a context save acts on the URL org, not the JWT claim.
 *
 * A context save reads the app's git connection to know where to commit; that
 * SELECT is scoped by public.tenant_id(). When the wrapped save action built a
 * claim-scoped server client, a member whose stale claim named a DIFFERENT org
 * read no connection under that claim — so the save silently no-op'd as "not
 * connected", even though under the org in the URL the app IS connected.
 *
 * This drives that exact connection read through the real RLS wire for ONE actor
 * two ways: header-scoped to the URL org (finds the connection → the save
 * proceeds) versus the actor's own claim org (finds nothing → the silent no-op).
 * The fix — createSupabaseServerClient(tenantId) in the action — is what puts the
 * save on the first path.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from '../app-level-roles/helpers';

describe('context save — the request tenant, not the claim, gates the connection read', () => {
  const admin = createSupabaseAdminClient();

  let urlOrg: SameTenantUser; // the org in the URL: owns the connected app
  let actor: SameTenantUser; // claim names their OWN org; also an owner of urlOrg
  let appId: string;
  let snapshotId: string; // the synced snapshot the mirror-read tests scope against
  const repository = `octo/context-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    urlOrg = await createTenantWithOwner();
    actor = await createTenantWithOwner(); // JWT claim = actor.tenantId (a different org)

    // The actor joins the URL org as an owner. Their JWT still claims their own
    // org, so a claim-scoped client acts on that org while a URL-scoped client
    // acts on the URL org — the exact divergence the URL-scoped tenant resolution closes.
    const { error: membershipError } = await admin.from('membership').insert({
      user_id: actor.id,
      tenant_id: urlOrg.tenantId,
      role: 'owner',
      status: 'active',
    });
    if (membershipError) throw new Error(`actor membership: ${membershipError.message}`);

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({
        name: `ctx-conn-${randomUUID().slice(0, 8)}`,
        tenant_id: urlOrg.tenantId,
        created_by: urlOrg.id,
      })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id;

    const { error: connectionError } = await admin.from('git_connection').insert({
      app_id: appId,
      tenant_id: urlOrg.tenantId,
      provider: 'github',
      repository,
      created_by: urlOrg.id,
    });
    if (connectionError) throw new Error(`git_connection insert: ${connectionError.message}`);

    // A synced snapshot with one mirrored file, so the tree/file reads have
    // content to scope. All rows carry the URL org's tenant_id — the mirror
    // read tests assert who can see them.
    const { data: snapshot, error: snapshotError } = await admin
      .from('context_snapshot')
      .insert({ tenant_id: urlOrg.tenantId, app_id: appId, commit_sha: 'commit-1', classifier_version: 1 })
      .select('id')
      .single();
    if (snapshotError) throw new Error(`context_snapshot insert: ${snapshotError.message}`);
    snapshotId = snapshot!.id;

    const { error: blobError } = await admin
      .from('context_blob')
      .insert({ tenant_id: urlOrg.tenantId, app_id: appId, blob_sha: 'blob-1', content: '# Hello', size: 7 });
    if (blobError) throw new Error(`context_blob insert: ${blobError.message}`);

    const { error: entryError } = await admin.from('context_tree_entry').insert({
      snapshot_id: snapshotId,
      tenant_id: urlOrg.tenantId,
      app_id: appId,
      path: '.outerlayer/AGENTS.md',
      blob_sha: 'blob-1',
      kind: 'instructions',
      scope_path: '',
    });
    if (entryError) throw new Error(`context_tree_entry insert: ${entryError.message}`);

    const { error: headError } = await admin.from('context_head').insert({
      app_id: appId,
      tenant_id: urlOrg.tenantId,
      branch: 'main',
      commit_sha: 'commit-1',
      snapshot_id: snapshotId,
    });
    if (headError) throw new Error(`context_head insert: ${headError.message}`);
  }, 90000);

  afterAll(async () => {
    await admin.from('git_connection').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin
      .from('membership')
      .delete()
      .eq('user_id', actor.id)
      .eq('tenant_id', urlOrg.tenantId);
    await cleanupTenantAndUsers(urlOrg.tenantId, [urlOrg]);
    await cleanupTenantAndUsers(actor.tenantId, [actor]);
  });

  // AC-066-11
  it('under the URL org the connection read finds the app’s repository', async () => {
    const asUrlOrg = await createTenantScopedClient(actor, urlOrg.tenantId);

    const { data, error } = await asUrlOrg
      .from('git_connection')
      .select('app_id, repository')
      .eq('app_id', appId);

    expect(error).toBeNull();
    // The save resolves the connected repo — it proceeds against the URL org.
    expect(data).toEqual([{ app_id: appId, repository }]);
  });

  it('under the actor’s own claim org the same read finds nothing — the silent no-op the fix prevents', async () => {
    // The fixture client sends no X-Tenant-Id, so public.tenant_id() falls back
    // to the claim (the actor’s own org). A claim-scoped save reads no connection
    // for this app and would bail "not connected", never touching the URL org’s
    // connected app.
    const { data, error } = await actor.client
      .from('git_connection')
      .select('app_id, repository')
      .eq('app_id', appId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('a member reading under the URL org sees the app’s synced head, tree, and blob', async () => {
    const asUrlOrg = await createTenantScopedClient(urlOrg, urlOrg.tenantId);

    const { data: head } = await asUrlOrg
      .from('context_head')
      .select('branch, commit_sha, snapshot_id')
      .eq('app_id', appId);
    expect(head).toEqual([{ branch: 'main', commit_sha: 'commit-1', snapshot_id: snapshotId }]);

    const { data: entries } = await asUrlOrg
      .from('context_tree_entry')
      .select('path, blob_sha, kind')
      .eq('app_id', appId);
    expect(entries).toEqual([{ path: '.outerlayer/AGENTS.md', blob_sha: 'blob-1', kind: 'instructions' }]);

    const { data: blob } = await asUrlOrg
      .from('context_blob')
      .select('content')
      .eq('app_id', appId)
      .eq('blob_sha', 'blob-1');
    expect(blob).toEqual([{ content: '# Hello' }]);
  });

  it('a non-member spoofing the URL tenant reads no mirror rows — fail-closed', async () => {
    // The URL org's owner is not a member of the actor's org; scoping them there
    // makes public.tenant_id() NULL, so RLS admits no mirror rows for the app.
    const spoof = await createTenantScopedClient(urlOrg, actor.tenantId);

    const { data: head } = await spoof.from('context_head').select('app_id').eq('app_id', appId);
    expect(head).toEqual([]);
    const { data: entries } = await spoof
      .from('context_tree_entry')
      .select('path')
      .eq('app_id', appId);
    expect(entries).toEqual([]);
    const { data: blob } = await spoof.from('context_blob').select('blob_sha').eq('app_id', appId);
    expect(blob).toEqual([]);
  });

  it('the URL org’s context is invisible under a different org the actor also belongs to (isolation)', async () => {
    // The actor is a member of their OWN org too; scoped there, the URL org's app
    // and its mirror are not visible — the read scopes to the acting tenant.
    const asActorOrg = await createTenantScopedClient(actor, actor.tenantId);

    const { data } = await asActorOrg
      .from('context_tree_entry')
      .select('path')
      .eq('app_id', appId);
    expect(data).toEqual([]);
  });
});
