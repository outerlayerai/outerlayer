import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { getRequestTenantId } from '@/lib/tenant/request-tenant';
import { verifyAppAccess } from '@/lib/analytics/tenant-context';
import { ForbiddenError, ValidationError } from '@repo/observability-service';

type AppContextOk = {
  ok: true;
  userId: string;
  tenantId: string;
  appId: string;
  accessToken: string | null;
  supabase: SupabaseClient;
};

type AppContextErr = {
  ok: false;
  status: 401 | 403;
  body: { error: string; code: 'UNAUTHORIZED' | 'FORBIDDEN' };
};

/**
 * Resolves an authed user + tenant for path-param-routed app endpoints.
 *
 * Wraps `createSupabaseServerClient` + `verifyAppAccess` so route tests
 * can mock this single function instead of the underlying supabase client
 * (which is forbidden by the @repo/supabase-test-mocks lint rule).
 */
export async function requireAppContext(
  appId: string
): Promise<AppContextOk | AppContextErr> {
  // The returned client is scoped to the URL-derived request tenant, so
  // callers' reads and writes run under it.
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      ok: false,
      status: 401,
      body: { error: 'Not authenticated', code: 'UNAUTHORIZED' },
    };
  }

  const tenantId = requestTenantId;
  if (!tenantId) {
    return {
      ok: false,
      status: 403,
      body: { error: 'No tenant associated with user', code: 'FORBIDDEN' },
    };
  }

  try {
    await verifyAppAccess(supabase, user.id, tenantId, appId);
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) {
      return {
        ok: false,
        status: 403,
        body: { error: error.message, code: 'FORBIDDEN' },
      };
    }
    throw error;
  }

  const { data: { session } } = await supabase.auth.getSession();
  return {
    ok: true,
    userId: user.id,
    tenantId,
    appId,
    accessToken: session?.access_token ?? null,
    supabase,
  };
}
