"use client";

import { useMemo } from "react";
import { useAuthContext } from "./use-auth-context";
import { MembershipWithTenant, ActiveTenant } from "../../types/membership";

/**
 * Hook for accessing membership-related data and utilities
 * Provides convenient access to memberships, active tenant, and helper functions
 */
export function useMemberships() {
  const { user } = useAuthContext();

  const memberships = useMemo<MembershipWithTenant[]>(
    () => user?.memberships ?? [],
    [user?.memberships]
  );

  const activeTenant = useMemo<ActiveTenant | null>(
    () => user?.activeTenant ?? null,
    [user?.activeTenant]
  );

  const activeMembership = useMemo<MembershipWithTenant | null>(() => {
    if (!activeTenant) return null;
    return (
      memberships.find((m) => m.tenant_id === activeTenant.tenant_id) ?? null
    );
  }, [memberships, activeTenant]);

  /** Number of active organization memberships */
  const membershipCount = memberships.length;

  /** Whether the user has reached the 10-organization limit */
  const isAtOrgLimit = membershipCount >= 10;

  /** Whether the user belongs to multiple organizations */
  const hasMultipleOrgs = membershipCount > 1;

  /** Current role in the active organization */
  const currentRole = activeTenant?.role ?? null;

  /** Whether the user is an owner in the active organization */
  const isOwner = currentRole === "owner";

  /** Whether the user is an admin or owner in the active organization */
  const isAdmin = currentRole === "owner" || currentRole === "admin";

  /** Whether the user can manage members (invite, remove, change roles) */
  const canManageMembers = isAdmin;

  /**
   * Find a membership by tenant ID
   */
  const getMembershipByTenantId = (
    tenantId: string
  ): MembershipWithTenant | null => {
    return memberships.find((m) => m.tenant_id === tenantId) ?? null;
  };

  /**
   * Find a membership by organization name (URL slug)
   */
  const getMembershipByOrgName = (
    orgName: string
  ): MembershipWithTenant | null => {
    return (
      memberships.find((m) => m.tenant?.organization_name === orgName) ?? null
    );
  };

  /**
   * Check if user is a member of a specific tenant
   */
  const isMemberOf = (tenantId: string): boolean => {
    return memberships.some((m) => m.tenant_id === tenantId);
  };

  return {
    // Data
    memberships,
    activeTenant,
    activeMembership,
    membershipCount,
    currentRole,

    // Flags
    isAtOrgLimit,
    hasMultipleOrgs,
    isOwner,
    isAdmin,
    canManageMembers,

    // Helpers
    getMembershipByTenantId,
    getMembershipByOrgName,
    isMemberOf,
  };
}
