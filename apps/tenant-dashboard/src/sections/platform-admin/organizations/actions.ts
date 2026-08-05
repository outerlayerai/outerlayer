'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  ListOrganizationsParams,
  OrganizationListItem,
  OrganizationDetail,
  PaginatedResponse,
  DeleteOrganizationParams,
  DeleteOrganizationResult,
} from '../../../types/platform-admin';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createOrganizationService } from '../services';

/**
 * List all organizations with optional search and filters.
 * Requires platform admin role.
 *
 * Delegates to OrganizationService for business logic.
 */
export async function listOrganizations(
  params: ListOrganizationsParams
): Promise<ServerActionResponse<PaginatedResponse<OrganizationListItem>>> {
  return await withPlatformAdminCheck(async () => {
    const service = createOrganizationService();
    return await service.list(params);
  });
}

/**
 * Get full details of a single organization.
 * Requires platform admin role.
 *
 * Delegates to OrganizationService for business logic.
 */
export async function getOrganizationDetail(
  tenantId: string
): Promise<ServerActionResponse<OrganizationDetail>> {
  return await withPlatformAdminCheck(async () => {
    const service = createOrganizationService();
    return await service.getDetail(tenantId);
  });
}

/**
 * Delete an organization and all its data.
 * This is a destructive operation that:
 * - Cancels any Stripe subscription
 * - Revokes all Unkey API keys
 * - Deletes the tenant and cascades to all related data (git connections included)
 * - Creates an immutable audit log entry
 *
 * Requires platform admin role and confirmation name match.
 *
 * Delegates to OrganizationService for business logic.
 */
export async function deleteOrganization(
  params: DeleteOrganizationParams
): Promise<ServerActionResponse<DeleteOrganizationResult>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createOrganizationService();
    return await service.delete(params, adminUser.id);
  });
}
