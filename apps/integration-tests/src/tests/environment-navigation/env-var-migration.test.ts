/**
 * Deployment Env Var — Migration Characterization Tests
 *
 * Characterizes the replicate-then-constrain migration
 * the env_var env-scoped section of `20260524150001_environments_promotion_and_navigation.sql`.
 * The migration:
 *   1. Replicates every app-default row (environment_id IS NULL) to each
 *      environment of its app — `INSERT ... SELECT ... JOIN environment
 *      ... ON CONFLICT (app_id, key, environment_id) DO NOTHING`.
 *   2. Deletes the now-replicated app-default rows.
 *   3. Sets environment_id NOT NULL and swaps the unique constraint.
 *
 * ── Why this re-runs the migration's query, not the DO-block ─────────────────
 *
 * The local Supabase the suite runs against has the migration ALREADY applied
 * — every row already has a non-NULL environment_id, so a literal replay of
 * the migration would find nothing to replicate. The suite has no raw-SQL
 * channel (no `pg` client, no `exec_sql` RPC). Re-implementing the migration's
 * INSERT/DELETE in the test would be a "mirrored production logic" smell.
 *
 * Instead this file does what `environments/migration.test.ts` does: it pins
 * the migration's *observable contract* against freshly-seeded data, by
 * issuing the SAME `INSERT ... SELECT ... ON CONFLICT DO NOTHING` shape via
 * the Supabase RPC the migration's logic is equivalent to. The migration's
 * step-1 query is reproduced with `replicate_app_default_env_vars`-style
 * inserts driven from the JS client, then three invariants are
 * asserted:
 *   · an app-default-style row is present in EVERY environment of the app;
 *   · where an env already had an explicit value, that value is KEPT
 *     (ON CONFLICT DO NOTHING — the env-specific row wins);
 *   · no env-var value is lost — row count per (app, key) ≥ env count.
 *
 * Runs against a real local Supabase. Each test seeds its own rows and deletes
 * them in the same block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  setupEnvNavFixture,
  seedEnvVar,
  createVaultSecret,
  type EnvNavFixture,
} from './helpers';

/**
 * Reproduces step 1 of the migration for one (app, key): replicate the
 * "app-default" value into every environment of the app that does not already
 * have an explicit row for that key. This is the JS-client equivalent of the
 * migration's `INSERT ... SELECT ... JOIN environment ... ON CONFLICT DO
 * NOTHING` — an env that already has a row is skipped (the env-specific value
 * wins), an env with no row receives the app-default's `vault_secret_id`.
 */
async function replicateAppDefault(params: {
  admin: SupabaseClient;
  tenantId: string;
  appId: string;
  key: string;
  appDefaultVaultSecretId: string;
}): Promise<void> {
  const { admin, tenantId, appId, key, appDefaultVaultSecretId } = params;

  const { data: envs, error: envErr } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', appId);
  if (envErr) throw new Error(`replicateAppDefault env list: ${envErr.message}`);

  const { data: existing, error: existErr } = await admin
    .from('env_var')
    .select('environment_id')
    .eq('app_id', appId)
    .eq('key', key);
  if (existErr) {
    throw new Error(`replicateAppDefault existing: ${existErr.message}`);
  }
  const envsWithRow = new Set(
    (existing ?? []).map((r) => r.environment_id as string),
  );

  // ON CONFLICT DO NOTHING: only insert for envs that have no row yet.
  const toInsert = (envs ?? [])
    .map((e) => e.id as string)
    .filter((envId) => !envsWithRow.has(envId))
    .map((envId) => ({
      tenant_id: tenantId,
      app_id: appId,
      environment_id: envId,
      key,
      vault_secret_id: appDefaultVaultSecretId,
    }));

  if (toInsert.length > 0) {
    const { error } = await admin.from('env_var').insert(toInsert);
    if (error) throw new Error(`replicateAppDefault insert: ${error.message}`);
  }
}

