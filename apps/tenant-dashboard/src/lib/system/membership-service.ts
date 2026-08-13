import "server-only";

import { SupabaseClient, User } from "@supabase/supabase-js";
import {
  MembershipService as PackageMembershipService,
  type MembershipServiceConfig as PackageMembershipServiceConfig,
  type InviteResult,
  type EntitlementGate,
  type AppRoleAssigner,
} from "@repo/org-management-service";
import { UserRole } from "@/lib/adapters/user-role";
import { EmailService, RateLimitService, StripeService } from "@/lib/external-services";
import { EntitlementService, buildDeniedInfo } from "@/lib/system/entitlement-service";
import { AuditLogService, captureRequestContext } from "@/lib/system/audit-log";
import { serverLogger } from "@/lib/observability/server-logger";
// EE import (one-way, documented in ee/README.md): the invite flow delegates
// per-app role assignment to the EE service; on unlicensed deployments it
// returns entitlement_denied and invites proceed without app roles.
import { AppMemberRoleService } from "@ee/features/app-access/app-member-role-service";

export type { InviteResult };

export interface MembershipServiceConfig {
  supabaseAdmin: SupabaseClient;
  supabaseServer: SupabaseClient;
  emailService: EmailService;
  rateLimitService: RateLimitService;
  stripeService: StripeService;
}

/** Role-changed / removed-from-org emails carry no per-call `origin`; one deployment-wide base URL applies to both. */
function resolveAppUrl(): string {
  return process.env.NODE_ENV === "production"
    ? "https://app.agentmark.co"
    : "http://localhost:3002";
}

function buildEntitlementGate(db: SupabaseClient): EntitlementGate {
  const entitlementService = new EntitlementService({ db });
  return {
    checkLimit: (tenantId, key, currentCount) =>
      entitlementService.checkLimit(tenantId, key as Parameters<typeof entitlementService.checkLimit>[1], currentCount),
    canAccess: (tenantId, key) =>
      entitlementService.canAccess(tenantId, key as Parameters<typeof entitlementService.canAccess>[1]),
    buildDeniedInfo: (key, checkResult) =>
      buildDeniedInfo(
        key as Parameters<typeof buildDeniedInfo>[0],
        checkResult as Parameters<typeof buildDeniedInfo>[1],
      ),
  };
}

function buildAppRoleAssigner(db: SupabaseClient): AppRoleAssigner {
  return {
    bulkAssign: (tenantId, actorId, input) =>
      new AppMemberRoleService({ db, actorId }).bulkAssign(tenantId, input),
  };
}

/**
 * Thin wrapper over `@repo/org-management-service`'s framework-free
 * `MembershipService`: wires the dashboard's own billing-tier gating, audit
 * log, EE app-role assignment, and observability sink into the package's
 * injected seams. Keeps the pre-extraction constructor shape (five fields)
 * so existing callers (`lib/adapters/membership.ts`) are unaffected.
 */
export class MembershipService {
  private inner: PackageMembershipService;

  constructor(config: MembershipServiceConfig) {
    const packageConfig: PackageMembershipServiceConfig = {
      supabaseAdmin: config.supabaseAdmin,
      supabaseServer: config.supabaseServer,
      emailService: config.emailService,
      rateLimitService: config.rateLimitService,
      stripeService: config.stripeService,
      entitlements: buildEntitlementGate(config.supabaseAdmin),
      auditLog: new AuditLogService({ db: config.supabaseAdmin }),
      getRequestContext: captureRequestContext,
      logger: { error: (error, metadata) => serverLogger.error(error, metadata) },
      appRoleAssigner: buildAppRoleAssigner(config.supabaseAdmin),
      appUrl: resolveAppUrl(),
    };
    this.inner = new PackageMembershipService(packageConfig);
  }

  sendInvite(params: {
    adminUser: User;
    tenantId: string;
    name: string;
    email: string;
    role: UserRole;
    origin: string;
    appRoles?: Array<{ appId: string; role: "read" | "write" | "admin" }>;
  }): Promise<InviteResult> {
    return this.inner.sendInvite(params);
  }

  changeUserRole(params: {
    adminUser: User;
    tenantId: string;
    targetUserId: string;
    newRole: UserRole;
    customRoleId?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    return this.inner.changeUserRole(params);
  }

  removeUserFromOrg(params: {
    adminUser: User;
    tenantId: string;
    targetUserId: string;
  }): Promise<{ success: boolean; error?: string }> {
    return this.inner.removeUserFromOrg(params);
  }

  resendInviteLink(params: {
    adminUser: User;
    tenantId: string;
    email: string;
    origin: string;
  }): Promise<{ success: boolean; error?: string }> {
    return this.inner.resendInviteLink(params);
  }
}
