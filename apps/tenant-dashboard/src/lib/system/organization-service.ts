import "server-only";

import { SupabaseClient, User } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { serverLogger, type StripeService } from "@/lib/adapters";
import { AuditLogService } from "./audit-log";
import { captureActivationEvent } from "../posthog-server";

export interface OrganizationServiceConfig {
  supabaseAdmin: SupabaseClient;
  /**
   * Cookie-bound session client, or `null` when the caller has none to
   * offer. Only `getMembershipCount` reads it — `acceptInvitation` and
   * `getInvitationDetails` run entirely on `supabaseAdmin` for a pending
   * invitee whose membership isn't active yet, so there's no session-scoped
   * client to hand in. Required (not optional) so every construction site
   * makes that choice explicitly instead of silently omitting the field.
   */
  supabaseServer: SupabaseClient | null;
  stripeService: StripeService;
  /**
   * When false, org creation skips Stripe customer provisioning and stores a
   * null stripe_customer_id (self-hosting with billing disabled). Defaults to
   * true so the hosted flow is unchanged.
   */
  billingEnabled?: boolean;
}

export interface CreateOrgResult {
  success: boolean;
  error?: string;
  tenantId?: string;
  organizationName?: string;
}

export interface SwitchOrgResult {
  success: boolean;
  error?: string;
  tenantId?: string;
}

export interface AcceptInviteResult {
  success: boolean;
  error?: string;
  tenantId?: string;
  companyName?: string;
}

export interface InvitationDetails {
  id: string;
  companyName: string;
  organizationName: string;
  isExpired: boolean;
  expiresAt: string | null;
}

const MAX_ORGANIZATIONS = 10;

// ============================================================================
// Organization Service
// ============================================================================

export class OrganizationService {
  private supabaseAdmin: SupabaseClient;
  private supabaseServer: SupabaseClient | null;
  private stripeService: StripeService;
  private billingEnabled: boolean;
  private auditLog: AuditLogService;

  constructor(config: OrganizationServiceConfig) {
    this.supabaseAdmin = config.supabaseAdmin;
    this.supabaseServer = config.supabaseServer;
    this.stripeService = config.stripeService;
    this.billingEnabled = config.billingEnabled ?? true;
    this.auditLog = new AuditLogService({ db: config.supabaseAdmin });
  }

  /**
   * Record which organization the user last switched to. A preference write —
   * the switcher navigates to the new org's URL, which is what scopes the
   * next request.
   */
  async setLastActiveOrg(params: {
    user: User;
    tenantId: string;
  }): Promise<SwitchOrgResult> {
    const { user, tenantId } = params;

    // Verify active membership before recording the preference.
    const { data: membership, error: membershipError } = await this.supabaseAdmin
      .from("membership")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .single();

    if (membershipError || !membership) {
      return { success: false, error: "Not a member of this organization" };
    }

    const { error: updateError } = await this.supabaseAdmin
      .from("profile")
      .update({ last_active_tenant_id: tenantId })
      .eq("id", user.id);

    if (updateError) {
      return { success: false, error: updateError.message };
    }

    return { success: true, tenantId };
  }

  /**
   * Create a new organization
   *
   * Flow:
   * 1. Check org limit (app-side)
   * 2. Create Stripe customer (external service, first to allow rollback)
   * 3. Call create_organization_transaction (atomic DB: tenant + billing + membership + last-active preference)
   */
  async createOrganization(params: {
    user: User;
    organizationName: string;
    companyName: string;
  }): Promise<CreateOrgResult> {
    const { user, organizationName, companyName } = params;

    // Check org limit
    const { count, error: countError } = await this.supabaseAdmin
      .from("membership")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "active");

    if (countError) {
      return { success: false, error: countError.message };
    }

    if ((count || 0) >= MAX_ORGANIZATIONS) {
      return { success: false, error: "You cannot belong to more than 10 organizations" };
    }

    const idempotencyKey = randomUUID();

