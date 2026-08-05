'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  FeatureFlagListItem,
  FeatureFlagDetail,
  CreateFeatureFlagParams,
  UpdateFeatureFlagParams,
  SetFlagOverrideParams,
  RemoveFlagOverrideParams,
} from '../../../types/platform-admin';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createFeatureFlagService } from '../services';

/**
 * List all feature flags with their settings.
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function listFeatureFlags(): Promise<ServerActionResponse<FeatureFlagListItem[]>> {
  return await withPlatformAdminCheck(async () => {
    const service = createFeatureFlagService();
    return await service.list();
  });
}

/**
 * Get a feature flag with its override configuration.
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function getFeatureFlagDetail(
  flagId: string
): Promise<ServerActionResponse<FeatureFlagDetail>> {
  return await withPlatformAdminCheck(async () => {
    const service = createFeatureFlagService();
    return await service.getDetail(flagId);
  });
}

/**
 * Create a new feature flag.
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function createFeatureFlag(
  params: CreateFeatureFlagParams
): Promise<ServerActionResponse<{ id: string; key: string }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createFeatureFlagService();
    return await service.create(params, adminUser.id);
  });
}

/**
 * Update a feature flag's settings.
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function updateFeatureFlag(
  params: UpdateFeatureFlagParams
): Promise<ServerActionResponse<{ updated: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createFeatureFlagService();
    return await service.update(params, adminUser.id);
  });
}

/**
 * Delete a feature flag (overrides are cascade-deleted).
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function deleteFeatureFlag(
  flagId: string
): Promise<ServerActionResponse<{ deleted: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createFeatureFlagService();
    return await service.delete(flagId, adminUser.id);
  });
}

/**
 * Set an override for a specific organization (create or update).
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function setFlagOverride(
  params: SetFlagOverrideParams
): Promise<ServerActionResponse<{ set: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createFeatureFlagService();
    return await service.setOverride(params, adminUser.id);
  });
}

/**
 * Remove an override for a specific organization.
 * Requires platform admin role.
 *
 * Delegates to FeatureFlagService for business logic.
 */
export async function removeFlagOverride(
  params: RemoveFlagOverrideParams
): Promise<ServerActionResponse<{ removed: true }>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createFeatureFlagService();
    return await service.removeOverride(params, adminUser.id);
  });
}
