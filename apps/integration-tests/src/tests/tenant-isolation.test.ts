import { cleanupTestUsers } from '../lib/test-utils';
import {
  createTestUser,
  createTestData,
  cleanupTestData,
  Role,
  ResourceType
} from '../lib/rbac-test-utils';
import { ensureDefaultEnvironment } from '../lib/environment-test-utils';

describe('Tenant Isolation', () => {
  // ============================================================================
  // TEST SETUP AND TEARDOWN
  // ============================================================================

  afterEach(async () => {
    await cleanupTestUsers();
  });

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  const createResourceData = async (
    resourceType: ResourceType,
    tenantId: string,
    createdBy: string,
    dependencies: any[] = []
  ) => {
    let testData: any;
    let newDependencies: any[] = [...dependencies];
    const uniqueId = crypto.randomUUID();

    switch (resourceType) {
      case 'app':
        testData = {
          name: `Test ${resourceType} ${uniqueId}`,
          tenant_id: tenantId,
          created_by: createdBy
        };
        break;

      case 'api_key':
        const apiApp = await createTestData('app', {
          name: `Test App ${uniqueId}`,
          tenant_id: tenantId,
          created_by: createdBy
        });
        newDependencies.push({ table: 'app', id: apiApp.id });

        // Api_key.environment_id is NOT NULL. A raw app insert
        // does not auto-create the default environment, so seed it here.
        const apiKeyEnvId = await ensureDefaultEnvironment(apiApp.id, tenantId);

        testData = {
          name: `Test ${resourceType} ${uniqueId}`,
          api_key_id: `test-key-${uniqueId}`,
          app_id: apiApp.id,
          environment_id: apiKeyEnvId,
          tenant_id: tenantId,
          created_by: createdBy
        };
        break;

      case 'git_connection':
        const gitConnApp = await createTestData('app', {
          name: `Test App ${uniqueId}`,
          tenant_id: tenantId,
          created_by: createdBy
        });
        newDependencies.push({ table: 'app', id: gitConnApp.id });

        testData = {
          app_id: gitConnApp.id,
          tenant_id: tenantId,
          created_by: createdBy
        };
        break;

      case 'git_branch':
        const branchApp = await createTestData('app', {
          name: `Test App ${uniqueId}`,
          tenant_id: tenantId,
          created_by: createdBy
        });
        newDependencies.push({ table: 'app', id: branchApp.id });

        testData = {
          app_id: branchApp.id,
          tenant_id: tenantId,
          created_by: createdBy
        };
        break;

      default:
        testData = {
          name: `Test ${resourceType} ${uniqueId}`,
          tenant_id: tenantId,
          created_by: createdBy
        };
    }

    const data = await createTestData(resourceType, testData);
    return { data, dependencies: newDependencies };
  };

  const cleanupResourceData = async (resourceType: ResourceType, dataId: string, dependencies: any[]) => {
    await cleanupTestData(resourceType, { id: dataId });
    for (const dep of dependencies) {
      await cleanupTestData(dep.table, { id: dep.id });
    }
  };

  const testCrossTenantAccess = async (
    resourceType: ResourceType,
    userARole: Role,
    userBRole: Role
  ) => {
    const userA = await createTestUser(userARole);
    const userB = await createTestUser(userBRole);

    // Create data for user B
    const { data: dataB, dependencies } = await createResourceData(
      resourceType,
      userB.tenantId,
      userB.id
    );

    // User A should NOT see User B's data
    const { data: crossTenantData } = await userA.client
      .from(resourceType)
      .select('id, name, tenant_id')
      .eq('id', dataB.id);

    // Handle both null and empty array responses
    if (crossTenantData === null) {
      expect(crossTenantData).toBeNull();
    } else {
      expect(crossTenantData).toHaveLength(0);
    }

    // Cleanup
    await cleanupResourceData(resourceType, dataB.id, dependencies);
  };

  // ============================================================================
  // CROSS-TENANT ACCESS TESTS
  // ============================================================================

  describe('Cross-Tenant Access Prevention', () => {
    const resourceTypes: Array<{
      resourceType: ResourceType;
      userARole: Role;
      userBRole: Role;
      description: string;
    }> = [
      { resourceType: 'app', userARole: 'owner', userBRole: 'admin', description: 'app' },
      { resourceType: 'api_key', userARole: 'write', userBRole: 'admin', description: 'API key' },
      { resourceType: 'git_connection', userARole: 'admin', userBRole: 'write', description: 'Git connection' },
      { resourceType: 'git_branch', userARole: 'write', userBRole: 'read', description: 'Git branch' }
    ];

    resourceTypes.forEach(({ resourceType, userARole, userBRole, description }) => {
      it(`should prevent ${userARole} from accessing ${userBRole}'s ${description}`, async () => {
        await testCrossTenantAccess(resourceType, userARole, userBRole);
      });
    });

    it('should prevent profile access across tenants', async () => {
      const userA = await createTestUser('admin');
      const userB = await createTestUser('owner');

      // User A should NOT see User B's profile (they are in different tenants)
      const { data: crossTenantData } = await userA.client
        .from('profile')
        .select('id, name')
        .eq('id', userB.id);

      expect(crossTenantData).toHaveLength(0);
    });
  });

  // ============================================================================
  // SAME-ROLE CROSS-TENANT TESTS
  // ============================================================================

  describe('Same-Role Cross-Tenant Isolation', () => {
    it('should prevent owner from accessing other owner data', async () => {
      const ownerA = await createTestUser('owner');
      const ownerB = await createTestUser('owner');

      // Create data for owner B
      const { data: dataB, dependencies } = await createResourceData(
        'app',
        ownerB.tenantId,
        ownerB.id
      );

      // Owner A should not see Owner B's data
      const { data: crossTenantData } = await ownerA.client
        .from('app')
        .select('*')
        .eq('id', dataB.id);

      expect(crossTenantData).toHaveLength(0);

      // Cleanup
      await cleanupResourceData('app', dataB.id, dependencies);
    });

    it('should prevent admin from accessing other admin data', async () => {
      const adminA = await createTestUser('admin');
      const adminB = await createTestUser('admin');

      // Create data for admin B
      const { data: dataB, dependencies } = await createResourceData(
        'app',
        adminB.tenantId,
        adminB.id
      );

      // Admin A should not see Admin B's data
      const { data: crossTenantData } = await adminA.client
        .from('app')
        .select('*')
        .eq('id', dataB.id);

      expect(crossTenantData).toHaveLength(0);

      // Cleanup
      await cleanupResourceData('app', dataB.id, dependencies);
    });

    it('should prevent write user from accessing other write user data', async () => {
      const writeA = await createTestUser('write');
      const writeB = await createTestUser('write');

      // Create data for write B
      const { data: dataB, dependencies } = await createResourceData(
        'app',
        writeB.tenantId,
        writeB.id
      );

      // Write A should not see Write B's data
      const { data: crossTenantData } = await writeA.client
        .from('app')
        .select('*')
        .eq('id', dataB.id);

      expect(crossTenantData).toHaveLength(0);

      // Cleanup
      await cleanupResourceData('app', dataB.id, dependencies);
    });
  });

  // ============================================================================
  // DISABLED ROLE TESTS
  // ============================================================================

  describe('Disabled Role Isolation', () => {
    // proves AC-075-02
    it('should prevent disabled users from accessing any tenant data', async () => {
      const disabledUser = await createTestUser('disabled');
      const activeUser = await createTestUser('owner');

      // Create data for active user
      const { data: activeData, dependencies } = await createResourceData(
        'app',
        activeUser.tenantId,
        activeUser.id
      );

      // Disabled user should not see their own data (if any)
      const { data: ownData } = await disabledUser.client
        .from('app')
        .select('*');

      expect(ownData).toHaveLength(0);

      // Disabled user should not see other tenant's data
      const { data: otherData } = await disabledUser.client
        .from('app')
        .select('*')
        .eq('id', activeData.id);

      expect(otherData).toHaveLength(0);

      // Cleanup
      await cleanupResourceData('app', activeData.id, dependencies);
    });

    it('should prevent disabled users from creating data', async () => {
      const disabledUser = await createTestUser('disabled');

      // Disabled user should not be able to create data
      const { error } = await disabledUser.client
        .from('app')
        .insert({
          name: 'Disabled user app',
          tenant_id: disabledUser.tenantId,
          created_by: disabledUser.id
        });

      expect(error).not.toBeNull();
      expect(error!.message).toContain('row-level security policy');
    });
  });

  // ============================================================================
  // BULK OPERATION TESTS
  // ============================================================================

  describe('Bulk Operation Isolation', () => {
    it('should prevent bulk reads across tenants', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      // Create multiple records for user B
      const [{ data: dataB1, dependencies: deps1 }, { data: dataB2, dependencies: deps2 }] =
        await Promise.all([
          createResourceData('app', userB.tenantId, userB.id),
          createResourceData('app', userB.tenantId, userB.id),
        ]);

      // User A should not see any of user B's apps in bulk query
      const { data: bulkData } = await userA.client
        .from('app')
        .select('*')
        .in('id', [dataB1.id, dataB2.id]);

      // Handle both null and empty array responses
      if (bulkData === null) {
        expect(bulkData).toBeNull();
      } else {
        expect(bulkData).toHaveLength(0);
      }

      // Cleanup
      await cleanupResourceData('app', dataB1.id, deps1);
      await cleanupResourceData('app', dataB2.id, deps2);
    });

    it('should prevent bulk updates across tenants', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      // Create data for user B
      const { data: dataB, dependencies } = await createResourceData(
        'app',
        userB.tenantId,
        userB.id
      );

      // User A should not be able to bulk update user B's data
      const { data: updateResult, error: updateError } = await userA.client
        .from('app')
        .update({ name: 'Modified by User A' })
        .in('id', [dataB.id])
        .select();

      if (updateError) {
        expect(updateError.message).toContain('row-level security policy');
      } else {
        // If no error, the update should return no rows (RLS blocked it)
        expect(updateResult).toHaveLength(0);
      }

      // Cleanup
      await cleanupResourceData('app', dataB.id, dependencies);
    });
  });

  // ============================================================================
  // COMPLEX QUERY TESTS
  // ============================================================================

  describe('Complex Query Isolation', () => {
    it('should prevent cross-tenant aggregations', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      // Create multiple records for user B
      const [{ data: dataB1, dependencies: deps1 }, { data: dataB2, dependencies: deps2 }] =
        await Promise.all([
          createResourceData('app', userB.tenantId, userB.id),
          createResourceData('app', userB.tenantId, userB.id),
        ]);

      // User A should not see user B's data in count aggregation
      const { data: countData } = await userA.client
        .from('app')
        .select('*', { count: 'exact' })
        .in('id', [dataB1.id, dataB2.id]);

      // Handle both null and empty array responses
      if (countData === null) {
        expect(countData).toBeNull();
      } else {
        expect(countData).toHaveLength(0);
      }

      // Cleanup
      await cleanupResourceData('app', dataB1.id, deps1);
      await cleanupResourceData('app', dataB2.id, deps2);
    });

    it('should prevent cross-tenant range queries', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      // Create data for user B
      const { data: dataB, dependencies } = await createResourceData(
        'app',
        userB.tenantId,
        userB.id
      );

      // User A should not see user B's data in range query
      const { data: rangeData } = await userA.client
        .from('app')
        .select('*')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .lte('created_at', new Date().toISOString())
        .eq('id', dataB.id);

      // Handle both null and empty array responses
      if (rangeData === null) {
        expect(rangeData).toBeNull();
      } else {
        expect(rangeData).toHaveLength(0);
      }

      // Cleanup
      await cleanupResourceData('app', dataB.id, dependencies);
    });
  });

  // ============================================================================
  // TENANT BOUNDARY TESTS
  // ============================================================================

  describe('Tenant Boundary Validation', () => {
    it('should ensure users from different tenants have different tenant IDs', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      expect(userA.tenantId).not.toBe(userB.tenantId);
      expect(userA.tenantId).toEqual(expect.any(String));
      expect(userB.tenantId).toEqual(expect.any(String));
    });

    it('should prevent users from accessing tenant data from other tenants', async () => {
      const userA = await createTestUser('owner');
      const userB = await createTestUser('admin');

      // User A should NOT be able to access User B's tenant data
      const { data: tenantData, error } = await userA.client
        .from('tenant')
        .select('*')
        .eq('tenant_id', userB.tenantId)
        .single();

      expect(error).not.toBeNull();
      expect(tenantData).toBeNull();
    });

    it('should allow users to access their own tenant data', async () => {
      const user = await createTestUser('owner');

      // User should be able to access their own tenant data
      const { data: tenantData, error } = await user.client
        .from('tenant')
        .select('*')
        .eq('tenant_id', user.tenantId)
        .single();

      expect(error).toBeNull();
      expect(tenantData).not.toBeNull();
      expect(tenantData.tenant_id).toBe(user.tenantId);
    });
  });

  // ============================================================================
  // MULTI-TENANT SCENARIO TESTS
  // ============================================================================

  describe('Multi-Tenant Scenarios', () => {
    it('should handle multiple tenants with similar data structures', async () => {
      const tenant1Owner = await createTestUser('owner');
      const tenant2Owner = await createTestUser('owner');
      const tenant3Admin = await createTestUser('admin');

      // Create similar data in different tenants
      const [
        { data: app1, dependencies: deps1 },
        { data: app2, dependencies: deps2 },
        { data: app3, dependencies: deps3 },
      ] = await Promise.all([
        createResourceData('app', tenant1Owner.tenantId, tenant1Owner.id),
        createResourceData('app', tenant2Owner.tenantId, tenant2Owner.id),
        createResourceData('app', tenant3Admin.tenantId, tenant3Admin.id),
      ]);

      // Each user should only see their own data
      const [{ data: tenant1Apps }, { data: tenant2Apps }, { data: tenant3Apps }] =
        await Promise.all([
          tenant1Owner.client.from('app').select('id, name, tenant_id').eq('id', app1.id),
          tenant2Owner.client.from('app').select('id, name, tenant_id').eq('id', app2.id),
          tenant3Admin.client.from('app').select('id, name, tenant_id').eq('id', app3.id),
        ]);

      // Each tenant should only see their own app
      expect(tenant1Apps).toHaveLength(1);
      expect(tenant1Apps![0]!.tenant_id).toBe(tenant1Owner.tenantId);

      expect(tenant2Apps).toHaveLength(1);
      expect(tenant2Apps![0]!.tenant_id).toBe(tenant2Owner.tenantId);

      expect(tenant3Apps).toHaveLength(1);
      expect(tenant3Apps![0]!.tenant_id).toBe(tenant3Admin.tenantId);

      // Cleanup
      await Promise.all([
        cleanupResourceData('app', app1.id, deps1),
        cleanupResourceData('app', app2.id, deps2),
        cleanupResourceData('app', app3.id, deps3),
      ]);
    });
  });
}); 