    // Step 1: Create Stripe customer (external service, created first for easy
    // rollback). Skipped when billing is disabled (self-hosting): the org is
    // created with a null stripe_customer_id and defaults to the hobby tier.
    let stripeCustomerId: string | null = null;
    if (this.billingEnabled) {
      try {
        const stripeCustomer = await this.stripeService.createCustomer(
          {
            name: user.user_metadata?.display_name || user.email || companyName,
            email: user.email || "",
            metadata: {
              organizationName,
              createdBy: user.id,
              idempotencyKey,
            },
          },
          { idempotencyKey }
        );
        stripeCustomerId = stripeCustomer.id;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        await serverLogger.error(err, { context: "Failed to create Stripe customer", userId: user.id, organizationName });
        return { success: false, error: "Failed to set up billing. Please try again." };
      }
    }

    // Step 2: Atomic DB transaction (tenant + billing + membership + claims).
    // Self-hosting (billing off) defaults new orgs to the enterprise tier so
    // entitlements resolve unlimited through the normal resolver (operators can
    // still cap a tenant via overrides). Hosted keeps the 'hobby' free default.
    const { data: txResult, error: txError } = await this.supabaseAdmin.rpc(
      "create_organization_transaction",
      {
        p_user_id: user.id,
        p_organization_name: organizationName,
        p_company_name: companyName,
        p_stripe_customer_id: stripeCustomerId,
        p_tier_id: this.billingEnabled ? "hobby" : "enterprise",
      }
    );

    if (txError) {
      // Rollback Stripe customer on DB failure (no-op when billing is disabled)
      if (stripeCustomerId) {
        await this.rollbackStripeCustomer(stripeCustomerId);
      }

      // Handle specific error types from the database transaction
      const errorText = (txError.message || "").toLowerCase();
      const errorDetails = (txError.details || "").toLowerCase();
      const errorHint = (txError.hint || "").toLowerCase();
      const errorCode = txError.code;

      // Duplicate organization name (PostgreSQL unique_violation OR explicit exception from RPC)
      if (
        errorCode === '23505' || // PostgreSQL unique constraint violation
        errorText.includes("already exists") ||
        errorText.includes("duplicate key") ||
        errorText.includes("unique constraint") ||
        errorDetails.includes("already exists") ||
        errorDetails.includes("duplicate key") ||
        errorHint.includes("already exists")
      ) {
        return { success: false, error: "Organization name is already taken" };
      }

      // Membership limit exceeded (from check_membership_limit trigger)
      if (errorText.includes("cannot belong to more than")) {
        return { success: false, error: "You cannot belong to more than 10 organizations" };
      }

      const err = new Error(txError.message || "Database transaction failed");
      await serverLogger.error(err, { context: "Failed to create organization", userId: user.id, organizationName, errorCode, errorDetails, errorHint });
      return { success: false, error: `Failed to create organization. Please try again. [${errorCode || "UNKNOWN"}: ${txError.message || "no details"}]` };
    }

    const tenantId = txResult?.tenant_id;

    void captureActivationEvent('org_provisioned', user.id, tenantId, {
      organization_name: organizationName,
    });

