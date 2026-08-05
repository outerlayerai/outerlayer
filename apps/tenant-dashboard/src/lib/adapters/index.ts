/**
 * lib/adapters — the single sanctioned bridge from new-world code to the legacy tree.
 *
 * New-architecture code (src/features, src/lib/action-kit, src/lib/system,
 * src/lib/hooks, src/lib/app-shell) may not import legacy modules
 * (src/sections, src/services, legacy auth, the root Supabase client wrappers)
 * directly — a `no-restricted-imports` rail forbids it. When a migrated surface
 * genuinely needs something the legacy tree still owns, the crossing goes here:
 * add a narrow, named adapter function that wraps the legacy call and exposes a
 * new-world-shaped surface, then export it from this barrel. The lint rail lifts
 * the legacy-import ban for this directory only, so every new→old dependency is
 * visible, counted, and removable as the underlying surface migrates.
 */

export {
  loadRequestServiceContext,
  loadPreTenantActor,
  checkRequestPermission,
  resolveCallerMembershipId,
} from './request-service-context'
export { isTempAccessReadOnlySession } from './temp-access-guard'

export { tenantChQuery, fetchSessionOutcomeScores, getSessionListOutcomes } from './pr-outcomes'
export { logServerError } from './server-error-log'
export { hasCustomMetricsEntitlement } from './dashboard-entitlements'
export { createBillingService, resolveBillingConfig, type StripeService } from './billing'
export { getSpanLimit } from './span-usage'
export { getEntitlement } from './entitlement'
export {
  listAuditLogEntries,
  getAuditLogEntryDetail,
  listAuditLogEntriesForExport,
  auditLogRowsToCsv,
} from './audit-log'
export {
  sendMemberInvite,
  resendMemberInvite,
  changeMemberRole,
  removeMember,
} from './membership'
export { switchActiveOrg, countActiveMemberships, createNewOrganization } from './organization'
export { serverLogger } from './server-logger'
