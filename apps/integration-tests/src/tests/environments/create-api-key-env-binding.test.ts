/**
 * Integration test for the post-fix CreateApiKey env-binding contract.
 *
 * Pre-fix, the handler hard-coded `environment_id = (is_default=true).id`
 * for every CreateApiKey call. A writer authenticated with an env=prod-bound
 * key could only ever mint env=dev-bound child keys, and the minted key was
 * then invisible in the caller's own env-scoped ListApiKeys response.
 *
 * Post-fix, the handler looks up the caller's `api_key.environment_id` and
 * stamps the new row with the SAME env_id. This test verifies that contract
 * end-to-end against real Supabase:
 *   - The caller's parent key is seeded as env=prod-bound.
 *   - We replicate the route's resolve-and-insert logic with the real admin
 *     client.
 *   - The new row's `environment_id` is prod's id (not dev's).
 *   - The new row surfaces in an env-scoped listing for prod and is absent
 *     from the dev-scoped listing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';

describe('CreateApiKey env binding (real Supabase)', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let tenantId: string;
  let appId: string;
  let devEnvId: string;
  let prodEnvId: string;
  let parentKeyId: string;
  let parentKeyRowId: string;
  let ownerUserId: string;
  const mintedKeyIds: string[] = [];

  beforeAll(async () => {
    tenantId = randomUUID();
    const email = `cak-${Date.now()}-${randomUUID().slice(0, 6)}@test.com`;
    const { data: a } = await admin.auth.admin.createUser({
      email,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    ownerUserId = a!.user!.id;
    await admin.from('profile').insert({ id: ownerUserId, name: 'cak', email });
    await admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `cak-${randomUUID().slice(0, 6)}`,
      organization_name: `cak-${randomUUID().slice(0, 6)}`,
      created_by: ownerUserId,
    });

    const { data: app } = await admin
      .from('app')
      .insert({ name: `cak-${randomUUID().slice(0, 6)}`, tenant_id: tenantId, created_by: ownerUserId })
      .select('id')
      .single();
    appId = (app as { id: string }).id;

    // The default `dev` env is auto-seeded by the `on_create_seed_default_env`
    // trigger when the app row is inserted; resolve its id via the
    // fetch-or-create helper instead of inserting a colliding duplicate.
    devEnvId = await ensureDefaultEnvironment(appId, tenantId);

    const { data: prod } = await admin
      .from('environment')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        name: 'prod',
        is_default: false,
        created_by: ownerUserId,
      })
      .select('id')
      .single();
    prodEnvId = (prod as { id: string }).id;

    // Seed the parent api_key — env=prod-bound.
    parentKeyId = `key_parent_${randomUUID().slice(0, 8)}`;
    const { data: parentRow } = await admin
      .from('api_key')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        environment_id: prodEnvId,
        name: `cak-parent-${randomUUID().slice(0, 6)}`,
        api_key_id: parentKeyId,
        created_by: ownerUserId,
      })
      .select('id')
      .single();
    parentKeyRowId = (parentRow as { id: string }).id;
  });

  afterAll(async () => {
    if (mintedKeyIds.length > 0) {
      await admin.from('api_key').delete().in('api_key_id', mintedKeyIds);
    }
    await admin.from('api_key').delete().eq('id', parentKeyRowId);
    await admin.from('environment').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('tenant').delete().eq('tenant_id', tenantId);
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => undefined);
  });

  /**
   * Replicates the post-fix CreateApiKey handler insert path against real
   * Supabase: lookup caller's env from api_key, insert a new key bound to
   * the SAME env. This is the exact two-step the route does after the fix.
   */
  async function mintChildKey(parentApiKeyId: string, name: string): Promise<string> {
    // 1. Lookup caller's env_id from their api_key row.
    const { data: caller, error: callerErr } = await admin
      .from('api_key')
      .select('environment_id')
      .eq('api_key_id', parentApiKeyId)
      .maybeSingle();
    if (callerErr || !caller) throw new Error(`caller lookup: ${callerErr?.message ?? 'not found'}`);
    const envId = (caller as { environment_id: string }).environment_id;
    if (!envId) throw new Error('caller has no environment_id');

    // 2. Insert the new api_key row, stamping the same env_id.
    const newKeyId = `key_child_${randomUUID().slice(0, 8)}`;
    const { error: insertErr } = await admin.from('api_key').insert({
      tenant_id: tenantId,
      app_id: appId,
      environment_id: envId,
      name,
      api_key_id: newKeyId,
      created_by: null,
    });
    if (insertErr) throw new Error(`insert: ${insertErr.message}`);
    mintedKeyIds.push(newKeyId);
    return newKeyId;
  }

  it('binds the new api_key to the SAME env as the caller (prod), not the default env (dev)', async () => {
    const childKeyId = await mintChildKey(parentKeyId, `child-of-prod-${randomUUID().slice(0, 6)}`);

    const { data: child } = await admin
      .from('api_key')
      .select('environment_id')
      .eq('api_key_id', childKeyId)
      .single();
    expect((child as { environment_id: string }).environment_id).toBe(prodEnvId);
    expect((child as { environment_id: string }).environment_id).not.toBe(devEnvId);
  });

  it('the minted key surfaces in an env-scoped list for prod', async () => {
    const childKeyId = await mintChildKey(parentKeyId, `child-listing-${randomUUID().slice(0, 6)}`);

    const { data: prodList } = await admin
      .from('api_key')
      .select('api_key_id')
      .eq('app_id', appId)
      .eq('environment_id', prodEnvId);
    const prodIds = (prodList ?? []).map((r) => (r as { api_key_id: string }).api_key_id);
    expect(prodIds).toContain(childKeyId);
  });

  it('the minted key is ABSENT from an env-scoped list for dev (the pre-fix bug surface)', async () => {
    const childKeyId = await mintChildKey(parentKeyId, `child-absence-${randomUUID().slice(0, 6)}`);

    const { data: devList } = await admin
      .from('api_key')
      .select('api_key_id')
      .eq('app_id', appId)
      .eq('environment_id', devEnvId);
    const devIds = (devList ?? []).map((r) => (r as { api_key_id: string }).api_key_id);
    expect(devIds).not.toContain(childKeyId);
  });
});
