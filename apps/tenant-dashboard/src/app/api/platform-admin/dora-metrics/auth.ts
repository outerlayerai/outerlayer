/**
 * Platform Admin Authentication Wrapper
 *
 * Provides a higher-order function that wraps route handlers with
 * platform admin authentication. Ensures handlers CANNOT be called
 * without a verified PlatformAdminContext.
 *
 * Platform admin requirements:
 * 1. User must be authenticated
 * 2. User must be on an allowed platform-admin email domain
 * 3. User must have a row in platform_user_role table
 */

import 'server-only';

import { NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/supabaseServerClient';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { isAllowedPlatformAdminEmail } from '@/auth/platform-admin-domain';

/**
 * Context provided to authenticated platform admin handlers.
 */
interface PlatformAdminContext {
  userId: string;
  email: string;
}

/**
 * Handler function that receives verified PlatformAdminContext.
 *
 * TypeScript enforces that handlers accept PlatformAdminContext as second
 * parameter, making it impossible to write a handler that doesn't receive
 * verified context.
 */
export type PlatformAdminHandler = (
  request: Request,
  context: PlatformAdminContext
) => Promise<Response>;

// ============================================================================
// Wrapper Implementation
// ============================================================================

/**
 * Wraps a route handler with platform admin authentication.
 *
 * The returned handler:
 * 1. Validates user session via Supabase auth
 * 2. Checks the email sits on an allowed platform-admin domain
 * 3. Verifies user exists in platform_user_role table
 * 4. Passes PlatformAdminContext to handler
 *
 * @param handler - The handler function to wrap
 * @returns Wrapped handler that performs auth before calling original
 *
 * @example
 * ```typescript
 * // In route.ts
 * export const GET = withPlatformAdminAuth(async (request, context) => {
 *   // context.userId is GUARANTEED verified as platform admin
 *   // context.email is GUARANTEED to be on an allowed platform-admin domain
 *   const metrics = await getDoraMetrics();
 *   return NextResponse.json(metrics);
 * });
 * ```
 */
export function withPlatformAdminAuth(handler: PlatformAdminHandler) {
  return async (request: Request): Promise<Response> => {
    try {
      // 1. Validate user session
      const supabase = await createSupabaseServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user || !user.email) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // 2. Email domain check
      if (!isAllowedPlatformAdminEmail(user.email)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // 3. Platform admin role check (from platform_user_role table - separate from tenant roles)
      const supabaseAdmin = createSupabaseAdminClient();
      const { data } = await supabaseAdmin
        .from('platform_user_role')
        .select('role')
        .eq('user_id', user.id)
        .single();

      if (!data) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // 4. Call handler with verified context
      return await handler(request, { userId: user.id, email: user.email });
    } catch (error) {
      console.error('[platform-admin-auth] Unexpected error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}
