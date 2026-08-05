/**
 * RLS: the api_key UPDATE policy added with the Postgres key-store.
 *
 * The policy ("Enable api_key update for users with update access") gates on
 * private.app_authorize('api_key.update', app_id) AND tenant_id() matching the
 * row. Nothing else in the suite exercises it directly, so this file pins the
 * two behaviors that matter:
 *
 *   1. Positive control — a tenant's owner CAN update their own key's
 *      permissions. This also proves the policy exists at all: without it,
 *      Postgres denies UPDATE for `authenticated` outright and the negative
 *      case below would pass vacuously.
 *   2. Tenant isolation — a signed-in owner of ANOTHER tenant updating the
 *      same row touches zero rows, and the stored permissions are unchanged.
 *
 * Runs entirely against Supabase (no gateway needed).
 */
import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { setupEnvFixture, type EnvTestFixture } from './helpers';

const admin = createSupabaseAdminClient();

describe('api_key UPDATE RLS policy', () => {
  let tenantA: EnvTestFixture;
  let tenantB: EnvTestFixture;
  let keyRowId: string;

  beforeAll(async () => {
    tenantA = await setupEnvFixture();
    tenantB = await setupEnvFixture();

    // Seed a key row for tenant A directly (service role — set_tenant_id
    // trusts the passed tenant_id on the service path). No digest is written:
    // this test exercises the row's RLS, not verification.
    const { data, error } = await admin
      .from('api_key')
      .insert({
        name: `rls-update-${randomBytes(4).toString('hex')}`,
        api_key_id: `key_${randomBytes(12).toString('hex')}`,
        app_id: tenantA.app.id,
        tenant_id: tenantA.tenant.id,
        environment_id: tenantA.defaultEnv.id,
        permissions: ['trace.write'],
        key_prefix: 'sk_outerlayer_rlstest',
        created_by: null,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seed api_key row: ${error?.message}`);
    keyRowId = data.id as string;
  }, 120_000);

  afterAll(async () => {
    await admin.from('api_key').delete().eq('id', keyRowId);
    await tenantA?.cleanup();
    await tenantB?.cleanup();
  });

  it("tenant B's owner cannot update tenant A's key permissions (zero rows, value unchanged)", async () => {
    const { data, error } = await tenantB.ownerUser.client
      .from('api_key')
      .update({ permissions: ['score.write'] })
      .eq('id', keyRowId)
      .select('id');

    // RLS filters the row out of the UPDATE's scope: no error, zero rows.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: row } = await admin
      .from('api_key')
      .select('permissions')
      .eq('id', keyRowId)
      .single();
    expect(row?.permissions).toEqual(['trace.write']);
  });

  it("tenant A's owner can update their own key's permissions (positive control)", async () => {
    const { data, error } = await tenantA.ownerUser.client
      .from('api_key')
      .update({ permissions: ['trace.write', 'score.write'] })
      .eq('id', keyRowId)
      .select('id, permissions');

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: keyRowId, permissions: ['trace.write', 'score.write'] },
    ]);

    const { data: row } = await admin
      .from('api_key')
      .select('permissions')
      .eq('id', keyRowId)
      .single();
    expect(row?.permissions).toEqual(['trace.write', 'score.write']);
  });
});
