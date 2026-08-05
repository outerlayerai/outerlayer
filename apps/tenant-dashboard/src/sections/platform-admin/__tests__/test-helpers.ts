/* eslint-disable import/no-unused-modules */
/**
 * Test helpers for platform admin integration tests
 * Exports may not all be used currently but are available for future tests
 */

import type { Mock } from 'vitest';

// Mock user data
export const mockPlatformAdmin = {
  id: 'admin-user-id-123',
  email: 'admin@outerlayer.ai',
};

export const mockNonAgentmarkUser = {
  id: 'user-id-456',
  email: 'user@example.com',
};

export const mockAgentmarkUserWithoutRole = {
  id: 'user-id-789',
  email: 'norole@outerlayer.ai',
};

// Mock organization data
export const mockTenant = {
  tenant_id: 'tenant-123',
  company_name: 'Test Company',
  organization_name: 'test-org',
  created_at: '2025-01-01T00:00:00Z',
  created_by: 'creator-id-123',
};

export const mockTenants = [
  mockTenant,
  {
    tenant_id: 'tenant-456',
    company_name: 'Another Company',
    organization_name: 'another-org',
    created_at: '2025-01-02T00:00:00Z',
    created_by: 'creator-id-456',
  },
];

// Mock profile data
export const mockProfile = {
  id: 'creator-id-123',
  email: 'creator@example.com',
  name: 'Test Creator',
};

// Mock membership data
export const mockMemberships = [
  { role: 'owner', user_id: 'user-1', profile: { id: 'user-1', email: 'owner@example.com', name: 'Owner' } },
  { role: 'admin', user_id: 'user-2', profile: { id: 'user-2', email: 'admin@example.com', name: 'Admin' } },
];

// Mock platform user role
export const mockPlatformUserRole = {
  id: 'platform-role-id-123',
  user_id: mockPlatformAdmin.id,
  role: 'platform_admin' as const,
  created_at: '2025-01-01T00:00:00Z',
  created_by: null,
};

/**
 * Type for table mock results
 */
export type TableMockResult = { data: unknown; error: unknown; count?: number | null };

/**
 * Type for dynamic table mock factory (for tests needing call-count based responses)
 */
export type TableMockFactory = () => TableMockResult;

/**
 * Create a chainable mock for Supabase query builder
 */
export function createChainableMock(finalResult: TableMockResult) {
  const chainable: Record<string, Mock> = {};

  const createMethod = (): Mock => {
    return vi.fn().mockImplementation(() => {
      // Return a Promise-like object that also has chainable methods
      const result = {
        ...chainable,
        then: (resolve: (value: typeof finalResult) => void) => {
          resolve(finalResult);
          return Promise.resolve(finalResult);
        },
        // Make it directly awaitable
        [Symbol.toStringTag]: 'Promise',
      };
      // Add promise methods
      Object.setPrototypeOf(result, Promise.prototype);
      return result;
    });
  };

  // Add all common Supabase query methods
  const methods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'or', 'and',
    'not', 'contains', 'containedBy', 'range', 'textSearch',
    'filter', 'match', 'order', 'limit', 'offset', 'range',
    'single', 'maybeSingle', 'csv', 'returns',
  ];

  methods.forEach(method => {
    chainable[method] = createMethod();
  });

  return chainable;
}

/**
 * State holder for table mock results - allows tests to configure per-table responses
 */
export const mockTableResults: Record<string, TableMockResult | TableMockFactory> = {};

/**
 * Reset mock table results - call in beforeEach
 */
export function resetMockTableResults() {
  Object.keys(mockTableResults).forEach(key => delete mockTableResults[key]);
}

/**
 * Set mock results for specific tables
 */
export function setMockTableResults(results: Record<string, TableMockResult | TableMockFactory>) {
  Object.assign(mockTableResults, results);
}

/**
 * Create a mock Supabase client that uses mockTableResults for per-table responses.
 * Use this with vi.mock() for supabaseAdminClient/supabaseServerClient.
 */
export function createTableAwareMockClient() {
  return {
    from: vi.fn((table: string) => {
      const resultOrFactory = mockTableResults[table];
      const result = typeof resultOrFactory === 'function'
        ? resultOrFactory()
        : (resultOrFactory || { data: null, error: null });
      return createChainableMock(result);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockPlatformAdmin },
        error: null,
      }),
    },
  };
}

/**
 * Create mock Supabase admin client for testing
 */
export function createMockSupabaseAdmin(overrides: Record<string, { data: unknown; error: unknown; count?: number }> = {}) {
  const defaultResult = { data: null, error: null };

  return {
    from: vi.fn((table: string) => {
      const result = overrides[table] || defaultResult;
      return createChainableMock(result);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockPlatformAdmin },
        error: null,
      }),
    },
  };
}

/**
 * Create mock Supabase server client for testing
 */
export function createMockSupabaseServer(user: typeof mockPlatformAdmin | null = mockPlatformAdmin) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: user ? null : { message: 'Not authenticated' },
      }),
    },
    from: vi.fn(() => createChainableMock({ data: null, error: null })),
  };
}
