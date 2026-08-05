import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EntitlementService, buildDeniedInfo } from '@/lib/system/entitlement-service';
import { AuditLogService } from '@/lib/system/audit-log';
import type {
  AppMemberRole,
  AppMemberRoleRow,
  AssignAppRoleInput,
  AssignAppCustomRoleInput,
  BulkAssignInput,
  BulkAssignResult,
} from '@/types/app-member-role';
import type { EntitlementDeniedInfo } from '@/config/entitlements';

interface AppMemberRoleServiceDeps {
  db: SupabaseClient;
  /** Profile id of the acting user, recorded on rbac_audit_log rows. */
  actorId?: string;
}

type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; entitlement?: EntitlementDeniedInfo };

// ============================================================================
// Validation Schemas
// ============================================================================

// Yup's .uuid() enforces strict RFC 4122 (variant nibble must be 8/9/a/b).
// PostgreSQL's uuid type accepts any 8-4-4-4-12 hex value, so we use a
// looser regex to avoid rejecting valid DB-stored UUIDs (e.g. seeded data).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_REGEX, 'Must be a valid UUID');
const roleSchema = z.enum(['read', 'write', 'admin'], {
  // Preserve the exact user-facing string the prior yup `.oneOf()` produced so
  // API error messages (asserted by the app-member-role integration test) don't
  // change across the yup→zod migration.
  message: 'role must be one of the following values: read, write, admin',
});

const assignSchema = z.object({
  membershipId: uuidSchema,
  appId: uuidSchema,
  role: roleSchema,
});

const bulkAssignSchema = z.object({
  membershipId: uuidSchema,
  assignments: z
    .array(z.object({ appId: uuidSchema, role: roleSchema }))
    .min(1, 'assignments must have at least 1 item'),
});

/** First human-readable message from a validation failure (ZodError.message is a JSON blob). */
function zodErrorMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues[0]?.message ?? 'Invalid input';
  return e instanceof Error ? e.message : String(e);
}

// ============================================================================
// App Member Role Service
// ============================================================================

export class AppMemberRoleService {
  private db: SupabaseClient;
  private actorId: string | null;
  private auditLog: AuditLogService;

  constructor(deps: AppMemberRoleServiceDeps) {
    this.db = deps.db;
    this.actorId = deps.actorId ?? null;
    this.auditLog = new AuditLogService({ db: deps.db });
  }

  // ── Entitlement gate ────────────────────────────────────────────────

  private async checkEntitlement(
    tenantId: string,
  ): Promise<{ allowed: boolean; denied?: EntitlementDeniedInfo }> {
    const entitlementService = new EntitlementService({ db: this.db });
    const allowed = await entitlementService.canAccess(tenantId, 'app_level_roles');
    if (allowed) return { allowed: true };

    const deniedInfo = buildDeniedInfo('app_level_roles', {
      allowed: false,
      limit: 0,
      currentCount: 0,
      requiredTier: 'team',
    });
    return { allowed: false, denied: deniedInfo };
  }

  // ── Owner protection ────────────────────────────────────────────────

  private async isOwner(membershipId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('membership')
      .select('role')
      .eq('id', membershipId)
      .single();
    if (error) {
      throw new Error(`Failed to check membership role: ${error.message}`);
    }
    return data?.role === 'owner';
  }

  // ── Queries ─────────────────────────────────────────────────────────

