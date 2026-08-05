/**
 * Service layer types for platform admin.
 * Services accept dependencies via constructor for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';


/**
 * Stripe client interface for billing operations.
 */
export interface IStripeClient {
  subscriptions: {
    cancel: (subscriptionId: string) => Promise<Stripe.Subscription>;
  };
}

/**
 * Re-export EmailService from the shared service layer.
 * Platform admin services use the same email service as the rest of the app.
 */
import type { EmailService } from '../../../lib/external-services';
export type { EmailService };

/**
 * Audit log service interface — the single write seam for the consolidated
 * audit_log table (see src/lib/system/audit-log/). Platform callers omit
 * actorType/tenantId and get human, platform-scoped defaults.
 */
import type { AuditLogEntry } from '@/lib/system/audit-log';

export interface IAuditLogService {
  create: (entry: AuditLogEntry) => Promise<void>;
}

/**
 * Dependencies for OrganizationService.
 */
export interface OrganizationServiceDeps {
  db: SupabaseClient;
  stripe?: IStripeClient;
  auditLog: IAuditLogService;
}

/**
 * Dependencies for UserService.
 */
export interface UserServiceDeps {
  db: SupabaseClient;
  auditLog: IAuditLogService;
}

/**
 * Dependencies for TempAccessService.
 */
export interface TempAccessServiceDeps {
  db: SupabaseClient;
  emailService?: EmailService;
  auditLog: IAuditLogService;
}
