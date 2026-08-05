/**
 * API Key visibility — kind-scoped keys must be listable (Integration)
 *
 * Regression: the dashboard keys list filtered
 * `.eq('environment_id', <selectedEnv>)`, but a kind-scoped key has
 * `environment_id = NULL`, so it appeared in NO per-env list and could never be
 * viewed or revoked after its one-time plaintext reveal. The fix lists a
 * selected env's PINNED keys OR any kind-scoped key, via
 * `.or('environment_id.eq.<env>,allowed_env_kinds.not.is.null')`.
 *
 * This exercises the REAL PostgREST `.or` semantics against a real local
 * Supabase (the unit test mocks the REST layer and can't validate the actual
 * query). Each test seeds its own rows and deletes them in the same block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { setupEnvNavFixture, type EnvNavFixture } from './helpers';

describe('api_key visibility — kind-scoped keys are listable', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;
  const keyIds: string[] = [];
  let devPinnedId: string;
  let prodPinnedId: string;
  let kindScopedId: string;

  async function seedKey(opts: {
    name: string;
    environmentId: string | null;
    allowedEnvKinds: string[] | null;
  }): Promise<string> {
    const { data, error } = await admin
      .from('api_key')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        api_key_id: `unkey-${randomUUID()}`,
        name: opts.name,
        environment_id: opts.environmentId,
        allowed_env_kinds: opts.allowedEnvKinds,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seedKey(${opts.name}): ${error?.message}`);
    keyIds.push(data.id as string);
    return data.id as string;
  }

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();
    devPinnedId = await seedKey({
      name: 'Dev pinned',
      environmentId: fixture.devEnv.id,
      allowedEnvKinds: null,
    });
    prodPinnedId = await seedKey({
      name: 'Prod pinned',
      environmentId: fixture.prodEnv.id,
      allowedEnvKinds: null,
    });
    kindScopedId = await seedKey({
      name: 'Preview CI key',
      environmentId: null,
      allowedEnvKinds: ['preview'],
    });
  });

  afterAll(async () => {
    if (keyIds.length) await admin.from('api_key').delete().in('id', keyIds);
    await fixture?.cleanup();
  });

  it('the fixed query returns the env-pinned keys for THIS env PLUS the kind-scoped key', async () => {
    // The exact query the settings page runs for the dev env.
    const { data, error } = await admin
      .from('api_key')
      .select('id')
      .eq('app_id', fixture.appId)
      .or(`environment_id.eq.${fixture.devEnv.id},allowed_env_kinds.not.is.null`);
    expect(error).toBeNull();
    const ids = (data ?? []).map((r) => r.id as string).sort();
    // dev-pinned + kind-scoped, but NOT the prod-pinned key.
    expect(ids).toEqual([devPinnedId, kindScopedId].sort());
    expect(ids).not.toContain(prodPinnedId);
  });

  it('the kind-scoped key shows on EVERY env view (prod selected), never the other env pin', async () => {
    const { data } = await admin
      .from('api_key')
      .select('id')
      .eq('app_id', fixture.appId)
      .or(`environment_id.eq.${fixture.prodEnv.id},allowed_env_kinds.not.is.null`);
    const ids = (data ?? []).map((r) => r.id as string).sort();
    expect(ids).toEqual([prodPinnedId, kindScopedId].sort());
    expect(ids).not.toContain(devPinnedId);
  });

  it('proves the OLD query hid the kind-scoped key (regression lock)', async () => {
    // The pre-fix query — env-equality only — never returns env_id NULL rows.
    const { data } = await admin
      .from('api_key')
      .select('id')
      .eq('app_id', fixture.appId)
      .eq('environment_id', fixture.devEnv.id);
    const ids = (data ?? []).map((r) => r.id as string);
    expect(ids).toContain(devPinnedId);
    expect(ids).not.toContain(kindScopedId);
  });
});
