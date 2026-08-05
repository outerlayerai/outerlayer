/**
 * TempAccessService - Business logic for temporary access management.
 * Service class with dependency injection so tests can supply their own deps.
 *
 * Architecture: Membership-based temp access (role merged into membership)
 * When granting temp access:
 *   1. Insert a membership row with role='read' for the admin in the target tenant
 *   2. Create a temp_access_grant record to track expiry
 * pg_cron handles cleanup of expired grants (deletes membership).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TempAccessServiceDeps,
  EmailService,
  IAuditLogService,
} from './types';
import { EmailType } from '../../../utils/email';
import { APP_URL } from '../../../config-global';
import type {
  GrantTempAccessParams,
  GrantTempAccessResult,
  RevokeTempAccessParams,
  RevokeTempAccessResult,
  ActiveGrant,
} from '../../../types/platform-admin';

const TEMP_ACCESS_DURATION_HOURS = 24;

export class TempAccessService {
  private db: SupabaseClient;
  private emailService?: EmailService;
  private auditLog: IAuditLogService;

  constructor(deps: TempAccessServiceDeps) {
    this.db = deps.db;
    this.emailService = deps.emailService;
    this.auditLog = deps.auditLog;
  }

  /**
   * Grant temporary read-only access to an organization.
   * Inserts a membership row with role='read' and creates a temp_access_grant record.
   */
  async grant(
    params: GrantTempAccessParams,
    adminUserId: string
  ): Promise<{ data?: GrantTempAccessResult; error?: string }> {
    const { tenantId, reason, customerPermissionConfirmed } = params;

    // Step 0a: Validate reason is provided
    if (!reason || !reason.trim()) {
      return { error: 'You must provide a reason for access' };
    }

    // Step 0b: Validate customer permission confirmation
    if (!customerPermissionConfirmed) {
      return { error: 'You must confirm that you have received customer permission' };
    }

    // Step 1: Verify the tenant exists
    const { data: tenant, error: tenantError } = await this.db
      .from('tenant')
      .select('tenant_id, organization_name')
      .eq('tenant_id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return { error: 'Organization not found' };
    }

    // Step 2: Check for existing active grant
    const { data: existingGrant } = await this.db
      .from('temp_access_grant')
      .select('id')
      .eq('created_by', adminUserId)
      .eq('tenant_id', tenantId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (existingGrant) {
      return { error: 'You already have an active access grant for this organization' };
    }

    // Step 3: Check if admin already has a membership in this tenant
    const { data: existingMembership } = await this.db
      .from('membership')
      .select('id')
      .eq('user_id', adminUserId)
      .eq('tenant_id', tenantId)
      .single();

    if (existingMembership) {
      return { error: 'You already have a membership in this organization' };
    }

    // Step 4: Calculate expiry
    const expiresAt = new Date(Date.now() + TEMP_ACCESS_DURATION_HOURS * 60 * 60 * 1000);

    // Step 5: Create membership and temp_access_grant atomically via stored procedure
    const { data: grantId, error: txError } = await this.db.rpc(
      'grant_temp_access_transaction',
      {
        p_admin_user_id: adminUserId,
        p_tenant_id: tenantId,
        p_reason: reason.trim(),
        p_customer_permission_confirmed: customerPermissionConfirmed,
        p_expires_at: expiresAt.toISOString(),
      }
    );

    if (txError || !grantId) {
      return { error: `Failed to grant access: ${txError?.message}` };
    }

    const grant = { id: grantId };

    // Step 6: Send email notification to org owners
    await this.notifyOwners(tenantId, adminUserId, expiresAt.toISOString(), reason);

    // Step 7: Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'temp_access_grant',
      targetType: 'tenant',
      targetId: tenantId,
      targetIdentifier: tenant.organization_name,
      details: {
        reason: reason || null,
        expires_at: expiresAt.toISOString(),
        customer_permission_confirmed: customerPermissionConfirmed,
      },
      beforeState: null,
      afterState: {
        grant_id: grant.id,
        expires_at: expiresAt.toISOString(),
      },
    });

    return {
      data: {
        grantId: grant.id,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /**
   * Revoke temporary access early.
   * Deletes the membership row and sets revoked_at on temp_access_grant.
   */
  async revoke(
    params: RevokeTempAccessParams,
    adminUserId: string
  ): Promise<{ data?: RevokeTempAccessResult; error?: string }> {
    const { grantId } = params;

    // Step 1: Get the grant
    const { data: grant, error: grantError } = await this.db
      .from('temp_access_grant')
      .select('id, created_by, tenant_id, created_at, expires_at, revoked_at')
      .eq('id', grantId)
      .single();

    if (grantError || !grant) {
      return { error: 'Access grant not found' };
    }

    if (grant.revoked_at) {
      return { error: 'Access grant has already been revoked' };
    }

    if (new Date(grant.expires_at) <= new Date()) {
      return { error: 'Access grant has already expired' };
    }

    // Step 2: Get org name for audit log
    const { data: tenant } = await this.db
      .from('tenant')
      .select('organization_name')
      .eq('tenant_id', grant.tenant_id)
      .single();

    // Step 3: Delete the membership
    await this.db
      .from('membership')
      .delete()
      .eq('user_id', grant.created_by)
      .eq('tenant_id', grant.tenant_id);

    // Step 4: Mark grant as revoked
    const revokedAt = new Date().toISOString();
    const { error: updateError } = await this.db
      .from('temp_access_grant')
      .update({ revoked_at: revokedAt })
      .eq('id', grantId);

    if (updateError) {
      return { error: `Failed to revoke access: ${updateError.message}` };
    }

    // Step 5: Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'temp_access_revoke',
      targetType: 'tenant',
      targetId: grant.tenant_id,
      targetIdentifier: tenant?.organization_name || grant.tenant_id,
      details: {
        grant_id: grantId,
        original_expiry: grant.expires_at,
        revoked_early: true,
      },
      beforeState: {
        grant_id: grant.id,
        expires_at: grant.expires_at,
        revoked_at: null,
      },
      afterState: {
        grant_id: grant.id,
        expires_at: grant.expires_at,
        revoked_at: revokedAt,
      },
    });

    return {
      data: {
        revoked: true,
        revokedAt,
      },
    };
  }

  /**
   * List all active temporary access grants.
   */
  async listActive(): Promise<{ data?: ActiveGrant[]; error?: string }> {
    const now = new Date();

    const { data: grants, error } = await this.db
      .from('temp_access_grant')
      .select(
        `
        id,
        created_by,
        tenant_id,
        created_at,
        expires_at,
        profile:profile!temp_access_grant_created_by_fkey(email, name),
        tenant:tenant!temp_access_grant_tenant_id_fkey(organization_name)
      `
      )
      .is('revoked_at', null)
      .gt('expires_at', now.toISOString())
      .order('expires_at', { ascending: true });

    if (error) {
      return { error: `Failed to list active grants: ${error.message}` };
    }

    const activeGrants: ActiveGrant[] = (grants || []).map((g) => {
      // The join may return an array, get the first element
      const profileData = g.profile as unknown;
      const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as { email: string; name: string | null } | null;
      const tenantData = g.tenant as unknown;
      const tenant = (Array.isArray(tenantData) ? tenantData[0] : tenantData) as { organization_name: string } | null;
      const expiresAt = new Date(g.expires_at);
      // Use current time for accurate time_remaining calculation (not query start time)
      const timeRemaining = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000));

      return {
        id: g.id,
        created_by: g.created_by,
        admin_email: profile?.email || 'Unknown',
        admin_name: profile?.name || null,
        tenant_id: g.tenant_id,
        organization_name: tenant?.organization_name || 'Unknown',
        created_at: g.created_at,
        expires_at: g.expires_at,
        time_remaining_minutes: timeRemaining,
      };
    });

    return { data: activeGrants };
  }

  /**
   * Send email notifications to organization owners about temp access grant.
   */
  private async notifyOwners(
    tenantId: string,
    adminUserId: string,
    expiresAt: string,
    _reason?: string
  ): Promise<void> {
    if (!this.emailService) {
      return;
    }

    // Get admin email
    const { data: admin } = await this.db
      .from('profile')
      .select('email')
      .eq('id', adminUserId)
      .single();

    if (!admin) {
      return;
    }

    // Get org name
    const { data: tenant } = await this.db
      .from('tenant')
      .select('organization_name')
      .eq('tenant_id', tenantId)
      .single();

    if (!tenant) {
      return;
    }

    // Get org owners
    const { data: owners } = await this.db
      .from('membership')
      .select(
        `
        user_id,
        profile:profile!membership_user_id_fkey(email, name)
      `
      )
      .eq('tenant_id', tenantId)
      .eq('role', 'owner')
      .eq('status', 'active');

    if (!owners || owners.length === 0) {
      return;
    }

    // Send email to each owner
    for (const owner of owners) {
      // The join may return an array, get the first element
      const profileData = owner.profile as unknown;
      const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as { email: string; name: string | null } | null;
      if (!profile) continue;
      try {
        const { error } = await this.emailService.sendEmail({
          to: profile.email,
          subject: `Platform Admin Access Granted to ${tenant.organization_name}`,
          emailType: EmailType.TempAccessNotification,
          templateParams: {
            appUrl: APP_URL,
            organizationName: tenant.organization_name,
            adminEmail: admin.email,
            expiresAt,
          },
        });
        if (error) {
          console.error(`Failed to send temp access notification to ${profile.email}:`, error);
        }
      } catch (error) {
        console.error(`Failed to send temp access notification to ${profile.email}:`, error);
      }
    }
  }
}
