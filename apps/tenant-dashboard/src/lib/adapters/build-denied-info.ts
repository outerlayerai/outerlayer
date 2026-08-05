/**
 * Adapter bridge for `buildDeniedInfo`, which the legacy entitlement service
 * still owns. It is a pure static-config lookup (safe to call from a client
 * component), but the crossing still goes through a named adapter so a
 * new→legacy dependency stays visible and removable as entitlements migrate.
 *
 * Kept out of the adapters barrel on purpose — see `git-provider-type.ts`.
 * Import this module directly.
 */
export { buildDeniedInfo } from "@/lib/system/entitlement-service";
