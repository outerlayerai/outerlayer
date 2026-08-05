import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ForbiddenError, ValidationError } from '@repo/observability-service';
import type { Database } from '@/types/db';

// Re-export types from shared package.
// `VerifiedAppId` is consumed from the integration-tests workspace.
// eslint-disable-next-line import/no-unused-modules
export type { TenantContext, VerifiedAppId } from '@repo/observability-service';
// Import for local use
import type { VerifiedAppId, TenantContext } from '@repo/observability-service';

/**
 * Verifies that a user has access to an application and creates a TenantContext.
 *
 * This is the ONLY way to create a valid TenantContext with a VerifiedAppId.
 * The returned context is frozen (immutable) to prevent tampering.
 *
 * @param db - A Supabase client already scoped to `tenantId` (e.g. the
 *   RLS-scoped `ctx.db` a request's service context resolved). This module
 *   opens no client of its own.
 * @param userId - The authenticated user's ID
 * @param tenantId - The tenant ID authorizing this request; every caller
 *   resolves this from `getRequestTenantId()` (the URL-derived request
 *   tenant).
 * @param requestedAppId - The app ID the user is trying to access
 * @returns Frozen TenantContext with verified appId
 * @throws {ValidationError} If any required parameter is missing
 * @throws {ForbiddenError} If the app doesn't exist or belongs to a different tenant
 *
 * @example
 * ```typescript
 * const context = await verifyAppAccess(db, user.id, requestTenantId, appId);
 * // context.appId is now guaranteed to belong to the user's tenant
 * const metrics = await analyticsDAL.getMetrics(context, dateRange);
 * ```
 */
export async function verifyAppAccess(
  db: SupabaseClient<Database>,
  userId: string,
  tenantId: string,
  requestedAppId: string,
  dataRetentionDays: number = -1
): Promise<TenantContext> {
  // Input validation
  if (!userId) {
    throw new ValidationError('userId is required');
  }
  if (!tenantId) {
    throw new ValidationError('tenantId is required');
  }
  if (!requestedAppId) {
    throw new ValidationError('appId is required');
  }

  const { data: app, error } = await db
    .from('app')
    .select('id')
    .eq('id', requestedAppId)
    .eq('tenant_id', tenantId)
    .single();

  // If error or no data, access is denied
  if (error || !app) {
    throw new ForbiddenError('Access denied to this application');
  }

  // Create and freeze the context
  // The cast to VerifiedAppId is safe here because we just verified ownership
  const context: TenantContext = Object.freeze({
    userId,
    tenantId,
    appId: requestedAppId as VerifiedAppId,
    dataRetentionDays,
  });

  return context;
}
