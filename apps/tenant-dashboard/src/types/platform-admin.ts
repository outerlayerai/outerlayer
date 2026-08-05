/* eslint-disable import/no-unused-modules */
// Types for platform admin feature - many exports are defined for future phases
import type { ServerActionResponse } from './server-action';

// ============================================
// Platform Role Types (Orthogonal from Tenant Roles)
// ============================================

/**
 * Platform role is SEPARATE from tenant roles (app_role).
 * A user can have BOTH a platform role AND tenant roles simultaneously.
 */
export type PlatformRole = 'platform_admin';

/**
 * Platform permissions are separate from tenant permissions.
 * These control access to platform-wide admin features.
 * Uses dot notation to match app_permission convention.
 */
export type PlatformPermission =
  | 'platform.org.read'
  | 'platform.org.delete'
  | 'platform.user.read'
  | 'platform.user.delete'
  | 'platform.temp_access.grant'
  | 'platform.flag.manage'
  | 'platform.audit.read'
  | 'platform.entitlement.read'
  | 'platform.entitlement.write'
  | 'platform.entitlement.delete';

// ============================================
// Pagination
// ============================================

export interface PaginationParams {
  page: number; // 1-indexed
  pageSize: number; // Default: 25, Max: 100
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ============================================
// Audit Log Types
// ============================================

export type ActionType =
  // Platform-admin actions
  | 'org_delete'
  | 'user_delete'
  | 'temp_access_grant'
  | 'temp_access_revoke'
  | 'flag_create'
  | 'flag_update'
  | 'flag_delete'
  | 'flag_targeting_update'
  | 'platform_role_grant'
  | 'platform_role_revoke'
  | 'entitlement_tier_change'
  | 'entitlement_override_set'
  | 'entitlement_override_remove'
  // Tenant-side RBAC actions
  | 'member_invited'
  | 'invite_resent'
  | 'invite_accepted'
  | 'member_role_changed'
  | 'member_removed'
  | 'custom_role_created'
  | 'custom_role_updated'
  | 'custom_role_deleted'
  | 'custom_role_assigned'
  | 'custom_role_unassigned'
  | 'app_role_assigned'
  | 'app_role_updated'
  | 'app_role_revoked'
  | 'app_roles_bulk_assigned'
  | 'app_scope_changed'
  // API key lifecycle (keys ARE access control)
  | 'api_key_created'
  | 'api_key_updated'
  | 'api_key_deleted'
  // Denied mutation attempts (permission gates)
  | 'permission_denied';

export type TargetType =
  | 'tenant'
  | 'profile'
  | 'feature_flag'
  | 'temp_access_grant'
  | 'membership'
  | 'custom_role'
  | 'app_member_role'
  | 'api_key'
  | 'permission';

export type AuditActorType = 'human' | 'gateway' | 'api_key' | 'system' | 'webhook';

// ============================================
// Organization Types
// ============================================

export interface ListOrganizationsParams extends PaginationParams {
  search?: string;
  createdAfter?: string;
  createdBefore?: string;
  sortBy?: 'name' | 'created_at' | 'user_count';
  sortOrder?: 'asc' | 'desc';
}

export interface OrganizationListItem {
  tenant_id: string;
  company_name: string;
  organization_name: string;
  created_at: string;
  user_count: number;
  subscription_tier: string | null;
  stripe_subscription_status: string | null;
}

export interface OrganizationDetail {
  tenant_id: string;
  company_name: string;
  organization_name: string;
  created_at: string;
  created_by: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  users: Array<{
    id: string;
    email: string;
    name: string | null;
    role: 'owner' | 'admin' | 'write' | 'read' | 'disabled';
    joined_at: string;
  }>;
  apps_count: number;
  api_keys_count: number;
  billing: {
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
    tier_id: string;
    tier_display_name: string;
  } | null;
  temp_access_grants: Array<{
    id: string;
    admin_email: string;
    created_at: string;
    expires_at: string;
  }>;
  managed_deployments: Array<{
    app_id: string;
    app_name: string;
    runtime: string;
    fly_app_name: string;
    fly_machine_id: string | null;
    latest_code_status: string | null;
  }>;
}

export interface DeleteOrganizationParams {
  tenantId: string;
  confirmationName: string;
  reason?: string;
}

export interface DeleteOrganizationResult {
  deleted: true;
  stripeSubscriptionCancelled: boolean;
  apiKeyCount: number;
  userCount: number;
}

// ============================================
// User Types
// ============================================

export interface ListUsersParams extends PaginationParams {
  search?: string;
  hasOrganization?: boolean;
  sortBy?: 'email' | 'name' | 'created_at' | 'last_sign_in';
  sortOrder?: 'asc' | 'desc';
}

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  organization_count: number;
  is_platform_admin: boolean;
}

