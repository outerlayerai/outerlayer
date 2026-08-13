/**
 * @repo/org-management-service
 *
 * Framework-free membership lifecycle and admin-API-key bearer-authority
 * primitives. Every host-specific concern — email, rate limiting,
 * entitlement gating, audit logging, per-app role assignment, request
 * metadata, and the HMAC pepper — is injected; this package imports no
 * `next/*` and constructs no Supabase client of its own.
 */

export {
  MembershipService,
  type MembershipServiceConfig,
  type InviteResult,
} from './membership-service';

export {
  ADMIN_API_KEY_PREFIX,
  mintAdminApiKey,
  verifyAdminApiKeyBearer,
  resolveAdminApiKeyContext,
  resolveBearerServiceContext,
  type AdminApiKeyServiceContext,
  type AdminApiKeyRequestAuth,
  type BearerServiceContextResult,
} from './admin-api-key-authority';

export {
  MembershipRoleEnum,
  type MembershipRole,
  type EmailService,
  type EmailSendResult,
  type RateLimitService,
  type StripeService,
  type EntitlementCheckResult,
  type EntitlementGate,
  type AppRoleAssignment,
  type BulkAppRoleAssignResult,
  type AppRoleAssigner,
  type AuditLogEntryInput,
  type AuditLogWriter,
  type RequestContext,
  type Logger,
} from './types';
