export {
  // Matrix-agnostic resolvers (dashboard uses these because its key set
  // is wider than tier-config's).
  resolveBoolean,
  resolveNumeric,
  // Bulk read for rendering the full entitlement panel.
  readAllOverrides,
  // Batch resolution for cross-tenant cron paths (throws on read errors).
  resolveNumericLimitForAllTenants,
  type TenantNumericLimits,
  // Quota arithmetic — UNLIMITED-aware count vs limit.
  quotaCheck,
  // Tier-config-narrow convenience wrappers (gateway entry points).
  resolveBooleanEntitlement,
  resolveNumericLimit,
  // Types.
  type SupabaseEntitlementClient,
  type EntitlementResolverLogger,
  type EntitlementOverrideRow,
  type QuotaCheckResult,
  type TierMatrix,
} from './resolver';
