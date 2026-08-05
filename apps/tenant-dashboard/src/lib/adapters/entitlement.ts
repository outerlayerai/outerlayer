/**
 * The general-purpose boolean-entitlement gate, re-exported from its
 * canonical home (`@/lib/system/get-entitlement`) so route-tier callers
 * (the settings layout's SSO/roles/audit-log/AI-costs tab gates) keep one
 * stable import path across the re-home.
 */
export { getEntitlement } from "@/lib/system/get-entitlement";
