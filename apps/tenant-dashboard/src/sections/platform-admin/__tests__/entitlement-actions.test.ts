/**
 * Tests for entitlement server actions:
 * getTenantEntitlements, setTenantTier, setEntitlementOverride, removeEntitlementOverride
 */

import {
  mockPlatformAdmin,
  createTableAwareMockClient,
} from './test-helpers';
import * as supabaseAdminClientModule from '../../../supabaseAdminClient';
import * as supabaseServerClientModule from '../../../supabaseServerClient';

// --- Mocks ---

// Mock withPlatformAdminCheck to bypass auth
vi.mock('../utils/with-platform-admin-check', () => ({
  withPlatformAdminCheck: vi.fn((action: (user: { id: string; email: string; platformRole: string }) => Promise<unknown>) => {
    return action({
      id: mockPlatformAdmin.id,
      email: mockPlatformAdmin.email,
      platformRole: 'platform_admin',
    });
  }),
}));

// Mock EntitlementService
const mockGetEffectiveEntitlements = vi.fn();
const mockGetOverrides = vi.fn();
const mockGetTenantTier = vi.fn();
const mockSetTenantTier = vi.fn();
const mockSetOverride = vi.fn();
const mockRemoveOverride = vi.fn();

vi.mock('@/lib/system/entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(function () {
    return {
      getEffectiveEntitlements: mockGetEffectiveEntitlements,
      getOverrides: mockGetOverrides,
      getTenantTier: mockGetTenantTier,
      setTenantTier: mockSetTenantTier,
      setOverride: mockSetOverride,
      removeOverride: mockRemoveOverride,
    };
  }),
}));

// Mock AuditLogService
const mockAuditCreate = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/system/audit-log', () => ({
  AuditLogService: vi.fn().mockImplementation(function () {
    return {
      create: mockAuditCreate,
    };
  }),
}));

// Import after mocking
import {
  getTenantEntitlements,
  setTenantTier,
  setEntitlementOverride,
  removeEntitlementOverride,
} from '../organizations/entitlement-actions';

// --- Tests ---

describe('getTenantEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // no additional reset needed — mocks are service-level, not table-level
  });

  it('returns entitlements and overrides for a tenant', async () => {
    const fakeEntitlements = { tierId: 'growth', max_apps: 10, alerts_enabled: true };
    const fakeOverrides = [{ id: 'o1', entitlementKey: 'max_apps', value: 20 }];

    mockGetEffectiveEntitlements.mockResolvedValue(fakeEntitlements);
    mockGetOverrides.mockResolvedValue(fakeOverrides);

    const result = await getTenantEntitlements('tenant-123');

    expect(result.data).toEqual({
      entitlements: fakeEntitlements,
      overrides: fakeOverrides,
    });
    expect(result.error).toBeUndefined();
    expect(mockGetEffectiveEntitlements).toHaveBeenCalledWith('tenant-123');
    expect(mockGetOverrides).toHaveBeenCalledWith('tenant-123');
  });
});

describe('setTenantTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // no additional reset needed — mocks are service-level, not table-level
  });

  it('updates tier and creates audit log with before/after state', async () => {
    mockGetTenantTier.mockResolvedValue('hobby');
    mockSetTenantTier.mockResolvedValue(undefined);

    const result = await setTenantTier('tenant-123', 'growth', 'Test Org');

    expect(result.data).toEqual({ updated: true });
    expect(result.error).toBeUndefined();

    expect(mockSetTenantTier).toHaveBeenCalledWith('tenant-123', 'growth');
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: mockPlatformAdmin.id,
        actionType: 'entitlement_tier_change',
        targetType: 'tenant',
        targetId: 'tenant-123',
        targetIdentifier: 'Test Org',
        details: { previousTier: 'hobby', newTier: 'growth' },
        beforeState: { tier_id: 'hobby' },
        afterState: { tier_id: 'growth' },
      }),
    );
  });

  it('still creates audit log when setting the same tier (no-op change)', async () => {
    mockGetTenantTier.mockResolvedValue('hobby');
    mockSetTenantTier.mockResolvedValue(undefined);

    const result = await setTenantTier('tenant-123', 'hobby', 'Test Org');

    expect(result.data).toEqual({ updated: true });
    expect(mockSetTenantTier).toHaveBeenCalledWith('tenant-123', 'hobby');
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { previousTier: 'hobby', newTier: 'hobby' },
        beforeState: { tier_id: 'hobby' },
        afterState: { tier_id: 'hobby' },
      }),
    );
  });

  it('rejects invalid tier ID', async () => {
    const result = await setTenantTier('tenant-123', 'nonexistent' as any, 'Test Org');

    expect(result.error).toContain('Invalid tier');
    expect(result.data).toBeUndefined();
    expect(mockSetTenantTier).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('setEntitlementOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // no additional reset needed — mocks are service-level, not table-level
  });

  it('sets override and creates audit log', async () => {
    mockSetOverride.mockResolvedValue(undefined);

    const result = await setEntitlementOverride(
      'tenant-123',
      'max_apps',
      50,
      'Customer needs more apps',
      'Test Org',
    );

    expect(result.data).toEqual({ set: true });
    expect(result.error).toBeUndefined();

    expect(mockSetOverride).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      key: 'max_apps',
      value: 50,
      reason: 'Customer needs more apps',
      createdBy: mockPlatformAdmin.id,
    });

    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: mockPlatformAdmin.id,
        actionType: 'entitlement_override_set',
        targetType: 'tenant',
        targetId: 'tenant-123',
        targetIdentifier: 'Test Org',
        details: {
          entitlementKey: 'max_apps',
          value: 50,
          reason: 'Customer needs more apps',
        },
      }),
    );
  });
});

describe('removeEntitlementOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // no additional reset needed — mocks are service-level, not table-level
  });

  it('removes override and creates audit log', async () => {
    mockRemoveOverride.mockResolvedValue(undefined);

    const result = await removeEntitlementOverride('tenant-123', 'max_apps', 'Test Org');

    expect(result.data).toEqual({ removed: true });
    expect(result.error).toBeUndefined();

    expect(mockRemoveOverride).toHaveBeenCalledWith('tenant-123', 'max_apps');

    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: mockPlatformAdmin.id,
        actionType: 'entitlement_override_remove',
        targetType: 'tenant',
        targetId: 'tenant-123',
        targetIdentifier: 'Test Org',
        details: { entitlementKey: 'max_apps' },
      }),
    );
  });
});

// --- Error propagation tests ---
// withPlatformAdminCheck does not catch errors thrown by the action callback,
// so service errors propagate as unhandled exceptions.

describe('error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('should propagate error when setTenantTier service throws', async () => {
    mockGetTenantTier.mockResolvedValue('hobby');
    mockSetTenantTier.mockRejectedValue(new Error('DB connection lost'));

    await expect(setTenantTier('tenant-123', 'growth', 'Test Org')).rejects.toThrow('DB connection lost');
  });

  it('should propagate error when setOverride service throws', async () => {
    mockSetOverride.mockRejectedValue(new Error('Constraint violation'));

    await expect(
      setEntitlementOverride('tenant-123', 'max_apps', 50, 'reason', 'Test Org'),
    ).rejects.toThrow('Constraint violation');
  });

  it('should propagate error when removeOverride service throws', async () => {
    mockRemoveOverride.mockRejectedValue(new Error('Row not found'));

    await expect(
      removeEntitlementOverride('tenant-123', 'max_apps', 'Test Org'),
    ).rejects.toThrow('Row not found');
  });
});
