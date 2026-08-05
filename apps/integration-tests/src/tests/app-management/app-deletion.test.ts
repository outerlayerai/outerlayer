/**
 * App Deletion Integration Tests
 *
 * Tests the app deletion functionality with real Supabase database.
 * Runs against a real local Supabase instance.
 *
 * NOTE: The app table has minimal columns:
 * - id, tenant_id, name, created_at, created_by, updated_at, updated_by
 *
 * git_connection has FK to app (app_id), not the reverse.
 *
 * Test naming follows II.K: "should [specific outcome] when [specific condition]"
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  getSupabaseAdmin,
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  TestUser,
} from '../../lib/test-utils';
import {
  createTestApp,
  createTestGitConnection,
  cleanupTestApps,
  cleanupTestGitConnections,
  getTestApp,
} from '../../lib/app-test-utils';

describe('App Deletion Integration Tests', () => {
  let testUser: TestUser;
  const admin = getSupabaseAdmin();

  beforeAll(async () => {
    // Arrange: Create authenticated test user with tenant
    testUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    // Clean up all test data
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  describe('Valid App Deletion', () => {
    it('should delete app when valid app id provided', async () => {
      // Arrange: Create an app to delete
      const app = await createTestApp(testUser.tenantId, { name: 'app-to-delete' });

      // Act: Delete the app
      const result = await testUser.client
        .from('app')
        .delete()
        .eq('id', app.id)
        .select()
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.id).toBe(app.id);

      // Verify it's actually gone
      const checkResult = await getTestApp(app.id);
      expect(checkResult).toBeNull();
    });

  });

  describe('Cascade Delete Behavior', () => {
    it('should cascade delete api_keys when app deleted', async () => {
      // Arrange: Create app with API key
      const app = await createTestApp(testUser.tenantId, { name: 'app-with-apikey' });

      // Create an API key for this app (using admin to bypass potential permission issues)
      const { error: keyError } = await admin
        .from('api_key')
        .insert({
          app_id: app.id,
          tenant_id: testUser.tenantId,
          environment_id: app.defaultEnvironmentId,
          name: 'test-key',
          api_key_id: `key_${Date.now()}`,
          created_by: testUser.id,
        })
        .select()
        .single();

      if (keyError) {
        throw new Error(`Prerequisite failed: could not create api_key for cascade test: ${keyError.message}. Check that the api_key table exists and has columns: app_id, tenant_id, name, api_key_id, created_by.`);
      }

      // Act: Delete the app
      await testUser.client
        .from('app')
        .delete()
        .eq('id', app.id);

      // Assert: API key should be cascade deleted
      const { data: remainingKeys } = await admin
        .from('api_key')
        .select()
        .eq('app_id', app.id);

      expect(remainingKeys).toHaveLength(0);
    });

    it('should cascade delete git_connection when app deleted', async () => {
      // Arrange: Create app first, then git connection linked to it
      const app = await createTestApp(testUser.tenantId, { name: 'app-with-git' });

      // Create git connection with reference to the app
      const gitConnection = await createTestGitConnection(testUser.tenantId, {
        provider: 'github',
        appId: app.id,
      });

      // Act: Delete the app
      await testUser.client
        .from('app')
        .delete()
        .eq('id', app.id);

      // Assert: App should be deleted
      const deletedApp = await getTestApp(app.id);
      expect(deletedApp).toBeNull();

      // Git connection should be cascade deleted (FK constraint with ON DELETE CASCADE)
      const { data: connection } = await admin
        .from('git_connection')
        .select()
        .eq('id', gitConnection.id);

      expect(connection).toHaveLength(0);
    });

  });

  describe('Error Handling', () => {
    it('should return empty result when app does not exist', async () => {
      // Arrange: Non-existent app ID
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      // Act
      const result = await testUser.client
        .from('app')
        .delete()
        .eq('id', nonExistentId)
        .select();

      // Assert: Should return empty array, not error
      assertSuccess(result);
      expect(result.data).toHaveLength(0);
    });

    it('should return error when deleting app in another tenant', async () => {
      // Arrange: Create app in another tenant
      const otherUser = await createAuthenticatedUser('owner');
      const otherApp = await createTestApp(otherUser.tenantId, { name: 'other-tenant-app' });

      // Act: Try to delete app from different tenant
      const result = await testUser.client
        .from('app')
        .delete()
        .eq('id', otherApp.id)
        .select();

      // Assert: Should return empty (RLS blocks access)
      assertSuccess(result);
      expect(result.data).toHaveLength(0);

      // Verify app still exists
      const stillExists = await getTestApp(otherApp.id);
      expect(stillExists).not.toBeNull();

      // Cleanup
      await cleanupTestApps(otherUser.tenantId);
    });
  });

  describe('Permission Checks', () => {
    it('should prevent member without delete permission from deleting app', async () => {
      // Arrange: Create a member user (not owner)
      const memberUser = await createAuthenticatedUser('read');

      // Create app as admin
      const app = await createTestApp(memberUser.tenantId, { name: 'member-no-delete-app' });

      // Act: Try to delete as read-only member
      const result = await memberUser.client
        .from('app')
        .delete()
        .eq('id', app.id)
        .select();

      // Assert: Read-only user should not be able to delete (RLS blocks)
      assertSuccess(result);
      expect(result.data).toHaveLength(0);

      // Verify app still exists
      const stillExists = await getTestApp(app.id);
      expect(stillExists).not.toBeNull();

      // Cleanup
      await cleanupTestApps(memberUser.tenantId);
    });
  });
});
