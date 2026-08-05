import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EntitlementService, buildDeniedInfo } from '@/lib/system/entitlement-service';
import { AuditLogService } from '@/lib/system/audit-log';
import { logServerError } from '@/lib/adapters';
import type {
  CreateCustomRoleInput,
  UpdateCustomRoleInput,
  CustomRoleWithPermissions,
  CustomRoleDetail,
} from '@/types/custom-role';
import type { EntitlementDeniedInfo } from '@/config/entitlements';

interface CustomRoleServiceDeps {
  db: SupabaseClient;
  adminDb: SupabaseClient;
  /** Profile id of the acting user, recorded on rbac_audit_log rows. */
  actorId?: string;
}

type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; entitlement?: EntitlementDeniedInfo };

// ============================================================================
// Validation Schemas
// ============================================================================

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Role name is required')
  .max(100, 'Role name must be 100 characters or less')
  .regex(/^[a-zA-Z0-9-]+$/, 'Role name can only contain letters, numbers, and dashes');

const descriptionSchema = z
  .string()
  .max(500, 'Role description must be 500 characters or less')
  .nullable()
  .optional();

const permissionsSchema = z
  .array(z.string().min(1))
  .min(1, 'At least one permission is required');

const createSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  permissions: permissionsSchema,
});

const updateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Role name is required')
    .max(100, 'Role name must be 100 characters or less')
    .regex(/^[a-zA-Z0-9-]+$/, 'Role name can only contain letters, numbers, and dashes')
    .optional(),
  description: descriptionSchema,
  permissions: z
    .array(z.string().min(1))
    .min(1, 'At least one permission is required')
    .optional(),
});

/** First human-readable message from a validation failure (ZodError.message is a JSON blob). */
function zodErrorMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues[0]?.message ?? 'Invalid input';
  return e instanceof Error ? e.message : String(e);
}

// ============================================================================
// Custom Role Service
// ============================================================================

export class CustomRoleService {
  private db: SupabaseClient;
  private adminDb: SupabaseClient;
  private actorId: string | null;
  private auditLog: AuditLogService;

  constructor(deps: CustomRoleServiceDeps) {
    this.db = deps.db;
    this.adminDb = deps.adminDb;
    this.actorId = deps.actorId ?? null;
    this.auditLog = new AuditLogService({ db: deps.adminDb });
  }

  // ── Entitlement gate ────────────────────────────────────────────────

  private async checkEntitlement(
    tenantId: string,
  ): Promise<{ allowed: boolean; denied?: EntitlementDeniedInfo }> {
    const entitlementService = new EntitlementService({ db: this.adminDb });
    const allowed = await entitlementService.canAccess(tenantId, 'custom_roles');
    if (allowed) return { allowed: true };

    const deniedInfo = buildDeniedInfo('custom_roles', {
      allowed: false,
      limit: 0,
      currentCount: 0,
      requiredTier: 'team',
    });
    return { allowed: false, denied: deniedInfo };
  }

  // ── Mutations (create, update, delete check entitlement) ──────────

