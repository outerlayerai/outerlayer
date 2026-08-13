import "server-only";

import { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { UserRole, UserRoleEnum } from "@/lib/adapters/user-role";
import { EmailService, RateLimitService, StripeService } from "@/lib/external-services";
import { EmailType } from "../../utils/email";
import { EntitlementService, buildDeniedInfo } from "@/lib/system/entitlement-service";
// EE import (one-way, documented in ee/README.md): the invite flow delegates
// per-app role assignment to the EE service; on unlicensed deployments it
// returns entitlement_denied and invites proceed without app roles.
import { AppMemberRoleService } from "@ee/features/app-access/app-member-role-service";
import { AuditLogService, captureRequestContext } from "@/lib/system/audit-log";
import { serverLogger } from "@/lib/observability/server-logger";

const emailSchema = z.string().min(1).email();

export interface MembershipServiceConfig {
  supabaseAdmin: SupabaseClient;
  supabaseServer: SupabaseClient;
  emailService: EmailService;
  rateLimitService: RateLimitService;
  stripeService: StripeService;
}

export interface InviteResult {
  success: boolean;
  error?: string;
  entitlement?: import("@/config/entitlements").EntitlementDeniedInfo;
  membershipId?: string;
}

const MAX_ORGANIZATIONS_PER_USER = 10;
const INVITATION_EXPIRY_DAYS = 7;

// ============================================================================
// Membership Service
// ============================================================================

export class MembershipService {
  private supabaseAdmin: SupabaseClient;
  private supabaseServer: SupabaseClient;
  private emailService: EmailService;
  private rateLimitService: RateLimitService;
  private auditLog: AuditLogService;

  constructor(config: MembershipServiceConfig) {
    this.supabaseAdmin = config.supabaseAdmin;
    this.supabaseServer = config.supabaseServer;
    this.emailService = config.emailService;
    this.rateLimitService = config.rateLimitService;
    this.auditLog = new AuditLogService({ db: config.supabaseAdmin });
  }

  /**
   * The actor's built-in org role, read table-driven from their active
   * membership in the resolved tenant — not the JWT claim, which can be stale or
   * name a different tenant's role. Owner is always a built-in role, so a null
   * or non-owner result is a non-owner for gate purposes.
   */
  private async actorOrgRole(userId: string, tenantId: string): Promise<string | null> {
    const { data } = await this.supabaseAdmin
      .from("membership")
      .select("role")
      .eq("user_id", userId)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();
    return (data?.role as string | undefined) ?? null;
  }

  /**
   * Send invitation to a user (handles both new and existing users)
   */
  async sendInvite(params: {
    adminUser: User;
    tenantId: string;
    name: string;
    email: string;
    role: UserRole;
    origin: string;
    appRoles?: Array<{ appId: string; role: 'read' | 'write' | 'admin' }>;
  }): Promise<InviteResult> {
    const { adminUser, tenantId, name, email, role, origin, appRoles } = params;

    // Validate email format
    try {
      emailSchema.parse(email);
    } catch {
      return { success: false, error: "Invalid email format" };
    }

    // Only owners can invite users as owners
    if (
      role === UserRoleEnum.OWNER &&
      (await this.actorOrgRole(adminUser.id, tenantId)) !== UserRoleEnum.OWNER
    ) {
      return { success: false, error: "Only owners can invite users as owners" };
    }

    // Rate limit check
    const { success: rateLimitSuccess } = await this.rateLimitService.limit(
      `${tenantId}-${email}-send-invite`
    );
    if (!rateLimitSuccess) {
      return {
        success: false,
        error: "An email was just recently sent. Please wait longer before trying to send another email",
      };
    }

    // Check user entitlement limit (count active + pending to prevent over-inviting)
    const { count: userCount } = await this.supabaseAdmin
      .from("membership")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["active", "pending"])
      .neq("role", "disabled");

    const entitlementService = new EntitlementService({ db: this.supabaseAdmin });
    const limitResult = await entitlementService.checkLimit(tenantId, 'max_users', userCount ?? 0);

    if (!limitResult.allowed) {
      return {
        success: false,
        error: 'entitlement_denied',
        entitlement: buildDeniedInfo('max_users', limitResult),
      } as InviteResult;
    }

    // Get tenant info
    const { data: tenant, error: tenantError } = await this.supabaseAdmin
      .from("tenant")
      .select("company_name")
      .eq("tenant_id", tenantId)
      .single();

    if (tenantError || !tenant) {
      return { success: false, error: tenantError?.message || "Tenant not found" };
    }

    // Check if user already exists
    const { data: existingProfile } = await this.supabaseAdmin
      .from("profile")
      .select("id")
      .eq("email", email)
      .single();

    let result: InviteResult;

    if (existingProfile) {
      result = await this.inviteExistingUser({
        existingUserId: existingProfile.id,
        tenantId,
        invitedBy: adminUser.id,
        role,
        email,
        companyName: tenant.company_name,
        origin,
      });
    } else {
      // New user flow
      result = await this.inviteNewUser({
        adminUser,
        name,
        email,
        role,
        tenantId,
        companyName: tenant.company_name,
        origin,
      });
    }

    // NOTE: the member_invited audit row is written atomically INSIDE the
    // invite transaction functions (03-functions-transactions.sql), not here.

    // Assign per-app roles if invitation succeeded, roles provided, and entitlement active
    if (result.success && result.membershipId && appRoles && appRoles.length > 0) {
      try {
        const entitlementService = new EntitlementService({ db: this.supabaseAdmin });
        const hasEntitlement = await entitlementService.canAccess(tenantId, 'app_level_roles');

        if (!hasEntitlement) {
          return {
            success: false,
            error: 'entitlement_denied',
            entitlement: buildDeniedInfo('app_level_roles', {
              allowed: false,
              limit: 0,
              currentCount: 0,
              requiredTier: 'team',
            }),
          };
        }

        const appRoleService = new AppMemberRoleService({
          db: this.supabaseAdmin,
          actorId: adminUser.id,
        });
        const bulkResult = await appRoleService.bulkAssign(tenantId, {
          membershipId: result.membershipId,
          assignments: appRoles,
        });

        if (!bulkResult.success) {
          await serverLogger.error(
            new Error("Failed to assign app-level roles during invite"),
            { tenantId, membershipId: result.membershipId, appRoles, error: bulkResult.error }
          );
          return {
            success: false,
            error: "User was invited but app-level role assignments failed. Please assign app roles manually in Settings > App Access.",
            membershipId: result.membershipId,
          };
        }

        if (bulkResult.data.errors.length > 0) {
          const failedApps = bulkResult.data.errors.map((e) => e.appId).join(', ');
          await serverLogger.error(
            new Error("Partial failure assigning app-level roles during invite"),
            { tenantId, membershipId: result.membershipId, errors: bulkResult.data.errors }
          );
          return {
            success: false,
            error: `User was invited but some app role assignments failed (${failedApps}). Please review in Settings > App Access.`,
            membershipId: result.membershipId,
          };
        }
      } catch (error) {
        await serverLogger.error(
          new Error("Failed to assign app-level roles during invite"),
          { tenantId, membershipId: result.membershipId, appRoles, error }
        );
        return {
          success: false,
          error: "User was invited but app-level role assignments failed. Please assign app roles manually in Settings > App Access.",
          membershipId: result.membershipId,
        };
      }
    }

    return result;
  }

  private async inviteExistingUser(params: {
    existingUserId: string;
    tenantId: string;
    invitedBy: string;
    role: UserRole;
    email: string;
    companyName: string;
    origin: string;
  }): Promise<InviteResult> {
    const { existingUserId, tenantId, invitedBy, role, email, companyName, origin } = params;

    // Check if user already has a membership in this tenant
    const { data: existingMembership } = await this.supabaseAdmin
      .from("membership")
      .select("id, role")
      .eq("user_id", existingUserId)
      .eq("tenant_id", tenantId)
      .single();

    if (existingMembership) {
      if (existingMembership.role === UserRoleEnum.DISABLED) {
        return { success: false, error: "This user was previously disabled in this organization" };
      }
      return { success: false, error: "User is already a member of this organization" };
    }

    // Check org limit for the user being invited
    const { count: userOrgCount } = await this.supabaseAdmin
      .from("membership")
      .select("*", { count: "exact", head: true })
      .eq("user_id", existingUserId);

    if (userOrgCount && userOrgCount >= MAX_ORGANIZATIONS_PER_USER) {
      return { success: false, error: "User has reached the maximum of 10 organizations" };
    }

    // Create membership atomically via stored procedure
    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const context = await captureRequestContext();
    const { data: membershipId, error: txError } = await this.supabaseAdmin.rpc(
      "invite_existing_user_transaction",
      {
        p_user_id: existingUserId,
        p_tenant_id: tenantId,
        p_invited_by: invitedBy,
        p_role: role,
        p_invited_at: invitedAt.toISOString(),
        p_expires_at: expiresAt.toISOString(),
        p_ip_address: context.ipAddress,
        p_user_agent: context.userAgent,
        p_request_id: context.requestId,
      }
    );

    if (txError) {
      return { success: false, error: txError.message };
    }

    // Send email
    const inviteLink = `${origin}/auth/accept-invite?id=${membershipId}`;
    const emailResult = await this.emailService.sendEmail({
      emailType: EmailType.Invite,
      templateParams: { inviteLink, appUrl: origin, companyName },
      to: email,
      subject: `You've been invited to join ${companyName}`,
    });

    if (emailResult.error) {
      await serverLogger.error(new Error("Failed to send invitation email"), { email, companyName, emailError: emailResult.error });
      return { success: false, error: "Invitation created but failed to send email. Please resend the invite." };
    }

    return { success: true, membershipId };
  }

  private async inviteNewUser(params: {
    adminUser: User;
    name: string;
    email: string;
    role: UserRole;
    tenantId: string;
    companyName: string;
    origin: string;
  }): Promise<InviteResult> {
    const { adminUser, name, email, role, tenantId, companyName, origin } = params;

    // Create user and generate invite token (does NOT send email)
    const { error: linkError, data: linkData } =
      await this.supabaseAdmin.auth.admin.generateLink({
        type: "invite",
        email,
        options: { data: { display_name: name, company_name: companyName } },
      });

    if (linkError || !linkData?.user) {
      return { success: false, error: linkError?.message || "Failed to invite user" };
    }

    const invitedUser = linkData.user;

    // Create profile, membership, and set claim atomically via stored procedure
    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const context = await captureRequestContext();
    const { data: membershipId, error: txError } = await this.supabaseAdmin.rpc(
      "invite_new_user_transaction",
      {
        p_user_id: invitedUser.id,
        p_tenant_id: tenantId,
        p_invited_by: adminUser.id,
        p_email: email,
        p_name: name,
        p_role: role,
        p_invited_at: invitedAt.toISOString(),
        p_expires_at: expiresAt.toISOString(),
        p_ip_address: context.ipAddress,
        p_user_agent: context.userAgent,
        p_request_id: context.requestId,
      }
    );

    if (txError) {
      // Cleanup: Delete the orphaned auth user since transaction failed
      await this.deleteUserWithRetry(invitedUser.id);
      return { success: false, error: txError.message };
    }

    // Send invite email with link through /auth/confirm (establishes session + activates membership).
    // flow=invite makes the new-password page render first-time-setup copy
    // instead of the password-reset copy; the param must be encoded so it
    // stays inside `next` rather than becoming a param of /auth/confirm.
    const inviteLink = `${origin}/auth/confirm?token_hash=${linkData.properties.hashed_token}&type=invite&next=${encodeURIComponent("/auth/new-password?flow=invite")}`;
    const emailResult = await this.emailService.sendEmail({
      emailType: EmailType.Invite,
      templateParams: { inviteLink, appUrl: origin, companyName },
      to: email,
      subject: `You've been invited to join ${companyName}`,
    });

    if (emailResult.error) {
      await serverLogger.error(new Error("Failed to send invitation email"), { email, companyName, emailError: emailResult.error });
      return { success: false, error: "Invitation created but failed to send email. Please resend the invite." };
    }

    return { success: true, membershipId };
  }

  /**
   * Change a user's role in the organization
   */
  async changeUserRole(params: {
    adminUser: User;
    tenantId: string;
    targetUserId: string;
    newRole: UserRole;
    customRoleId?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    const { adminUser, tenantId, targetUserId, newRole, customRoleId } = params;
    const actorRole = await this.actorOrgRole(adminUser.id, tenantId);

    // Get target user's current role from membership (include pending to allow role changes on invited users)
    const { data: prevMembership, error: prevMembershipError } = await this.supabaseAdmin
      .from("membership")
      .select("id, role, custom_role_id")
      .eq("user_id", targetUserId)
      .eq("tenant_id", tenantId)
      .in("status", ["active", "pending"])
      .single();

    if (prevMembershipError || !prevMembership) {
      return { success: false, error: "User not found in organization" };
    }

    // Only owners can promote to owner
    if (newRole === UserRoleEnum.OWNER && actorRole !== UserRoleEnum.OWNER) {
      return { success: false, error: "Only owners can promote users to owner role" };
    }

    // Protect last owner
    if (prevMembership.role === UserRoleEnum.OWNER && newRole !== UserRoleEnum.OWNER) {
      const { count: ownerCount } = await this.supabaseAdmin
        .from("membership")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("role", UserRoleEnum.OWNER)
        .eq("status", "active");

      if (ownerCount && ownerCount <= 1) {
        return { success: false, error: "Cannot demote the last owner. Transfer ownership first." };
      }

      if (actorRole !== UserRoleEnum.OWNER) {
        return { success: false, error: "Only owners can change another owner's role" };
      }
    }

    // Apply the change and its audit row atomically (they commit or roll back
    // together — see change_member_role_transaction). Assigning a custom role
    // sets custom_role_id and pins role to the 'read' built-in fallback;
    // otherwise the explicit built-in role is applied and any custom role is
    // cleared. "Custom active" is custom_role_id IS NOT NULL, not a role value.
    const context = await captureRequestContext();
    const { error: updateUserError } = await this.supabaseAdmin.rpc(
      "change_member_role_transaction",
      {
        p_tenant_id: tenantId,
        p_target_user_id: targetUserId,
        p_actor_id: adminUser.id,
        p_new_role: customRoleId ? null : newRole,
        p_custom_role_id: customRoleId ?? null,
        p_ip_address: context.ipAddress,
        p_user_agent: context.userAgent,
        p_request_id: context.requestId,
      }
    );

    if (updateUserError) {
      return { success: false, error: updateUserError.message };
    }

    // Send email notification
    await this.sendRoleChangedEmail({
      targetUserId,
      tenantId,
      oldRole: prevMembership.role,
      newRole,
    });

    return { success: true };
  }

  /**
   * Remove a user from the organization
   */
  async removeUserFromOrg(params: {
    adminUser: User;
    tenantId: string;
    targetUserId: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { adminUser, tenantId, targetUserId } = params;

    // Get target user's role from membership (include pending to allow removing invited users)
    const { data: membership, error: membershipError } = await this.supabaseAdmin
      .from("membership")
      .select("id, role, status")
      .eq("user_id", targetUserId)
      .eq("tenant_id", tenantId)
      .in("status", ["active", "pending"])
      .single();

    if (membershipError || !membership) {
      return { success: false, error: "User not found in organization" };
    }

    // Protect last owner
    if (membership.role === UserRoleEnum.OWNER) {
      const { count: ownerCount } = await this.supabaseAdmin
        .from("membership")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("role", UserRoleEnum.OWNER)
        .eq("status", "active");

      if (ownerCount && ownerCount <= 1) {
        return { success: false, error: "Cannot remove the last owner from the organization" };
      }

      if ((await this.actorOrgRole(adminUser.id, tenantId)) !== UserRoleEnum.OWNER) {
        return { success: false, error: "Only owners can remove other owners" };
      }
    }

    // Get user email before deletion (for notification)
    const { data: userProfile } = await this.supabaseAdmin
      .from("profile")
      .select("email")
      .eq("id", targetUserId)
      .single();

    // Get org name for notification
    const { data: tenant } = await this.supabaseAdmin
      .from("tenant")
      .select("organization_name")
      .eq("tenant_id", tenantId)
      .single();

    // Delete the membership and write its audit row atomically (they commit
    // or roll back together — see remove_member_transaction).
    const context = await captureRequestContext();
    const { error: membershipDeleteError } = await this.supabaseAdmin.rpc(
      "remove_member_transaction",
      {
        p_tenant_id: tenantId,
        p_target_user_id: targetUserId,
        p_actor_id: adminUser.id,
        p_ip_address: context.ipAddress,
        p_user_agent: context.userAgent,
        p_request_id: context.requestId,
      }
    );

    if (membershipDeleteError) {
      return { success: false, error: membershipDeleteError.message };
    }

    // Send email notification
    if (userProfile?.email && tenant?.organization_name) {
      await this.sendRemovedFromOrgEmail({
        email: userProfile.email,
        orgName: tenant.organization_name,
      });
    }

    return { success: true };
  }

  // Users cannot voluntarily leave organizations. Only admins can remove users
  // via the removeUserFromOrg method.

  /**
   * Resend invitation link to a user
   */
  async resendInviteLink(params: {
    adminUser: User;
    tenantId: string;
    email: string;
    origin: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { adminUser, tenantId, email, origin } = params;

    // Rate limit check
    const { success: rateLimitSuccess } = await this.rateLimitService.limit(
      `${tenantId}-${email}-send-invite`
    );
    if (!rateLimitSuccess) {
      return {
        success: false,
        error: "An email was just recently sent. Please wait longer before trying to send another email",
      };
    }

    // Get the profile (use admin client to bypass RLS - pending users may not be visible via RLS)
    const { data: invitedUserProfile } = await this.supabaseAdmin
      .from("profile")
      .select("id")
      .eq("email", email)
      .single();

    if (!invitedUserProfile) {
      return { success: false, error: "User not found" };
    }

    // Verify the user has a membership in the current tenant
    const { data: membership } = await this.supabaseAdmin
      .from("membership")
      .select("id, status")
      .eq("user_id", invitedUserProfile.id)
      .eq("tenant_id", tenantId)
      .single();

    if (!membership) {
      return { success: false, error: "User is not a member of this organization" };
    }

    // Get auth user to check if confirmed
    const { data: invitedUser } = await this.supabaseAdmin.auth.admin.getUserById(
      invitedUserProfile.id
    );

    if (!invitedUser.user) {
      return { success: false, error: "User not found" };
    }

    // Get tenant info for email
    const { data: tenant } = await this.supabaseServer
      .from("tenant")
      .select("company_name")
      .single();

    const companyName = tenant?.company_name || "an organization";

    if (invitedUser.user.confirmed_at) {
      // Existing confirmed user - check for pending membership
      if (membership.status !== "pending") {
        return { success: false, error: "No pending invitation found for this user" };
      }

      // Update expires_at to extend the invitation
      const newExpiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      await this.supabaseAdmin
        .from("membership")
        .update({ expires_at: newExpiresAt.toISOString() })
        .eq("id", membership.id);

      // Send accept-invite email
      const inviteLink = `${origin}/auth/accept-invite?id=${membership.id}`;

      const emailResult = await this.emailService.sendEmail({
        emailType: EmailType.Invite,
        templateParams: { inviteLink, appUrl: origin, companyName },
        to: email,
        subject: `You've been invited to join ${companyName}`,
      });

      if (emailResult.error) {
        return { success: false, error: "Failed to send email" };
      }

      await this.auditLog.create({
        tenantId,
        actorId: adminUser.id,
        actionType: 'invite_resent',
        targetType: 'membership',
        targetId: membership.id,
        targetIdentifier: email,
        details: { expires_at: newExpiresAt.toISOString() },
      });

      return { success: true };
    }

    // New user flow - generate auth invite link
    const { error: linkError, data: linkData } = await this.supabaseAdmin.auth.admin.generateLink({
      email,
      type: "invite",
    });

    if (linkError) {
      return { success: false, error: linkError.message };
    }

    const inviteLink = `${origin}/auth/confirm?token_hash=${linkData.properties.hashed_token}&type=invite&next=${encodeURIComponent("/auth/new-password?flow=invite")}`;

    const emailResult = await this.emailService.sendEmail({
      emailType: EmailType.Invite,
      templateParams: { inviteLink, appUrl: origin, companyName },
      to: email,
      subject: "You've been invited",
    });

    if (emailResult.error) {
      return { success: false, error: "Failed to send email" };
    }

    await this.auditLog.create({
      tenantId,
      actorId: adminUser.id,
      actionType: 'invite_resent',
      targetType: 'membership',
      targetId: membership.id,
      targetIdentifier: email,
    });

    return { success: true };
  }

  private async sendRoleChangedEmail(params: {
    targetUserId: string;
    tenantId: string;
    oldRole: string;
    newRole: string;
  }): Promise<void> {
    const { targetUserId, tenantId, oldRole, newRole } = params;

    try {
      // Get user email
      const { data: userProfile } = await this.supabaseAdmin
        .from("profile")
        .select("email")
        .eq("id", targetUserId)
        .single();

      if (!userProfile?.email) {
        console.error("Failed to get user email for role change notification");
        return;
      }

      // Get org name
      const { data: tenant } = await this.supabaseAdmin
        .from("tenant")
        .select("organization_name")
        .eq("tenant_id", tenantId)
        .single();

      if (!tenant?.organization_name) {
        console.error("Failed to get org name for role change notification");
        return;
      }

      const appUrl = process.env.NODE_ENV === "production"
        ? "https://app.agentmark.co"
        : "http://localhost:3002";

      await this.emailService.sendEmail({
        emailType: EmailType.RoleChanged,
        templateParams: {
          appUrl,
          orgName: tenant.organization_name,
          oldRole,
          newRole,
        },
        to: userProfile.email,
        subject: `Your role has been updated in ${tenant.organization_name}`,
      });
    } catch (error) {
      console.error("Failed to send role change email:", error);
    }
  }

  private async sendRemovedFromOrgEmail(params: {
    email: string;
    orgName: string;
  }): Promise<void> {
    const { email, orgName } = params;

    try {
      const appUrl = process.env.NODE_ENV === "production"
        ? "https://app.agentmark.co"
        : "http://localhost:3002";

      await this.emailService.sendEmail({
        emailType: EmailType.RemovedFromOrg,
        templateParams: {
          appUrl,
          orgName,
        },
        to: email,
        subject: `You have been removed from ${orgName}`,
      });
    } catch (error) {
      console.error("Failed to send removal email:", error);
    }
  }

  /**
   * Delete a user with retry logic for cleanup operations
   */
  private async deleteUserWithRetry(
    userId: string,
    maxRetries: number = 3
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // auth-js REPORTS HTTP failures via the returned `error` field rather
      // than throwing, so both channels must count as a failed attempt —
      // catching alone would end the loop after one silent miss.
      let failure: unknown = null;
      try {
        const { error } = await this.supabaseAdmin.auth.admin.deleteUser(userId);
        if (!error) return;
        failure = error;
      } catch (error) {
        failure = error;
      }
      if (attempt === maxRetries) {
        console.error(
          `Failed to cleanup orphaned auth user after ${maxRetries} attempts:`,
          { userId, error: failure }
        );
        return;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      const delay = 100 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
