/**
 * Deployment Env Var Integration Tests
 *
 * Tests CRUD operations and RLS policies for the env_var table
 * against a real Supabase database.
 *
 * RLS permission mapping (from 12-rbac.sql):
 *   owner/admin/write: read, insert, update, delete
 *   read: read only
 *
 * Test naming: should [specific outcome] when [specific condition]
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  checkTableExists,
  requirePrerequisite,
  type TestUser,
  type PrerequisiteCheck,
} from '../../lib/test-utils';
import { createTestApp, cleanupTestApps } from '../../lib/app-test-utils';
import {
  createTestEnvVar,
  cleanupTestEnvVars,
  resolveDefaultEnvironmentId,
} from './helpers';

describe('Deployment Env Var Integration Tests', () => {
  let prerequisite: PrerequisiteCheck;
  let ownerUser: TestUser;
  let appId: string;
  const admin = getSupabaseAdmin();

  beforeAll(async () => {
    prerequisite = await checkTableExists('env_var');
    if (!prerequisite.available) return;

    ownerUser = await createAuthenticatedUser('owner');
    const app = await createTestApp(ownerUser.tenantId);
    appId = app.id;
  });

  afterAll(async () => {
    if (appId) await cleanupTestEnvVars(appId);
    if (ownerUser) await cleanupTestApps(ownerUser.tenantId);
    await cleanupTestUsers();
  });

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  describe('CRUD operations', () => {
    afterEach(async () => {
      if (appId) await cleanupTestEnvVars(appId);
    });

    it('should insert env var when user has write permission', async () => {
      requirePrerequisite(prerequisite);

      // Arrange
      const key = `TEST_KEY_${Date.now()}`;
      const value = 'test-secret-value';

      // Act
      const envVar = await createTestEnvVar(
        ownerUser.client,
        appId,
        ownerUser.tenantId,
        key,
        value,
      );

      // Assert
      expect(envVar.key).toBe(key);
      expect(envVar.app_id).toBe(appId);
      expect(envVar.tenant_id).toBe(ownerUser.tenantId);
      expect(envVar.vault_secret_id).toEqual(expect.any(String));
      expect(envVar.id).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(envVar.created_at))).toBe(false);
    });

    it('should read env vars when user has read permission', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: seed via admin
      const key = `READ_KEY_${Date.now()}`;
      await createTestEnvVar(admin, appId, ownerUser.tenantId, key, 'secret');

      // Act: read as authenticated user
      const result = await ownerUser.client
        .from('env_var')
        .select('*')
        .eq('app_id', appId)
        .eq('key', key)
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.key).toBe(key);
      expect(result.data.app_id).toBe(appId);
    });

    it('should update env var vault_secret_id when user has update permission', async () => {
      requirePrerequisite(prerequisite);

      // Arrange
      const key = `UPDATE_KEY_${Date.now()}`;
      const envVar = await createTestEnvVar(admin, appId, ownerUser.tenantId, key, 'old-value');

      // Create a new vault secret for the update
      const { data: newSecretId, error: secretError } = await admin.rpc('insert_secret', {
        name: `env_${appId}_${key}_v2`,
        secret: 'new-value',
      });
      if (secretError || !newSecretId) throw new Error(`Failed to insert vault secret: ${secretError?.message}`);

      // Act
      const result = await ownerUser.client
        .from('env_var')
        .update({ vault_secret_id: newSecretId })
        .eq('id', envVar.id)
        .select()
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.vault_secret_id).toBe(newSecretId);

      // Remove the extra secret
      await admin.rpc('delete_secret', { secret_name: `env_${appId}_${key}_v2` });
    });

    it('should delete env var when user has delete permission', async () => {
      requirePrerequisite(prerequisite);

      // Arrange
      const key = `DELETE_KEY_${Date.now()}`;
      const envVar = await createTestEnvVar(admin, appId, ownerUser.tenantId, key, 'to-delete');

      // Act
      const deleteResult = await ownerUser.client
        .from('env_var')
        .delete()
        .eq('id', envVar.id)
        .select()
        .single();

      // Assert: row was returned from delete (confirming it existed and was deleted)
      assertSuccess(deleteResult);
      expect(deleteResult.data.id).toBe(envVar.id);

      // Verify it's gone
      const { data: remaining } = await admin
        .from('env_var')
        .select('id')
        .eq('id', envVar.id);

      expect(remaining).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Constraints
  // --------------------------------------------------------------------------

  describe('Constraints', () => {
    afterEach(async () => {
      if (appId) await cleanupTestEnvVars(appId);
    });

    it('should enforce unique constraint on (app_id, key, environment_id)', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: insert first env var (scoped to the app's default env)
      const key = `UNIQUE_KEY_${Date.now()}`;
      const defaultEnvId = await resolveDefaultEnvironmentId(appId);
      await createTestEnvVar(admin, appId, ownerUser.tenantId, key, 'first', defaultEnvId);

      // Act: insert duplicate (app_id, key, environment_id)
      const { data: dupSecretId, error: dupSecretError } = await admin.rpc('insert_secret', {
        name: `env_${appId}_${key}_dup`,
        secret: 'duplicate',
      });
      if (dupSecretError || !dupSecretId) throw new Error(`Failed to insert vault secret: ${dupSecretError?.message}`);

      const result = await admin
        .from('env_var')
        .insert({
          app_id: appId,
          tenant_id: ownerUser.tenantId,
          key,
          vault_secret_id: dupSecretId,
          environment_id: defaultEnvId,
        })
        .select()
        .single();

      // Assert: should fail with unique constraint violation.
      // environment_id is NOT NULL, and the constraint
      // env_var_app_key_env_unique is a plain
      // UNIQUE (app_id, key, environment_id). Two rows with the same tuple
      // collide, so the duplicate is rejected.
      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('23505'); // unique_violation
      expect(result.error!.message).toContain('env_var_app_key_env_unique');

      // Remove the extra secret
      await admin.rpc('delete_secret', { secret_name: `env_${appId}_${key}_dup` });
    });
  });

  // --------------------------------------------------------------------------
  // RLS: Read-only role
  // --------------------------------------------------------------------------

  describe('RLS: read-only role', () => {
    let readUser: TestUser;
    let readAppId: string;

    beforeAll(async () => {
      if (!prerequisite.available) return;

      readUser = await createAuthenticatedUser('read');

      // Create app in the read user's tenant
      const app = await createTestApp(readUser.tenantId);
      readAppId = app.id;
    });

    afterAll(async () => {
      if (readAppId) await cleanupTestEnvVars(readAppId);
      if (readUser) await cleanupTestApps(readUser.tenantId);
    });

    it('should allow viewer to read env vars', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: seed via admin
      const key = `VIEWER_READ_${Date.now()}`;
      await createTestEnvVar(admin, readAppId, readUser.tenantId, key, 'readable');

      // Act
      const result = await readUser.client
        .from('env_var')
        .select('*')
        .eq('app_id', readAppId)
        .eq('key', key);

      // Assert
      assertSuccess(result);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.key).toBe(key);
    });

    it('should deny viewer insert access', async () => {
      requirePrerequisite(prerequisite);

      // Arrange
      const { data: secretId, error: secretError } = await admin.rpc('insert_secret', {
        name: `env_${readAppId}_DENIED_INSERT_${Date.now()}`,
        secret: 'nope',
      });
      if (secretError || !secretId) throw new Error(`Failed to insert vault secret: ${secretError?.message}`);

      const key = `DENIED_INSERT_${Date.now()}`;

      // Act
      const result = await readUser.client
        .from('env_var')
        .insert({
          app_id: readAppId,
          tenant_id: readUser.tenantId,
          key,
          vault_secret_id: secretId,
        })
        .select()
        .single();

      // Assert: RLS denies insert for read role
      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('42501'); // insufficient_privilege
      expect(result.error!.message).toContain('row-level security');

      // Cleanup
      await admin.rpc('delete_secret', { secret_name: `env_${readAppId}_DENIED_INSERT_${Date.now()}` });
    });

    it('should deny viewer delete access', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: seed via admin
      const key = `VIEWER_NO_DELETE_${Date.now()}`;
      const envVar = await createTestEnvVar(admin, readAppId, readUser.tenantId, key, 'undeletable');

      // Act: attempt delete as read user
      const deleteResult = await readUser.client
        .from('env_var')
        .delete()
        .eq('id', envVar.id)
        .select();

      // Assert: RLS silently returns 0 rows for delete denial
      expect(deleteResult.data).toHaveLength(0);

      // Verify record still exists
      const { data: stillExists } = await admin
        .from('env_var')
        .select('id')
        .eq('id', envVar.id);

      expect(stillExists).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Cross-Tenant Isolation
  // --------------------------------------------------------------------------

  describe('Cross-tenant isolation', () => {
    let otherUser: TestUser;
    let otherAppId: string;

    beforeAll(async () => {
      if (!prerequisite.available) return;

      otherUser = await createAuthenticatedUser('owner');
      const otherApp = await createTestApp(otherUser.tenantId);
      otherAppId = otherApp.id;
    });

    afterAll(async () => {
      if (otherAppId) await cleanupTestEnvVars(otherAppId);
      if (otherUser) await cleanupTestApps(otherUser.tenantId);
    });

    it('should isolate env vars across tenants', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: seed env var in other tenant's app
      const key = `ISOLATED_KEY_${Date.now()}`;
      await createTestEnvVar(admin, otherAppId, otherUser.tenantId, key, 'other-secret');

      // Act: ownerUser (different tenant) tries to read it
      const result = await ownerUser.client
        .from('env_var')
        .select('*')
        .eq('app_id', otherAppId);

      // Assert: should see no rows from the other tenant
      expect(result.data).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Cascade Delete
  // --------------------------------------------------------------------------

  describe('Cascade delete', () => {
    it('should cascade delete env vars when app is deleted', async () => {
      requirePrerequisite(prerequisite);

      // Arrange: create a dedicated app with env vars
      const cascadeApp = await createTestApp(ownerUser.tenantId);
      const key1 = `CASCADE_1_${Date.now()}`;
      const key2 = `CASCADE_2_${Date.now()}`;
      await createTestEnvVar(admin, cascadeApp.id, ownerUser.tenantId, key1, 'val1');
      await createTestEnvVar(admin, cascadeApp.id, ownerUser.tenantId, key2, 'val2');

      // Verify they exist
      const { data: before } = await admin
        .from('env_var')
        .select('id')
        .eq('app_id', cascadeApp.id);
      expect(before).toHaveLength(2);

      // Act: delete the app
      await admin.from('app').delete().eq('id', cascadeApp.id);

      // Assert: env vars should be cascade deleted
      const { data: after } = await admin
        .from('env_var')
        .select('id')
        .eq('app_id', cascadeApp.id);

      expect(after).toHaveLength(0);
    });
  });
});
