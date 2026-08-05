'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  EntitlementKey,
  TierId,
  ResolvedEntitlements,
  TenantEntitlementOverride,
} from '../../../config/entitlements';
import { TIERS } from '../../../config/entitlements';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createSupabaseAdminClient } from '../../../supabaseAdminClient';
import { EntitlementService } from '@/lib/system/entitlement-service';
import { AuditLogService } from '@/lib/system/audit-log';

function createEntitlementService() {
  const db = createSupabaseAdminClient();
  return new EntitlementService({ db });
}

function createAuditLog() {
  const db = createSupabaseAdminClient();
  return new AuditLogService({ db });
}

/**
 * Get the resolved entitlements for a tenant (tier defaults + overrides).
 * Requires platform admin role.
 */
export async function getTenantEntitlements(
  tenantId: string,
): Promise<ServerActionResponse<{ entitlements: ResolvedEntitlements; overrides: TenantEntitlementOverride[] }>> {
  return await withPlatformAdminCheck(async () => {
    const service = createEntitlementService();
    const [entitlements, overrides] = await Promise.all([
      service.getEffectiveEntitlements(tenantId),
      service.getOverrides(tenantId),
    ]);
    return { data: { entitlements, overrides } };
  });
}

/**
 * Change a tenant's tier. Creates an audit log entry.
 * Requires platform admin role.
 */
export async function setTenantTier(
  tenantId: string,
  tierId: TierId,
  organizationName: string,
): Promise<ServerActionResponse<{ updated: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    if (!(tierId in TIERS)) {
      return { error: `Invalid tier: ${tierId}` };
    }

    const service = createEntitlementService();
    const auditLog = createAuditLog();

    const previousTier = await service.getTenantTier(tenantId);

    await service.setTenantTier(tenantId, tierId);

    await auditLog.create({
      actorId: adminUser.id,
      actionType: 'entitlement_tier_change',
      targetType: 'tenant',
      targetId: tenantId,
      targetIdentifier: organizationName,
      details: { previousTier, newTier: tierId },
      beforeState: { tier_id: previousTier },
      afterState: { tier_id: tierId },
    });

    return { data: { updated: true } };
  });
}

/**
 * Set an entitlement override for a tenant. Creates an audit log entry.
 * Requires platform admin role.
 */
export async function setEntitlementOverride(
  tenantId: string,
  key: EntitlementKey,
  value: boolean | number | string,
  reason: string,
  organizationName: string,
): Promise<ServerActionResponse<{ set: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createEntitlementService();
    const auditLog = createAuditLog();

    await service.setOverride({ tenantId, key, value, reason, createdBy: adminUser.id });

    await auditLog.create({
      actorId: adminUser.id,
      actionType: 'entitlement_override_set',
      targetType: 'tenant',
      targetId: tenantId,
      targetIdentifier: organizationName,
      details: { entitlementKey: key, value, reason },
    });

    return { data: { set: true } };
  });
}

/**
 * Remove an entitlement override for a tenant. Creates an audit log entry.
 * Requires platform admin role.
 */
export async function removeEntitlementOverride(
  tenantId: string,
  key: EntitlementKey,
  organizationName: string,
): Promise<ServerActionResponse<{ removed: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createEntitlementService();
    const auditLog = createAuditLog();

    await service.removeOverride(tenantId, key);

    await auditLog.create({
      actorId: adminUser.id,
      actionType: 'entitlement_override_remove',
      targetType: 'tenant',
      targetId: tenantId,
      targetIdentifier: organizationName,
      details: { entitlementKey: key },
    });

    return { data: { removed: true } };
  });
}
