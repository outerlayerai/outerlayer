'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  GrantTempAccessParams,
  GrantTempAccessResult,
  RevokeTempAccessParams,
  RevokeTempAccessResult,
  ActiveGrant,
} from '../../../types/platform-admin';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createTempAccessService } from '../services';

/**
 * Grant temporary read-only access to an organization.
 * Requires platform admin role.
 *
 * Delegates to TempAccessService for business logic.
 */
export async function grantTempAccess(
  params: GrantTempAccessParams
): Promise<ServerActionResponse<GrantTempAccessResult>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createTempAccessService();
    return await service.grant(params, adminUser.id);
  });
}

/**
 * Revoke temporary access early.
 * Requires platform admin role.
 *
 * Delegates to TempAccessService for business logic.
 */
export async function revokeTempAccess(
  params: RevokeTempAccessParams
): Promise<ServerActionResponse<RevokeTempAccessResult>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createTempAccessService();
    return await service.revoke(params, adminUser.id);
  });
}

/**
 * List all active temporary access grants.
 * Requires platform admin role.
 *
 * Delegates to TempAccessService for business logic.
 */
export async function listActiveGrants(): Promise<ServerActionResponse<ActiveGrant[]>> {
  return await withPlatformAdminCheck(async () => {
    const service = createTempAccessService();
    return await service.listActive();
  });
}
