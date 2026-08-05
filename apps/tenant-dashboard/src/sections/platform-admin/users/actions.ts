'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  ListUsersParams,
  UserListItem,
  UserDetail,
  PaginatedResponse,
  DeleteUserParams,
  DeleteUserResult,
} from '../../../types/platform-admin';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createUserService } from '../services';

/**
 * List all users with optional search and filters.
 * Requires platform admin role.
 *
 * Delegates to UserService for business logic.
 */
export async function listUsers(
  params: ListUsersParams
): Promise<ServerActionResponse<PaginatedResponse<UserListItem>>> {
  return await withPlatformAdminCheck(async () => {
    const service = createUserService();
    return await service.list(params);
  });
}

/**
 * Get full details of a single user.
 * Requires platform admin role.
 *
 * Delegates to UserService for business logic.
 */
export async function getUserDetail(
  userId: string
): Promise<ServerActionResponse<UserDetail>> {
  return await withPlatformAdminCheck(async () => {
    const service = createUserService();
    return await service.getDetail(userId);
  });
}

/**
 * Delete a user and all their data.
 * This is a destructive operation that:
 * - Removes user from all organizations (membership)
 * - Deletes the user's profile
 * - Deletes the user from auth.users
 * - Creates an immutable audit log entry
 *
 * Warnings:
 * - Sole owner detection: If user is sole owner of any org, those orgs become orphaned
 * - Self-deletion prevention: Admin cannot delete themselves
 *
 * Requires platform admin role and confirmation email match.
 *
 * Delegates to UserService for business logic.
 */
export async function deleteUser(
  params: DeleteUserParams
): Promise<ServerActionResponse<DeleteUserResult>> {
  return await withPlatformAdminCheck(async (adminUser) => {
    const service = createUserService();
    return await service.delete(params, adminUser.id);
  });
}
