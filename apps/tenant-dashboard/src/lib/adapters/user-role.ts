/**
 * Adapter bridge for the membership role type, which `src/auth/types` still
 * owns. Kept as a named adapter (rather than an inline `@/auth/types` import
 * in system-layer code) so the crossing stays visible and removable as the
 * auth domain migrates.
 */
export type { UserRole } from "@/auth/types";
