import type { LogContext } from "../types/context";
import { createSupabaseServerClient } from "../supabaseServerClient";
import { getRequestTenantId } from "../lib/tenant/request-tenant";

/**
 * Get log context by fetching user from Supabase.
 * Returns context with tenantId (the URL-derived request tenant, when one is
 * present) and userId. Safe to call from server components, API routes, and
 * server actions. Returns undefined on client or if user is not authenticated.
 *
 * @param appId - Optional app ID to include in context (pass when in app-specific routes)
 */
export async function getLogContext(appId?: string): Promise<LogContext | undefined> {
  // Only works on server
  if (typeof window !== "undefined") {
    return undefined;
  }

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return undefined;
    }

    return {
      isProduction: process.env.NODE_ENV === "production",
      tenantId: await getRequestTenantId(),
      userId: user.id,
      appId,
    };
  } catch {
    // Failed to get user context - return undefined
    return undefined;
  }
}

/**
 * Create a LogContext with explicit values (for cases where user is already fetched).
 */
export function createLogContext(options?: {
  tenantId?: string;
  userId?: string;
  appId?: string;
}): LogContext {
  return {
    isProduction: process.env.NODE_ENV === "production",
    tenantId: options?.tenantId,
    userId: options?.userId,
    appId: options?.appId,
  };
}