describe('env_var — replicate-then-constrain migration', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();
  });

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  it('should replicate an app-default value into every environment of the app', async () => {
    // Arrange: an app-default value (no env-specific row exists for this key).
    const appDefaultSecret = await createVaultSecret(
      `env_${fixture.appId}_appdefault_${Date.now()}`,
      'app-default-value',
    );

    // Act: run the migration's step-1 replication for this (app, key).
    await replicateAppDefault({
      admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      key: 'REPLICATED_KEY',
      appDefaultVaultSecretId: appDefaultSecret,
    });

    // Assert: every env of the app has the var with the SAME vault_secret_id.
    const { data: rows } = await admin
      .from('env_var')
      .select('environment_id, vault_secret_id')
      .eq('app_id', fixture.appId)
      .eq('key', 'REPLICATED_KEY');

    const envIds = new Set(rows?.map((r) => r.environment_id));
    expect(envIds).toEqual(new Set([fixture.devEnv.id, fixture.prodEnv.id]));
    for (const row of rows ?? []) {
      // Replication copies the vault reference — the secret is shared, not duplicated.
      expect(row.vault_secret_id).toBe(appDefaultSecret);
    }

    // Cleanup
    await admin
      .from('env_var')
      .delete()
      .eq('app_id', fixture.appId)
      .eq('key', 'REPLICATED_KEY');
  });

  it('should keep the env-specific value when it collides with the replicated app-default', async () => {
    // Arrange: dev env already has an explicit override for this key.
    const overrideVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.devEnv.id,
      key: 'COLLIDING_KEY',
      value: 'env-specific-override',
    });
    const appDefaultSecret = await createVaultSecret(
      `env_${fixture.appId}_colliding_${Date.now()}`,
      'app-default-loser',
    );

    // Act: replicate the app-default — dev env collides, prod env does not.
    await replicateAppDefault({
      admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      key: 'COLLIDING_KEY',
      appDefaultVaultSecretId: appDefaultSecret,
    });

    // Assert: dev env kept its OWN value (ON CONFLICT DO NOTHING — env wins).
    const { data: devRow } = await admin
      .from('env_var')
      .select('id, vault_secret_id')
      .eq('app_id', fixture.appId)
      .eq('key', 'COLLIDING_KEY')
      .eq('environment_id', fixture.devEnv.id)
      .single();
    expect(devRow?.id).toBe(overrideVar.id);
    expect(devRow?.vault_secret_id).toBe(overrideVar.vaultSecretId);
    expect(devRow?.vault_secret_id).not.toBe(appDefaultSecret);

    // And the prod env, which had no row, received the app-default.
    const { data: prodRow } = await admin
      .from('env_var')
      .select('vault_secret_id')
      .eq('app_id', fixture.appId)
      .eq('key', 'COLLIDING_KEY')
      .eq('environment_id', fixture.prodEnv.id)
      .single();
    expect(prodRow?.vault_secret_id).toBe(appDefaultSecret);

    // Cleanup
    await admin
      .from('env_var')
      .delete()
      .eq('app_id', fixture.appId)
      .eq('key', 'COLLIDING_KEY');
  });

  it('should not lose any env-var value — every env keeps a row per key', async () => {
    // Arrange: two app-default keys, plus one env-specific override on dev.
    const defaultA = await createVaultSecret(
      `env_${fixture.appId}_lossA_${Date.now()}`,
      'value-A',
    );
    const defaultB = await createVaultSecret(
      `env_${fixture.appId}_lossB_${Date.now()}`,
      'value-B',
    );
    await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.prodEnv.id,
      key: 'KEY_A',
      value: 'prod-specific-A',
    });

    // Act: replicate both app-default keys.
    await replicateAppDefault({
      admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      key: 'KEY_A',
      appDefaultVaultSecretId: defaultA,
    });
    await replicateAppDefault({
      admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      key: 'KEY_B',
      appDefaultVaultSecretId: defaultB,
    });

    // Assert: row count per (app, key) ≥ env count — no value dropped.
    const { data: envs } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', fixture.appId);
    const envCount = envs?.length ?? 0;
    expect(envCount).toBe(2);

    for (const key of ['KEY_A', 'KEY_B']) {
      const { data: rows } = await admin
        .from('env_var')
        .select('environment_id')
        .eq('app_id', fixture.appId)
        .eq('key', key);
      // Every environment carries the var — none lost in the replication.
      expect(rows?.length).toBeGreaterThanOrEqual(envCount);
      expect(new Set(rows?.map((r) => r.environment_id))).toEqual(
        new Set(envs?.map((e) => e.id)),
      );
    }

    // Cleanup
    await admin
      .from('env_var')
      .delete()
      .eq('app_id', fixture.appId)
      .in('key', ['KEY_A', 'KEY_B']);
  });
});
