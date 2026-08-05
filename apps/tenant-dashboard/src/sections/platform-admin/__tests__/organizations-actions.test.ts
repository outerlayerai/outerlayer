/**
 * Integration tests for organization server actions
 * listOrganizations tests (pagination, search, filters)
 * getOrganizationDetail tests (valid org, non-existent org)
 */

// Mock server-only modules BEFORE any imports that might trigger them
vi.mock('../../../lib/system/git/connection', () => ({
  createGitProviderForApp: vi.fn(),
}));

import {
  mockPlatformAdmin,
  mockTenant,
  mockTenants,
  mockProfile,
  mockMemberships,
  createTableAwareMockClient,
  mockTableResults,
  resetMockTableResults,
  setMockTableResults,
} from './test-helpers';
import * as supabaseAdminClientModule from '../../../supabaseAdminClient';
import * as supabaseServerClientModule from '../../../supabaseServerClient';

// Import after mocking
import { listOrganizations, getOrganizationDetail } from '../organizations/actions';

function resetSupabaseClientSpies() {
  vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockImplementation(
    () => createTableAwareMockClient() as any,
  );
  vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockPlatformAdmin },
        error: null,
      }),
    },
  } as any);
}

describe('listOrganizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSupabaseClientSpies();
    resetMockTableResults();
    setMockTableResults({
      platform_user_role: { data: { role: 'platform_admin' }, error: null },
      tenant: { data: mockTenants, error: null, count: mockTenants.length },
      membership: { data: [{ tenant_id: mockTenant.tenant_id }], error: null },
    });
  });

  describe('basic functionality', () => {
    it('should return paginated list of organizations', async () => {
      const result = await listOrganizations({
        page: 1,
        pageSize: 25,
      });

      expect(result.error).toBeUndefined();
      expect(result.data?.items).toHaveLength(mockTenants.length);
      expect(result.data?.total).toBe(mockTenants.length);
      expect(result.data?.page).toBe(1);
      expect(result.data?.pageSize).toBeLessThanOrEqual(100);
    });

    it('should respect pageSize limit of 100', async () => {
      const result = await listOrganizations({
        page: 1,
        pageSize: 200, // Over limit
      });

      expect(result.data?.pageSize).toBeLessThanOrEqual(100);
    });

    it('should calculate totalPages correctly', async () => {
      mockTableResults.tenant = {
        data: mockTenants,
        error: null,
        count: 50,
      };

      const result = await listOrganizations({
        page: 1,
        pageSize: 10,
      });

      expect(result.data?.totalPages).toBe(5); // 50 / 10 = 5
    });
  });

  describe('search functionality', () => {
    it('should handle empty search results', async () => {
      mockTableResults.tenant = { data: [], error: null, count: 0 };

      const result = await listOrganizations({
        page: 1,
        pageSize: 25,
        search: 'nonexistent-org',
      });

      expect(result.data?.items).toEqual([]);
      expect(result.data?.total).toBe(0);
    });
  });

  // NOTE: Date filtering and sorting behavior are not covered here — a "no
  // error" assertion on mocked data wouldn't test the actual behavior. The
  // integration tests in
  // apps/integration-tests/src/tests/platform-admin/organizations.test.ts
  // cover these features against the real database.

  describe('error handling', () => {
    it('should return error when database query fails', async () => {
      mockTableResults.tenant = {
        data: null,
        error: { message: 'Database connection error' },
      };

      const result = await listOrganizations({
        page: 1,
        pageSize: 25,
      });

      expect(result.error).toContain('Failed to list organizations');
    });

    it('should deny access to non-platform-admin', async () => {
      // Override the platform_user_role check to fail
      mockTableResults.platform_user_role = {
        data: null,
        error: { code: 'PGRST116' },
      };

      const result = await listOrganizations({
        page: 1,
        pageSize: 25,
      });

      expect(result.error).toContain('Access denied');
    });
  });

  describe('response structure', () => {
    it('should return correct OrganizationListItem fields', async () => {
      mockTableResults.tenant = {
        data: [
          {
            tenant_id: 'test-tenant',
            company_name: 'Test Company',
            organization_name: 'test-org',
            created_at: '2025-01-01T00:00:00Z',
            billing: { stripe_subscription_id: 'sub_123' },
          },
        ],
        error: null,
        count: 1,
      };

      const result = await listOrganizations({
        page: 1,
        pageSize: 25,
      });

      const item = result.data?.items[0];
      expect(item).toHaveProperty('tenant_id');
      expect(item).toHaveProperty('company_name');
      expect(item).toHaveProperty('organization_name');
      expect(item).toHaveProperty('created_at');
      expect(item).toHaveProperty('user_count');
      expect(item).toHaveProperty('subscription_tier');
    });
  });
});

