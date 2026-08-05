// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { useMemberships } from '../hooks/use-memberships';
import { MembershipWithTenant, ActiveTenant } from '../../types/membership';
import type { Tenant } from '../../types/tenant';

// Mock useAuthContext
let mockUser: any = null;
vi.mock('../hooks/use-auth-context', () => ({
  useAuthContext: () => ({ user: mockUser }),
}));

describe('useMemberships', () => {
  const createTenant = (overrides: Partial<Tenant> = {}): Tenant => ({
    tenant_id: 'tenant-123',
    organization_name: 'Test Org',
    company_name: 'Test Company',
    created_at: null,
    created_by: null,
    updated_at: null,
    updated_by: null,
    first_trace_at: null,
    agent_capture_tier: 'redacted',
    ...overrides,
  });

  beforeEach(() => {
    mockUser = null;
  });

  describe('when user is null', () => {
    it('should return empty memberships array', () => {
      mockUser = null;

      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships).toEqual([]);
      expect(result.current.activeTenant).toBeNull();
      expect(result.current.activeMembership).toBeNull();
      expect(result.current.membershipCount).toBe(0);
    });
  });

  describe('when user has no memberships', () => {
    it('should return empty memberships array', () => {
      mockUser = {
        id: 'user-123',
        memberships: [],
        activeTenant: null,
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships).toEqual([]);
      expect(result.current.activeTenant).toBeNull();
      expect(result.current.activeMembership).toBeNull();
      expect(result.current.membershipCount).toBe(0);
      expect(result.current.hasMultipleOrgs).toBe(false);
      expect(result.current.isAtOrgLimit).toBe(false);
    });
  });

  describe('when user has single membership', () => {
    const mockMemberships: MembershipWithTenant[] = [
      {
        id: 'membership-1',
        user_id: 'user-123',
        tenant_id: 'tenant-123',
        role: 'owner',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-01',
        tenant: createTenant(),
      },
    ];

    const mockActiveTenant: ActiveTenant = {
      tenant_id: 'tenant-123',
      organization_name: 'Test Org',
      company_name: 'Test Company',
      role: 'owner',
    };

    beforeEach(() => {
      mockUser = {
        id: 'user-123',
        memberships: mockMemberships,
        activeTenant: mockActiveTenant,
      };
    });

    it('should return membership data', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships).toEqual(mockMemberships);
      expect(result.current.activeTenant).toEqual(mockActiveTenant);
      expect(result.current.membershipCount).toBe(1);
      expect(result.current.hasMultipleOrgs).toBe(false);
      expect(result.current.isAtOrgLimit).toBe(false);
    });

    it('should return active membership', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.activeMembership).toEqual(mockMemberships[0]);
    });

    it('should return current role as owner', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.currentRole).toBe('owner');
      expect(result.current.isOwner).toBe(true);
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.canManageMembers).toBe(true);
    });
  });

  describe('when user has multiple memberships', () => {
    const mockMemberships: MembershipWithTenant[] = [
      {
        id: 'membership-1',
        user_id: 'user-123',
        tenant_id: 'tenant-1',
        role: 'owner',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-01',
        tenant: createTenant({
          tenant_id: 'tenant-1',
          organization_name: 'Org One',
          company_name: 'Company One',
        }),
      },
      {
        id: 'membership-2',
        user_id: 'user-123',
        tenant_id: 'tenant-2',
        role: 'admin',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-02',
        tenant: createTenant({
          tenant_id: 'tenant-2',
          organization_name: 'Org Two',
          company_name: 'Company Two',
        }),
      },
      {
        id: 'membership-3',
        user_id: 'user-123',
        tenant_id: 'tenant-3',
        role: 'write',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-03',
        tenant: createTenant({
          tenant_id: 'tenant-3',
          organization_name: 'Org Three',
          company_name: 'Company Three',
        }),
      },
    ];

    const mockActiveTenant: ActiveTenant = {
      tenant_id: 'tenant-2',
      organization_name: 'Org Two',
      company_name: 'Company Two',
      role: 'admin',
    };

    beforeEach(() => {
      mockUser = {
        id: 'user-123',
        memberships: mockMemberships,
        activeTenant: mockActiveTenant,
      };
    });

    it('should return all memberships', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships).toEqual(mockMemberships);
      expect(result.current.membershipCount).toBe(3);
      expect(result.current.hasMultipleOrgs).toBe(true);
      expect(result.current.isAtOrgLimit).toBe(false);
    });

    it('should return correct active membership', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.activeMembership).toEqual(mockMemberships[1]);
      expect(result.current.activeMembership?.tenant_id).toBe('tenant-2');
    });

    it('should return current role from active tenant', () => {
      const { result } = renderHook(() => useMemberships());

      expect(result.current.currentRole).toBe('admin');
      expect(result.current.isOwner).toBe(false);
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.canManageMembers).toBe(true);
    });
  });

  describe('role-based flags', () => {
    it('should correctly identify owner role', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'owner',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'Test Org',
          company_name: 'Test Company',
          role: 'owner',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.isOwner).toBe(true);
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.canManageMembers).toBe(true);
    });

    it('should correctly identify admin role', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'admin',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'Test Org',
          company_name: 'Test Company',
          role: 'admin',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.isOwner).toBe(false);
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.canManageMembers).toBe(true);
    });

    it('should correctly identify write role', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'write',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'Test Org',
          company_name: 'Test Company',
          role: 'write',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.isOwner).toBe(false);
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.canManageMembers).toBe(false);
    });

    it('should correctly identify read role', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'read',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'Test Org',
          company_name: 'Test Company',
          role: 'read',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.isOwner).toBe(false);
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.canManageMembers).toBe(false);
    });

    it('should handle null active tenant', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'owner',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: null,
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.currentRole).toBeNull();
      expect(result.current.isOwner).toBe(false);
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.canManageMembers).toBe(false);
    });
  });

  describe('organization limit', () => {
    it('should detect when user is at 10 organization limit', () => {
      const memberships: MembershipWithTenant[] = Array.from({ length: 10 }, (_, i) => ({
        id: `membership-${i}`,
        user_id: 'user-123',
        tenant_id: `tenant-${i}`,
        role: 'read',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-01',
        tenant: createTenant({
          tenant_id: `tenant-${i}`,
          organization_name: `Org ${i}`,
          company_name: `Company ${i}`,
        }),
      }));

      mockUser = {
        id: 'user-123',
        memberships,
        activeTenant: {
          tenant_id: 'tenant-0',
          organization_name: 'Org 0',
          company_name: 'Company 0',
          role: 'read',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.membershipCount).toBe(10);
      expect(result.current.isAtOrgLimit).toBe(true);
    });

    it('should return false when user has fewer than 10 organizations', () => {
      const memberships: MembershipWithTenant[] = Array.from({ length: 5 }, (_, i) => ({
        id: `membership-${i}`,
        user_id: 'user-123',
        tenant_id: `tenant-${i}`,
        role: 'read',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-01',
        tenant: createTenant({
          tenant_id: `tenant-${i}`,
          organization_name: `Org ${i}`,
          company_name: `Company ${i}`,
        }),
      }));

      mockUser = {
        id: 'user-123',
        memberships,
        activeTenant: {
          tenant_id: 'tenant-0',
          organization_name: 'Org 0',
          company_name: 'Company 0',
          role: 'read',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.membershipCount).toBe(5);
      expect(result.current.isAtOrgLimit).toBe(false);
    });
  });

  describe('helper functions', () => {
    const mockMemberships: MembershipWithTenant[] = [
      {
        id: 'membership-1',
        user_id: 'user-123',
        tenant_id: 'tenant-1',
        role: 'owner',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-01',
        tenant: createTenant({
          tenant_id: 'tenant-1',
          organization_name: 'alpha-corp',
          company_name: 'Alpha Corp',
        }),
      },
      {
        id: 'membership-2',
        user_id: 'user-123',
        tenant_id: 'tenant-2',
        role: 'admin',
        status: 'active',
        invited_at: null,
        invited_by: null,
        expires_at: null,
        created_at: '2024-01-02',
        tenant: createTenant({
          tenant_id: 'tenant-2',
          organization_name: 'beta-inc',
          company_name: 'Beta Inc',
        }),
      },
    ];

    beforeEach(() => {
      mockUser = {
        id: 'user-123',
        memberships: mockMemberships,
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'alpha-corp',
          company_name: 'Alpha Corp',
          role: 'owner',
        },
      };
    });

    describe('getMembershipByTenantId', () => {
      it('should find membership by tenant ID when it exists', () => {
        const { result } = renderHook(() => useMemberships());

        const membership = result.current.getMembershipByTenantId('tenant-2');

        expect(membership).toEqual(mockMemberships[1]);
        expect(membership?.tenant_id).toBe('tenant-2');
      });

      it('should return null when tenant ID does not exist', () => {
        const { result } = renderHook(() => useMemberships());

        const membership = result.current.getMembershipByTenantId('nonexistent-tenant');

        expect(membership).toBeNull();
      });
    });

    describe('getMembershipByOrgName', () => {
      it('should find membership by organization name when it exists', () => {
        const { result } = renderHook(() => useMemberships());

        const membership = result.current.getMembershipByOrgName('beta-inc');

        expect(membership).toEqual(mockMemberships[1]);
        expect(membership?.tenant.organization_name).toBe('beta-inc');
      });

      it('should return null when organization name does not exist', () => {
        const { result } = renderHook(() => useMemberships());

        const membership = result.current.getMembershipByOrgName('nonexistent-org');

        expect(membership).toBeNull();
      });
    });

    describe('isMemberOf', () => {
      it('should return true when user is member of tenant', () => {
        const { result } = renderHook(() => useMemberships());

        expect(result.current.isMemberOf('tenant-1')).toBe(true);
        expect(result.current.isMemberOf('tenant-2')).toBe(true);
      });

      it('should return false when user is not member of tenant', () => {
        const { result } = renderHook(() => useMemberships());

        expect(result.current.isMemberOf('tenant-3')).toBe(false);
        expect(result.current.isMemberOf('nonexistent-tenant')).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('should handle undefined memberships', () => {
      mockUser = {
        id: 'user-123',
        memberships: undefined,
        activeTenant: null,
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships).toEqual([]);
      expect(result.current.membershipCount).toBe(0);
    });

    it('should handle missing active tenant when memberships exist', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'owner',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: null,
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.memberships.length).toBe(1);
      expect(result.current.activeTenant).toBeNull();
      expect(result.current.activeMembership).toBeNull();
    });

    it('should return null for active membership when active tenant ID does not match any membership', () => {
      mockUser = {
        id: 'user-123',
        memberships: [
          {
            id: 'membership-1',
            user_id: 'user-123',
            tenant_id: 'tenant-1',
            role: 'owner',
            status: 'active',
            invited_at: null,
            invited_by: null,
            expires_at: null,
            created_at: '2024-01-01',
            tenant: createTenant({ tenant_id: 'tenant-1' }),
          },
        ],
        activeTenant: {
          tenant_id: 'tenant-999',
          organization_name: 'Other Org',
          company_name: 'Other Company',
          role: 'read',
        },
      };

      const { result } = renderHook(() => useMemberships());

      expect(result.current.activeMembership).toBeNull();
    });
  });

  describe('memoization', () => {
    it('should return stable references when user data does not change', () => {
      const mockMemberships: MembershipWithTenant[] = [
        {
          id: 'membership-1',
          user_id: 'user-123',
          tenant_id: 'tenant-1',
          role: 'owner',
          status: 'active',
          invited_at: null,
          invited_by: null,
          expires_at: null,
          created_at: '2024-01-01',
          tenant: createTenant({ tenant_id: 'tenant-1' }),
        },
      ];

      mockUser = {
        id: 'user-123',
        memberships: mockMemberships,
        activeTenant: {
          tenant_id: 'tenant-1',
          organization_name: 'Test Org',
          company_name: 'Test Company',
          role: 'owner',
        },
      };

      const { result, rerender } = renderHook(() => useMemberships());

      const firstMemberships = result.current.memberships;
      const firstActiveTenant = result.current.activeTenant;
      const firstActiveMembership = result.current.activeMembership;

      rerender();

      expect(result.current.memberships).toBe(firstMemberships);
      expect(result.current.activeTenant).toBe(firstActiveTenant);
      expect(result.current.activeMembership).toBe(firstActiveMembership);
    });
  });
});
