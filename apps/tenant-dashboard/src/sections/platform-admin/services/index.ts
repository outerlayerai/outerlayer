/**
 * Service layer exports and factory functions.
 * Production services use default dependencies; tests inject mocks via the
 * constructor.
 */

import Stripe from 'stripe';
import { createSupabaseAdminClient } from '../../../supabaseAdminClient';
import { STRIPE_SECRET_KEY } from '../../../config-global.server';
import { OrganizationService } from './organization-service';
import { UserService } from './user-service';
import { AuditLogService } from '@/lib/system/audit-log';
import { TempAccessService } from './temp-access-service';
import { AuditLogViewerService } from '@/lib/system/audit-log/audit-log-viewer-service';
import { FeatureFlagService } from './feature-flag-service';
import { createEmailService } from '../../../lib/external-services';

// Export types only - service classes are accessed via factory functions below
export * from './types';

/**
 * Create OrganizationService with production dependencies.
 * For testing, instantiate OrganizationService directly with mock deps.
 */
export function createOrganizationService(): OrganizationService {
  const db = createSupabaseAdminClient();
  const auditLog = new AuditLogService({ db });

  return new OrganizationService({
    db,
    stripe: STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : undefined,
    auditLog,
  });
}

/**
 * Create UserService with production dependencies.
 * For testing, instantiate UserService directly with mock deps.
 */
export function createUserService(): UserService {
  const db = createSupabaseAdminClient();
  const auditLog = new AuditLogService({ db });

  return new UserService({
    db,
    auditLog,
  });
}

/**
 * Create TempAccessService with production dependencies.
 * For testing, instantiate TempAccessService directly with mock deps.
 */
export function createTempAccessService(): TempAccessService {
  const db = createSupabaseAdminClient();
  const auditLog = new AuditLogService({ db });
  const emailService = createEmailService();

  return new TempAccessService({
    db,
    emailService,
    auditLog,
  });
}

/**
 * Create AuditLogViewerService with production dependencies.
 * For testing, instantiate AuditLogViewerService directly with mock deps.
 */
export function createAuditLogViewerService(): AuditLogViewerService {
  const db = createSupabaseAdminClient();
  return new AuditLogViewerService({ db });
}

/**
 * Create FeatureFlagService with production dependencies.
 * For testing, instantiate FeatureFlagService directly with mock deps.
 */
export function createFeatureFlagService(): FeatureFlagService {
  const db = createSupabaseAdminClient();
  const auditLog = new AuditLogService({ db });

  return new FeatureFlagService({
    db,
    auditLog,
  });
}