    return {
      success: true,
      tenantId: tenantId,
      organizationName: organizationName,
    };
  }

  /**
   * Accept an invitation to join an organization
   */
  async acceptInvitation(params: {
    user: User;
    membershipId: string;
  }): Promise<AcceptInviteResult> {
    const { user, membershipId } = params;

    // Get membership with tenant info
    const { data: membership, error: membershipError } = await this.supabaseAdmin
      .from("membership")
      .select(`
        id,
        user_id,
        tenant_id,
        status,
        expires_at,
        tenant:tenant_id (
          tenant_id,
          company_name,
          organization_name
        )
      `)
      .eq("id", membershipId)
      .single();

    if (membershipError || !membership) {
      return { success: false, error: "Invitation not found" };
    }

    // Verify invitation belongs to user. Reported identically to a
    // nonexistent membership id: a distinct message here would let an
    // authenticated caller enumerate valid membership ids by probing which
    // ones return this outcome instead of "Invitation not found".
    if (membership.user_id !== user.id) {
      void serverLogger.info("Invitation lookup denied: membership belongs to a different user", {
        membershipId,
        requestingUserId: user.id,
      });
      return { success: false, error: "Invitation not found" };
    }

    // Check if already active
    if (membership.status === "active") {
      return { success: false, error: "You are already a member of this organization" };
    }

    // Validate not expired
    if (membership.expires_at) {
      const expiresAt = new Date(membership.expires_at);
      if (expiresAt < new Date()) {
        return { success: false, error: "expired" };
      }
    }

    // Check org limit
    const { count: activeCount } = await this.supabaseAdmin
      .from("membership")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "active");

    if (activeCount && activeCount >= MAX_ORGANIZATIONS) {
      return {
        success: false,
        error: "You have reached the maximum of 10 organizations. Leave an organization to accept this invitation.",
      };
    }

    // Accept invitation
    const { error: updateError } = await this.supabaseAdmin
      .from("membership")
      .update({ status: "active", accepted_at: new Date().toISOString() })
      .eq("id", membershipId);

    if (updateError) {
      return { success: false, error: updateError.message };
    }

    const tenant = membership.tenant as unknown as { tenant_id: string; company_name: string; organization_name: string };

    await this.auditLog.create({
      tenantId: membership.tenant_id,
      actorId: user.id,
      actionType: 'invite_accepted',
      targetType: 'membership',
      targetId: membershipId,
      targetIdentifier: user.email ?? null,
      beforeState: { status: 'pending' },
      afterState: { status: 'active' },
    });

    return {
      success: true,
      tenantId: tenant.tenant_id,
      companyName: tenant.company_name,
    };
  }

  /**
   * Get invitation details for display
   */
  async getInvitationDetails(params: {
    user: User;
    membershipId: string;
  }): Promise<{ success: boolean; error?: string; data?: InvitationDetails }> {
    const { user, membershipId } = params;

    const { data: membership, error: membershipError } = await this.supabaseAdmin
      .from("membership")
      .select(`
        id,
        user_id,
        status,
        expires_at,
        tenant:tenant_id (
          company_name,
          organization_name
        )
      `)
      .eq("id", membershipId)
      .single();

    if (membershipError || !membership) {
      return { success: false, error: "Invitation not found" };
    }

    // Same collapse as `acceptInvitation`: a mismatched owner reports
    // identically to a nonexistent membership id so neither outcome is an
    // enumeration oracle for valid membership ids.
    if (membership.user_id !== user.id) {
      void serverLogger.info("Invitation lookup denied: membership belongs to a different user", {
        membershipId,
        requestingUserId: user.id,
      });
      return { success: false, error: "Invitation not found" };
    }

    if (membership.status === "active") {
      return { success: false, error: "already_accepted" };
    }

    const tenant = membership.tenant as unknown as { company_name: string; organization_name: string };
    const isExpired = membership.expires_at ? new Date(membership.expires_at) < new Date() : false;

    return {
      success: true,
      data: {
        id: membership.id,
        companyName: tenant.company_name,
        organizationName: tenant.organization_name,
        isExpired,
        expiresAt: membership.expires_at,
      },
    };
  }

  /**
   * Get count of active memberships for a user
   */
  async getMembershipCount(user: User): Promise<{ success: boolean; error?: string; count?: number }> {
    if (!this.supabaseServer) {
      // Fail loudly rather than falling back to `supabaseAdmin` or returning
      // an unscoped count — a silently-wrong membership count would let a
      // caller compare it against the org-limit under the wrong scope.
      throw new Error(
        "getMembershipCount requires a session-bound supabaseServer client; this OrganizationService was constructed with supabaseServer: null",
      );
    }

    const { count, error } = await this.supabaseServer
      .from("membership")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "active");

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, count: count || 0 };
  }

  private async rollbackStripeCustomer(customerId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.stripeService.deleteCustomer(customerId);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log structured error for monitoring/alerting
      const err = new Error("Failed to rollback Stripe customer - orphan customer may exist");
      await serverLogger.error(err, {
        stripeCustomerId: customerId,
        originalError: errorMessage,
        action_required: "Manual cleanup may be needed in Stripe dashboard",
      });

      return { success: false, error: errorMessage };
    }
  }
}