  async getByMembership(membershipId: string): Promise<AppMemberRoleRow[]> {
    const { data, error } = await this.db
      .from('app_member_role')
      .select('*')
      .eq('membership_id', membershipId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as AppMemberRoleRow[];
  }

  async getByApp(appId: string): Promise<AppMemberRoleRow[]> {
    const { data, error } = await this.db
      .from('app_member_role')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as AppMemberRoleRow[];
  }

  async getAll(tenantId: string): Promise<AppMemberRoleRow[]> {
    const { data, error } = await this.db
      .from('app_member_role')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as AppMemberRoleRow[];
  }

  async isAppScoped(membershipId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('membership')
      .select('is_app_scoped')
      .eq('id', membershipId)
      .single();

    if (error) throw new Error(error.message);
    return data?.is_app_scoped ?? false;
  }

  async setAppScoped(
    tenantId: string,
    membershipId: string,
    isAppScoped: boolean,
  ): Promise<ServiceResult<{ isAppScoped: boolean }>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Owner protection
    try {
      if (await this.isOwner(membershipId)) {
        return { success: false, error: 'Cannot restrict app access for org owners' };
      }
    } catch (e: unknown) {
      return { success: false, error: (e as Error).message };
    }

    const { error } = await this.db
      .from('membership')
      .update({ is_app_scoped: isAppScoped })
      .eq('id', membershipId)
      .eq('tenant_id', tenantId)
      .select('is_app_scoped')
      .single();

    if (error) return { success: false, error: error.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'app_scope_changed',
      targetType: 'membership',
      targetId: membershipId,
      afterState: { is_app_scoped: isAppScoped },
    });

