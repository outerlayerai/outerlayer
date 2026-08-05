/**
 * Git Connection Integration Tests
 *
 * Tests the git_connection RLS policies with real Supabase database.
 * Runs against a real local Supabase instance.
 *
 * NOTE: The git_connection table has FK to app (app_id is required):
 * - id, tenant_id, app_id, provider, access_token, refresh_token, repository, installation_id
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
  createTestGitConnection,
  cleanupTestApps,
  cleanupTestGitConnections,
} from '../../lib/app-test-utils';

describe('Git Connection Integration Tests', () => {
  let testUser: TestUser;

  beforeAll(async () => {
    testUser = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
  });

  describe('RLS Policy Enforcement', () => {
    it('should prevent accessing git connection from another tenant', async () => {
      // Arrange: Create connection in other tenant
      const otherUser = await createAuthenticatedUser('owner');
      const otherApp = await createTestApp(otherUser.tenantId, { name: 'other-tenant-app' });
      const otherConnection = await createTestGitConnection(otherUser.tenantId, {
        provider: 'github',
        appId: otherApp.id,
      });

      // Act: Try to read connection from different tenant
      const result = await testUser.client
        .from('git_connection')
        .select('id, repository')
        .eq('id', otherConnection.id);

      // Assert: Should return empty (RLS blocks access)
      assertSuccess(result);
      expect(result.data).toHaveLength(0);

      // Cleanup
      await cleanupTestGitConnections(otherUser.tenantId);
      await cleanupTestApps(otherUser.tenantId);
    });

    it('should allow reading git connections in own tenant', async () => {
      // Arrange: Create app and connection
      const app = await createTestApp(testUser.tenantId, { name: 'own-tenant-app' });
      await createTestGitConnection(testUser.tenantId, {
        provider: 'github',
        appId: app.id,
      });

      // Act: Read connections in own tenant
      const result = await testUser.client
        .from('git_connection')
        .select('id, repository')
        .eq('tenant_id', testUser.tenantId);

      // Assert: Should return own connections
      assertSuccess(result);
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe('credential column grants', () => {
    it('rejects a tenant owner reading the webhook secret, even for their own connection', async () => {
      // Arrange: a connection the owner can otherwise read (own tenant, RLS allows it).
      const app = await createTestApp(testUser.tenantId, { name: 'credential-column-test-app' });
      const connection = await createTestGitConnection(testUser.tenantId, {
        provider: 'github',
        appId: app.id,
        repository: 'owner/credential-column-test-repo',
      });

      // Positive control: prove RLS actually admits this row before asserting
      // the column grant denies it. Without this, a 42501 on the credential
      // select would be indistinguishable from a row RLS never surfaced at
      // all (Postgres checks column privilege before RLS).
      const safeColumnsResult = await testUser.client
        .from('git_connection')
        .select('id, repository')
        .eq('app_id', app.id);
      assertSuccess(safeColumnsResult);
      expect(safeColumnsResult.data).toEqual([{ id: connection.id, repository: connection.repository }]);

      // Act: select the credential column as the tenant owner — the highest
      // tenant-scoped role, and the one whose SELECT policy on this table
      // (`git_connection.read`) is otherwise satisfied.
      const result = await testUser.client
        .from('git_connection')
        .select('webhook_secret')
        .eq('app_id', app.id);

      // Assert: a privilege error (42501), not an RLS-shaped empty result —
      // the column grant denies this before RLS is even evaluated. This is
      // the actual regression coverage for the credential-column exposure;
      // the RLS-allow/deny matrix in rbac-matrix.test.ts intentionally uses
      // an explicit safe column list and cannot see this distinction.
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('42501');
    });
  });
});
