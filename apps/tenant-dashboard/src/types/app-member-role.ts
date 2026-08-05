/**
 * Types for the app-level roles feature.
 * Per-app role assignments linking org members to specific apps with granular roles.
 */

/** Valid per-app built-in roles (subset of app_role — owner/disabled are org-level only) */
export type AppMemberRole = "read" | "write" | "admin";

/** Database row for app_member_role table */
export interface AppMemberRoleRow {
  id: string;
  membership_id: string;
  app_id: string;
  tenant_id: string;
  /** Built-in role — always set as fallback */
  role: AppMemberRole;
  /** Custom role override — when set, app_authorize uses this instead of built-in role */
  custom_role_id: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Input for assigning a per-app built-in role */
export interface AssignAppRoleInput {
  membershipId: string;
  appId: string;
  role: AppMemberRole;
}

/** Input for assigning a per-app custom role (role is kept as fallback) */
export interface AssignAppCustomRoleInput {
  membershipId: string;
  appId: string;
  role: AppMemberRole;
  customRoleId: string;
}

/** Input for updating an existing per-app role */
export interface UpdateAppRoleInput { // eslint-disable-line import/no-unused-modules -- part of the app-role API surface
  appMemberRoleId: string;
  role: AppMemberRole;
}

/** Input for revoking a per-app role */
export interface RevokeAppRoleInput { // eslint-disable-line import/no-unused-modules -- part of the app-role API surface
  appMemberRoleId: string;
}

/** Input for bulk assigning per-app roles (invite flow + bulk management) */
export interface BulkAssignInput {
  membershipId: string;
  assignments: Array<{ appId: string; role: AppMemberRole }>;
}

/** Input for querying app roles (optional filters) */
export interface GetAppRolesInput { // eslint-disable-line import/no-unused-modules -- part of the app-role API surface
  membershipId?: string;
  appId?: string;
}

/** Enriched app role row for display (includes member + app details) */
export interface AppRoleRow { // eslint-disable-line import/no-unused-modules -- part of the app-role API surface
  id: string;
  membershipId: string;
  appId: string;
  appName: string;
  role: string;
  memberName: string;
  memberEmail: string;
  createdAt: string;
  updatedAt: string | null;
}

/** Result for bulk assign operations */
export interface BulkAssignResult {
  created: number;
  errors: Array<{ appId: string; error: string }>;
}