export interface UserDetail {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  github_username: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_platform_admin: boolean;
  organizations: Array<{
    tenant_id: string;
    organization_name: string;
    role: 'owner' | 'admin' | 'write' | 'read' | 'disabled';
    is_sole_owner: boolean;
  }>;
}

export interface DeleteUserParams {
  userId: string;
  confirmationEmail: string;
  acknowledgeOrphanedOrgs?: boolean;
  reason?: string;
}

export interface DeleteUserResult {
  deleted: true;
  organizationsOrphaned: string[];
}

// ============================================
// Temporary Access Types
// ============================================

export interface GrantTempAccessParams {
  tenantId: string;
  /** Required justification for the access request */
  reason: string;
  /** Admin must confirm they received customer permission before access is granted */
  customerPermissionConfirmed: boolean;
}

export interface GrantTempAccessResult {
  grantId: string;
  expiresAt: string;
}

export interface RevokeTempAccessParams {
  grantId: string;
}

export interface RevokeTempAccessResult {
  revoked: true;
  revokedAt: string;
}

export interface ActiveGrant {
  id: string;
  created_by: string;
  admin_email: string;
  admin_name: string | null;
  tenant_id: string;
  organization_name: string;
  created_at: string;
  expires_at: string;
  time_remaining_minutes: number;
}

// ============================================
// Feature Flag Types
// ============================================

export type FlagStrategy = 'global' | 'percentage' | 'targeted';

export interface FeatureFlagListItem {
  id: string;
  key: string;
  description: string | null;
  is_enabled: boolean;
  strategy: FlagStrategy;
  rollout_percentage: number;
  override_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface FeatureFlagOverride {
  id: string;
  tenant_id: string;
  organization_name: string;
  is_enabled: boolean;
  created_at: string;
}

export interface FeatureFlagDetail {
  id: string;
  key: string;
  description: string | null;
  is_enabled: boolean;
  strategy: FlagStrategy;
  rollout_percentage: number;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  overrides: FeatureFlagOverride[];
}

export interface CreateFeatureFlagParams {
  key: string;
  description?: string;
  is_enabled?: boolean;
  strategy?: FlagStrategy;
  rollout_percentage?: number;
}

export interface UpdateFeatureFlagParams {
  flagId: string;
  is_enabled?: boolean;
  strategy?: FlagStrategy;
  rollout_percentage?: number;
  description?: string;
}

export interface SetFlagOverrideParams {
  flagId: string;
  tenantId: string;
  isEnabled: boolean;
}

export interface RemoveFlagOverrideParams {
  flagId: string;
  tenantId: string;
}

// ============================================
// Audit Log Types (Viewing)
// ============================================

export interface ListAuditLogsParams extends PaginationParams {
  /**
   * Scope to one tenant's trail. The tenant-facing viewer forces this from
   * the session JWT; the platform-admin viewer omits it (all rows).
   */
  tenantId?: string;
  actorId?: string;
  actionType?: ActionType;
  targetType?: TargetType;
  targetId?: string;
  startDate?: string;
  endDate?: string;
}

export interface AuditLogListItem {
  id: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  actor_label: string | null;
  actor_email: string | null;
  actor_name: string | null;
  tenant_id: string | null;
  action_type: ActionType;
  target_type: TargetType;
  target_id: string | null;
  target_identifier: string | null;
  created_at: string;
  details_preview: string | null;
}

export interface AuditLogDetail {
  id: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  actor_label: string | null;
  actor_email: string | null;
  actor_name: string | null;
  tenant_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  action_type: ActionType;
  target_type: TargetType;
  target_id: string | null;
  target_identifier: string | null;
  details: Record<string, unknown> | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

// Re-export for convenience
export type { ServerActionResponse };
