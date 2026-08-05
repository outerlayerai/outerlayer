/**
 * Acceptance: deleting a tenant removes everything that belongs to it.
 *
 * Every foreign key referencing public.tenant carries ON DELETE CASCADE (or
 * SET NULL for pure-preference columns like profile.last_active_tenant_id). A
 * mixed set is not a weaker guarantee, it is a nondeterministic one: deleting a
 * tenant fires one RI trigger per referencing constraint in trigger-name order,
 * which follows constraint creation order rather than dependency order. A
 * NO ACTION constraint on a table that also cascades from `app` is therefore a
 * race -- if the cascade through `app` runs first the rows are gone and the
 * check passes, and if the check runs first it sees live rows and aborts the
 * whole delete. Which one wins flips whenever a constraint is dropped and
 * recreated, so the same delete can pass locally and fail in production off
 * nothing but migration history.
 *
 * Neither half below is redundant. The catalog test pins the declared action
 * so a single new NO ACTION reference fails loudly at the source. The
 * behavioural test proves the delete path actually completes, and it is the one
 * that fails when the catalog drifts -- the unit tests around the delete
 * service mock the RPC, so nothing above the database can catch this.
 *
 * Every write here goes through the SERVICE ROLE, which bypasses RLS entirely.
 * RLS was never what governed cascade behaviour; the constraints are.
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

/**
 * The tables whose tenant reference was the order-dependent half of the set.
 * Each also cascades from `app`, which is precisely why a NO ACTION tenant
 * reference on them was a race rather than a consistent failure.
 */
const PREVIOUSLY_ORDER_DEPENDENT = [
  'app',
  'git_connection',
  'git_branch',
  'user_git_identity',
  'notification',
  'context_snapshot',
  'context_blob',
  'context_tree_entry',
  'context_head',
] as const;

