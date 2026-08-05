/**
 * The dashboards domain's one entitlement gate: the add-widget custom-metrics
 * check. `getEntitlement` (`@/lib/system/get-entitlement`) is a collaborator
 * seam (its own suite covers the resolution rules); this test pins the
 * tenant/feature-key pair the gate forwards and both outcomes, so a swapped
 * feature key or a gate that fails open would fail here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getEntitlementMock } = vi.hoisted(() => ({
  getEntitlementMock: vi.fn(),
}));

vi.mock('@/lib/system/get-entitlement', () => ({
  getEntitlement: getEntitlementMock,
}));

import { hasCustomMetricsEntitlement } from '../dashboard-entitlements';

const TENANT = 'tenant-1';

beforeEach(() => {
  getEntitlementMock.mockReset();
});

describe('hasCustomMetricsEntitlement', () => {
  it('resolves true and forwards the exact tenantId/feature-key pair when the tenant is entitled', async () => {
    getEntitlementMock.mockResolvedValue(true);

    const result = await hasCustomMetricsEntitlement(TENANT);

    expect(result).toBe(true);
    expect(getEntitlementMock).toHaveBeenCalledWith(TENANT, 'custom_metrics_enabled');
  });

  it('resolves false when the tenant is not entitled, without altering the args forwarded', async () => {
    getEntitlementMock.mockResolvedValue(false);

    const result = await hasCustomMetricsEntitlement(TENANT);

    expect(result).toBe(false);
    expect(getEntitlementMock).toHaveBeenCalledWith(TENANT, 'custom_metrics_enabled');
  });
});
