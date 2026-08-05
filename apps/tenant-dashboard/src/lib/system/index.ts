import 'server-only';

/**
 * lib/system — the admin boundary.
 *
 * This module is the ONLY sanctioned home for the service-role (RLS-bypassing)
 * client. The many hand-rolled admin call sites across the legacy app collapse
 * here into a small set of named, purpose-scoped functions (e.g. `getEntitlement`,
 * `writeAuditLog`, `readSecret`, `resolveUserPermissions`) — each an explicit,
 * reviewable opt-out of RLS, never an ad-hoc convenience.
 *
 * A path-scoped `no-restricted-imports` lint rule enforces the boundary: the
 * service-role client factory is importable from nowhere else. `server-only`
 * keeps the whole module (and its privileged surface) out of client bundles.
 */

import { getAdminDataClient } from './admin-client';
import { TermsAgreementService } from './terms-agreement';

export { getEntitlement } from './get-entitlement';
export { fetchAiCostConfigForTenant, type AiCostConfig } from './ai-cost-config-read';
export { resolveMemberDisplayNames } from './resolve-member-display-names';
export { listTenantMembers, type TenantMember } from './list-tenant-members';
export {
  listAppMemberRoles,
  listAppsForDropdown,
  getMembershipAppScoped,
  type AppMemberRoleRow,
} from './app-access-reads';
export { OrganizationService } from './organization-service';
export type {
  OrganizationServiceConfig,
  CreateOrgResult,
  SwitchOrgResult,
  AcceptInviteResult,
  InvitationDetails,
} from './organization-service';
export { TermsAgreementService, recordTermsAgreementForUser } from './terms-agreement';
export type {
  ConsentType,
  ITermsAgreementService,
  RecordAgreementParams,
  TermsAgreementRecord,
  TermsCheckResult,
} from './terms-agreement-types';
export { createEmailRegistrationService, EmailRegistrationService } from './registration/email-registration';
export { createOAuthRegistrationService, OAuthRegistrationService } from './registration/oauth-registration';
export type {
  RegistrationServiceConfig,
  OAuthRegistrationServiceConfig,
} from './registration/types';
export {
  AuditLogService,
  captureRequestContext,
  writeAuditLog,
  isAuditedPermission,
  AUDITED_PERMISSION_SUFFIXES,
  type AuditLogEntry,
} from './audit-log';
export { EntitlementService, buildDeniedInfo } from './entitlement-service';

/**
 * Constructs a `TermsAgreementService` bound to the service-role client.
 * Callers use this instead of building the admin client themselves —
 * construction stays confined here.
 */
export function createTermsAgreementService(): TermsAgreementService {
  return new TermsAgreementService({ supabaseAdmin: getAdminDataClient() });
}
