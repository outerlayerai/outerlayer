/**
 * Analytics Authentication Wrapper
 *
 * Provides a higher-order function that wraps route handlers with
 * authentication and tenant verification. Ensures handlers CANNOT
 * be called without a verified TenantContext.
 *
 * Per Next.js best practices: "Verify authentication as close as
 * possible to your data source."
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { getRequestTenantId } from '@/lib/tenant/request-tenant';
import { verifyAppAccess, type TenantContext } from '@/lib/analytics/tenant-context';
import { EntitlementService } from '@/lib/system/entitlement-service';
import { ForbiddenError, ValidationError } from '@/lib/analytics/errors';
import { analyticsLogger } from '@/lib/analytics/logger';

/**
 * Handler function that receives verified TenantContext.
 *
 * TypeScript enforces that handlers accept TenantContext as second parameter,
 * making it impossible to write a handler that doesn't receive verified context.
 */
export type AuthenticatedHandler = (
  request: Request,
  context: TenantContext
) => Promise<Response>;

/**
 * Handler function for dynamic routes that receives route params.
 *
 * Used for routes like /api/analytics/traces/[id] where we need
 * both the TenantContext and the dynamic route parameters.
 */
export type AuthenticatedHandlerWithParams<P = Record<string, string>> = (
  request: Request,
  context: TenantContext,
  params: P
) => Promise<Response>;

/**
 * Standard error response shape for auth failures.
 */
interface ErrorResponse {
  error: string;
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
}

// ============================================================================
// Wrapper Implementation
// ============================================================================

/**
 * Wraps a route handler with authentication and tenant verification.
 *
 * The returned handler:
 * 1. Validates user session
 * 2. Extracts tenant_id from JWT
 * 3. Verifies app belongs to tenant
 * 4. Passes frozen TenantContext to handler
 *
 * @param handler - The handler function to wrap
 * @returns Wrapped handler that performs auth before calling original
 *
 * @example
 * ```typescript
 * // In route.ts
 * export const GET = withAnalyticsAuth(async (request, context) => {
 *   // context.appId is GUARANTEED verified
 *   // context.tenantId is GUARANTEED from JWT
 *   const metrics = await analyticsDAL.getMetrics(context, params);
 *   return NextResponse.json(metrics);
 * });
 * ```
 */
export function withAnalyticsAuth(handler: AuthenticatedHandler) {
  return async (request: Request): Promise<Response> => {
    try {
      // Step 1: Get user from session under the URL-derived request tenant.
      // The middleware forwards it as x-tenant-id; the header-scoped client runs
      // every read under public.tenant_id()'s membership-checked answer.
      const requestTenantId = await getRequestTenantId();
      const supabase = await createSupabaseServerClient(requestTenantId);
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (userError || !user) {
        return createErrorResponse(
          'Not authenticated',
          'UNAUTHORIZED',
          401
        );
      }

      // Step 2: Resolve the URL-derived request tenant.
      const tenantId = requestTenantId;
      if (!tenantId) {
        return createErrorResponse(
          'No tenant associated with user',
          'FORBIDDEN',
          403
        );
      }

      // Step 3: Get and validate appId from query params
      const url = new URL(request.url);
      const appId = url.searchParams.get('appId');

      if (!appId) {
        return createErrorResponse(
          'appId query parameter is required',
          'VALIDATION_ERROR',
          400
        );
      }

      // Step 4: Fetch data retention entitlement for the tenant
      const adminDb = createSupabaseAdminClient();
      const entitlementService = new EntitlementService({ db: adminDb });
      const dataRetentionDays = await entitlementService.getLimit(tenantId, 'data_retention_days');

      // Step 5: Verify app belongs to tenant and create context
      const context = await verifyAppAccess(supabase, user.id, tenantId, appId, dataRetentionDays);

      // Step 5: Call handler with verified context
      return await handler(request, context);

    } catch (error) {
      // Handle known error types
      if (error instanceof ForbiddenError) {
        return createErrorResponse(
          error.message,
          'FORBIDDEN',
          403
        );
      }

      if (error instanceof ValidationError) {
        return createErrorResponse(
          error.message,
          'VALIDATION_ERROR',
          400
        );
      }

      // Log unexpected errors but don't expose details
      analyticsLogger.error('withAnalyticsAuth', error);

      return createErrorResponse(
        'Internal server error',
        'INTERNAL_ERROR',
        500
      );
    }
  };
}

/**
 * Wraps a dynamic route handler with authentication and tenant verification.
 *
 * Similar to withAnalyticsAuth but also passes route params to the handler.
 * Use this for routes like /api/analytics/traces/[id].
 *
 * @param handler - The handler function to wrap
 * @returns Wrapped handler that performs auth before calling original
 *
 * @example
 * ```typescript
 * // In traces/[id]/route.ts
 * export const GET = withAnalyticsAuthParams<{ id: string }>(
 *   async (request, context, params) => {
 *     const trace = await getCachedTraces(context, params.id);
 *     return NextResponse.json(trace);
 *   }
 * );
 * ```
 */
export function withAnalyticsAuthParams<P extends Record<string, string>>(
  handler: AuthenticatedHandlerWithParams<P>
) {
  return async (
    request: Request,
    { params }: { params: Promise<P> }
  ): Promise<Response> => {
    try {
      // Step 1: Get user from session under the URL-derived request tenant.
      // The middleware forwards it as x-tenant-id; the header-scoped client runs
      // every read under public.tenant_id()'s membership-checked answer.
      const requestTenantId = await getRequestTenantId();
      const supabase = await createSupabaseServerClient(requestTenantId);
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (userError || !user) {
        return createErrorResponse(
          'Not authenticated',
          'UNAUTHORIZED',
          401
        );
      }

      // Step 2: Resolve the URL-derived request tenant.
      const tenantId = requestTenantId;
      if (!tenantId) {
        return createErrorResponse(
          'No tenant associated with user',
          'FORBIDDEN',
          403
        );
      }

      // Step 3: Get and validate appId from query params
      const url = new URL(request.url);
      const appId = url.searchParams.get('appId');

      if (!appId) {
        return createErrorResponse(
          'appId query parameter is required',
          'VALIDATION_ERROR',
          400
        );
      }

      // Step 4: Fetch data retention entitlement for the tenant
      const adminDb = createSupabaseAdminClient();
      const entitlementService = new EntitlementService({ db: adminDb });
      const dataRetentionDays = await entitlementService.getLimit(tenantId, 'data_retention_days');

      // Step 5: Verify app belongs to tenant and create context
      const context = await verifyAppAccess(supabase, user.id, tenantId, appId, dataRetentionDays);

      // Step 5: Await route params
      const resolvedParams = await params;

      // Step 6: Call handler with verified context and params
      return await handler(request, context, resolvedParams);

    } catch (error) {
      // Handle known error types
      if (error instanceof ForbiddenError) {
        return createErrorResponse(
          error.message,
          'FORBIDDEN',
          403
        );
      }

      if (error instanceof ValidationError) {
        return createErrorResponse(
          error.message,
          'VALIDATION_ERROR',
          400
        );
      }

      // Log unexpected errors but don't expose details
      analyticsLogger.error('withAnalyticsAuthParams', error);

      return createErrorResponse(
        'Internal server error',
        'INTERNAL_ERROR',
        500
      );
    }
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a standardized error response.
 */
function createErrorResponse(
  message: string,
  code: ErrorResponse['code'],
  status: number
): Response {
  return NextResponse.json(
    { error: message, code } as ErrorResponse,
    { status }
  );
}