  async create(
    tenantId: string,
    input: CreateCustomRoleInput,
  ): Promise<ServiceResult<CustomRoleWithPermissions>> {
    // Validate
    try {
      createSchema.parse(input);
    } catch (e: unknown) {
      return { success: false, error: zodErrorMessage(e) };
    }

    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    const name = input.name.trim();

    // Insert custom role
    const { data: role, error: roleError } = await this.db
      .from('custom_role')
      .insert({ tenant_id: tenantId, name, description: input.description || null })
      .select()
      .single();

    if (roleError) {
      if (roleError.code === '23505') {
        return { success: false, error: 'A role with this name already exists' };
      }
      return { success: false, error: roleError.message };
    }

    // Insert permissions
    const permissionRows = input.permissions.map((permission) => ({
      custom_role_id: role.id,
      permission,
    }));

    const { error: permError } = await this.db
      .from('custom_role_permission')
      .insert(permissionRows);

    if (permError) {
      // Cleanup role if permissions fail — log if cleanup itself fails
      const { error: cleanupError } = await this.adminDb
        .from('custom_role')
        .delete()
        .eq('id', role.id);
      if (cleanupError) {
        void logServerError(new Error(cleanupError.message), {
          operation: 'CustomRoleService.create.orphanCleanup',
          roleId: role.id,
        });
      }
      return { success: false, error: permError.message };
    }

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'custom_role_created',
      targetType: 'custom_role',
      targetId: role.id,
      targetIdentifier: name,
      afterState: {
        name,
        description: input.description || null,
        permissions: input.permissions,
      },
    });

    return {
      success: true,
      data: {
        ...role,
        permissions: input.permissions,
        memberCount: 0,
      },
    };
  }

  // ── Queries ─────────────────────────────────────────────────────────

  async getAll(tenantId: string): Promise<ServiceResult<CustomRoleWithPermissions[]>> {
    // Fetch roles
    const { data: roles, error: rolesError } = await this.db
      .from('custom_role')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (rolesError) return { success: false, error: rolesError.message };
    if (!roles || roles.length === 0) return { success: true, data: [] };

    // Fetch permissions for all roles
    const roleIds = roles.map((r: Record<string, unknown>) => r.id as string);
    const { data: permissions, error: permError } = await this.db
      .from('custom_role_permission')
      .select('custom_role_id, permission')
      .in('custom_role_id', roleIds);

    if (permError) return { success: false, error: `Failed to load role permissions: ${permError.message}` };

    // Fetch member counts
    const { data: memberCounts, error: memberError } = await this.adminDb
      .from('membership')
      .select('custom_role_id')
      .in('custom_role_id', roleIds)
      .not('custom_role_id', 'is', null);

    if (memberError) return { success: false, error: `Failed to load member counts: ${memberError.message}` };

    // Build permission map
    const permMap = new Map<string, string[]>();
    (permissions || []).forEach((p: Record<string, unknown>) => {
      const roleId = p.custom_role_id as string;
      const arr = permMap.get(roleId) || [];
      arr.push(p.permission as string);
      permMap.set(roleId, arr);
    });

    // Build member count map
    const countMap = new Map<string, number>();
    (memberCounts || []).forEach((m: Record<string, unknown>) => {
      const roleId = m.custom_role_id as string;
      countMap.set(roleId, (countMap.get(roleId) || 0) + 1);
    });

    return {
      success: true,
      data: roles.map((r: Record<string, unknown>) => ({
        ...(r as Record<string, unknown>),
        permissions: permMap.get(r.id as string) || [],
        memberCount: countMap.get(r.id as string) || 0,
      })) as CustomRoleWithPermissions[],
    };
  }

  async getById(
    tenantId: string,
    customRoleId: string,
  ): Promise<ServiceResult<CustomRoleDetail>> {
    const { data: role, error: roleError } = await this.db
      .from('custom_role')
      .select('*')
      .eq('id', customRoleId)
      .eq('tenant_id', tenantId)
      .single();

    if (roleError) return { success: false, error: roleError.message };

    // Fetch permissions
    const { data: permissions, error: permError } = await this.db
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRoleId);

    if (permError) return { success: false, error: `Failed to load permissions: ${permError.message}` };

    // Fetch assigned members
    const { data: memberships, error: memberError } = await this.adminDb
      .from('membership')
      .select('id, user_id')
      .eq('custom_role_id', customRoleId);

    if (memberError) return { success: false, error: `Failed to load members: ${memberError.message}` };

    let members: Array<{ membershipId: string; userName: string; userEmail: string }> = [];
    if (memberships && memberships.length > 0) {
      const userIds = memberships.map((m: Record<string, unknown>) => m.user_id as string);
      const { data: profiles, error: profileError } = await this.adminDb
        .from('profile')
        .select('id, display_name, email')
        .in('id', userIds);

      if (profileError) {
        return { success: false, error: `Failed to load member profiles: ${profileError.message}` };
      }

      members = memberships.map((m: Record<string, unknown>) => {
        const profile = (profiles || []).find(
          (p: Record<string, unknown>) => p.id === (m.user_id as string),
        );
        return {
          membershipId: m.id as string,
          userName: (profile?.display_name as string) || 'Unknown',
          userEmail: (profile?.email as string) || '',
        };
      });
    }

    return {
      success: true,
      data: {
        ...(role as Record<string, unknown>),
        permissions: (permissions || []).map(
          (p: Record<string, unknown>) => p.permission as string,
        ),
        members,
      } as CustomRoleDetail,
    };
  }

  // ── Update ──────────────────────────────────────────────────────────

  async update(
    tenantId: string,
    customRoleId: string,
    input: UpdateCustomRoleInput,
  ): Promise<ServiceResult<CustomRoleWithPermissions>> {
    // Validate
    try {
      updateSchema.parse(input);
    } catch (e: unknown) {
      return { success: false, error: zodErrorMessage(e) };
    }

    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Pre-image for the audit trail
    const before = await this.getRoleForAudit(tenantId, customRoleId);

    // Update role metadata
    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name.trim();
    if (input.description !== undefined) updateData.description = input.description || null;

    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await this.db
        .from('custom_role')
        .update(updateData)
        .eq('id', customRoleId)
        .eq('tenant_id', tenantId);

      if (updateError) {
        if (updateError.code === '23505') {
          return { success: false, error: 'A role with this name already exists' };
        }
        return { success: false, error: updateError.message };
      }
    }

    // Replace permissions if provided
    if (input.permissions !== undefined) {
      const { error: deletePermError } = await this.db
        .from('custom_role_permission')
        .delete()
        .eq('custom_role_id', customRoleId);

      if (deletePermError) return { success: false, error: `Failed to clear existing permissions: ${deletePermError.message}` };

      const permissionRows = input.permissions.map((permission) => ({
        custom_role_id: customRoleId,
        permission,
      }));

      const { error: permError } = await this.db
        .from('custom_role_permission')
        .insert(permissionRows);

      if (permError) return { success: false, error: permError.message };
    }

    // Return updated role by fetching from getAll
    const allResult = await this.getAll(tenantId);
    if (!allResult.success) return { success: false, error: allResult.error };

    const updated = allResult.data.find((r) => r.id === customRoleId);
    if (!updated) return { success: false, error: 'Role not found after update' };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'custom_role_updated',
      targetType: 'custom_role',
      targetId: customRoleId,
      targetIdentifier: updated.name,
      beforeState: before,
      afterState: {
        name: updated.name,
        description: updated.description,
        permissions: updated.permissions,
      },
    });

    return { success: true, data: updated };
  }

  // ── Delete ──────────────────────────────────────────────────────────

  // Valid app_role enum values (from 01-types.sql): owner, admin, write, read, disabled
  // 'owner' is intentionally excluded to prevent privilege escalation
  private static ALLOWED_FALLBACK_ROLES = new Set(['admin', 'write', 'read']);

  async delete(
    tenantId: string,
    customRoleId: string,
    fallbackRole?: string,
  ): Promise<ServiceResult<{ deleted: true; membersReassigned: number }>> {
    // Validate fallback role to prevent privilege escalation (e.g. injecting 'owner')
    if (fallbackRole && !fallbackRole.startsWith('custom:')) {
      if (!CustomRoleService.ALLOWED_FALLBACK_ROLES.has(fallbackRole)) {
        return { success: false, error: `Invalid fallback role: ${fallbackRole}` };
      }
    }

    // If fallback is a custom role, verify it belongs to this tenant
    if (fallbackRole?.startsWith('custom:')) {
      const fallbackCustomRoleId = fallbackRole.replace('custom:', '');
      const { data: targetRole } = await this.db
        .from('custom_role')
        .select('id')
        .eq('id', fallbackCustomRoleId)
        .eq('tenant_id', tenantId)
        .single();

      if (!targetRole) {
        return { success: false, error: 'Fallback custom role not found in this organization' };
      }
    }

    // Count assigned members
    const { count, error: countError } = await this.adminDb
      .from('membership')
      .select('*', { count: 'exact', head: true })
      .eq('custom_role_id', customRoleId);

    if (countError) {
      return {
        success: false,
        error: 'Unable to verify member assignments before deletion. Please try again.',
      };
    }

    const memberCount = count ?? 0;

    if (memberCount > 0 && !fallbackRole) {
      return {
        success: false,
        error: `Role has ${memberCount} assigned member(s). Specify a fallback role.`,
      };
    }

    // Pre-image for the audit trail (the role row is gone after the delete)
    const before = await this.getRoleForAudit(tenantId, customRoleId);

    // Reassign members if needed
    if (memberCount > 0 && fallbackRole) {
      let reassignError;
      if (fallbackRole.startsWith('custom:')) {
        // Fallback to another custom role
        const fallbackCustomRoleId = fallbackRole.replace('custom:', '');
        const { error } = await this.adminDb
          .from('membership')
          .update({ custom_role_id: fallbackCustomRoleId })
          .eq('custom_role_id', customRoleId);
        reassignError = error;
      } else {
        // Fallback to built-in role
        const { error } = await this.adminDb
          .from('membership')
          .update({ custom_role_id: null, role: fallbackRole })
          .eq('custom_role_id', customRoleId);
        reassignError = error;
      }

      if (reassignError) {
        return {
          success: false,
          error: `Failed to reassign members before deletion: ${reassignError.message}`,
        };
      }
    }

    // Delete the custom role (cascades to custom_role_permission)
    const { error: deleteError } = await this.db
      .from('custom_role')
      .delete()
      .eq('id', customRoleId)
      .eq('tenant_id', tenantId);

    if (deleteError) return { success: false, error: deleteError.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'custom_role_deleted',
      targetType: 'custom_role',
      targetId: customRoleId,
      targetIdentifier: before?.name ?? null,
      beforeState: before,
      details: { members_reassigned: memberCount, fallback_role: fallbackRole ?? null },
    });

    return { success: true, data: { deleted: true, membersReassigned: memberCount } };
  }

  // ── Assignment ──────────────────────────────────────────────────────

  async assign(
    tenantId: string,
    membershipId: string,
    customRoleId: string,
  ): Promise<ServiceResult<{ membershipId: string; customRoleId: string }>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Verify custom role belongs to tenant
    const { data: role, error: roleLookupError } = await this.db
      .from('custom_role')
      .select('id, name')
      .eq('id', customRoleId)
      .eq('tenant_id', tenantId)
      .single();

    if (roleLookupError && roleLookupError.code !== 'PGRST116') {
      return { success: false, error: `Failed to verify custom role: ${roleLookupError.message}` };
    }
    if (!role) return { success: false, error: 'Custom role not found in this organization' };

    // Set custom_role_id on membership
    const { error } = await this.adminDb
      .from('membership')
      .update({ custom_role_id: customRoleId })
      .eq('id', membershipId)
      .eq('tenant_id', tenantId);

    if (error) return { success: false, error: error.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'custom_role_assigned',
      targetType: 'membership',
      targetId: membershipId,
      afterState: { custom_role_id: customRoleId },
      details: { custom_role_name: role.name },
    });

    return { success: true, data: { membershipId, customRoleId } };
  }

  async unassign(
    tenantId: string,
    membershipId: string,
  ): Promise<ServiceResult<{ membershipId: string; revertedToRole: string }>> {
    // Get current built-in role for response
    const { data: membership, error: membershipLookupError } = await this.adminDb
      .from('membership')
      .select('role, custom_role_id')
      .eq('id', membershipId)
      .eq('tenant_id', tenantId)
      .single();

    if (membershipLookupError && membershipLookupError.code !== 'PGRST116') {
      return { success: false, error: `Failed to retrieve membership: ${membershipLookupError.message}` };
    }
    if (!membership) return { success: false, error: 'Membership not found' };

    const { error } = await this.adminDb
      .from('membership')
      .update({ custom_role_id: null })
      .eq('id', membershipId)
      .eq('tenant_id', tenantId);

    if (error) return { success: false, error: error.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'custom_role_unassigned',
      targetType: 'membership',
      targetId: membershipId,
      beforeState: { custom_role_id: membership.custom_role_id },
      afterState: { custom_role_id: null, role: membership.role },
    });

    return {
      success: true,
      data: {
        membershipId,
        revertedToRole: membership.role as string,
      },
    };
  }

  /** Best-effort pre-image read for audit rows; never blocks the mutation. */
  private async getRoleForAudit(
    tenantId: string,
    customRoleId: string,
  ): Promise<{ name: string; description: string | null; permissions: string[] } | null> {
    const { data: role } = await this.adminDb
      .from('custom_role')
      .select('name, description')
      .eq('id', customRoleId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!role) return null;

    const { data: perms } = await this.adminDb
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRoleId);

    return {
      name: role.name as string,
      description: (role.description as string | null) ?? null,
      permissions: (perms ?? []).map((p: Record<string, unknown>) => p.permission as string),
    };
  }
}
