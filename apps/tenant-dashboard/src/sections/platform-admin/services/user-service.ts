/**
 * UserService - Business logic for user management.
 * Service class with dependency injection so tests can supply their own deps.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  UserServiceDeps,
  IAuditLogService,
} from './types';
import type {
  ListUsersParams,
  UserListItem,
  UserDetail,
  PaginatedResponse,
  DeleteUserParams,
  DeleteUserResult,
} from '../../../types/platform-admin';
import { sanitizeSearchTerm } from '../utils/sanitize-search';

export class UserService {
  private db: SupabaseClient;
  private auditLog: IAuditLogService;

  constructor(deps: UserServiceDeps) {
    this.db = deps.db;
    this.auditLog = deps.auditLog;
  }

  /**
   * List all users with optional search and filters.
   */
  async list(
    params: ListUsersParams
  ): Promise<{ data?: PaginatedResponse<UserListItem>; error?: string }> {
    const {
      page = 1,
      pageSize = 25,
      search,
      hasOrganization,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = params;

    const effectivePageSize = Math.min(pageSize, 100);
    const offset = (page - 1) * effectivePageSize;

    let query = this.db
      .from('profile')
      .select(
        `
        id,
        email,
        name,
        avatar_url,
        created_at
      `,
        { count: 'exact' }
      );

    if (search) {
      const sanitized = sanitizeSearchTerm(search);
      query = query.or(`email.ilike.%${sanitized}%,name.ilike.%${sanitized}%`);
    }

    if (sortBy === 'email') {
      query = query.order('email', { ascending: sortOrder === 'asc' });
    } else if (sortBy === 'name') {
      query = query.order('name', { ascending: sortOrder === 'asc' });
    } else if (sortBy === 'created_at') {
      query = query.order('created_at', { ascending: sortOrder === 'asc' });
    }

    query = query.range(offset, offset + effectivePageSize - 1);

    const { data: profiles, error, count } = await query;

    if (error) {
      return { error: `Failed to list users: ${error.message}` };
    }

    const profileIds = profiles?.map((p) => p.id) || [];

    // Get organization counts
    const { data: memberships } = await this.db
      .from('membership')
      .select('user_id, tenant_id')
      .in('user_id', profileIds)
      .eq('status', 'active')
      .neq('role', 'disabled');

    const orgCountMap: Record<string, number> = {};
    memberships?.forEach((m) => {
      if (m.user_id) {
        orgCountMap[m.user_id] = (orgCountMap[m.user_id] || 0) + 1;
      }
    });

    // Get platform admin status
    const { data: platformRoles } = await this.db
      .from('platform_user_role')
      .select('user_id')
      .in('user_id', profileIds);

    const platformAdminSet = new Set(platformRoles?.map((pr) => pr.user_id) || []);

    // Get last sign in for only the users in this page (batch fetch, not all 1000 users)
    const lastSignInMap: Record<string, string | null> = {};
    if (profileIds.length > 0) {
      const authUserResults = await Promise.all(
        profileIds.map((id) => this.db.auth.admin.getUserById(id))
      );
      authUserResults.forEach((result) => {
        if (result.data?.user) {
          lastSignInMap[result.data.user.id] = result.data.user.last_sign_in_at || null;
        }
      });
    }

    let items: UserListItem[] = (profiles || []).map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      avatar_url: p.avatar_url,
      created_at: p.created_at || '',
      last_sign_in_at: lastSignInMap[p.id] || null,
      organization_count: orgCountMap[p.id] || 0,
      is_platform_admin: platformAdminSet.has(p.id),
    }));

    // Filter by hasOrganization if specified
    if (hasOrganization === true) {
      items = items.filter((u) => u.organization_count > 0);
    } else if (hasOrganization === false) {
      items = items.filter((u) => u.organization_count === 0);
    }

    // Sort by last_sign_in if requested
    if (sortBy === 'last_sign_in') {
      items.sort((a, b) => {
        const aTime = a.last_sign_in_at ? new Date(a.last_sign_in_at).getTime() : 0;
        const bTime = b.last_sign_in_at ? new Date(b.last_sign_in_at).getTime() : 0;
        const diff = aTime - bTime;
        return sortOrder === 'asc' ? diff : -diff;
      });
    }

    const total = count || 0;
    const totalPages = Math.ceil(total / effectivePageSize);

    return {
      data: {
        items,
        total,
        page,
        pageSize: effectivePageSize,
        totalPages,
      },
    };
  }

  /**
   * Get full details of a single user.
   */
  async getDetail(userId: string): Promise<{ data?: UserDetail; error?: string }> {
    const { data: profile, error: profileError } = await this.db
      .from('profile')
      .select(
        `
        id,
        email,
        name,
        avatar_url,
        github_username,
        created_at
      `
      )
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return { error: 'User not found' };
    }

    // Get last sign in
    const { data: authUser } = await this.db.auth.admin.getUserById(userId);
    const lastSignInAt = authUser?.user?.last_sign_in_at || null;

    // Check if platform admin
    const { data: platformRole } = await this.db
      .from('platform_user_role')
      .select('role')
      .eq('user_id', userId)
      .single();

    const isPlatformAdmin = !!platformRole;

    // Get user's organizations with roles
    const { data: userMemberships } = await this.db
      .from('membership')
      .select(
        `
        role,
        tenant_id,
        tenant:tenant!membership_tenant_id_fkey(organization_name)
      `
      )
      .eq('user_id', userId)
      .eq('status', 'active');

    // Batch fetch owner counts for all tenants where user is owner (avoid N+1)
    const ownerTenantIds = (userMemberships || [])
      .filter((m) => m.role === 'owner' && m.tenant_id)
      .map((m) => m.tenant_id);

    const ownerCountMap: Record<string, number> = {};
    if (ownerTenantIds.length > 0) {
      const { data: ownerMemberships } = await this.db
        .from('membership')
        .select('tenant_id')
        .in('tenant_id', ownerTenantIds)
        .eq('role', 'owner')
        .eq('status', 'active');

      // Count owners per tenant
      (ownerMemberships || []).forEach((m) => {
        if (m.tenant_id) {
          ownerCountMap[m.tenant_id] = (ownerCountMap[m.tenant_id] || 0) + 1;
        }
      });
    }

    const organizations: UserDetail['organizations'] = [];

    for (const m of userMemberships || []) {
      if (!m.tenant_id) continue;

      // The join may return an array, get the first element
      const tenantData = m.tenant as unknown;
      const tenant = (Array.isArray(tenantData) ? tenantData[0] : tenantData) as { organization_name: string } | null;
      if (!tenant) continue;

      // Check if sole owner using pre-fetched counts
      const isSoleOwner = m.role === 'owner' && (ownerCountMap[m.tenant_id] || 0) === 1;

      organizations.push({
        tenant_id: m.tenant_id,
        organization_name: tenant.organization_name,
        role: m.role as 'owner' | 'admin' | 'write' | 'read' | 'disabled',
        is_sole_owner: isSoleOwner,
      });
    }

    return {
      data: {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        avatar_url: profile.avatar_url,
        github_username: profile.github_username,
        created_at: profile.created_at || '',
        last_sign_in_at: lastSignInAt,
        is_platform_admin: isPlatformAdmin,
        organizations,
      },
    };
  }

  /**
   * Delete a user and all their data.
   */
  async delete(
    params: DeleteUserParams,
    adminUserId: string
  ): Promise<{ data?: DeleteUserResult; error?: string }> {
    const { userId, confirmationEmail, acknowledgeOrphanedOrgs, reason } = params;

    // Step 1: Prevent self-deletion
    if (userId === adminUserId) {
      return { error: 'Cannot delete your own account' };
    }

    // Step 1b: Check if target user is a platform admin
    const { data: targetPlatformRole } = await this.db
      .from('platform_user_role')
      .select('role')
      .eq('user_id', userId)
      .single();

    if (targetPlatformRole) {
      return { error: 'Cannot delete platform administrators. Revoke their platform admin role first.' };
    }

    // Step 2: Verify user exists
    const { data: profile, error: profileError } = await this.db
      .from('profile')
      .select('id, email, name, avatar_url, github_username, created_at')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return { error: 'User not found' };
    }

    // Step 3: Validate confirmation email
    if (profile.email.toLowerCase() !== confirmationEmail.toLowerCase()) {
      return {
        error: `Confirmation email "${confirmationEmail}" does not match user email "${profile.email}"`,
      };
    }

    // Step 4: Get user's organizations and check for sole ownership
    const { data: userMemberships } = await this.db
      .from('membership')
      .select('tenant_id, role, tenant:tenant!membership_tenant_id_fkey(organization_name)')
      .eq('user_id', userId)
      .eq('status', 'active');

    // Batch fetch owner counts for all tenants where user is owner (avoid N+1)
    const ownerTenantIds = (userMemberships || [])
      .filter((m) => m.role === 'owner' && m.tenant_id)
      .map((m) => m.tenant_id);

    const ownerCountMap: Record<string, number> = {};
    if (ownerTenantIds.length > 0) {
      const { data: ownerMemberships } = await this.db
        .from('membership')
        .select('tenant_id')
        .in('tenant_id', ownerTenantIds)
        .eq('role', 'owner')
        .eq('status', 'active');

      (ownerMemberships || []).forEach((m) => {
        if (m.tenant_id) {
          ownerCountMap[m.tenant_id] = (ownerCountMap[m.tenant_id] || 0) + 1;
        }
      });
    }

    const soleOwnerOrgs: Array<{ tenant_id: string; organization_name: string }> = [];

    for (const m of userMemberships || []) {
      if (m.role === 'owner' && m.tenant_id && (ownerCountMap[m.tenant_id] || 0) === 1) {
        // The join may return an array, get the first element
        const tenantData = m.tenant as unknown;
        const tenant = (Array.isArray(tenantData) ? tenantData[0] : tenantData) as { organization_name: string } | null;
        if (tenant) {
          soleOwnerOrgs.push({
            tenant_id: m.tenant_id,
            organization_name: tenant.organization_name,
          });
        }
      }
    }

    // Step 5: Require acknowledgment if user is sole owner
    if (soleOwnerOrgs.length > 0 && !acknowledgeOrphanedOrgs) {
      return {
        error: `User is the sole owner of ${soleOwnerOrgs.length} organization(s): ${soleOwnerOrgs.map((o) => o.organization_name).join(', ')}. These organizations will become orphaned. Set acknowledgeOrphanedOrgs to true to proceed.`,
      };
    }

    // Step 6: Check if user was a platform admin (for audit log)
    const { data: platformRole } = await this.db
      .from('platform_user_role')
      .select('role')
      .eq('user_id', userId)
      .single();

    const isPlatformAdmin = !!platformRole;

    // Step 7: Capture before_state
    const beforeState = {
      user_id: profile.id,
      email: profile.email,
      name: profile.name,
      avatar_url: profile.avatar_url,
      github_username: profile.github_username,
      created_at: profile.created_at,
      is_platform_admin: isPlatformAdmin,
      organization_count: userMemberships?.length || 0,
      sole_owner_orgs: soleOwnerOrgs.map((o) => o.organization_name),
    };

    // Step 8: Delete from auth.users (cascades to all related tables)
    const { error: deleteAuthError } = await this.db.auth.admin.deleteUser(userId);

    if (deleteAuthError) {
      console.error('Failed to delete user:', deleteAuthError);
      return { error: `Failed to delete user: ${deleteAuthError.message}` };
    }

    // Step 9: Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'user_delete',
      targetType: 'profile',
      targetId: userId,
      targetIdentifier: profile.email,
      details: {
        reason: reason || null,
        was_platform_admin: isPlatformAdmin,
        organizations_orphaned: soleOwnerOrgs.map((o) => o.organization_name),
        organizations_removed: userMemberships?.length || 0,
      },
      beforeState,
      afterState: null,
    });

    return {
      data: {
        deleted: true,
        organizationsOrphaned: soleOwnerOrgs.map((o) => o.organization_name),
      },
    };
  }
}
