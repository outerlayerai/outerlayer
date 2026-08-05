/**
 * Deployment Env Var — Environment-Scoped Integration Tests
 *
 * `env_var.environment_id` is NOT NULL and the unique
 * constraint is `UNIQUE (app_id, key, environment_id)`. Every env var belongs
 * to exactly one environment; there is no app-scoped fallback layer.
 *
 * Runs against a real local Supabase. Each test seeds its own rows and deletes
 * them in the same block. Test naming: `should [outcome] when [condition]`.
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

describe('env_var — environment-scoped', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let fixture: EnvNavFixture;

  beforeAll(async () => {
    fixture = await setupEnvNavFixture();
  });

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // environment_id NOT NULL
  // ───────────────────────────────────────────────────────────────────────────

  it('should insert an env var when environment_id is set', async () => {
    // Arrange + Act
    const envVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.devEnv.id,
      key: 'INSERT_OK',
      value: 'secret-value',
    });

    // Assert
    const { data } = await admin
      .from('env_var')
      .select('environment_id, key')
      .eq('id', envVar.id)
      .single();
    expect(data?.environment_id).toBe(fixture.devEnv.id);
    expect(data?.key).toBe('INSERT_OK');

    // Cleanup
    await admin.from('env_var').delete().eq('id', envVar.id);
  });

  it('should reject an env var insert when environment_id is NULL', async () => {
    // Arrange
    const secretId = await createVaultSecret(
      `env_${fixture.appId}_null_${Date.now()}`,
      'orphan',
    );

    // Act
    const result = await admin
      .from('env_var')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        environment_id: null,
        key: 'NULL_ENV',
        vault_secret_id: secretId,
      })
      .select()
      .single();

    // Assert: rejected by the exactly-one scope CHECK — environment_id is
    // nullable now, but a row must carry an environment_id OR a target_kind.
    expect(result.error).toBeTruthy();
    expect(result.error!.code).toBe('23514');
    expect(result.error!.message).toMatch(
      /chk_env_var_scope_exactly_one/,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Uniqueness — env_id is part of the key
  // ───────────────────────────────────────────────────────────────────────────

  it('should allow the same (app_id, key) in two different environments', async () => {
    // Arrange + Act: same key, two environments
    const devVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.devEnv.id,
      key: 'SHARED_KEY',
      value: 'dev-value',
    });
    const prodVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.prodEnv.id,
      key: 'SHARED_KEY',
      value: 'prod-value',
    });

    // Assert: both rows coexist, one per environment
    expect(devVar.id).not.toBe(prodVar.id);
    const { data } = await admin
      .from('env_var')
      .select('environment_id')
      .eq('app_id', fixture.appId)
      .eq('key', 'SHARED_KEY');
    expect(data).toHaveLength(2);
    expect(new Set(data?.map((r) => r.environment_id))).toEqual(
      new Set([fixture.devEnv.id, fixture.prodEnv.id]),
    );

    // Cleanup
    await admin
      .from('env_var')
      .delete()
      .in('id', [devVar.id, prodVar.id]);
  });

  it('should reject a duplicate (app_id, key, environment_id) via env_var_app_key_env_unique', async () => {
    // Arrange: first row for (app, key, dev env)
    const first = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.devEnv.id,
      key: 'DUP_KEY',
      value: 'first',
    });
    const dupSecretId = await createVaultSecret(
      `env_${fixture.appId}_dup_${Date.now()}`,
      'second',
    );

    // Act: insert same (app, key, env) tuple again
    const result = await admin
      .from('env_var')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        environment_id: fixture.devEnv.id,
        key: 'DUP_KEY',
        vault_secret_id: dupSecretId,
      })
      .select()
      .single();

    // Assert: rejected by the named unique constraint
    expect(result.error).toBeTruthy();
    expect(result.error!.message).toContain(
      'env_var_app_key_env_unique',
    );

    // Cleanup
    await admin.from('env_var').delete().eq('id', first.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cascade delete
  // ───────────────────────────────────────────────────────────────────────────

  it('should cascade-delete env vars when their environment is deleted', async () => {
    // Arrange: a dedicated non-default env with env vars on it
    const { data: tmpEnv } = await admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        name: 'staging',
        is_default: false,
        created_by: fixture.ownerUser.id,
      })
      .select('id')
      .single();
    const tmpEnvId = tmpEnv!.id as string;

    const envVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: tmpEnvId,
      key: 'CASCADE_KEY',
      value: 'gone-soon',
    });

    // Act: delete the environment
    const delResult = await admin
      .from('environment')
      .delete()
      .eq('id', tmpEnvId);
    expect(delResult.error).toBeNull();

    // Assert: the env var was cascade-deleted
    const { data: remaining } = await admin
      .from('env_var')
      .select('id')
      .eq('id', envVar.id);
    expect(remaining).toHaveLength(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RLS — read role
  // ───────────────────────────────────────────────────────────────────────────

  it('should allow a read-role user to SELECT env vars', async () => {
    // Arrange: seed via admin
    const envVar = await seedEnvVar({
      client: admin,
      tenantId: fixture.tenantId,
      appId: fixture.appId,
      environmentId: fixture.devEnv.id,
      key: 'READ_RLS',
      value: 'readable',
    });

    // Act: read as the read-role user
    const result = await fixture.readUser.client
      .from('env_var')
      .select('id, key')
      .eq('id', envVar.id);

    // Assert
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.key).toBe('READ_RLS');

    // Cleanup
    await admin.from('env_var').delete().eq('id', envVar.id);
  });

  it('should deny a read-role user from INSERTing an env var', async () => {
    // Arrange
    const secretId = await createVaultSecret(
      `env_${fixture.appId}_rls_${Date.now()}`,
      'denied',
    );

    // Act: insert as the read-role user
    const result = await fixture.readUser.client
      .from('env_var')
      .insert({
        tenant_id: fixture.tenantId,
        app_id: fixture.appId,
        environment_id: fixture.devEnv.id,
        key: 'READ_ROLE_INSERT',
        vault_secret_id: secretId,
      })
      .select()
      .single();

    // Assert: RLS denies the insert
    expect(result.error).toBeTruthy();
    expect(result.error!.message).toContain('row-level security');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-tenant isolation
  // ───────────────────────────────────────────────────────────────────────────

  it('should not expose another tenant env vars to an owner of a different tenant', async () => {
    // Arrange: a second tenant with its own app, env, and env var
    const other = await setupEnvNavFixture();
    try {
      const otherVar = await seedEnvVar({
        client: admin,
        tenantId: other.tenantId,
        appId: other.appId,
        environmentId: other.devEnv.id,
        key: 'TENANT_B_SECRET',
        value: 'isolated',
      });

      // Act: tenant A's owner queries tenant B's app
      const result = await fixture.ownerUser.client
        .from('env_var')
        .select('id')
        .eq('app_id', other.appId);

      // Assert: RLS hides the other tenant's rows
      expect(result.error).toBeNull();
      expect(result.data).toHaveLength(0);

      // Remove the env var explicitly (cleanup also handles it)
      await admin.from('env_var').delete().eq('id', otherVar.id);
    } finally {
      await other.cleanup();
    }
  });
});