describe('getOrganizationDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSupabaseClientSpies();
    resetMockTableResults();
    setMockTableResults({
      platform_user_role: { data: { role: 'platform_admin' }, error: null },
      tenant: { data: mockTenant, error: null },
      profile: { data: mockProfile, error: null },
      membership: { data: mockMemberships, error: null },
      app: { data: null, error: null, count: 5 },
      api_key: { data: null, error: null, count: 3 },
      billing: { data: { stripe_customer_id: 'cus_123', stripe_subscription_id: null }, error: null },
      temp_access_grant: { data: [], error: null },
    });
  });

  describe('valid organization', () => {
    it('should return full organization details', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.error).toBeUndefined();
      expect(result.data?.tenant_id).toBe(mockTenant.tenant_id);
      expect(result.data?.organization_name).toBe(mockTenant.organization_name);
    });

    it('should include user list with roles', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.data?.users).toEqual([
        expect.objectContaining({ email: 'owner@example.com', role: 'owner' }),
        expect.objectContaining({ email: 'admin@example.com', role: 'admin' }),
      ]);
    });

    it('should include resource counts', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.data?.apps_count).toBe(5);
      expect(result.data?.api_keys_count).toBe(3);
    });

    it('should include billing information', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.data?.billing).toEqual(
        expect.objectContaining({ stripe_customer_id: 'cus_123' })
      );
    });

    it('should include active temp access grants', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.data?.temp_access_grants).toEqual([]);
    });
  });

  describe('non-existent organization', () => {
    it('should return error for non-existent org', async () => {
      mockTableResults.tenant = {
        data: null,
        error: { code: 'PGRST116', message: 'No rows found' },
      };

      const result = await getOrganizationDetail('nonexistent-tenant-id');

      expect(result.error).toContain('not found');
    });
  });

  describe('access control', () => {
    it('should deny access to non-platform-admin', async () => {
      mockTableResults.platform_user_role = {
        data: null,
        error: { code: 'PGRST116' },
      };

      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.error).toContain('Access denied');
    });
  });

  describe('creator information', () => {
    it('should include creator details when available', async () => {
      const result = await getOrganizationDetail(mockTenant.tenant_id);

      // created_by should be populated from profile lookup
      expect(result.data?.created_by).toEqual(
        expect.objectContaining({ id: mockProfile.id, email: mockProfile.email })
      );
    });

    it('should handle missing creator gracefully', async () => {
      mockTableResults.profile = { data: null, error: null };

      const result = await getOrganizationDetail(mockTenant.tenant_id);

      expect(result.error).toBeUndefined();
      expect(result.data?.created_by).toBeNull();
    });
  });
});

describe('Platform Admin Authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockTableResults();
  });

  it('should require platform admin for listOrganizations', async () => {
    setMockTableResults({
      platform_user_role: { data: null, error: { code: 'PGRST116' } },
    });

    const result = await listOrganizations({ page: 1, pageSize: 25 });

    expect(result.error).toContain('Access denied');
  });

  it('should require platform admin for getOrganizationDetail', async () => {
    setMockTableResults({
      platform_user_role: { data: null, error: { code: 'PGRST116' } },
    });

    const result = await getOrganizationDetail('any-tenant-id');

    expect(result.error).toContain('Access denied');
  });
});