describe('deleting a tenant removes every row that belongs to it', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let survivor: SameTenantUser; // an unrelated org that must be left untouched
  let survivorAppId: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    survivor = await createTenantWithOwner();

    const { data: app, error } = await admin
      .from('app')
      .insert({
        name: `survivor-${randomUUID().slice(0, 8)}`,
        tenant_id: survivor.tenantId,
        created_by: survivor.id,
      })
      .select('id')
      .single();
    if (error) throw new Error(`survivor app create: ${error.message}`);
    survivorAppId = app.id;
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(survivor.tenantId, [survivor]);
    // The owner tenant is deleted by the test itself; this clears the auth user
    // and profile rows, which live outside the tenant cascade.
    try {
      await admin.from('profile').delete().eq('id', owner.id);
      await admin.auth.admin.deleteUser(owner.id);
    } catch (err) {
      console.warn(`Cleanup failed for ${owner.email}:`, err);
    }
  });

  /** Populate one row in each order-dependent table, all owned by `tenantId`. */
  async function seedOrderDependentRows(tenantId: string, userId: string) {
    const rid = randomUUID().slice(0, 8);

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `cascade-${rid}`, tenant_id: tenantId, created_by: userId })
      .select('id')
      .single();
    if (appError) throw new Error(`app: ${appError.message}`);
    const appId = app.id;

    await ensureDefaultEnvironment(appId, tenantId);
    const snapshotId = randomUUID();

    const check = (table: string, error: { message: string } | null) => {
      if (error) throw new Error(`${table}: ${error.message}`);
    };

    check(
      'git_connection',
      (await admin.from('git_connection').insert({ tenant_id: tenantId, app_id: appId })).error
    );
    check(
      'git_branch',
      (await admin.from('git_branch').insert({ tenant_id: tenantId, app_id: appId })).error
    );
    check(
      'user_git_identity',
      (
        await admin.from('user_git_identity').insert({
          profile_id: userId,
          tenant_id: tenantId,
          provider: 'github',
          username: `cascade-${rid}`,
        })
      ).error
    );
    check(
      'notification',
      (await admin.from('notification').insert({ tenant_id: tenantId, message: `cascade-${rid}` }))
        .error
    );
    check(
      'context_snapshot',
      (
        await admin.from('context_snapshot').insert({
          id: snapshotId,
          tenant_id: tenantId,
          app_id: appId,
          commit_sha: `sha-${rid}`,
          classifier_version: 1,
        })
      ).error
    );
    check(
      'context_blob',
      (
        await admin.from('context_blob').insert({
          tenant_id: tenantId,
          app_id: appId,
          blob_sha: `blob-${rid}`,
          content: 'x',
          size: 1,
        })
      ).error
    );
    check(
      'context_tree_entry',
      (
        await admin.from('context_tree_entry').insert({
          snapshot_id: snapshotId,
          tenant_id: tenantId,
          app_id: appId,
          path: 'a.md',
          blob_sha: `blob-${rid}`,
          kind: 'doc',
          scope_path: '/',
        })
      ).error
    );
    check(
      'context_head',
      (
        await admin.from('context_head').insert({
          app_id: appId,
          tenant_id: tenantId,
          branch: 'main',
          commit_sha: `sha-${rid}`,
          snapshot_id: snapshotId,
        })
      ).error
    );

    return appId;
  }

  /** Row counts per table for one tenant, in PREVIOUSLY_ORDER_DEPENDENT order. */
  async function countsFor(tenantId: string): Promise<number[]> {
    const counts: number[] = [];
    for (const table of PREVIOUSLY_ORDER_DEPENDENT) {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`count ${table}: ${error.message}`);
      counts.push(count ?? 0);
    }
    return counts;
  }

  it('declares ON DELETE CASCADE on every foreign key referencing tenant', async () => {
    // Reading the catalog rather than inferring from behaviour: a single new
    // NO ACTION reference is the regression, and it should name itself here
    // instead of surfacing later as an order-dependent delete failure.
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{
        conrelid: string;
        conname: string;
        confdeltype: string;
        convalidated: boolean;
      }>(
        `SELECT conrelid::regclass::text AS conrelid, conname, confdeltype, convalidated
           FROM pg_constraint
          WHERE contype = 'f'
            AND connamespace = 'public'::regnamespace
            AND confrelid = 'public.tenant'::regclass
          ORDER BY conname`
      );

      // 'c' = CASCADE and 'n' = SET NULL are both delete-order-independent;
      // 'a' = NO ACTION is the regression. The SET NULL set is pinned
      // positionally so a new reference still names itself here for review.
      const setNull = rows
        .filter((r) => r.confdeltype === 'n')
        .map((r) => `${r.conrelid}.${r.conname}`);
      expect(setNull).toEqual(['profile.profile_last_active_tenant_id_fkey']);

      const notCascading = rows
        .filter((r) => r.confdeltype !== 'c' && r.confdeltype !== 'n')
        .map((r) => `${r.conrelid}.${r.conname}`);
      expect(notCascading).toEqual([]);

      const unvalidated = rows.filter((r) => !r.convalidated).map((r) => r.conname);
      expect(unvalidated).toEqual([]);

      // Every table carrying the order-dependent reference is still covered.
      const covered = new Set(rows.map((r) => r.conrelid));
      expect(PREVIOUSLY_ORDER_DEPENDENT.filter((t) => !covered.has(t))).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('deletes a fully populated tenant and leaves no residue', async () => {
    await seedOrderDependentRows(owner.tenantId, owner.id);

    // Positional: catches a table silently dropping out of the fixture, which
    // would otherwise let the delete assertion pass over rows that never existed.
    const before = await countsFor(owner.tenantId);
    expect(before).toEqual(PREVIOUSLY_ORDER_DEPENDENT.map(() => 1));

    const { error } = await admin.rpc('platform_admin_delete_tenant', {
      p_tenant_id: owner.tenantId,
    });
    expect(error).toBeNull();

    const after = await countsFor(owner.tenantId);
    expect(after).toEqual(PREVIOUSLY_ORDER_DEPENDENT.map(() => 0));

    const { data: tenantRow } = await admin
      .from('tenant')
      .select('tenant_id')
      .eq('tenant_id', owner.tenantId)
      .maybeSingle();
    expect(tenantRow).toBeNull();
  });

  it('leaves an unrelated tenant untouched', async () => {
    // A cascade reaching past the tenant boundary is a far worse bug than an
    // incomplete one, so the delete above is pinned from both sides.
    const { data: apps } = await admin
      .from('app')
      .select('id')
      .eq('tenant_id', survivor.tenantId);
    expect(apps).toEqual([{ id: survivorAppId }]);

    const { data: tenantRow } = await admin
      .from('tenant')
      .select('tenant_id')
      .eq('tenant_id', survivor.tenantId)
      .maybeSingle();
    expect(tenantRow).toEqual({ tenant_id: survivor.tenantId });
  });
});
