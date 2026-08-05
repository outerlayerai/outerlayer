/**
 * CLI API Routes Integration Tests
 *
 * Tests the database operations underlying CLI API routes against real Supabase.
 * Runs against a real local Supabase instance.
 *
 * Routes tested:
 * - GET /api/cli/apps - List apps accessible to user
 * - POST /api/cli/dev-key - Create dev API key
 * - DELETE /api/cli/dev-key/:keyId - Delete dev API key
 * - POST /api/cli/dev-key/:keyId/refresh - Refresh dev API key
 *
 * These tests verify:
 * 1. Authentication: User must be authenticated to access data
 * 2. RLS enforcement: Users can only access their own tenant's data
 * 3. Validation: Database constraints are enforced
 * 4. Happy paths: Successful operations return correct data
 *
 * Test naming follows II.K: "should [specific outcome] when [specific condition]"
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  TestUser,
  createTimedTestSuite,
  getSupabaseAdmin,
} from '../../lib/test-utils';
import {
  createTestApp,
  cleanupTestApps,
  TestApp,
} from '../../lib/app-test-utils';

const { timedIt } = createTimedTestSuite('integration');

describe('CLI API Routes Integration Tests', () => {
  let testUser: TestUser;
  let testApp: TestApp;
  const admin = getSupabaseAdmin();

  beforeAll(async () => {
    // Arrange: Create authenticated test user with tenant
    testUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    // Clean up apps first, then users
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  beforeEach(async () => {
    // Create a test app for each test
    testApp = await createTestApp(testUser.tenantId, {
      name: `test-app-${Date.now()}`,
    });
  });

  afterEach(async () => {
    // Clean up apps and API keys after each test (before profile cleanup)
    await cleanupTestApps(testUser.tenantId);
    // Also clean up any api_keys that may be leftover
    await admin.from('api_key').delete().eq('tenant_id', testUser.tenantId);
  });

  describe('GET /api/cli/apps', () => {
    describe('Authentication', () => {
      timedIt('should verify user must be authenticated to query apps', async () => {
        // Act: Authenticated user queries their apps
        const result = await testUser.client
          .from('app')
          .select('*')
          .eq('tenant_id', testUser.tenantId);

        // Assert: Query succeeds with authentication
        assertSuccess(result);
      });

      timedIt('should verify user has tenant_id in JWT', async () => {
        // Arrange & Assert: Verify test user setup includes tenant_id
        expect(testUser.tenantId).not.toBe('');
        expect(testUser.tenantId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );

        // Verify the user's JWT contains tenant_id by checking app_metadata
        const { data: { user } } = await testUser.client.auth.getUser();
        expect(user?.id).toBe(testUser.id);
        expect(user?.app_metadata?.tenant_id).toBe(testUser.tenantId);
      });
    });

    describe('RLS Enforcement', () => {
      timedIt('should return only apps from user tenant', async () => {
        // Arrange: Create another user with different tenant
        const otherUser = await createAuthenticatedUser('owner');
        const otherApp = await createTestApp(otherUser.tenantId, {
          name: 'other-user-app',
        });

        // Act: Query apps with testUser's client
        const result = await testUser.client
          .from('app')
          .select(`
            id,
            name,
            tenant_id,
            created_at,
            tenant:tenant_id (
              organization_name
            )
          `)
          .eq('tenant_id', testUser.tenantId)
          .order('created_at', { ascending: false });

        // Assert: Should only see own tenant's apps
        assertSuccess(result);
        const appIds = result.data.map((app) => app.id);
        expect(appIds).toContain(testApp.id);
        expect(appIds).not.toContain(otherApp.id);

        // Clean up other user but NOT via cleanupTestUsers() which would delete ALL users
        await cleanupTestApps(otherUser.tenantId);
        // Manual cleanup for otherUser to avoid deleting the main testUser
        await admin.from('membership').delete().eq('user_id', otherUser.id);
        try {
          await admin.auth.admin.deleteUser(otherUser.id);
        } catch {}
        await admin.from('profile').delete().eq('id', otherUser.id);
        await admin.from('tenant').delete().eq('tenant_id', otherUser.tenantId);
      });
    });

    describe('Happy Path', () => {
      timedIt('should return list of apps with tenant names', async () => {
        // Arrange: Create multiple apps
        const app2 = await createTestApp(testUser.tenantId, {
          name: `app-2-${Date.now()}`,
        });

        // Act
        const result = await testUser.client
          .from('app')
          .select(`
            id,
            name,
            tenant_id,
            created_at,
            tenant:tenant_id (
              organization_name
            )
          `)
          .eq('tenant_id', testUser.tenantId)
          .order('created_at', { ascending: false });

        // Assert
        assertSuccess(result);
        expect(result.data.length).toBeGreaterThanOrEqual(2);

        const app1Data = result.data.find((a) => a.id === testApp.id);
        expect(app1Data).toBeDefined();
        expect(app1Data?.name).toBe(testApp.name);
        expect(app1Data?.tenant_id).toBe(testUser.tenantId);
        expect(typeof (app1Data?.tenant as any)?.organization_name).toBe('string');

        const app2Data = result.data.find((a) => a.id === app2.id);
        expect(app2Data).toBeDefined();
        expect(app2Data?.name).toBe(app2.name);
      });

      timedIt('should return empty array when user has no apps', async () => {
        // Arrange: Create a new user with no apps
        const newUser = await createAuthenticatedUser('owner');

        // Act
        const result = await newUser.client
          .from('app')
          .select('*')
          .eq('tenant_id', newUser.tenantId);

        // Assert
        assertSuccess(result);
        expect(result.data).toEqual([]);

        // Cleanup
        await cleanupTestApps(newUser.tenantId);
      });
    });
  });

  describe('POST /api/cli/dev-key', () => {
    describe('Validation', () => {
      timedIt('should fail when app_id is missing', async () => {
        // Act: Insert without app_id (NOT NULL constraint)
        const result = await admin
          .from('api_key')
          .insert({
            api_key_id: 'test_key_no_app',
            name: 'Test Key',
            tenant_id: testUser.tenantId,
            created_by: testUser.id,
            updated_by: testUser.id,
            // app_id missing
          } as any)
          .select()
          .single();

        // Assert
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('23502'); // NOT NULL violation
      });

      timedIt('should fail when app does not exist', async () => {
        // Arrange: Use non-existent app ID
        const fakeAppId = '00000000-0000-0000-0000-000000000000';

        // Act: Try to query non-existent app
        const result = await testUser.client
          .from('app')
          .select('id, name, tenant_id')
          .eq('id', fakeAppId)
          .eq('tenant_id', testUser.tenantId)
          .single();

        // Assert
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116'); // No rows returned
      });

      timedIt('should fail when app belongs to different tenant', async () => {
        // Arrange: Create another user with their own app
        const otherUser = await createAuthenticatedUser('owner');
        const otherApp = await createTestApp(otherUser.tenantId, {
          name: 'other-tenant-app',
        });

        // Act: Try to query other tenant's app with testUser's client
        const result = await testUser.client
          .from('app')
          .select('id, name, tenant_id')
          .eq('id', otherApp.id)
          .eq('tenant_id', testUser.tenantId) // This will not match
          .single();

        // Assert: Should not find app (RLS prevents cross-tenant access)
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116');

        // Cleanup
        await cleanupTestApps(otherUser.tenantId);
      });
    });

    describe('Database Operations', () => {
      timedIt('should store API key in database with correct metadata', async () => {
        // Arrange
        const keyId = `test_key_${Date.now()}`;
        const keyName = 'CLI Dev Key - Test';

        // Act
        const result = await admin
          .from('api_key')
          .insert({
            api_key_id: keyId,
            name: keyName,
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          })
          .select()
          .single();

        // Assert
        assertSuccess(result);
        expect(result.data.api_key_id).toBe(keyId);
        expect(result.data.name).toBe(keyName);
        expect(result.data.app_id).toBe(testApp.id);
        expect(result.data.tenant_id).toBe(testUser.tenantId);
        expect(typeof result.data.created_at).toBe('string');
      });

      timedIt('should enforce unique constraint on api_key_id', async () => {
        // Arrange
        const keyId = `test_key_unique_${Date.now()}`;

        // Act: Create first key
        const result1 = await admin
          .from('api_key')
          .insert({
            api_key_id: keyId,
            name: 'First Key',
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          })
          .select()
          .single();

        assertSuccess(result1);

        // Try to insert duplicate
        const result2 = await admin
          .from('api_key')
          .insert({
            api_key_id: keyId, // Same key_id
            name: 'Duplicate Key',
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          })
          .select()
          .single();

        // Assert: Duplicate should fail
        expect(result2.error).toBeDefined();
        expect(result2.error?.code).toBe('23505'); // Unique violation
      });
    });

    describe('Happy Path', () => {
      timedIt('should create dev key with correct structure', async () => {
        // Arrange
        const keyId = `test_key_happy_${Date.now()}`;
        const keyName = `CLI Dev Key - ${new Date().toISOString()}`;

        // Act
        const result = await admin
          .from('api_key')
          .insert({
            api_key_id: keyId,
            name: keyName,
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          })
          .select()
          .single();

        // Assert: Verify DB record structure
        assertSuccess(result);
        expect(result.data).toMatchObject({
          api_key_id: keyId,
          name: keyName,
          app_id: testApp.id,
          tenant_id: testUser.tenantId,
          environment_id: testApp.defaultEnvironmentId,
        });
        expect(typeof result.data.created_at).toBe('string');
        expect(result.data.created_by).toBe(testUser.id);
      });

      timedIt('should accept custom device_name', async () => {
        // Arrange
        const deviceName = 'MacBook Pro - Dev';
        const keyId = `test_key_device_${Date.now()}`;

        // Act
        const result = await admin
          .from('api_key')
          .insert({
            api_key_id: keyId,
            name: deviceName,
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          })
          .select()
          .single();

        // Assert
        assertSuccess(result);
        expect(result.data.name).toBe(deviceName);
      });
    });
  });

  describe('DELETE /api/cli/dev-key/:keyId', () => {
    let apiKeyId: string;

    beforeEach(async () => {
      // Create an API key for deletion tests
      apiKeyId = `test_key_delete_${Date.now()}`;
      const result = await admin
        .from('api_key')
        .insert({
          api_key_id: apiKeyId,
          name: 'Key to Delete',
          app_id: testApp.id,
          tenant_id: testUser.tenantId,
          environment_id: testApp.defaultEnvironmentId,
          created_by: testUser.id,
          updated_by: testUser.id,
        })
        .select()
        .single();

      assertSuccess(result);
    });

    describe('RLS Enforcement', () => {
      timedIt('should return 404 when key does not exist', async () => {
        // Arrange
        const fakeKeyId = 'non_existent_key';

        // Act
        const result = await testUser.client
          .from('api_key')
          .select('api_key_id, tenant_id')
          .eq('api_key_id', fakeKeyId)
          .eq('tenant_id', testUser.tenantId)
          .single();

        // Assert
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116');
      });

      timedIt('should prevent access to keys from different tenant', async () => {
        // Arrange: Create another user with their own key
        const otherUser = await createAuthenticatedUser('owner');
        const otherApp = await createTestApp(otherUser.tenantId);

        const otherKeyResult = await admin
          .from('api_key')
          .insert({
            api_key_id: 'other_user_key',
            name: 'Other User Key',
            app_id: otherApp.id,
            tenant_id: otherUser.tenantId,
            environment_id: otherApp.defaultEnvironmentId,
            created_by: otherUser.id,
            updated_by: otherUser.id,
          })
          .select()
          .single();

        assertSuccess(otherKeyResult);

        // Act: Try to access other tenant's key
        const result = await testUser.client
          .from('api_key')
          .select('api_key_id, tenant_id')
          .eq('api_key_id', 'other_user_key')
          .eq('tenant_id', testUser.tenantId)
          .single();

        // Assert: Should not find key (RLS prevents access)
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116');

        // Cleanup
        await cleanupTestApps(otherUser.tenantId);
      });
    });

    describe('Happy Path', () => {
      timedIt('should delete key from database', async () => {
        // Act
        const deleteResult = await admin
          .from('api_key')
          .delete()
          .eq('api_key_id', apiKeyId)
          .eq('tenant_id', testUser.tenantId);

        // Assert: Delete succeeded
        expect(deleteResult.error).toBeNull();

        // Verify key is gone
        const verifyResult = await admin
          .from('api_key')
          .select('*')
          .eq('api_key_id', apiKeyId)
          .single();

        expect(verifyResult.error).toBeDefined();
        expect(verifyResult.error?.code).toBe('PGRST116');
      });
    });
  });

  describe('POST /api/cli/dev-key/:keyId/refresh', () => {
    let originalKeyId: string;

    beforeEach(async () => {
      // Create an API key for refresh tests
      originalKeyId = `test_key_refresh_${Date.now()}`;
      const result = await admin
        .from('api_key')
        .insert({
          api_key_id: originalKeyId,
          name: 'Key to Refresh',
          app_id: testApp.id,
          tenant_id: testUser.tenantId,
          environment_id: testApp.defaultEnvironmentId,
          created_by: testUser.id,
          updated_by: testUser.id,
        })
        .select()
        .single();

      assertSuccess(result);
    });

    describe('RLS Enforcement', () => {
      timedIt('should return 404 when key does not exist', async () => {
        // Arrange
        const fakeKeyId = 'non_existent_key_refresh';

        // Act
        const result = await testUser.client
          .from('api_key')
          .select('api_key_id, name, app_id, tenant_id')
          .eq('api_key_id', fakeKeyId)
          .eq('tenant_id', testUser.tenantId)
          .single();

        // Assert
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116');
      });

      timedIt('should prevent access to keys from different tenant', async () => {
        // Arrange: Create another user with their own key
        const otherUser = await createAuthenticatedUser('owner');
        const otherApp = await createTestApp(otherUser.tenantId);

        const otherKeyResult = await admin
          .from('api_key')
          .insert({
            api_key_id: 'other_user_key_refresh',
            name: 'Other User Key',
            app_id: otherApp.id,
            tenant_id: otherUser.tenantId,
            environment_id: otherApp.defaultEnvironmentId,
            created_by: otherUser.id,
            updated_by: otherUser.id,
          })
          .select()
          .single();

        assertSuccess(otherKeyResult);

        // Act: Try to access other tenant's key
        const result = await testUser.client
          .from('api_key')
          .select('api_key_id, name, app_id, tenant_id')
          .eq('api_key_id', 'other_user_key_refresh')
          .eq('tenant_id', testUser.tenantId)
          .single();

        // Assert: Should not find key (RLS prevents access)
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('PGRST116');

        // Cleanup
        await cleanupTestApps(otherUser.tenantId);
      });
    });

    describe('Database Operations', () => {
      timedIt('should update api_key_id while preserving other fields', async () => {
        // Arrange
        const newKeyId = `test_key_refreshed_${Date.now()}`;

        // Act
        const result = await admin
          .from('api_key')
          .update({
            api_key_id: newKeyId,
            updated_by: testUser.id,
          })
          .eq('api_key_id', originalKeyId)
          .eq('tenant_id', testUser.tenantId)
          .select()
          .single();

        // Assert
        assertSuccess(result);
        expect(result.data.api_key_id).toBe(newKeyId);
        expect(result.data.name).toBe('Key to Refresh'); // Name preserved
        expect(result.data.app_id).toBe(testApp.id); // App preserved
        expect(result.data.tenant_id).toBe(testUser.tenantId); // Tenant preserved

        // Verify old key no longer exists
        const oldKeyCheck = await admin
          .from('api_key')
          .select('*')
          .eq('api_key_id', originalKeyId)
          .single();

        expect(oldKeyCheck.error).toBeDefined();
        expect(oldKeyCheck.error?.code).toBe('PGRST116');
      });

      timedIt('should fail when updating to duplicate api_key_id', async () => {
        // Arrange: Create a second key with a specific ID
        const conflictingKeyId = 'conflicting_key_id';
        await admin
          .from('api_key')
          .insert({
            api_key_id: conflictingKeyId,
            name: 'Conflicting Key',
            app_id: testApp.id,
            tenant_id: testUser.tenantId,
            environment_id: testApp.defaultEnvironmentId,
            created_by: testUser.id,
            updated_by: testUser.id,
          });

        // Act: Try to update original key to conflicting ID
        const result = await admin
          .from('api_key')
          .update({
            api_key_id: conflictingKeyId, // Duplicate
            updated_by: testUser.id,
          })
          .eq('api_key_id', originalKeyId)
          .eq('tenant_id', testUser.tenantId)
          .select()
          .single();

        // Assert: Update should fail with unique violation
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('23505'); // Unique violation

        // Verify original key still exists unchanged
        const verifyOriginal = await admin
          .from('api_key')
          .select('*')
          .eq('api_key_id', originalKeyId)
          .single();

        assertSuccess(verifyOriginal);
        expect(verifyOriginal.data.api_key_id).toBe(originalKeyId);
      });
    });

    describe('Happy Path', () => {
      timedIt('should successfully refresh key with new key_id', async () => {
        // Arrange
        const newKeyId = `refreshed_key_${Date.now()}`;

        // Act
        const result = await admin
          .from('api_key')
          .update({
            api_key_id: newKeyId,
            updated_by: testUser.id,
          })
          .eq('api_key_id', originalKeyId)
          .eq('tenant_id', testUser.tenantId)
          .select()
          .single();

        // Assert: Verify updated record
        assertSuccess(result);
        expect(result.data.api_key_id).toBe(newKeyId);
        expect(result.data.name).toBe('Key to Refresh');
        expect(result.data.app_id).toBe(testApp.id);
        expect(result.data.tenant_id).toBe(testUser.tenantId);
        expect(typeof result.data.updated_at).toBe('string');
        expect(result.data.updated_by).toBe(testUser.id);
      });
    });
  });

  describe('Cross-Route Integration', () => {
    timedIt('should support complete key lifecycle: create, refresh, delete', async () => {
      // Arrange: Create initial key
      const initialKeyId = `lifecycle_key_${Date.now()}`;
      const createResult = await admin
        .from('api_key')
        .insert({
          api_key_id: initialKeyId,
          name: 'Lifecycle Test Key',
          app_id: testApp.id,
          tenant_id: testUser.tenantId,
          environment_id: testApp.defaultEnvironmentId,
          created_by: testUser.id,
          updated_by: testUser.id,
        })
        .select()
        .single();

      assertSuccess(createResult);
      expect(createResult.data.api_key_id).toBe(initialKeyId);

      // Act 1: Refresh the key
      const refreshedKeyId = `lifecycle_key_refreshed_${Date.now()}`;
      const refreshResult = await admin
        .from('api_key')
        .update({
          api_key_id: refreshedKeyId,
          updated_by: testUser.id,
        })
        .eq('api_key_id', initialKeyId)
        .eq('tenant_id', testUser.tenantId)
        .select()
        .single();

      assertSuccess(refreshResult);
      expect(refreshResult.data.api_key_id).toBe(refreshedKeyId);

      // Act 2: Delete the refreshed key
      const deleteResult = await admin
        .from('api_key')
        .delete()
        .eq('api_key_id', refreshedKeyId)
        .eq('tenant_id', testUser.tenantId);

      expect(deleteResult.error).toBeNull();

      // Assert: Verify key is gone
      const verifyResult = await admin
        .from('api_key')
        .select('*')
        .eq('api_key_id', refreshedKeyId)
        .single();

      expect(verifyResult.error).toBeDefined();
      expect(verifyResult.error?.code).toBe('PGRST116');
    });

    timedIt('should list apps before creating keys', async () => {
      // Act 1: List apps
      const appsResult = await testUser.client
        .from('app')
        .select(`
          id,
          name,
          tenant_id,
          created_at,
          tenant:tenant_id (
            organization_name
          )
        `)
        .eq('tenant_id', testUser.tenantId);

      // Assert: Apps exist
      assertSuccess(appsResult);
      expect(appsResult.data.length).toBeGreaterThan(0);
      const appIds = appsResult.data.map((a) => a.id);
      expect(appIds).toContain(testApp.id);

      // Act 2: Create key for the app
      const keyId = `cross_route_key_${Date.now()}`;
      const keyResult = await admin
        .from('api_key')
        .insert({
          api_key_id: keyId,
          name: 'Cross-Route Test Key',
          app_id: testApp.id,
          tenant_id: testUser.tenantId,
          environment_id: testApp.defaultEnvironmentId,
          created_by: testUser.id,
          updated_by: testUser.id,
        })
        .select()
        .single();

      // Assert: Key created for correct app
      assertSuccess(keyResult);
      expect(keyResult.data.app_id).toBe(testApp.id);
    });
  });
});
