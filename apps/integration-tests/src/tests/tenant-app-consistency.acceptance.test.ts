/**
 * Acceptance: the database refuses a row whose tenant_id disagrees with its app_id.
 *
 * Tenant isolation is enforced by RLS predicates over a denormalized tenant_id,
 * and until composite foreign keys existed nothing made that column agree with
 * the app_id beside it. api_key is the sharp case: its policies scope the same
 * table two different ways -- the gateway's read policy trusts tenant_id, the
 * dashboard's CRUD policies trust `app_id IN authorized_app_ids(...)`. A row
 * where the two disagree is a row those policies disagree about, so whichever
 * one you happened to ask decided who could see the key.
 *
 * Every write here goes through the SERVICE ROLE, which bypasses RLS entirely.
 * That is the point: RLS was never the thing stopping a mismatched row, so a
 * test that drove an authenticated client would pass for the wrong reason.
 * What must reject these writes is the constraint itself.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { createSupabaseAdminClient } from '../lib/supabase-admin';
import { ensureDefaultEnvironment } from '../lib/environment-test-utils';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from './app-level-roles/helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

describe('tenant/app consistency is a database invariant', () => {
  const admin = createSupabaseAdminClient();

  let owning: SameTenantUser; // owns the app every write below points at
  let foreign: SameTenantUser; // an unrelated org, the "wrong" tenant_id
  let appId: string;
  let envId: string;

  beforeAll(async () => {
    owning = await createTenantWithOwner();
    foreign = await createTenantWithOwner();

    const { data: app, error } = await admin
      .from('app')
      .insert({
        name: `consistency-${randomUUID().slice(0, 8)}`,
        tenant_id: owning.tenantId,
        created_by: owning.id,
      })
      .select('id')
      .single();
    if (error) throw new Error(`app create: ${error.message}`);
    appId = app.id;

    envId = await ensureDefaultEnvironment(appId, owning.tenantId);
  });

  afterAll(async () => {
    await admin.from('saved_trace_filters').delete().eq('app_id', appId);
    await cleanupTenantAndUsers(owning.tenantId, [owning]);
    await cleanupTenantAndUsers(foreign.tenantId, [foreign]);
  });

  const newApiKey = (tenantId: string) => ({
    name: `key-${randomUUID().slice(0, 8)}`,
    api_key_id: `test-${randomUUID()}`,
    app_id: appId,
    environment_id: envId,
    tenant_id: tenantId,
    created_by: owning.id,
  });

  it('rejects an api_key whose tenant_id names an org that does not own its app', async () => {
    const { data, error } = await admin
      .from('api_key')
      .insert(newApiKey(foreign.tenantId))
      .select('id');

    // 23503 = foreign_key_violation. Asserting the constraint name too, so this
    // fails loudly if some other FK starts rejecting the row for another reason
    // and the test silently stops covering what it claims to.
    expect(error?.code).toBe('23503');
    expect(error?.message).toContain('api_key_tenant_app_fk');
    expect(data).toBeNull();

    const { data: leaked } = await admin
      .from('api_key')
      .select('id')
      .eq('app_id', appId)
      .eq('tenant_id', foreign.tenantId);
    expect(leaked).toEqual([]);
  });

  it('accepts the same api_key once its tenant_id matches the app owner', async () => {
    const { data, error } = await admin
      .from('api_key')
      .insert(newApiKey(owning.tenantId))
      .select('id, tenant_id, app_id')
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({
      id: expect.any(String),
      tenant_id: owning.tenantId,
      app_id: appId,
    });

    await admin.from('api_key').delete().eq('id', data!.id);
  });

  it('rejects moving an existing row to a foreign tenant by UPDATE', async () => {
    const { data: created, error: createError } = await admin
      .from('api_key')
      .insert(newApiKey(owning.tenantId))
      .select('id')
      .single();
    if (createError) throw new Error(`seed key: ${createError.message}`);

    const { error } = await admin
      .from('api_key')
      .update({ tenant_id: foreign.tenantId })
      .eq('id', created.id);

    expect(error?.code).toBe('23503');
    expect(error?.message).toContain('api_key_tenant_app_fk');

    const { data: after } = await admin
      .from('api_key')
      .select('tenant_id')
      .eq('id', created.id)
      .single();
    expect(after?.tenant_id).toBe(owning.tenantId);

    await admin.from('api_key').delete().eq('id', created.id);
  });

  it('rejects a cross-tenant saved_trace_filters row, which no other FK guards', async () => {
    // saved_trace_filters is the one table carrying both columns that never had
    // a single-column app_id foreign key, so the composite constraint is the
    // only thing tying its app_id to a real app at all.
    const { error } = await admin.from('saved_trace_filters').insert({
      name: `filter-${randomUUID().slice(0, 8)}`,
      user_id: owning.id,
      tenant_id: foreign.tenantId,
      app_id: appId,
      filter_config: {},
      page: 'traces',
    });

    expect(error?.code).toBe('23503');
    expect(error?.message).toContain('saved_trace_filters_tenant_app_fk');
  });

  it('deletes an app with saved views, which nothing else would clean up', async () => {
    // Unlike every other table here, saved_trace_filters has no single-column
    // app_id key, so the composite constraint is the only thing that removes
    // these rows when their app goes away. Without it a deleted app left its
    // saved views behind pointing at an id that no longer resolves -- rows no
    // read path can reach, since every one of them scopes by app_id.
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({
        name: `views-${randomUUID().slice(0, 8)}`,
        tenant_id: owning.tenantId,
        created_by: owning.id,
      })
      .select('id')
      .single();
    if (appError) throw new Error(`views app: ${appError.message}`);

    const { error: filterError } = await admin.from('saved_trace_filters').insert({
      name: `view-${randomUUID().slice(0, 8)}`,
      user_id: owning.id,
      tenant_id: owning.tenantId,
      app_id: app.id,
      filter_config: {},
      page: 'traces',
    });
    if (filterError) throw new Error(`seed saved view: ${filterError.message}`);

    const { error: deleteError } = await admin.from('app').delete().eq('id', app.id);
    expect(deleteError).toBeNull();

    const { data: survivors } = await admin
      .from('saved_trace_filters')
      .select('id')
      .eq('app_id', app.id);
    expect(survivors).toEqual([]);
  });

  it('declares ON DELETE CASCADE on every composite key, on all 18 tables', async () => {
    // This reads the catalog rather than deleting an app and watching the rows
    // vanish, because the behavioural version of this test cannot fail: each of
    // these tables also carries a single-column app_id cascade that deletes the
    // children anyway.
    //
    // The action still matters. Left at the default NO ACTION these constraints
    // make app deletion order-dependent -- the cascade trigger and the
    // no-action check trigger are both AFTER ROW triggers on app and fire in
    // trigger-name order, so if the check runs first it sees live children and
    // aborts the delete with "still referenced from table". Whether it does is
    // an accident of which constraint was created first, and it flips if one is
    // ever dropped and recreated. Pinning the declared action is the only way
    // to catch that regression deterministically.
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{
        conname: string;
        confdeltype: string;
        convalidated: boolean;
      }>(
        `SELECT conname, confdeltype, convalidated
         FROM pg_constraint
         WHERE contype = 'f' AND conname LIKE '%\\_tenant\\_app\\_fk'
         ORDER BY conname`
      );

      expect(rows).toHaveLength(18);
      // 'c' = CASCADE. Any 'a' (NO ACTION) in here is the order-dependent bug.
      expect(rows.filter((r) => r.confdeltype !== 'c')).toEqual([]);
      expect(rows.filter((r) => !r.convalidated)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('deletes an app cleanly with the composite constraints in place', async () => {
    // The composite keys reference app, so a badly specified one can block app
    // deletion outright. This proves the delete path still completes.
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({
        name: `cascade-${randomUUID().slice(0, 8)}`,
        tenant_id: owning.tenantId,
        created_by: owning.id,
      })
      .select('id')
      .single();
    if (appError) throw new Error(`cascade app: ${appError.message}`);

    const cascadeEnvId = await ensureDefaultEnvironment(app.id, owning.tenantId);
    const { error: keyError } = await admin.from('api_key').insert({
      name: `cascade-key-${randomUUID().slice(0, 8)}`,
      api_key_id: `test-${randomUUID()}`,
      app_id: app.id,
      environment_id: cascadeEnvId,
      tenant_id: owning.tenantId,
      created_by: owning.id,
    });
    if (keyError) throw new Error(`cascade key: ${keyError.message}`);

    const { error: deleteError } = await admin
      .from('app')
      .delete()
      .eq('id', app.id);
    expect(deleteError).toBeNull();

    const { data: orphans } = await admin
      .from('api_key')
      .select('id')
      .eq('app_id', app.id);
    expect(orphans).toEqual([]);
  });
});
