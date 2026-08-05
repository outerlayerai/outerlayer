/**
 * App Creation Integration Tests
 *
 * Tests the app creation functionality with real Supabase database.
 * Runs against a real local Supabase instance.
 *
 * NOTE: The app table has minimal columns:
 * - id, tenant_id, name, created_at, created_by, updated_at, updated_by
 *
 * Test naming follows II.K: "should [specific outcome] when [specific condition]"
 * Each test seeds its own rows and deletes them in the same block.
 */

import {
  createAuthenticatedUser,
  cleanupTestUsers,
  assertSuccess,
  TestUser,
} from '../../lib/test-utils';
import {
  createTestApp,
  cleanupTestApps,
} from '../../lib/app-test-utils';

describe('App Creation Integration Tests', () => {
  let testUser: TestUser;

  beforeAll(async () => {
    // Arrange: Create authenticated test user with tenant
    testUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    // Clean up all test data
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    // Clean up apps after each test to ensure isolation
    await cleanupTestApps(testUser.tenantId);
  });

  describe('Valid App Creation', () => {
    it('should create app when valid params provided', async () => {
      // Arrange
      const appName = `test-app-${Date.now()}`;

      // Act
      const result = await testUser.client
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: appName,
        })
        .select()
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.name).toBe(appName);
      expect(result.data.tenant_id).toBe(testUser.tenantId);
      // id is a server-generated UUID; created_at a server timestamp.
      expect(result.data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(typeof result.data.created_at).toBe('string');
    });

    it('should set created_by to current user when app created', async () => {
      // Arrange
      const appName = `audit-test-app-${Date.now()}`;

      // Act
      const result = await testUser.client
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: appName,
        })
        .select()
        .single();

      // Assert
      assertSuccess(result);
      expect(result.data.created_by).toBe(testUser.id);
    });

  });

  describe('Validation Errors', () => {
    it('should return error when app name is empty', async () => {
      // Arrange
      const emptyName = '';

      // Act
      const result = await testUser.client
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: emptyName,
        })
        .select()
        .single();

      // Assert
      expect(result.error).toBeDefined();
    });

    it('should return error when app name already exists in tenant', async () => {
      // Arrange: Create first app
      const duplicateName = `duplicate-test-${Date.now()}`;
      const firstApp = await testUser.client
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: duplicateName,
        })
        .select()
        .single();
      assertSuccess(firstApp);

      // Act: Try to create app with same name
      const result = await testUser.client
        .from('app')
        .insert({
          tenant_id: testUser.tenantId,
          name: duplicateName,
        })
        .select()
        .single();

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('23505'); // Unique violation
    });

    it('should return error when tenant_id is missing', async () => {
      // Act
      const result = await testUser.client
        .from('app')
        .insert({
          name: 'app-without-tenant',
          // tenant_id intentionally omitted
        } as Record<string, unknown>)
        .select()
        .single();

      // Assert
      expect(result.error).toBeDefined();
    });
  });

  describe('RLS Policy Enforcement', () => {
    it('should prevent creating app in another tenant', async () => {
      // Arrange: Create a second user with different tenant
      const otherUser = await createAuthenticatedUser('owner');

      // Act: Try to create app in other user's tenant
      const result = await testUser.client
        .from('app')
        .insert({
          tenant_id: otherUser.tenantId, // Wrong tenant!
          name: `cross-tenant-app-${Date.now()}`,
        })
        .select()
        .single();

      // Assert: Should fail due to RLS policy
      expect(result.error).toBeDefined();

      // Clean up other user
      await cleanupTestApps(otherUser.tenantId);
    });

    it('should allow reading only apps in own tenant', async () => {
      // Arrange: Create apps in test user's tenant
      await createTestApp(testUser.tenantId, { name: 'my-visible-app' });

      // Create another user with their own app
      const otherUser = await createAuthenticatedUser('owner');
      await createTestApp(otherUser.tenantId, { name: 'other-invisible-app' });

      // Act: Query all apps as test user
      const result = await testUser.client
        .from('app')
        .select('*');

      // Assert: Should only see own tenant's apps
      assertSuccess(result);
      const appNames = result.data.map((app: { name: string }) => app.name);
      expect(appNames).toContain('my-visible-app');
      expect(appNames).not.toContain('other-invisible-app');

      // Cleanup
      await cleanupTestApps(otherUser.tenantId);
    });
  });
});