    return { success: true, data: { isAppScoped } };
  }

  // ── Mutations (all check entitlement first) ─────────────────────────

  async assign(
    tenantId: string,
    input: AssignAppRoleInput,
  ): Promise<ServiceResult<AppMemberRoleRow>> {
    // Validate
    try {
      assignSchema.parse(input);
    } catch (e: unknown) {
      return { success: false, error: zodErrorMessage(e) };
    }

    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Owner protection
    if (await this.isOwner(input.membershipId)) {
      return { success: false, error: 'Cannot assign per-app roles to org owners' };
    }

    const { data, error } = await this.db
      .from('app_member_role')
      .insert({
        membership_id: input.membershipId,
        app_id: input.appId,
        tenant_id: tenantId,
        role: input.role,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return { success: false, error: 'Member already has a role on this app' };
      }
      return { success: false, error: error.message };
    }

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'app_role_assigned',
      targetType: 'app_member_role',
      targetId: (data as AppMemberRoleRow).id,
      afterState: { role: input.role },
      details: { app_id: input.appId, membership_id: input.membershipId },
    });

    return { success: true, data: data as AppMemberRoleRow };
  }

  async assignCustomRole(
    tenantId: string,
    input: AssignAppCustomRoleInput,
  ): Promise<ServiceResult<AppMemberRoleRow>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Owner protection
    if (await this.isOwner(input.membershipId)) {
      return { success: false, error: 'Cannot assign per-app roles to org owners' };
    }

    const { data, error } = await this.db
      .from('app_member_role')
      .insert({
        membership_id: input.membershipId,
        app_id: input.appId,
        tenant_id: tenantId,
        role: input.role,
        custom_role_id: input.customRoleId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return { success: false, error: 'Member already has a role on this app' };
      }
      return { success: false, error: error.message };
    }

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'app_role_assigned',
      targetType: 'app_member_role',
      targetId: (data as AppMemberRoleRow).id,
      afterState: { role: input.role, custom_role_id: input.customRoleId },
      details: { app_id: input.appId, membership_id: input.membershipId },
    });

    return { success: true, data: data as AppMemberRoleRow };
  }

  async bulkAssign(
    tenantId: string,
    input: BulkAssignInput,
  ): Promise<ServiceResult<BulkAssignResult>> {
    // Validate
    try {
      bulkAssignSchema.parse(input);
    } catch (e: unknown) {
      return { success: false, error: zodErrorMessage(e) };
    }

    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    // Owner protection
    if (await this.isOwner(input.membershipId)) {
      return { success: false, error: 'Cannot assign per-app roles to org owners' };
    }

    const errors: Array<{ appId: string; error: string }> = [];
    let created = 0;

    for (const assignment of input.assignments) {
      const { error } = await this.db.from('app_member_role').insert({
        membership_id: input.membershipId,
        app_id: assignment.appId,
        tenant_id: tenantId,
        role: assignment.role,
      });

      if (error) {
        errors.push({ appId: assignment.appId, error: error.message });
      } else {
        created++;
      }
    }

    if (created > 0) {
      await this.auditLog.create({
        tenantId,
        actorId: this.actorId,
        actionType: 'app_roles_bulk_assigned',
        targetType: 'app_member_role',
        afterState: { assignments: input.assignments },
        details: { membership_id: input.membershipId, created, failed: errors.length },
      });
    }

    return { success: true, data: { created, errors } };
  }

  async updateRole(
    tenantId: string,
    id: string,
    role: AppMemberRole,
  ): Promise<ServiceResult<AppMemberRoleRow>> {
    // Validate
    try {
      roleSchema.parse(role);
    } catch (e: unknown) {
      return { success: false, error: zodErrorMessage(e) };
    }

    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    const before = await this.getRowForAudit(tenantId, id);

    // Set built-in role, clear custom_role_id (mutual exclusivity)
    const { data, error } = await this.db
      .from('app_member_role')
      .update({ role, custom_role_id: null })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) return { success: false, error: error.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'app_role_updated',
      targetType: 'app_member_role',
      targetId: id,
      beforeState: before,
      afterState: { role, custom_role_id: null },
      details: before
        ? { app_id: before.app_id, membership_id: before.membership_id }
        : null,
    });

    return { success: true, data: data as AppMemberRoleRow };
  }

  async updateCustomRole(
    tenantId: string,
    id: string,
    customRoleId: string,
  ): Promise<ServiceResult<AppMemberRoleRow>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    const before = await this.getRowForAudit(tenantId, id);

    // Set custom_role_id as override (built-in role remains as fallback)
    const { data, error } = await this.db
      .from('app_member_role')
      .update({ custom_role_id: customRoleId })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) return { success: false, error: error.message };

    await this.auditLog.create({
      tenantId,
      actorId: this.actorId,
      actionType: 'app_role_updated',
      targetType: 'app_member_role',
      targetId: id,
      beforeState: before,
      afterState: { role: before?.role, custom_role_id: customRoleId },
      details: before
        ? { app_id: before.app_id, membership_id: before.membership_id }
        : null,
    });

    return { success: true, data: data as AppMemberRoleRow };
  }

  async revoke(
    tenantId: string,
    id: string,
  ): Promise<ServiceResult<{ success: boolean }>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    const { data: deleted, error } = await this.db
      .from('app_member_role')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('role, custom_role_id, app_id, membership_id');

    if (error) return { success: false, error: error.message };

    const before = deleted?.[0];
    if (before) {
      await this.auditLog.create({
        tenantId,
        actorId: this.actorId,
        actionType: 'app_role_revoked',
        targetType: 'app_member_role',
        targetId: id,
        beforeState: { role: before.role, custom_role_id: before.custom_role_id },
        details: { app_id: before.app_id, membership_id: before.membership_id },
      });
    }

    return { success: true, data: { success: true } };
  }

  async revokeAllForMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<ServiceResult<{ success: boolean }>> {
    // Entitlement gate
    const gate = await this.checkEntitlement(tenantId);
    if (!gate.allowed) {
      return { success: false, error: 'entitlement_denied', entitlement: gate.denied };
    }

    const { data: deleted, error } = await this.db
      .from('app_member_role')
      .delete()
      .eq('membership_id', membershipId)
      .eq('tenant_id', tenantId)
      .select('app_id, role');

    if (error) return { success: false, error: error.message };

    if (deleted && deleted.length > 0) {
      await this.auditLog.create({
        tenantId,
        actorId: this.actorId,
        actionType: 'app_role_revoked',
        targetType: 'app_member_role',
        beforeState: { revoked: deleted },
        details: { membership_id: membershipId, revoked_count: deleted.length },
      });
    }

    return { success: true, data: { success: true } };
  }

  /** Best-effort pre-image read for audit rows; never blocks the mutation. */
  private async getRowForAudit(
    tenantId: string,
    id: string,
  ): Promise<{ role: string; custom_role_id: string | null; app_id: string; membership_id: string } | null> {
    const { data } = await this.db
      .from('app_member_role')
      .select('role, custom_role_id, app_id, membership_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return data ?? null;
  }
}
