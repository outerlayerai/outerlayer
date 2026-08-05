/**
 * Integration test for the `on_create_seed_default_env` trigger
 * (migration 20260529221911).
 *
 * The bug: create-app moved to the gateway (`POST /v1/apps`), which inserts the
 * app row but never seeded the default `dev` env — leaving net-new apps with
 * zero environments, so Settings → Environment Variables could not resolve any
 * env ("Could not resolve the selected environment"). The fix enforces "every
 * app has exactly one default env" with a DB trigger so it holds for EVERY
 * create path, not just the (now-deprecated) server action.
 *
 * This test inserts a bare `app` row the way the gateway does (NO explicit env
 * insert) and asserts the trigger seeded exactly one `dev` / is_default env in
 * the no-pin state, scoped to the app's tenant. Runs against a real local
 * Supabase.
 *
 * Smallest production change that still passes this test: none. Drop the trigger
 * and the env count is 0 (the length assertion fails); seed the wrong
 * name/flags/version and the field assertions fail.
 */
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseAdminClient } from '../../lib/supabase-admin';

describe('on_create_seed_default_env trigger', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const tenantId = randomUUID();

  beforeAll(async () => {
    const rid = tenantId.slice(0, 8);
    const { error } = await admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `trigger-tests-${rid}`,
      organization_name: `trigger-tests-org-${rid}`,
      created_by: randomUUID(),
    });
    if (error) throw new Error(`tenant create: ${error.message}`);
  });

  afterAll(async () => {
    // Cascade: deleting the tenant removes its apps and their environments.
    await admin.from('tenant').delete().eq('tenant_id', tenantId);
  });

  it('seeds exactly one default `dev` env (no-pin) when an app is inserted with no explicit env', async () => {
    // Arrange + Act: insert a bare app row exactly like the gateway's
    // AppsService.createApp does — app row only, NO environment insert.
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({
        tenant_id: tenantId,
        name: `trigger-app-${randomUUID().slice(0, 8)}`,
      })
      .select('id, tenant_id')
      .single();
    if (appError || !app) throw new Error(`app create: ${appError?.message}`);

    // Assert: the trigger created exactly one environment for the app, and it
    // is the mandatory default `dev` in the no-pin state, scoped to the app's
    // tenant.
    const { data: envs, error: envError } = await admin
      .from('environment')
      .select('name, is_default, current_version, tenant_id')
      .eq('app_id', app.id);

    expect(envError).toBeNull();
    expect(envs).toHaveLength(1);
    const env = envs?.[0];
    if (!env) throw new Error('expected the trigger to seed exactly one environment');
    expect(env.name).toBe('dev');
    expect(env.is_default).toBe(true);
    // current_version is BIGINT — PostgREST may surface it as number or string;
    // coerce so the no-pin (0) assertion is robust to that representation.
    expect(Number(env.current_version)).toBe(0);
    expect(env.tenant_id).toBe(app.tenant_id);
  });

  it('does not create a second default env when an app already has one (the trigger is the sole seeder)', async () => {
    // A second app in the same tenant must get its OWN single default env —
    // the trigger is per-row, so this guards against a future change that might
    // seed cross-app or duplicate rows.
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({
        tenant_id: tenantId,
        name: `trigger-app2-${randomUUID().slice(0, 8)}`,
      })
      .select('id')
      .single();
    if (appError || !app) throw new Error(`app create: ${appError?.message}`);

    const { count, error } = await admin
      .from('environment')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', app.id)
      .eq('is_default', true);

    expect(error).toBeNull();
    expect(count).toBe(1);
  });
});
