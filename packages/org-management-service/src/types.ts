/**
 * Structural seams a host app wires real implementations into. Kept here
 * rather than importing the host's own service types so this package's only
 * external dependency stays `@supabase/supabase-js`.
 */

import type { Database } from '@repo/db-types';

/** Built-in organization role. Mirrors `public.app_role`. */
export type MembershipRole = Database['public']['Enums']['app_role'];

/**
 * Convenience const object for the built-in roles — a custom role is active
 * when a membership's `custom_role_id` is set, not a `role` value.
 */
export const MembershipRoleEnum = {
  OWNER: 'owner',
  ADMIN: 'admin',
  WRITE: 'write',
  READ: 'read',
  DISABLED: 'disabled',
} satisfies Record<string, MembershipRole>;

export interface EmailSendResult {
  error: Error | null;
}

/** The narrow email surface `MembershipService` needs — a host wires its own provider behind it. */
export interface EmailService {
  sendEmail(params: {
    to: string;
    subject: string;
    /** One of `'invite' | 'role_changed' | 'removed_from_org'` — the three membership-lifecycle email kinds. */
    emailType: string;
    templateParams: Record<string, unknown>;
  }): Promise<EmailSendResult>;
}

/** The narrow rate-limiting surface `MembershipService` needs. */
export interface RateLimitService {
  limit(identifier: string): Promise<{ success: boolean }>;
}

/**
 * The full billing surface `MembershipServiceConfig` accepts today. Kept as
 * an injected config field (unused by any current method) to preserve the
 * class's existing constructor shape for callers that already build one.
 */
export interface StripeService {
  createCustomer(
    params: { name: string; email: string; metadata: Record<string, string> },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  retrieveCustomer(customerId: string): Promise<unknown>;
  deleteCustomer(customerId: string): Promise<void>;
  retrieveSubscription(subscriptionId: string): Promise<unknown>;
  updateSubscription(subscriptionId: string, params: unknown): Promise<unknown>;
}

/** Result of an entitlement numeric-limit check — mirrors the host's `EntitlementCheckResult`. */
export interface EntitlementCheckResult {
  allowed: boolean;
  limit: number;
  currentCount: number;
  requiredTier?: string;
  upgradeUrl?: string;
}

/**
 * Billing-tier gating. `MembershipService` only ever checks two keys —
 * `max_users` (numeric limit) and `app_level_roles` (boolean access) — as
 * opaque strings, so the host's own entitlement-key union never has to be
 * imported here.
 */
export interface EntitlementGate {
  checkLimit(tenantId: string, key: string, currentCount: number): Promise<EntitlementCheckResult>;
  canAccess(tenantId: string, key: string): Promise<boolean>;
  /** Builds the user-facing denial payload for a gated key; shape is the host's own. */
  buildDeniedInfo(key: string, checkResult?: EntitlementCheckResult): Record<string, unknown>;
}

/** Per-app role assignment, delegated to the host's own (possibly EE-gated) implementation. */
export interface AppRoleAssignment {
  appId: string;
  role: 'read' | 'write' | 'admin';
}

export interface BulkAppRoleAssignResult {
  success: boolean;
  error?: string;
  data?: { errors: Array<{ appId: string }> };
}

/**
 * Per-app role assignment on a fresh invite. Optional in config — a host with
 * no per-app-role feature (or an unlicensed self-host) simply never supplies
 * `appRoles` on `sendInvite`, so this is never called.
 */
export interface AppRoleAssigner {
  bulkAssign(
    tenantId: string,
    actorId: string,
    input: { membershipId: string; assignments: AppRoleAssignment[] },
  ): Promise<BulkAppRoleAssignResult>;
}

/** The audit-log fields `MembershipService` writes. A subset of the host's richer entry shape. */
export interface AuditLogEntryInput {
  tenantId: string;
  actorId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  targetIdentifier?: string;
  details?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
}

/** The single audit write seam — a host wires its own service-role-backed implementation. */
export interface AuditLogWriter {
  create(entry: AuditLogEntryInput): Promise<void>;
}

/** Best-effort request metadata (IP, user agent, request id) stamped onto the transaction RPCs. */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Structured error logging — a host wires its own observability sink. */
export interface Logger {
  error(error: Error, metadata?: Record<string, unknown>): Promise<void>;
}
