// @vitest-environment jsdom
/**
 * useUrlTenantId — the browser counterpart to the server getRequestTenantId():
 * resolve the URL org to the signed-in user's own active-membership tenant, or
 * undefined when there is no org in the path or the user is not a member of it.
 * These pin the resolution branches a gateway caller relies on to decide whether
 * to send X-Tenant-Id at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseParams = vi.fn();
vi.mock('next/navigation', () => ({ useParams: () => mockUseParams() }));

const mockGetMembershipByOrgName = vi.fn();
vi.mock('@/lib/adapters/use-memberships', () => ({
  useMemberships: () => ({ getMembershipByOrgName: mockGetMembershipByOrgName }),
}));

import { useUrlTenantId } from '../use-url-tenant-id';

describe('useUrlTenantId', () => {
  beforeEach(() => {
    mockUseParams.mockReset();
    mockGetMembershipByOrgName.mockReset();
  });

  it('resolves the URL org to the active-membership tenant id', () => {
    mockUseParams.mockReturnValue({ orgName: 'acme' });
    mockGetMembershipByOrgName.mockReturnValue({ tenant_id: 'tenant-acme' });

    const { result } = renderHook(() => useUrlTenantId());

    expect(result.current).toBe('tenant-acme');
    expect(mockGetMembershipByOrgName).toHaveBeenCalledWith('acme');
  });

  it('returns undefined and never looks up membership when the path carries no org', () => {
    mockUseParams.mockReturnValue({});

    const { result } = renderHook(() => useUrlTenantId());

    expect(result.current).toBeUndefined();
    expect(mockGetMembershipByOrgName).not.toHaveBeenCalled();
  });

  it('returns undefined when the user is not an active member of the URL org', () => {
    mockUseParams.mockReturnValue({ orgName: 'stranger' });
    mockGetMembershipByOrgName.mockReturnValue(undefined);

    const { result } = renderHook(() => useUrlTenantId());

    expect(result.current).toBeUndefined();
  });

  it('uses the first segment when the route param is an array (catch-all route)', () => {
    mockUseParams.mockReturnValue({ orgName: ['acme', 'extra'] });
    mockGetMembershipByOrgName.mockReturnValue({ tenant_id: 'tenant-acme' });

    const { result } = renderHook(() => useUrlTenantId());

    expect(result.current).toBe('tenant-acme');
    expect(mockGetMembershipByOrgName).toHaveBeenCalledWith('acme');
  });

  it('returns undefined when useParams yields no params object', () => {
    mockUseParams.mockReturnValue(null);

    const { result } = renderHook(() => useUrlTenantId());

    expect(result.current).toBeUndefined();
    expect(mockGetMembershipByOrgName).not.toHaveBeenCalled();
  });
});
